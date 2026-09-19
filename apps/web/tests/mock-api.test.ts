import { describe, expect, it } from "vitest";
import { MockLloydApi } from "../lib/api/mock";
import { MIN_RELEASE_CONFIDENCE, sanitizedText } from "../lib/api/types";
import { DEMO_CASE_ID } from "../lib/fixtures/intake";

function api() {
  return new MockLloydApi({ latencyMs: 0 });
}

describe("MockLloydApi demo state machine", () => {
  it("seeds at least 50 commercial property submissions including the demo case", async () => {
    const list = await api().listCases();
    expect(list.totals.all).toBeGreaterThanOrEqual(50);
    expect(list.cases.some((item) => item.id === DEMO_CASE_ID)).toBe(true);
    expect(list.cases[0]?.decision).not.toBe("OUT_OF_APPETITE");
  });

  it("starts the Harbor Mill file in appetite before investigation", async () => {
    const detail = await api().getCase(DEMO_CASE_ID);
    expect(detail.decision).toBe("IN_APPETITE");
    expect(detail.stage).toBe("NEW");
    expect(detail.investigation.status).toBe("not_started");
  });

  it("runs Federato, Elasticsearch, Atlas, Gemini, OpenAI, and GPTZero steps then moves to Investigate", async () => {
    const client = api();
    const labels: string[] = [];
    const result = await client.investigate(DEMO_CASE_ID, (step) => {
      if (step.status === "completed") labels.push(step.sponsorLabel);
    });
    expect(new Set(labels)).toEqual(
      new Set(["OpenAI", "Federato", "Gemini", "Elasticsearch", "MongoDB Atlas", "GPTZero", "Appetite engine"]),
    );
    expect(result.decision).toBe("INVESTIGATE");
    expect(result.stage).toBe("NEEDS_REVIEW");
    expect(result.authenticity?.outcome).toBe("AUTHENTICITY_REVIEW");
    expect(result.criteria.find((item) => item.factor === "construction_mix")?.status).toBe("CONTRADICTED");
  });

  it("applies a broker response and recalculates to Accept with Conditions", async () => {
    const client = api();
    await client.investigate(DEMO_CASE_ID);
    const afterBroker = await client.applyBrokerResponse(DEMO_CASE_ID);
    expect(afterBroker.decision).toBe("ACCEPT_WITH_CONDITIONS");
    const recalc = await client.recalculate(DEMO_CASE_ID);
    expect(recalc.decision).toBe("ACCEPT_WITH_CONDITIONS");
    const list = await client.listCases();
    const demo = list.cases.find((item) => item.id === DEMO_CASE_ID);
    expect(demo?.decision).toBe("ACCEPT_WITH_CONDITIONS");
    expect(list.totals.readyToQuote).toBeGreaterThan(0);
  });

  it("requires an override reason and keeps the original recommendation", async () => {
    const client = api();
    await expect(client.recordOverride(DEMO_CASE_ID, "  ")).rejects.toThrow(/reason/i);
    const updated = await client.recordOverride(DEMO_CASE_ID, "Will review construction mix with engineering.");
    expect(updated.override?.reason).toContain("engineering");
    expect(updated.decision).toBe("IN_APPETITE");
  });
});

describe("secure intake release policy", () => {
  it("blocks automatic release while signature confidence is low", async () => {
    const client = api();
    let document = await client.captureIntake();
    expect(document.redactionConfidence).toBeLessThan(MIN_RELEASE_CONFIDENCE);
    await expect(
      client.approveAndRelease({
        destinations: ["gemini", "openai", "gptzero"],
        approvedBy: "A. Chen",
        acceptLowConfidence: false,
      }),
    ).rejects.toThrow(/approval/i);
    document = await client.toggleRedaction("span-signature", true);
    expect(document.redactionConfidence).toBeGreaterThanOrEqual(MIN_RELEASE_CONFIDENCE);
    const released = await client.approveAndRelease({
      destinations: ["gemini", "openai", "gptzero"],
      approvedBy: "A. Chen",
      acceptLowConfidence: false,
    });
    expect(released.document.released).toBe(true);
    expect(released.payload.gemini.text).not.toContain("jordan.hale@harbormill.example");
    expect(released.payload.gemini.text).not.toContain("DL-PA-8829173");
    expect(released.document.manifest?.destinations.gemini.length).toBeGreaterThan(0);
  });

  it("adds and removes redactions in the sanitized artifact", async () => {
    const client = api();
    let document = await client.getIntake();
    const email = document.spans.find((span) => span.type === "email")!;
    document = await client.toggleRedaction(email.id, false);
    expect(sanitizedText(document.originalText, document.spans)).toContain("jordan.hale@harbormill.example");
    document = await client.toggleRedaction(email.id, true);
    expect(sanitizedText(document.originalText, document.spans)).not.toContain("jordan.hale@harbormill.example");
    const start = document.originalText.indexOf("Allegheny County");
    document = await client.addManualRedaction(start, start + "Allegheny County".length, "person_name");
    expect(document.spans.some((span) => span.text === "Allegheny County" && span.enabled)).toBe(true);
  });
});
