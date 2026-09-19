import type { AnalyticsSummary, DecisionClass } from "../api/types";

function hours(): string[] {
  return Array.from({ length: 12 }, (_, i) => `${String(8 + i).padStart(2, "0")}:00`);
}

export function createAnalytics(input?: {
  investigatedDelta?: number;
  referralRate?: number;
  cloudAvoided?: number;
  cloudReleased?: number;
  overrideRate?: number;
  outcomes?: Record<DecisionClass, number>;
}): AnalyticsSummary {
  const labels = hours();
  const investigatedDelta = input?.investigatedDelta ?? 0;
  return {
    generatedAt: "2026-09-19T14:20:00.000Z",
    source: "tiger_data_continuous_aggregates",
    disclaimer:
      "Tiger Data stores pseudonymous operational telemetry only. This page never shows raw customer documents, prompts, OCR bodies, or token maps.",
    throughput: labels.map((hour, i) => ({
      hour,
      ingested: 4 + ((i * 3) % 5),
      investigated: Math.max(0, 2 + ((i * 2) % 4) + (i === labels.length - 1 ? investigatedDelta : 0)),
    })),
    investigationLatency: labels.map((hour, i) => ({
      hour,
      p50Ms: 4200 + i * 80,
      p95Ms: 9100 + i * 140,
    })),
    sensitiveFieldsRedacted: [
      { type: "person_name", count: 48 },
      { type: "email", count: 44 },
      { type: "phone", count: 41 },
      { type: "policy_number", count: 39 },
      { type: "government_id", count: 12 },
      { type: "signature", count: 18 },
    ],
    cloudRequestsAvoided: input?.cloudAvoided ?? 37,
    cloudRequestsReleased: input?.cloudReleased ?? 11,
    referralRate: input?.referralRate ?? 0.31,
    appetiteOutcomes: [
      { decision: "IN_APPETITE", count: input?.outcomes?.IN_APPETITE ?? 14 },
      { decision: "ACCEPT_WITH_CONDITIONS", count: input?.outcomes?.ACCEPT_WITH_CONDITIONS ?? 6 },
      { decision: "INVESTIGATE", count: input?.outcomes?.INVESTIGATE ?? 18 },
      { decision: "OUT_OF_APPETITE", count: input?.outcomes?.OUT_OF_APPETITE ?? 14 },
    ],
    frequentlyFailedRules: [
      { rule: "Primary risk state", failures: 9 },
      { rule: "Five-year loss value", failures: 7 },
      { rule: "Submission type (renewal)", failures: 6 },
      { rule: "Construction mix", failures: 5 },
      { rule: "Building age", failures: 4 },
    ],
    humanOverrideRate: input?.overrideRate ?? 0.08,
    ocrRedactionConfidence: labels.map((hour, i) => ({
      hour,
      ocr: Number((0.9 + (i % 4) * 0.01).toFixed(2)),
      redaction: Number((0.92 + (i % 3) * 0.01).toFixed(2)),
    })),
  };
}
