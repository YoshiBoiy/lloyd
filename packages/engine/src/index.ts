import { z } from "zod";

export const keys = [
  "submissionType",
  "lineOfBusiness",
  "primaryState",
  "tiv",
  "premium",
  "buildingYear",
  "construction",
  "losses",
] as const;
export type CriterionKey = (typeof keys)[number];
export const statuses = [
  "TARGET",
  "ACCEPTABLE",
  "NOT_ACCEPTABLE",
  "UNKNOWN",
  "CONTRADICTED",
  "BOUNDARY_REVIEW",
] as const;
export type Status = (typeof statuses)[number];
export const Evidence = z
  .object({
    id: z.string().min(1),
    source: z.enum(["federato", "fixture", "human", "gemini"]),
    path: z.string(),
    observedAt: z.string().datetime(),
    verified: z.boolean(),
  })
  .strict();
export type Evidence = z.infer<typeof Evidence>;
export const Fact = z
  .object({
    value: z.unknown(),
    evidence: z.array(Evidence),
    contradicted: z.boolean().default(false),
    alternatives: z.array(z.unknown()).optional(),
  })
  .strict();
export type Fact = z.infer<typeof Fact>;
export const Facts = z
  .object({
    accountName: Fact.optional(),
    effectiveDate: Fact.optional(),
    expirationDate: Fact.optional(),
    submissionType: Fact.optional(),
    lineOfBusiness: Fact.optional(),
    primaryState: Fact.optional(),
    tiv: Fact.optional(),
    premium: Fact.optional(),
    buildingYear: Fact.optional(),
    construction: Fact.optional(),
    losses: Fact.optional(),
  })
  .strict();
export type Facts = z.infer<typeof Facts>;
export const buildingsSchema = z
  .array(
    z
      .object({
        tiv: z.number().finite().nonnegative(),
        construction: z.enum([
          "joisted_masonry",
          "noncombustible",
          "steel",
          "masonry_noncombustible",
          "frame",
          "other",
        ]),
      })
      .strict(),
  )
  .min(1);
const lossSchema = z
  .object({
    complete: z.literal(true),
    items: z.array(
      z
        .object({
          date: z.string().date(),
          amount: z.number().finite().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();
const weights: Record<CriterionKey, number> = {
  submissionType: 10,
  lineOfBusiness: 15,
  primaryState: 10,
  tiv: 15,
  premium: 15,
  buildingYear: 10,
  construction: 10,
  losses: 15,
};
const multipliers: Record<Status, number> = {
  TARGET: 1,
  ACCEPTABLE: 0.8,
  BOUNDARY_REVIEW: 0.45,
  UNKNOWN: 0.35,
  CONTRADICTED: 0.2,
  NOT_ACCEPTABLE: 0,
};
const targetStates = ["OH", "PA", "MD", "CO", "CA", "FL"];
const allowedStates = [...targetStates, "NC", "SC", "GA", "VA", "UT"];
export interface Criterion {
  key: CriterionKey;
  status: Status;
  weight: number;
  points: number;
  observed: unknown;
  evidenceIds: string[];
  clauseId: string;
  explanation: string;
}
export interface Decision {
  class:
    | "IN_APPETITE"
    | "INVESTIGATE"
    | "OUT_OF_APPETITE"
    | "ACCEPT_WITH_CONDITIONS";
  appetiteScore: number;
  priorityScore: number;
  completenessScore: number;
  opportunityScore: number;
  freshnessScore: number;
  confidence: number;
  criteria: Criterion[];
  assumptions: string[];
}
export function constructionPercent(value: unknown): number | undefined {
  const r = buildingsSchema.safeParse(value);
  if (!r.success) return;
  const total = r.data.reduce((n, b) => n + b.tiv, 0);
  if (!total) return;
  return (
    r.data
      .filter((b) => !["frame", "other"].includes(b.construction))
      .reduce((n, b) => n + b.tiv, 0) / total
  );
}
export function fiveYearLoss(
  value: unknown,
  effective: unknown,
): number | undefined {
  const r = lossSchema.safeParse(value),
    d = z.string().date().safeParse(effective);
  if (!r.success || !d.success) return;
  const end = new Date(d.data),
    start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - 5);
  return r.data.items
    .filter((l) => new Date(l.date) >= start && new Date(l.date) < end)
    .reduce((n, l) => n + l.amount, 0);
}
const number = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
function classify(key: CriterionKey, value: unknown): Status {
  if (value === undefined || value === null) return "UNKNOWN";
  switch (key) {
    case "submissionType":
      return typeof value !== "string"
        ? "UNKNOWN"
        : value === "new_business"
          ? "ACCEPTABLE"
          : value === "renewal"
            ? "NOT_ACCEPTABLE"
            : "UNKNOWN";
    case "lineOfBusiness":
      return typeof value !== "string" || !value
        ? "UNKNOWN"
        : value === "property"
          ? "ACCEPTABLE"
          : "NOT_ACCEPTABLE";
    case "primaryState":
      return typeof value !== "string" || !/^[A-Z]{2}$/.test(value)
        ? "UNKNOWN"
        : targetStates.includes(value)
          ? "TARGET"
          : allowedStates.includes(value)
            ? "ACCEPTABLE"
            : "NOT_ACCEPTABLE";
    case "tiv":
      return !number(value)
        ? "UNKNOWN"
        : value > 150e6
          ? "NOT_ACCEPTABLE"
          : value >= 50e6 && value <= 100e6
            ? "TARGET"
            : "ACCEPTABLE";
    case "premium":
      return !number(value)
        ? "UNKNOWN"
        : value < 50e3 || value > 175e3
          ? "NOT_ACCEPTABLE"
          : value >= 75e3 && value <= 100e3
            ? "TARGET"
            : "ACCEPTABLE";
    case "buildingYear":
      return !number(value) ||
        !Number.isInteger(value) ||
        value < 1000 ||
        value > 2200
        ? "UNKNOWN"
        : value < 1990
          ? "NOT_ACCEPTABLE"
          : value === 1990
            ? "BOUNDARY_REVIEW"
            : value > 2010
              ? "TARGET"
              : "ACCEPTABLE";
    case "construction":
      return !number(value) || value > 1
        ? "UNKNOWN"
        : value === 0.5
          ? "BOUNDARY_REVIEW"
          : value > 0.5
            ? "ACCEPTABLE"
            : "NOT_ACCEPTABLE";
    case "losses":
      return !number(value)
        ? "UNKNOWN"
        : value === 100e3
          ? "BOUNDARY_REVIEW"
          : value > 100e3
            ? "NOT_ACCEPTABLE"
            : "ACCEPTABLE";
  }
}
export function evaluate(facts: Facts, now = new Date()): Decision {
  const criteria = keys.map((key) => {
    const fact = facts[key];
    let observed = fact?.value;
    if (key === "construction") observed = constructionPercent(observed);
    if (key === "losses")
      observed = fiveYearLoss(observed, facts.effectiveDate?.value);
    const verified = !!fact?.evidence.some((e) => e.verified);
    const status: Status =
      fact?.contradicted ||
      (key === "losses" && facts.effectiveDate?.contradicted)
        ? "CONTRADICTED"
        : !verified ||
            (key === "losses" &&
              !facts.effectiveDate?.evidence.some((e) => e.verified))
          ? "UNKNOWN"
          : classify(key, observed);
    return {
      key,
      status,
      weight: weights[key],
      points: weights[key] * multipliers[status],
      observed: observed ?? null,
      evidenceIds: fact?.evidence.map((e) => e.id) ?? [],
      clauseId: `property.${key}.2025`,
      explanation: `${key}: ${status}`,
    };
  });
  const appetiteScore = criteria.reduce((n, c) => n + c.points, 0);
  const completenessScore =
    (["accountName", "effectiveDate", "expirationDate", ...keys].filter((k) => {
      const f = facts[k as keyof Facts];
      return (
        f &&
        !f.contradicted &&
        f.value != null &&
        f.evidence.some((e) => e.verified) &&
        (!keys.includes(k as CriterionKey) ||
          criteria.find((c) => c.key === k)?.status !== "UNKNOWN")
      );
    }).length /
      11) *
    100;
  const p = facts.premium?.value;
  // Product choice (TDD leaves normalization unspecified): linear shoulders around the target band.
  const opportunityScore =
    !number(p) || p < 50e3 || p > 175e3
      ? 0
      : p < 75e3
        ? 80 + ((p - 50e3) / 25e3) * 20
        : p <= 100e3
          ? 100
          : 100 - ((p - 100e3) / 75e3) * 20;
  const dates = Object.values(facts)
    .flatMap(
      (f) =>
        f?.evidence
          .filter((e) => e.verified)
          .map((e) => Date.parse(e.observedAt)) ?? [],
    )
    .filter(Number.isFinite);
  const freshnessScore = dates.length
    ? Math.max(
        0,
        100 -
          (Math.max(0, now.getTime() - Math.min(...dates)) / 864e5) *
            (100 / 90),
      )
    : 0;
  const recommendation = criteria.some((c) => c.status === "NOT_ACCEPTABLE")
    ? "OUT_OF_APPETITE"
    : criteria.some((c) =>
          ["UNKNOWN", "CONTRADICTED", "BOUNDARY_REVIEW"].includes(c.status),
        )
      ? "INVESTIGATE"
      : "IN_APPETITE";
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    class: recommendation,
    appetiteScore: round(appetiteScore),
    priorityScore: round(
      0.7 * appetiteScore +
        0.15 * completenessScore +
        0.1 * opportunityScore +
        0.05 * freshnessScore,
    ),
    completenessScore: round(completenessScore),
    opportunityScore,
    freshnessScore: round(freshnessScore),
    confidence: round(completenessScore / 100),
    criteria,
    assumptions: [
      "Construction weighted by building TIV; missing building TIV makes mix unknown.",
      "Loss window: [effective date minus five calendar years, effective date). Complete loss history required.",
      "Verified policy TIV takes precedence; otherwise sum complete building TIVs.",
      "Controlling building year is the oldest known year; all building years required.",
      "Opportunity uses linear target-band shoulders; freshness decays over 90 days using oldest supporting evidence.",
    ],
  };
}
const descriptions: Record<CriterionKey, string> = {
  submissionType:
    "Confirm new business; a renewal cannot be relabeled to satisfy appetite.",
  lineOfBusiness:
    "Confirm property line; refer other lines to a suitable product.",
  primaryState:
    "Confirm the actual primary risk state; do not change location to pass appetite.",
  tiv: "Verify TIV is at most $150,000,000; any coverage change requires human review.",
  premium:
    "Verify premium within $50,000–$175,000; nearest acceptable threshold applies only to a genuine quote change.",
  buildingYear: "Provide evidence of controlling building year after 1990.",
  construction:
    "Confirm more than 50% of insured value is acceptable construction.",
  losses:
    "Provide complete five-year loss runs showing less than $100,000 incurred.",
};
export function pathToYes(decision: Decision) {
  return decision.criteria
    .filter((c) => !["TARGET", "ACCEPTABLE"].includes(c.status))
    .map((c) => ({
      criterion: c.key,
      action:
        c.status === "NOT_ACCEPTABLE" ? "VERIFY_OR_REFER" : "REQUEST_EVIDENCE",
      description: descriptions[c.key],
      nearestAcceptableValue:
        c.key === "premium" && number(c.observed)
          ? Math.max(50e3, Math.min(175e3, c.observed))
          : c.key === "tiv"
            ? 150e6
            : c.key === "buildingYear"
              ? 1991
              : null,
    }));
}
export function simulate(
  original: Facts,
  changes: Partial<Record<keyof Facts, unknown>>,
  conditions: string[] = [],
  now = new Date(),
) {
  const facts = structuredClone(original);
  for (const [key, value] of Object.entries(changes)) {
    if (!Object.hasOwn(Facts.shape, key))
      throw new Error("Unknown simulation field");
    facts[key as keyof Facts] = {
      value,
      contradicted: false,
      evidence: [
        {
          id: `simulation:${key}`,
          source: "human",
          path: key,
          observedAt: now.toISOString(),
          verified: true,
        },
      ],
    };
  }
  const decision = evaluate(facts, now);
  if (decision.class === "IN_APPETITE" && conditions.length)
    decision.class = "ACCEPT_WITH_CONDITIONS";
  return {
    label: "SIMULATION" as const,
    changes,
    conditions,
    decision,
    pathToYes: pathToYes(decision),
    changedCriteria: decision.criteria
      .filter(
        (c) =>
          c.status !==
          evaluate(original, now).criteria.find((o) => o.key === c.key)?.status,
      )
      .map((c) => c.key),
  };
}
export function compareCases(
  a: { id: string; decision: Decision },
  b: { id: string; decision: Decision },
): number {
  const lane = {
    IN_APPETITE: 0,
    ACCEPT_WITH_CONDITIONS: 0,
    INVESTIGATE: 1,
    OUT_OF_APPETITE: 2,
  };
  return (
    lane[a.decision.class] - lane[b.decision.class] ||
    (a.decision.class === "INVESTIGATE"
      ? b.decision.opportunityScore - a.decision.opportunityScore ||
        pathToYes(a.decision).length - pathToYes(b.decision).length
      : 0) ||
    b.decision.priorityScore - a.decision.priorityScore ||
    a.id.localeCompare(b.id)
  );
}
