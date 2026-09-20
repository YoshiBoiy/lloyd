import { expect, it, vi } from "vitest";
import { OAuth, Federato } from "../packages/integrations/src/federato.js";
import {
  fixtureRows,
  fixtureSchema,
} from "../packages/integrations/src/fixtures.js";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
it("OAuth deduplicates refresh and refreshes early at four hours", async () => {
  let now = 0;
  const fetch = vi
    .fn()
    .mockImplementation(async () =>
      json({ access_token: "opaque", expires_in: 14400 }),
    );
  const auth = new OAuth("id", "secret", fetch, () => now);
  await Promise.all([auth.get(), auth.get(), auth.get()]);
  expect(fetch).toHaveBeenCalledTimes(1);
  now = 14099e3;
  await auth.get();
  expect(fetch).toHaveBeenCalledTimes(1);
  now = 14100e3;
  await auth.get();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]?.[0]).toBe(
    "https://auth.product.federato.ai/oauth/token",
  );
});
it("bad JWT issuer/audience fails closed", async () => {
  const token = `a.${Buffer.from(JSON.stringify({ iss: "https://wrong/", aud: "wrong", exp: 9999999999 })).toString("base64url")}.b`;
  const auth = new OAuth(
    "id",
    "secret",
    vi.fn().mockResolvedValue(json({ access_token: token })),
  );
  await expect(auth.get()).rejects.toMatchObject({ category: "AUTH" });
});
it("Federato 401 refreshes exactly once", async () => {
  // The wire schema-discovery response has no top-level "resources" wrapper
  // (it is the resource map itself) and uses the documented field vocabulary
  // (`itemSchema` for array items, `resource`/`cardinality` for references),
  // which normalizeLiveSchema translates into our internal Schema shape.
  const wireSchema = {
    DemoSubmission: {
      fields: {
        id: { type: "string" },
        accountName: { type: "string" },
        submissionType: { type: "string" },
        lineOfBusiness: { type: "string" },
        primaryState: { type: "string" },
        effectiveDate: { type: "string" },
        expirationDate: { type: "string" },
        tiv: { type: "number" },
        premium: { type: "number" },
        buildingYear: { type: "number" },
        construction: {
          type: "array",
          itemSchema: {
            type: "object",
            fields: {
              tiv: { type: "number" },
              construction: { type: "string" },
            },
          },
        },
        losses: {
          type: "object",
          fields: {
            complete: { type: "boolean" },
            items: {
              type: "array",
              itemSchema: {
                type: "object",
                fields: {
                  date: { type: "string" },
                  amount: { type: "number" },
                },
              },
            },
          },
        },
      },
    },
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json({ access_token: "one" }))
    .mockResolvedValueOnce(json({}, 401))
    .mockResolvedValueOnce(json({ access_token: "two" }))
    .mockResolvedValueOnce(json(wireSchema));
  const c = new Federato(
    fixtureSchema,
    [],
    { id: "id", secret: "secret" },
    fetch,
  );
  expect((await c.getSchema()).schema).toEqual(fixtureSchema);
  expect(fetch).toHaveBeenCalledTimes(4);
});
it("redirect is a routing error, never automatically followed", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json({ access_token: "one" }))
    .mockResolvedValueOnce(new Response("", { status: 301 }));
  const c = new Federato(
    fixtureSchema,
    [],
    { id: "id", secret: "secret" },
    fetch,
  );
  await expect(c.getSchema()).rejects.toMatchObject({ category: "ROUTING" });
  expect(fetch.mock.calls[1]?.[1].redirect).toBe("manual");
});
it("fixture pagination retains independent total and schema hash", async () => {
  const c = new Federato(fixtureSchema, fixtureRows);
  const graph = await c.getSchema();
  const r = await c.runQuery({
    resource: "DemoSubmission",
    select: { id: "id" },
    pagination: { limit: 5, offset: 50 },
  });
  expect(r.total).toBe(56);
  expect(r.records).toHaveLength(5);
  expect(r.schemaHash).toBe(graph.hash);
  await expect(
    c.runQuery(
      {
        resource: "DemoSubmission",
        select: { id: "id" },
        pagination: { limit: 5, offset: 0 },
      },
      "stale",
    ),
  ).rejects.toMatchObject({ code: "SCHEMA_CHANGED" });
});
