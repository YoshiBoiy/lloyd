import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpLloydApi } from "../lib/api/http";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HttpLloydApi analytics", () => {
  it("loads Tiger summary even when the case store is down", async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requested.push(url);
        if (url.endsWith("/api/analytics/summary")) {
          return new Response(
            JSON.stringify({
              analytics: {
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
                    human_overrides: "0",
                    human_override_rate: 0,
                  },
                ],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            error: { code: "INTERNAL_ERROR", message: "Operation failed; no sensitive details were logged" },
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const summary = await new HttpLloydApi("http://api.test").getAnalytics();
    expect(requested).toEqual(["http://api.test/api/analytics/summary"]);
    expect(summary.source).toBe("tiger_data_continuous_aggregates");
    expect(summary.throughput[0]?.ingested).toBe(2);
    expect(summary.cloudRequestsReleased).toBe(2);
  });
});
