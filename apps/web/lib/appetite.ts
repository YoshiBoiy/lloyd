import type { CriterionStatus, DecisionClass, CriterionFactor, AppetiteCriterion } from "./api/types";

export const CRITERION_WEIGHTS: Record<CriterionFactor, number> = {
  submission_type: 10,
  line_of_business: 15,
  primary_state: 10,
  tiv: 15,
  premium: 15,
  building_year: 10,
  construction_mix: 10,
  five_year_loss_value: 15,
};

export const STATUS_MULTIPLIER: Record<CriterionStatus, number> = {
  TARGET: 1,
  ACCEPTABLE: 0.8,
  BOUNDARY_REVIEW: 0.45,
  UNKNOWN: 0.35,
  CONTRADICTED: 0.2,
  NOT_ACCEPTABLE: 0,
};

const TARGET_STATES = new Set(["OH", "PA", "MD", "CO", "CA", "FL"]);
const ACCEPTABLE_STATES = new Set(["OH", "PA", "MD", "CO", "CA", "FL", "NC", "SC", "GA", "VA", "UT"]);

export function classifySubmissionType(value: string | null): CriterionStatus {
  if (!value) return "UNKNOWN";
  if (value === "renewal") return "NOT_ACCEPTABLE";
  if (value === "new_business") return "ACCEPTABLE";
  return "UNKNOWN";
}

export function classifyLineOfBusiness(value: string | null): CriterionStatus {
  if (!value) return "UNKNOWN";
  return value.toLowerCase() === "property" ? "ACCEPTABLE" : "NOT_ACCEPTABLE";
}

export function classifyState(value: string | null): CriterionStatus {
  if (!value) return "UNKNOWN";
  if (TARGET_STATES.has(value)) return "TARGET";
  if (ACCEPTABLE_STATES.has(value)) return "ACCEPTABLE";
  return "NOT_ACCEPTABLE";
}

export function classifyTiv(value: number | null): CriterionStatus {
  if (value === null || Number.isNaN(value)) return "UNKNOWN";
  if (value > 150_000_000) return "NOT_ACCEPTABLE";
  if (value >= 50_000_000 && value <= 100_000_000) return "TARGET";
  if (value <= 150_000_000) return "ACCEPTABLE";
  return "NOT_ACCEPTABLE";
}

export function classifyPremium(value: number | null): CriterionStatus {
  if (value === null || Number.isNaN(value)) return "UNKNOWN";
  if (value < 50_000 || value > 175_000) return "NOT_ACCEPTABLE";
  if (value >= 75_000 && value <= 100_000) return "TARGET";
  return "ACCEPTABLE";
}

export function classifyBuildingYear(value: number | null): CriterionStatus {
  if (value === null || Number.isNaN(value)) return "UNKNOWN";
  if (value === 1990) return "BOUNDARY_REVIEW";
  if (value < 1990) return "NOT_ACCEPTABLE";
  if (value > 2010) return "TARGET";
  return "ACCEPTABLE";
}

export function classifyConstructionMix(pct: number | null): CriterionStatus {
  if (pct === null || Number.isNaN(pct)) return "UNKNOWN";
  if (pct === 0.5) return "BOUNDARY_REVIEW";
  if (pct > 0.5) return "ACCEPTABLE";
  return "NOT_ACCEPTABLE";
}

export function classifyFiveYearLoss(value: number | null): CriterionStatus {
  if (value === null || Number.isNaN(value)) return "UNKNOWN";
  if (value === 100_000) return "BOUNDARY_REVIEW";
  if (value > 100_000) return "NOT_ACCEPTABLE";
  return "ACCEPTABLE";
}

export function decideClass(
  criteria: Pick<AppetiteCriterion, "status">[],
  options?: { conditionsRemain?: boolean },
): DecisionClass {
  const statuses = criteria.map((c) => c.status);
  if (statuses.includes("NOT_ACCEPTABLE")) return "OUT_OF_APPETITE";
  if (
    statuses.includes("UNKNOWN") ||
    statuses.includes("CONTRADICTED") ||
    statuses.includes("BOUNDARY_REVIEW")
  ) {
    return "INVESTIGATE";
  }
  if (options?.conditionsRemain) return "ACCEPT_WITH_CONDITIONS";
  return "IN_APPETITE";
}

export function appetiteScore(criteria: Pick<AppetiteCriterion, "factor" | "status">[]): number {
  return criteria.reduce((sum, criterion) => {
    const weight = CRITERION_WEIGHTS[criterion.factor];
    return sum + weight * STATUS_MULTIPLIER[criterion.status];
  }, 0);
}

export function completenessScore(
  criteria: Pick<AppetiteCriterion, "status">[],
): number {
  if (criteria.length === 0) return 0;
  const verified = criteria.filter(
    (c) => c.status === "TARGET" || c.status === "ACCEPTABLE" || c.status === "NOT_ACCEPTABLE",
  ).length;
  return (verified / criteria.length) * 100;
}

export function opportunityScore(premium: number | null): number {
  if (premium === null) return 0;
  if (premium >= 75_000 && premium <= 100_000) return 100;
  if (premium >= 50_000 && premium <= 175_000) return 80;
  return 20;
}

export function priorityScore(input: {
  appetite: number;
  completeness: number;
  opportunity: number;
  freshness: number;
}): number {
  return (
    0.7 * input.appetite +
    0.15 * input.completeness +
    0.1 * input.opportunity +
    0.05 * input.freshness
  );
}
