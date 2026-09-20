import { expect, it } from "vitest";
import { createApp } from "../apps/api/src/app.js";
it("full offline API flow is idempotent and keeps simulations separate", async () => {
  const app = createApp();
  const bootstrap = await app.inject({ method: "POST", url: "/api/bootstrap" });
  expect(bootstrap.statusCode).toBe(200);
  expect(bootstrap.json().mode).toBe("fixture");
  const ingested = await app.inject({ method: "POST", url: "/api/ingest" });
  expect(ingested.json()).toMatchObject({
    total: 56,
    created: 56,
    status: "complete",
  });
  expect(
    (await app.inject({ method: "POST", url: "/api/ingest" })).json(),
  ).toMatchObject({ created: 0, unchanged: 56 });
  const queue = (await app.inject({ url: "/api/cases?limit=100" })).json();
  expect(queue.total).toBe(56);
  expect(queue.items[0].decision.class).toBe("IN_APPETITE");
  const before = (await app.inject({ url: "/api/cases/demo-001" })).json();
  expect(before.case.decision.class).toBe("INVESTIGATE");
  const investigated = await app.inject({
    method: "POST",
    url: "/api/cases/demo-001/investigate",
  });
  expect(investigated.statusCode).toBe(200);
  expect(investigated.json().investigation.steps.length).toBeGreaterThanOrEqual(
    3,
  );
  const result = (
    await app.inject({
      method: "POST",
      url: "/api/cases/demo-001/simulate",
      payload: {
        changes: {
          losses: {
            complete: true,
            items: [{ date: "2024-01-01", amount: 24000 }],
          },
        },
        conditions: ["Verify original loss runs"],
      },
    })
  ).json();
  expect(result.simulation.label).toBe("SIMULATION");
  expect(result.simulation.decision.class).toBe("ACCEPT_WITH_CONDITIONS");
  expect((await app.inject({ url: "/api/cases/demo-001" })).json()).toEqual(
    before,
  );
  const action = (
    await app.inject({
      method: "POST",
      url: "/api/cases/demo-001/actions/draft-information-request",
    })
  ).json();
  expect(action.action.status).toBe("DRAFT");
  expect(
    (await app.inject({ url: "/api/analytics/summary" })).json().analytics
      .total,
  ).toBeGreaterThan(56);
  await app.close();
});
it("auth and errors reveal no stack or submitted secret", async () => {
  const app = createApp({ apiToken: "test-token" });
  expect((await app.inject({ url: "/api/cases" })).statusCode).toBe(401);
  const result = await app.inject({
    url: "/api/cases?tokenMap=CANARY",
    headers: { authorization: "Bearer test-token" },
  });
  expect(result.statusCode).toBe(400);
  expect(result.body).not.toContain("CANARY");
  await app.close();
});
it("malformed model proposals stop within repair budget", async () => {
  const app = createApp(
    {},
    {
      planner: {
        next: async () => ({
          tool: "send_email",
          reason: "bad",
          query: null,
          documentId: null,
        }),
      },
    },
  );
  await app.inject({ method: "POST", url: "/api/ingest" });
  const result = (
    await app.inject({ method: "POST", url: "/api/cases/demo-001/investigate" })
  ).json();
  expect(result.investigation.stopReason).toBe("invalid_planner_output");
  expect(result.investigation.decision.class).toBe("INVESTIGATE");
  await app.close();
});
it("streams bounded investigation progress and completion as SSE", async () => {
  const app = createApp();
  await app.inject({ method: "POST", url: "/api/ingest" });
  const result = await app.inject({
    method: "POST",
    url: "/api/cases/demo-001/investigate",
    headers: { accept: "text/event-stream" },
  });
  expect(result.statusCode).toBe(200);
  expect(result.headers["content-type"]).toBe("text/event-stream");
  expect(result.body).toContain("event: step");
  expect(result.body).toContain("event: completed");
  await app.close();
});
it("investigation resolves a missing fact from new verified source evidence and preserves history", async () => {
  const { Federato } = await import("../packages/integrations/src/federato.js");
  const { fixtureRows, fixtureSchema } =
    await import("../packages/integrations/src/fixtures.js");
  const row = structuredClone(fixtureRows[0]!);
  delete row.losses;
  const federato = new Federato(fixtureSchema, [row]);
  const app = createApp({}, { federato });
  await app.inject({ method: "POST", url: "/api/ingest" });
  expect(
    (await app.inject({ url: "/api/cases/demo-001" })).json().case.decision
      .class,
  ).toBe("INVESTIGATE");
  row.losses = {
    complete: true,
    items: [{ date: "2024-01-01", amount: 24000 }],
  };
  const investigation = (
    await app.inject({ method: "POST", url: "/api/cases/demo-001/investigate" })
  ).json().investigation;
  expect(investigation.decision.class).toBe("IN_APPETITE");
  expect(investigation.stopReason).toBe("all_required_criteria_resolved");
  expect(
    (await app.inject({ url: "/api/cases/demo-001" })).json().case.version,
  ).toBe(2);
  await app.close();
});
it("repeated valid tool proposals cannot exceed the investigation budget", async () => {
  const app = createApp(
    {},
    {
      planner: {
        next: async () => ({
          tool: "inspect_schema",
          reason: "Inspect",
          query: null,
          documentId: null,
        }),
      },
    },
  );
  await app.inject({ method: "POST", url: "/api/ingest" });
  const result = (
    await app.inject({ method: "POST", url: "/api/cases/demo-001/investigate" })
  ).json().investigation;
  expect(result.steps).toHaveLength(10);
  expect(result.stopReason).toBe("tool_budget_reached");
  expect(result.decision.class).toBe("INVESTIGATE");
  await app.close();
});
it("conflicting source values remain preserved and contradicted", async () => {
  const { Federato } = await import("../packages/integrations/src/federato.js");
  const { fixtureRows, fixtureSchema } =
    await import("../packages/integrations/src/fixtures.js");
  const row = structuredClone(fixtureRows[0]!);
  const app = createApp({}, { federato: new Federato(fixtureSchema, [row]) });
  await app.inject({ method: "POST", url: "/api/ingest" });
  row.premium = 90000;
  const result = (
    await app.inject({ method: "POST", url: "/api/cases/demo-001/investigate" })
  ).json().investigation;
  expect(result.facts.premium.alternatives).toEqual([84000, 90000]);
  expect(
    result.decision.criteria.find((c: { key: string }) => c.key === "premium")
      .status,
  ).toBe("CONTRADICTED");
  await app.close();
});
it("lists cases as unavailable instead of leaking an internal store failure", async () => {
  const { CaseStore } = await import("../packages/integrations/src/data.js");
  class UnavailableStore extends CaseStore {
    override async list(): Promise<never> {
      throw new Error("MongoServerSelectionError");
    }
  }
  const app = createApp({}, { store: new UnavailableStore() });
  await app.inject({ method: "POST", url: "/api/bootstrap" });
  const result = await app.inject({ url: "/api/cases?limit=100&offset=0" });
  expect(result.statusCode).toBe(503);
  expect(result.json().error.code).toBe("ATLAS_UNAVAILABLE");
  expect(result.body).not.toContain("MongoServerSelectionError");
  await app.close();
});
