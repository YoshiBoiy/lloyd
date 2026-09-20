import { describe, expect, it } from "vitest";
import { mapAnalytics, mapListItem, summarizeCases, applyCaseFilters, type WireListItem } from "../lib/api/backend-map";

const sample: WireListItem = {
  id: "sub-1",
  updatedAt: "2026-09-19T18:00:00.000Z",
  account: { name: "Allegheny Tool & Die" },
  normalizedRisk: { primaryState: "PA", tiv: 72_000_000, premium: 84_000 },
  decision: {
    class: "IN_APPETITE",
    appetiteScore: 82,
    priorityScore: 80,
    completenessScore: 91,
    confidence: 0.91,
    criteria: [
      { key: "submissionType", status: "ACCEPTABLE", weight: 10, points: 8, observed: "new_business", evidenceIds: [], clauseId: "property.submissionType.2025", explanation: "ok" },
      { key: "primaryState", status: "TARGET", weight: 10, points: 10, observed: "PA", evidenceIds: [], clauseId: "property.primaryState.2025", explanation: "ok" },
    ],
  },
};

describe("live case mapping", () => {
  it("maps Federato queue rows into the workstation summary without demo flags", () => {
    const row = mapListItem(sample);
    expect(row.accountName).toBe("Allegheny Tool & Die");
    expect(row.state).toBe("PA");
    expect(row.decision).toBe("IN_APPETITE");
    expect(row.isDemo).toBe(false);
    expect(row.stage).toBe("READY_TO_QUOTE");
  });

  it("filters and totals from the live set rather than fixtures", () => {
    const listed = summarizeCases(applyCaseFilters([mapListItem(sample)], { state: "PA" }));
    expect(listed.totals.all).toBe(1);
    expect(listed.lanes.inAppetite).toBe(1);
    expect(summarizeCases(applyCaseFilters([mapListItem(sample)], { state: "OH" })).totals.all).toBe(0);
  });
});

describe("live analytics mapping", () => {
  it("maps Tiger hourly aggregates without listing cases", () => {
    const summary = mapAnalytics({
      status: "AVAILABLE",
      mode: "live",
      hourly: [
        {
          hour: "2026-09-20T00:00:00.000Z",
          throughput: "2",
          average_duration_ms: 12,
          failures: "0",
          failure_rate: 0,
          releases: "2",
          redaction_count: "4",
          human_overrides: "1",
          human_override_rate: 0.5,
        },
      ],
    });
    expect(summary.source).toBe("tiger_data_continuous_aggregates");
    expect(summary.throughput).toEqual([{ hour: "2026-09-20T00:00:00.000Z", ingested: 2, investigated: 2 }]);
    expect(summary.investigationLatency).toEqual([{ hour: "2026-09-20T00:00:00.000Z", p50Ms: 12, p95Ms: 12 }]);
    expect(summary.cloudRequestsReleased).toBe(2);
    expect(summary.sensitiveFieldsRedacted).toEqual([{ type: "redacted", count: 4 }]);
    expect(summary.humanOverrideRate).toBe(0.5);
    expect(summary.appetiteOutcomes.every((row) => row.count === 0)).toBe(true);
  });
});
