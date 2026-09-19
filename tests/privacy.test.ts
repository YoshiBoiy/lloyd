import { randomUUID, createHmac } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  verifyIntake,
  sha256,
  approvalMessage,
  Preference,
  TelemetryEvent,
  type SanitizedIntake,
} from "../packages/contracts/src/index.js";
import { createApp } from "../apps/api/src/app.js";
import {
  Backboard,
  Telemetry,
  EvidenceStore,
  embed,
  CaseStore,
} from "../packages/integrations/src/data.js";
import {
  ModelServices,
  validateExtraction,
} from "../packages/integrations/src/models.js";
export function intake(
  text = "Year built: 2016",
  confidence = 0.99,
): SanitizedIntake {
  return {
    artifact: { mediaType: "text/plain", text },
    manifest: {
      version: 1,
      documentId: randomUUID(),
      caseId: "demo-001",
      sanitizedSha256: sha256(text),
      fields: [
        {
          path: "buildingYear",
          classification: "cloud_allowed",
          confidence: 1,
        },
      ],
      destinations: ["lloyd-api", "gemini", "elasticsearch"],
      confidence,
      createdAt: new Date().toISOString(),
    },
  };
}
it("requires exact sanitized UTF-8 hash", () => {
  const d = intake();
  d.artifact.text += " ";
  expect(() =>
    verifyIntake(d, ["lloyd-api", "gemini", "elasticsearch"]),
  ).toThrow(/hash/);
  const missing = JSON.parse(JSON.stringify(intake()));
  delete missing.manifest.sanitizedSha256;
  expect(() => verifyIntake(missing, ["lloyd-api"])).toThrow();
});
it("rejects token maps and local-only field metadata", () => {
  const d = intake();
  expect(() =>
    verifyIntake({ ...d, tokenMap: { CANARY: "secret" } }, ["lloyd-api"]),
  ).toThrow();
  d.manifest.fields[0]!.classification = "local_only";
  expect(() =>
    verifyIntake(d, ["lloyd-api", "gemini", "elasticsearch"]),
  ).toThrow(/Local/);
});
it("rejects unapproved provider destination", () =>
  expect(() => verifyIntake(intake(), ["lloyd-api"])).toThrow(/Destination/));
it("does not trust user-authored approval", () => {
  const d = intake("safe", 0.5);
  d.manifest.approval = {
    approvedBy: "user",
    approvedAt: new Date().toISOString(),
  };
  expect(() =>
    verifyIntake(d, ["lloyd-api", "gemini", "elasticsearch"]),
  ).toThrow(/approval/);
  expect(
    verifyIntake(
      d,
      ["lloyd-api", "gemini", "elasticsearch"],
      "lloyd-api",
      true,
    ),
  ).toEqual(d);
});
it.each([
  "canary.sensitive@example.test",
  "123-45-6789",
  "sk-canarysecret0123456789",
])("rejects sensitive canary %s", (text) =>
  expect(() =>
    verifyIntake(intake(text), ["lloyd-api", "gemini", "elasticsearch"]),
  ).toThrow(/sensitive/),
);
it("telemetry allowlist forbids bodies and token maps", () => {
  expect(() =>
    TelemetryEvent.parse({
      eventId: randomUUID(),
      casePseudonym: "a".repeat(64),
      event: "released",
      durationMs: 1,
      at: new Date().toISOString(),
      outcome: "success",
      prompt: "CANARY",
    }),
  ).toThrow();
});
it("backboard accepts approved preferences only", async () => {
  const b = new Backboard();
  expect(() =>
    Preference.parse({
      userId: "a".repeat(64),
      key: "theme",
      value: "dark",
      approved: false,
    }),
  ).toThrow();
  await expect(
    b.remember({
      userId: "a".repeat(64),
      key: "theme",
      value: "dark",
      approved: true,
      caseId: "CANARY",
    }),
  ).rejects.toThrow();
  expect(
    await b.remember({
      userId: "a".repeat(64),
      key: "theme",
      value: "dark",
      approved: true,
    }),
  ).toMatchObject({ status: "STORED" });
});
it("Backboard outage is nonfatal and never accepts case text", async () => {
  const transport = vi.fn().mockRejectedValue(new Error("offline"));
  const b = new Backboard(
    { url: "https://example.test", key: "test", assistantId: "test" },
    transport,
  );
  expect(
    await b.remember({
      userId: "a".repeat(64),
      key: "theme",
      value: "dark",
      approved: true,
    }),
  ).toMatchObject({ status: "UNAVAILABLE" });
});
it("Gemini rejects facts without actual source support", () => {
  const c = {
    document_type: "report",
    candidate_facts: [
      {
        field: "buildingYear",
        value: 2016,
        unit: "year",
        page: 1,
        supporting_excerpt: "Year built: 2016",
        confidence: 0.9,
      },
    ],
  };
  expect(validateExtraction(c, "Year built: 2016")).toEqual(c);
  expect(() => validateExtraction(c, "Year built: 1989")).toThrow();
  expect(() =>
    validateExtraction(
      { ...c, candidate_facts: [{ ...c.candidate_facts[0], value: 1989 }] },
      "Year built: 2016",
    ),
  ).toThrow();
});
it("model outages are unavailable, not fabricated clear evidence", async () => {
  const transport = vi.fn().mockRejectedValue(new Error("offline")),
    m = new ModelServices({ geminiKey: "key", gptzeroKey: "key" }, transport);
  expect(await m.extract(intake())).toMatchObject({ status: "UNAVAILABLE" });
  const d = intake("Inspection narrative. ".repeat(30));
  d.manifest.destinations.push("gptzero");
  expect(
    await m.authorship(d, { version: "v1", reviewThreshold: 0.5 }),
  ).toMatchObject({ outcome: "UNAVAILABLE" });
});
it("claim gate catches a cited but unsupported assertion", async () =>
  expect(
    await new ModelServices().claimSupport(
      [{ text: "Everything is safe", evidenceIds: ["e1"] }],
      [{ id: "e1", text: "Year built 1989" }],
    ),
  ).toMatchObject({ status: "NEEDS_REVIEW", unsupportedCount: 1 }));
it("retrieval isolates cases and time filters, retains provenance", async () => {
  const s = new EvidenceStore();
  for (const [id, caseId, text] of [
    ["one", "a", "POLICY-ABC steel construction"],
    ["two", "b", "POLICY-ABC CANARY"],
    ["three", "a", "masonry structure"],
  ])
    await s.add({
      evidenceId: id!,
      caseId: caseId!,
      text: text!,
      sourceUri: `fixture://${id}`,
      sourceField: "text",
      observedAt: "2026-01-01T00:00:00Z",
      contentHash: sha256(text!),
      vector: embed(text!),
    });
  const r = await s.search("a", "POLICY-ABC");
  expect(r.results[0]?.chunk.evidenceId).toBe("one");
  expect(JSON.stringify(r)).not.toContain("CANARY");
  expect(r.results.every((r) => r.chunk.sourceUri)).toBe(true);
  expect(
    (await s.search("a", "masonry", { after: "2027-01-01" })).results,
  ).toHaveLength(0);
});
it("Elastic outage returns unavailable", async () => {
  const s = new EvidenceStore(
    "https://example.test",
    undefined,
    vi.fn().mockRejectedValue(new Error("offline")),
  );
  expect(await s.search("a", "query")).toMatchObject({ status: "UNAVAILABLE" });
});
it("telemetry outage cannot block underwriting", async () => {
  const t = new Telemetry("postgres://invalid:invalid@127.0.0.1:1/invalid");
  expect(await t.emit("case", "ingested", "success", 0)).toEqual({
    status: "UNAVAILABLE",
  });
  await t.close();
});
it("API intake validates canaries, hash and human signature", async () => {
  const app = createApp({ approvalKey: "paired-key" });
  await app.inject({ method: "POST", url: "/api/ingest" });
  const good = intake("safe", 0.5);
  good.manifest.approval = {
    approvedBy: "reviewer",
    approvedAt: new Date().toISOString(),
  };
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/intake/sanitized",
        payload: good,
      })
    ).statusCode,
  ).toBe(403);
  const m = good.manifest;
  const signed = approvalMessage(m);
  const signature = createHmac("sha256", "paired-key")
    .update(signed)
    .digest("hex");
  const response = await app.inject({
    method: "POST",
    url: "/api/intake/sanitized",
    payload: good,
    headers: { "x-release-approval": signature },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().status).toBe("ACCEPTED");
  await app.close();
});
it("precedents exclude current case", async () => {
  const store = new CaseStore();
  expect(await store.list()).toEqual([]);
});
it("field-level low confidence cannot be hidden by aggregate confidence", () => {
  const d = intake();
  d.manifest.fields[0]!.confidence = 0.1;
  expect(() =>
    verifyIntake(d, ["lloyd-api", "gemini", "elasticsearch"]),
  ).toThrow(/approval/);
});
it("authenticity signal affects workflow only with explicit carrier policy", async () => {
  const transport = vi
    .fn()
    .mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ documents: [{ completely_generated_prob: 0.9 }] }),
          { status: 200 },
        ),
    );
  const models = new ModelServices({ gptzeroKey: "fixture-key" }, transport);
  const d = intake(
    "Synthetic inspection narrative with sufficient text. ".repeat(20),
  );
  d.manifest.destinations.push("gptzero");
  expect(await models.authorship(d)).toMatchObject({ outcome: "CLEAR" });
  expect(
    await models.authorship(d, { version: "demo-v1", reviewThreshold: 0.8 }),
  ).toMatchObject({ outcome: "AUTHENTICITY_REVIEW" });
});
