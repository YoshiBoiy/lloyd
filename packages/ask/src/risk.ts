import { constructionPercent, fiveYearLoss } from "../../engine/src/index.js";
import type { CaseRecord } from "../../integrations/src/data.js";
import type { Filters } from "./contracts.js";
// risk-v1: categories are ordinal navigation encodings, never decision scores.
export const RISK_PARAMETERS = {
  version: "risk-v1",
  submissionType: ["new_business", "renewal"],
  lineOfBusiness: ["property", "casualty"],
  states: [
    "OH",
    "PA",
    "MD",
    "CO",
    "CA",
    "FL",
    "NC",
    "SC",
    "GA",
    "VA",
    "UT",
    "NY",
  ],
  tivScale: 200e6,
  premiumScale: 200e3,
  yearOrigin: 1900,
  yearScale: 150,
  lossScale: 200e3,
};
export function riskProfile(c: CaseRecord) {
  const f = c.facts,
    p = RISK_PARAMETERS;
  const category = (v: unknown, values: string[]) =>
    typeof v === "string" && values.includes(v)
      ? (values.indexOf(v) + 1) / values.length
      : undefined;
  const numeric = (v: unknown, scale: number, origin = 0) =>
    typeof v === "number" && Number.isFinite(v)
      ? (v - origin) / scale
      : undefined;
  const names = [
    "submissionType",
    "lineOfBusiness",
    "primaryState",
    "tiv",
    "premium",
    "buildingYear",
    "construction",
    "losses",
  ];
  const raw = [
    category(f.submissionType?.value, p.submissionType),
    category(f.lineOfBusiness?.value, p.lineOfBusiness),
    category(f.primaryState?.value, p.states),
    numeric(f.tiv?.value, p.tivScale),
    numeric(f.premium?.value, p.premiumScale),
    numeric(f.buildingYear?.value, p.yearScale, p.yearOrigin),
    constructionPercent(f.construction?.value),
    numeric(fiveYearLoss(f.losses?.value, f.effectiveDate?.value), p.lossScale),
  ];
  return {
    version: p.version,
    vector: raw.map((x, i) =>
      f[names[i] as keyof typeof f]?.contradicted ? -1 : (x ?? -1),
    ),
    missingDimensions: names.filter(
      (_, i) =>
        raw[i] === undefined || f[names[i] as keyof typeof f]?.contradicted,
    ),
  };
}
export function matchesFilters(c: CaseRecord, f: Filters) {
  const inRange = (value: unknown, r?: { min?: number; max?: number }) =>
    !r ||
    (typeof value === "number" &&
      (r.min === undefined || value >= r.min) &&
      (r.max === undefined || value <= r.max));
  return (
    (!f.caseId || f.caseId === c.id) &&
    (!f.finalDecision || f.finalDecision.includes(c.decision.class)) &&
    (!f.state || c.facts.primaryState?.value === f.state) &&
    (!f.lineOfBusiness || c.facts.lineOfBusiness?.value === f.lineOfBusiness) &&
    (!f.submissionType || c.facts.submissionType?.value === f.submissionType) &&
    inRange(c.facts.premium?.value, f.premium) &&
    inRange(c.facts.tiv?.value, f.tiv) &&
    inRange(c.facts.buildingYear?.value, f.buildingYear) &&
    inRange(
      fiveYearLoss(c.facts.losses?.value, c.facts.effectiveDate?.value),
      f.losses,
    ) &&
    inRange(c.decision.completenessScore, f.completeness) &&
    inRange(c.decision.confidence, f.confidence) &&
    (!f.constructionStatus ||
      c.decision.criteria.some(
        (x) => x.key === "construction" && x.status === f.constructionStatus,
      )) &&
    (!f.criterionState ||
      c.decision.criteria.some((x) => x.status === f.criterionState)) &&
    (!f.after || c.updatedAt >= f.after) &&
    (!f.before || c.updatedAt <= f.before) &&
    (f.humanApproved === undefined ||
      Boolean(c.humanApproved) === f.humanApproved)
  );
}
