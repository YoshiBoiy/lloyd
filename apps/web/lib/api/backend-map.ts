import type {
  ActivityItem,
  AnalyticsSummary,
  AppetiteCriterion,
  CaseDetail,
  CaseDocument,
  CaseListFilters,
  CaseListResponse,
  CaseStage,
  CaseSummary,
  CriterionFactor,
  DecisionClass,
  EvidenceLabel,
  GuidelineClause,
  InvestigationStep,
  NormalizedFact,
  PathToYesStep,
  SimilarCase,
} from "./types";

export const CRITERION_FACTOR: Record<string, CriterionFactor> = {
  submissionType: "submission_type",
  lineOfBusiness: "line_of_business",
  primaryState: "primary_state",
  tiv: "tiv",
  premium: "premium",
  buildingYear: "building_year",
  construction: "construction_mix",
  losses: "five_year_loss_value",
};

const FACTOR_LABEL: Record<CriterionFactor, string> = {
  submission_type: "Submission type",
  line_of_business: "Line of business",
  primary_state: "Primary risk state",
  tiv: "TIV",
  premium: "Premium",
  building_year: "Building year",
  construction_mix: "Construction mix",
  five_year_loss_value: "Five-year losses",
};

const TOOL_MAP: Record<string, InvestigationStep["tool"]> = {
  inspect_schema: "openai_plan",
  query_federato: "federato_query",
  search_elastic_evidence: "elastic_search",
  find_atlas_precedents: "atlas_precedents",
  evaluate_appetite: "evaluate_appetite",
  extract_document_with_gemini: "gemini_extract",
  scan_authorship_with_gptzero: "gptzero_authorship",
  check_claim_support_with_gptzero: "gptzero_claims",
  draft_information_request: "openai_plan",
  openai_plan: "openai_plan",
  federato_query: "federato_query",
  gemini_extract: "gemini_extract",
  elastic_search: "elastic_search",
  atlas_precedents: "atlas_precedents",
  gptzero_authorship: "gptzero_authorship",
  gptzero_claims: "gptzero_claims",
};

const SPONSOR: Record<InvestigationStep["tool"], string> = {
  openai_plan: "OpenAI",
  federato_query: "Federato",
  gemini_extract: "Gemini",
  elastic_search: "Elasticsearch",
  atlas_precedents: "MongoDB Atlas",
  gptzero_authorship: "GPTZero",
  gptzero_claims: "GPTZero",
  evaluate_appetite: "Appetite engine",
};

export interface WireFact {
  value?: unknown;
  contradicted?: boolean;
  evidence?: { id: string; source: string; path: string; observedAt: string; verified: boolean }[];
}

export interface WireCriterion {
  key: string;
  status: AppetiteCriterion["status"];
  weight: number;
  points: number;
  observed: unknown;
  evidenceIds: string[];
  clauseId: string;
  explanation: string;
}

export interface WireDecision {
  class: DecisionClass;
  appetiteScore: number;
  priorityScore: number;
  completenessScore: number;
  confidence: number;
  criteria: WireCriterion[];
  assumptions?: string[];
}

export interface WireListItem {
  id: string;
  version?: number;
  updatedAt?: string;
  account?: { name?: string | null };
  normalizedRisk?: { primaryState?: string | null; tiv?: number | null; premium?: number | null };
  decision: WireDecision;
  mode?: string;
}

export interface WireCaseRecord {
  id: string;
  version: number;
  updatedAt: string;
  mode?: string;
  facts: Record<string, WireFact | undefined>;
  decision: WireDecision;
}

export interface WirePathToYes {
  criterion: string;
  action: string;
  description: string;
}

export interface WireStep {
  sequence?: number;
  tool: string;
  reason?: string;
  status?: string;
  resultCount?: number;
  at?: string;
  resultSummary?: string;
}

export interface WirePrecedent {
  id: string;
  score: number;
  decision: DecisionClass;
  humanApproved?: boolean;
  sharedFactors: string[];
  materialDifferences: string[];
  accountName?: string;
}

const APPETITE_CLAUSES: Omit<GuidelineClause, "affectedSubmissionIds">[] = [
  {
    clauseId: "property.submission_type.acceptable.2025",
    factor: "submission_type",
    classification: "ACCEPTABLE",
    version: "2025",
    effectiveDate: "2025-01-01",
    originalLanguage: "New business is acceptable. Renewal business is not acceptable.",
    structuredRule: "submission_type == new_business → ACCEPTABLE; renewal → NOT_ACCEPTABLE",
    exceptions: [],
    sourceDocument: "APPETITE_GUIDELINES.pdf",
    sourcePassage: "Submission type — Acceptable: New business. Not acceptable: Renewal business.",
  },
  {
    clauseId: "property.lob.acceptable.2025",
    factor: "line_of_business",
    classification: "ACCEPTABLE",
    version: "2025",
    effectiveDate: "2025-01-01",
    originalLanguage: "Commercial property is acceptable. Any other line of business is not acceptable.",
    structuredRule: "line_of_business == property → ACCEPTABLE; else NOT_ACCEPTABLE",
    exceptions: [],
    sourceDocument: "APPETITE_GUIDELINES.pdf",
    sourcePassage: "Line of business — Acceptable: Property.",
  },
  {
    clauseId: "property.state.target.2025",
    factor: "primary_state",
    classification: "TARGET",
    version: "2025",
    effectiveDate: "2025-01-01",
    originalLanguage: "Target states are Ohio, Pennsylvania, Maryland, Colorado, California, and Florida.",
    structuredRule: "primary_state ∈ {OH, PA, MD, CO, CA, FL} → TARGET",
    exceptions: ["NC, SC, GA, VA, UT remain acceptable rather than target."],
    sourceDocument: "APPETITE_GUIDELINES.pdf",
    sourcePassage: "Primary risk state — Target: OH, PA, MD, CO, CA, FL.",
  },
  {
    clauseId: "property.state.acceptable.2025",
    factor: "primary_state",
    classification: "ACCEPTABLE",
    version: "2025",
    effectiveDate: "2025-01-01",
    originalLanguage: "North Carolina, South Carolina, Georgia, Virginia, and Utah are acceptable.",
    structuredRule: "primary_state ∈ {NC, SC, GA, VA, UT} → ACCEPTABLE",
    exceptions: [],
    sourceDocument: "APPETITE_GUIDELINES.pdf",
    sourcePassage: "Primary risk state — Acceptable: OH, PA, MD, CO, CA, FL, NC, SC, GA, VA, UT.",
  },
  {
    clauseId: "property.tiv.2025",
    factor: "tiv",
    classification: "TARGET",
    version: "2025",
    effectiveDate: "2025-01-01",
    originalLanguage: "Target TIV is $50 million through $100 million. Values up to $150 million are acceptable. Above $150 million is not acceptable.",
    structuredRule: "50e6 ≤ tiv ≤ 100e6 → TARGET; tiv ≤ 150e6 → ACCEPTABLE; else NOT_ACCEPTABLE",
    exceptions: ["Product ranges that say “up to” are inclusive."],
    sourceDocument: "APPETITE_GUIDELINES.pdf",
    sourcePassage: "TIV — Target: $50M–$100M. Acceptable: up to $150M. Not acceptable: over $150M.",
  },
  {
    clauseId: "property.total_premium.acceptable.2025",
    factor: "premium",
    classification: "ACCEPTABLE",
    version: "2025",
    effectiveDate: "2025-01-01",
    originalLanguage: "Total premium from $50,000 through $175,000 is acceptable. Target is $75,000 through $100,000.",
    structuredRule: "75000 ≤ premium ≤ 100000 → TARGET; 50000 ≤ premium ≤ 175000 → ACCEPTABLE",
    exceptions: [],
    sourceDocument: "APPETITE_GUIDELINES.pdf",
    sourcePassage: "Total premium from $50,000 through $175,000 is acceptable.",
  },
  {
    clauseId: "property.building_year.2025",
    factor: "building_year",
    classification: "TARGET",
    version: "2025",
    effectiveDate: "2025-01-01",
    originalLanguage: "Buildings newer than 2010 are target. Newer than 1990 is acceptable. Older than 1990 is not acceptable. 1990 is a documented boundary.",
    structuredRule: "year > 2010 → TARGET; year > 1990 → ACCEPTABLE; year == 1990 → BOUNDARY_REVIEW; year < 1990 → NOT_ACCEPTABLE",
    exceptions: ["Year 1990 is BOUNDARY_REVIEW, not a favorable interpretation."],
    sourceDocument: "APPETITE_GUIDELINES.pdf",
    sourcePassage: "Building age — Target: newer than 2010. Acceptable: newer than 1990. Not acceptable: older than 1990.",
  },
  {
    clauseId: "property.construction.2025",
    factor: "construction_mix",
    classification: "ACCEPTABLE",
    version: "2025",
    effectiveDate: "2025-01-01",
    originalLanguage: "More than 50% of TIV must be joisted masonry, non-combustible/steel, or masonry non-combustible.",
    structuredRule: "acceptable_construction_pct_by_tiv > 0.50 → ACCEPTABLE; == 0.50 → BOUNDARY_REVIEW",
    exceptions: ["Missing TIV on a building prevents a confident construction-weight calculation."],
    sourceDocument: "APPETITE_GUIDELINES.pdf",
    sourcePassage: "Construction — Acceptable: more than 50% joisted masonry, non-combustible/steel, or masonry non-combustible.",
  },
  {
    clauseId: "property.five_year_loss.2025",
    factor: "five_year_loss_value",
    classification: "ACCEPTABLE",
    version: "2025",
    effectiveDate: "2025-01-01",
    originalLanguage: "Five-year loss value under $100,000 is acceptable. Over $100,000 is not acceptable. Exactly $100,000 is a documented boundary.",
    structuredRule: "loss < 100000 → ACCEPTABLE; loss == 100000 → BOUNDARY_REVIEW; loss > 100000 → NOT_ACCEPTABLE",
    exceptions: ["$100,000 is BOUNDARY_REVIEW."],
    sourceDocument: "APPETITE_GUIDELINES.pdf",
    sourcePassage: "Five-year loss value — Acceptable: under $100K. Not acceptable: over $100K.",
  },
];

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function str(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function criterionObserved(item: WireListItem | WireCaseRecord, key: string): unknown {
  const hit = item.decision.criteria.find((c) => c.key === key);
  return hit?.observed;
}

export function stageFor(decision: DecisionClass): CaseStage {
  if (decision === "IN_APPETITE" || decision === "ACCEPT_WITH_CONDITIONS") return "READY_TO_QUOTE";
  if (decision === "INVESTIGATE" || decision === "OUT_OF_APPETITE") return "NEEDS_REVIEW";
  return "NEW";
}

export function mapListItem(item: WireListItem): CaseSummary {
  const submission = str(criterionObserved(item, "submissionType")) || "new_business";
  const lob = str(criterionObserved(item, "lineOfBusiness")) || "property";
  return {
    id: item.id,
    accountName: item.account?.name?.trim() || "Untitled submission",
    submissionType: submission === "renewal" ? "renewal" : "new_business",
    lineOfBusiness: lob || "property",
    state: item.normalizedRisk?.primaryState || str(criterionObserved(item, "primaryState")) || "—",
    premium: item.normalizedRisk?.premium ?? num(criterionObserved(item, "premium")),
    tiv: item.normalizedRisk?.tiv ?? num(criterionObserved(item, "tiv")),
    broker: "—",
    assignee: "—",
    decision: item.decision.class,
    appetiteScore: item.decision.appetiteScore,
    priorityScore: item.decision.priorityScore,
    completeness: item.decision.completenessScore,
    confidence: item.decision.confidence,
    stage: stageFor(item.decision.class),
    decisiveFactors: item.decision.criteria.filter((c) => !["TARGET", "ACCEPTABLE"].includes(c.status)).map((c) => c.key),
    updatedAt: item.updatedAt || new Date(0).toISOString(),
    isDemo: false,
  };
}

export function applyCaseFilters(cases: CaseSummary[], filters: CaseListFilters = {}): CaseSummary[] {
  const q = filters.search?.trim().toLowerCase();
  return cases.filter((item) => {
    if (q && ![item.accountName, item.broker, item.state, item.id].join(" ").toLowerCase().includes(q)) return false;
    if (filters.state && item.state !== filters.state) return false;
    if (filters.decision && item.decision !== filters.decision) return false;
    if (filters.assignee && item.assignee !== filters.assignee) return false;
    if (filters.stage && item.stage !== filters.stage) return false;
    return true;
  });
}

export function summarizeCases(cases: CaseSummary[]): CaseListResponse {
  return {
    cases,
    totals: {
      all: cases.length,
      new: cases.filter((c) => c.stage === "NEW").length,
      investigating: cases.filter((c) => c.stage === "INVESTIGATING").length,
      needsReview: cases.filter((c) => c.stage === "NEEDS_REVIEW").length,
      readyToQuote: cases.filter((c) => c.stage === "READY_TO_QUOTE").length,
    },
    lanes: {
      inAppetite: cases.filter((c) => c.decision === "IN_APPETITE" || c.decision === "ACCEPT_WITH_CONDITIONS").length,
      investigate: cases.filter((c) => c.decision === "INVESTIGATE").length,
      outOfAppetite: cases.filter((c) => c.decision === "OUT_OF_APPETITE").length,
    },
  };
}

function formatObserved(value: unknown, factor: CriterionFactor): string {
  if (Array.isArray(value)) return `${value.length} building${value.length === 1 ? "" : "s"}`;
  if (factor === "tiv" || factor === "premium" || factor === "five_year_loss_value") {
    const n = num(value);
    return n ? `$${n.toLocaleString("en-US")}` : "Unknown";
  }
  if (factor === "construction_mix") {
    const n = num(value);
    return n ? `${Math.round(n * 100)}% acceptable construction` : "Unknown";
  }
  if (factor === "line_of_business") return str(value).replaceAll("_", " ");
  if (factor === "submission_type") return str(value).replaceAll("_", " ");
  return str(value);
}

export function mapCriteria(decision: WireDecision, facts: Record<string, WireFact | undefined> = {}): AppetiteCriterion[] {
  return decision.criteria.map((c) => {
    const factor = CRITERION_FACTOR[c.key] ?? "submission_type";
    const fact = facts[c.key];
    const evidence = (fact?.evidence ?? []).map((e) => ({
      source: (e.source === "federato" ? "federato" : e.source === "gemini" ? "gemini" : "federato") as NormalizedFact["provenance"][number]["source"],
      path: e.path,
      observedAt: e.observedAt,
    }));
    return {
      factor,
      label: FACTOR_LABEL[factor],
      observed: formatObserved(c.observed, factor),
      status: c.status,
      evidenceLabel: fact?.contradicted ? "CONTRADICTED" : fact?.evidence?.some((e) => e.verified) ? "VERIFIED" : "INFERRED",
      weight: c.weight,
      contribution: c.points,
      ruleId: c.clauseId,
      ruleText: c.explanation,
      evidence,
    };
  });
}

export function mapFacts(id: string, facts: Record<string, WireFact | undefined>): NormalizedFact[] {
  const labels: Record<string, string> = {
    accountName: "Account",
    effectiveDate: "Effective",
    expirationDate: "Expiration",
    submissionType: "Submission type",
    lineOfBusiness: "Line of business",
    primaryState: "Primary state",
    tiv: "TIV",
    premium: "Premium",
    buildingYear: "Building year",
    construction: "Construction",
    losses: "Losses",
  };
  return Object.entries(facts)
    .filter(([, fact]) => fact && fact.value != null)
    .map(([key, fact]) => {
      const verified = !!fact?.evidence?.some((e) => e.verified);
      const labelStatus: EvidenceLabel = fact?.contradicted ? "CONTRADICTED" : verified ? "VERIFIED" : "INFERRED";
      return {
        id: `${id}:${key}`,
        label: labels[key] ?? key,
        path: key,
        value: formatObserved(fact!.value, CRITERION_FACTOR[key] ?? "submission_type"),
        rawValue: (typeof fact!.value === "string" || typeof fact!.value === "number" || typeof fact!.value === "boolean" || fact!.value == null
          ? fact!.value
          : JSON.stringify(fact!.value)) as string | number | boolean | null,
        labelStatus,
        provenance: (fact!.evidence ?? []).map((e) => ({
          source: (e.source === "human" ? "human" : e.source === "gemini" ? "gemini" : "federato") as NormalizedFact["provenance"][number]["source"],
          path: e.path,
          observedAt: e.observedAt,
        })),
      };
    });
}

export function mapPathToYes(rows: WirePathToYes[] = []): PathToYesStep[] {
  return rows.map((row) => ({
    action: row.action === "VERIFY_OR_REFER" ? "CONFIRM_DISCLOSURE" : "REQUEST_EVIDENCE",
    description: row.description,
    criterion: CRITERION_FACTOR[row.criterion],
  }));
}

export function mapInvestigationSteps(steps: WireStep[] = []): InvestigationStep[] {
  return steps.map((step, index) => {
    const tool = TOOL_MAP[step.tool] ?? "evaluate_appetite";
    const status = step.status === "completed" || step.status === "skipped" || step.status === "running" || step.status === "pending" ? step.status : "completed";
    return {
      sequence: step.sequence ?? index + 1,
      tool,
      sponsorLabel: SPONSOR[tool],
      reason: step.reason || "Investigation step",
      status,
      resultSummary: step.resultSummary ?? (step.resultCount != null ? `${step.resultCount} result(s)` : undefined),
      completedAt: step.at,
    };
  });
}

export function mapPrecedents(matches: WirePrecedent[] = [], names: Record<string, string> = {}): SimilarCase[] {
  return matches.map((item) => ({
    caseId: item.id,
    accountName: item.accountName || names[item.id] || item.id,
    similarity: item.score,
    sharedFactors: item.sharedFactors.map((k) => FACTOR_LABEL[CRITERION_FACTOR[k] ?? "submission_type"] ?? k),
    materialDifferences: item.materialDifferences.map((k) => FACTOR_LABEL[CRITERION_FACTOR[k] ?? "submission_type"] ?? k),
    historicalDecision: item.decision,
    humanApprovedRationale: item.humanApproved ? "Human-approved neighbor" : "Nearest neighbor by risk vector — advisory only",
    humanApproved: !!item.humanApproved,
  }));
}

export function mapCaseDetail(
  record: WireCaseRecord,
  pathToYes: WirePathToYes[] = [],
  extras: {
    steps?: WireStep[];
    precedents?: WirePrecedent[];
    names?: Record<string, string>;
    documents?: CaseDocument[];
  } = {},
): CaseDetail {
  const documents = [...(extras.documents ?? [])].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const summary = mapListItem({
    id: record.id,
    version: record.version,
    updatedAt: record.updatedAt,
    account: { name: str(record.facts.accountName?.value) || null },
    normalizedRisk: {
      primaryState: str(record.facts.primaryState?.value) || null,
      tiv: num(record.facts.tiv?.value) || null,
      premium: num(record.facts.premium?.value) || null,
    },
    decision: record.decision,
  });
  const facts = mapFacts(record.id, record.facts);
  const criteria = mapCriteria(record.decision, record.facts);
  const year = record.facts.buildingYear?.value;
  const construction = record.facts.construction?.value;
  const losses = record.decision.criteria.find((c) => c.key === "losses")?.observed;
  return {
    ...summary,
    effectiveDate: str(record.facts.effectiveDate?.value),
    expirationDate: str(record.facts.expirationDate?.value),
    buildingYear: typeof year === "number" ? year : null,
    acceptableConstructionPctByTiv: typeof construction === "number" ? construction : null,
    fiveYearLossValue: typeof losses === "number" ? losses : null,
    facts,
    criteria,
    explanation:
      record.decision.assumptions?.join(" ") ||
      `${summary.accountName} is ${summary.decision.replaceAll("_", " ").toLowerCase()} at appetite score ${Math.round(summary.appetiteScore)}.`,
    pathToYes: mapPathToYes(pathToYes),
    evidence: facts.flatMap((fact) =>
      fact.provenance.map((p, i) => ({
        evidenceId: `${fact.id}:${i}`,
        title: fact.label,
        text: fact.value,
        sourceType: p.source,
        sourceUri: p.path ?? fact.path,
        verificationStatus: fact.labelStatus,
        observedAt: p.observedAt,
        reliability: fact.labelStatus === "VERIFIED" ? 0.9 : 0.5,
      })),
    ),
    activity: [],
    notes: [],
    similarCases: mapPrecedents(extras.precedents, extras.names),
    investigation: {
      id: extras.steps?.length ? "latest" : null,
      status: extras.steps?.length ? "completed" : "not_started",
      steps: mapInvestigationSteps(extras.steps),
    },
    authenticity: null,
    override: null,
    simulation: false,
    version: record.version,
    documents,
  };
}

export function mapGuidelines(cases: CaseSummary[], query = ""): GuidelineClause[] {
  const q = query.trim().toLowerCase();
  const clauses = APPETITE_CLAUSES.map((clause) => {
    const affected = cases
      .filter((item) => {
        if (clause.factor === "submission_type") return item.submissionType === "renewal";
        if (clause.factor === "line_of_business") return item.lineOfBusiness !== "property";
        if (clause.clauseId.includes("state.target")) return ["OH", "PA", "MD", "CO", "CA", "FL"].includes(item.state);
        if (clause.clauseId.includes("state.acceptable")) return ["NC", "SC", "GA", "VA", "UT"].includes(item.state);
        if (clause.factor === "tiv") return item.tiv > 150_000_000;
        if (clause.factor === "premium") return item.premium < 50_000 || item.premium > 175_000;
        if (clause.factor === "building_year") return false;
        if (clause.factor === "construction_mix") return false;
        if (clause.factor === "five_year_loss_value") return false;
        return false;
      })
      .map((item) => item.id)
      .slice(0, 8);
    return { ...clause, affectedSubmissionIds: affected };
  });
  if (!q) return clauses;
  return clauses.filter((clause) =>
    [clause.originalLanguage, clause.factor, clause.sourcePassage, clause.structuredRule].join(" ").toLowerCase().includes(q),
  );
}

export function mapActivity(cases: CaseSummary[]): ActivityItem[] {
  return [...cases]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 12)
    .map((item) => ({
      id: `activity:${item.id}`,
      at: item.updatedAt,
      actor: "Lloyd",
      summary: `${item.accountName} · ${item.decision.replaceAll("_", " ")}`,
      kind: "system" as const,
    }));
}

export function mapAnalytics(
  telemetry: {
    status?: string;
    mode?: string;
    total?: number;
    failures?: number;
    averageDurationMs?: number;
    hourly?: {
      hour: string;
      ingested?: number | string;
      investigated?: number | string;
      p50_ms?: number | string;
      p95_ms?: number | string;
      throughput?: number | string;
      average_duration_ms?: number | string;
      failures?: number | string;
      failure_rate?: number | string;
      releases?: number | string;
      redaction_count?: number | string;
      human_overrides?: number | string;
      human_override_rate?: number | string;
    }[];
  },
  cases: CaseSummary[] = [],
): AnalyticsSummary {
  const hourly = telemetry.hourly ?? [];
  const outcomes: DecisionClass[] = ["IN_APPETITE", "ACCEPT_WITH_CONDITIONS", "INVESTIGATE", "OUT_OF_APPETITE"];
  const live = telemetry.mode === "live";
  const events = hourly.reduce((n, row) => n + num(row.throughput ?? row.ingested), 0);
  const overrides = hourly.reduce((n, row) => n + num(row.human_overrides), 0);
  const released = hourly.reduce((n, row) => n + num(row.releases), 0);
  const redacted = hourly.reduce((n, row) => n + num(row.redaction_count), 0);
  return {
    generatedAt: new Date().toISOString(),
    source: live ? "tiger_data_continuous_aggregates" : "case_store",
    disclaimer: live
      ? "Operational telemetry from Tiger Data. This page never shows raw documents, prompts, OCR bodies, or token maps."
      : "Live appetite outcomes from the case store. Hourly telemetry appears once Tiger Data is connected.",
    throughput: hourly.map((row) => {
      const volume = num(row.throughput ?? row.ingested);
      return {
        hour: String(row.hour),
        ingested: num(row.ingested) || volume,
        investigated: num(row.investigated) || volume,
      };
    }),
    investigationLatency: hourly.map((row) => {
      const duration = num(row.average_duration_ms);
      return {
        hour: String(row.hour),
        p50Ms: num(row.p50_ms) || duration,
        p95Ms: num(row.p95_ms) || duration,
      };
    }),
    sensitiveFieldsRedacted: redacted ? [{ type: "redacted", count: redacted }] : [],
    cloudRequestsAvoided: 0,
    cloudRequestsReleased: released,
    referralRate: cases.length ? cases.filter((c) => c.decision === "INVESTIGATE").length / cases.length : 0,
    appetiteOutcomes: outcomes.map((decision) => ({ decision, count: cases.filter((c) => c.decision === decision).length })),
    frequentlyFailedRules: [],
    humanOverrideRate: events ? overrides / events : 0,
    ocrRedactionConfidence: [],
  };
}
