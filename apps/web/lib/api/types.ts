/**
 * Frontend-facing Lloyd contracts.
 *
 * Temporary duplicates of the TDD API surface and privacy manifest shapes.
 * Replace with `@lloyd/contracts` (and generated OpenAPI types) during the
 * integration pass. See INTEGRATION.md.
 */

export type DecisionClass =
  | "IN_APPETITE"
  | "INVESTIGATE"
  | "OUT_OF_APPETITE"
  | "ACCEPT_WITH_CONDITIONS";

export type CriterionStatus =
  | "TARGET"
  | "ACCEPTABLE"
  | "NOT_ACCEPTABLE"
  | "UNKNOWN"
  | "CONTRADICTED"
  | "BOUNDARY_REVIEW";

export type EvidenceLabel =
  | "VERIFIED"
  | "INFERRED"
  | "CONTRADICTED"
  | "UNKNOWN"
  | "STALE";

export type CaseStage = "NEW" | "INVESTIGATING" | "NEEDS_REVIEW" | "READY_TO_QUOTE";

export type PrivacyClassification =
  | "LOCAL_ONLY"
  | "REDACTED"
  | "TOKENIZED"
  | "GENERALIZED"
  | "CLOUD_ALLOWED";

export type SensitiveFieldType =
  | "person_name"
  | "email"
  | "phone"
  | "policy_number"
  | "government_id"
  | "signature";

export type CloudDestination = "gemini" | "openai" | "gptzero";

export type CriterionFactor =
  | "submission_type"
  | "line_of_business"
  | "primary_state"
  | "tiv"
  | "premium"
  | "building_year"
  | "construction_mix"
  | "five_year_loss_value";

export interface ProvenancePointer {
  source: "federato" | "gemini" | "elasticsearch" | "atlas" | "gptzero" | "broker" | "rdk" | "human";
  resource?: string;
  path?: string;
  queryId?: string;
  evidenceId?: string;
  observedAt: string;
  note?: string;
}

export interface NormalizedFact {
  id: string;
  label: string;
  path: string;
  value: string;
  rawValue: string | number | boolean | null;
  unit?: string;
  labelStatus: EvidenceLabel;
  provenance: ProvenancePointer[];
}

export interface AppetiteCriterion {
  factor: CriterionFactor;
  label: string;
  observed: string;
  status: CriterionStatus;
  evidenceLabel: EvidenceLabel;
  weight: number;
  contribution: number;
  ruleId: string;
  ruleText: string;
  evidence: ProvenancePointer[];
  querySummary?: string;
}

export interface PathToYesStep {
  action: "REQUEST_EVIDENCE" | "CONFIRM_DISCLOSURE" | "OPERATIONAL_CONDITION";
  description: string;
  criterion?: CriterionFactor;
}

export interface SimilarCase {
  caseId: string;
  accountName: string;
  similarity: number;
  sharedFactors: string[];
  materialDifferences: string[];
  historicalDecision: DecisionClass;
  humanApprovedRationale: string;
  humanApproved: boolean;
}

export interface EvidenceItem {
  evidenceId: string;
  title: string;
  text: string;
  sourceType: string;
  sourceUri: string;
  verificationStatus: EvidenceLabel;
  observedAt: string;
  reliability: number;
}

export interface ActivityItem {
  id: string;
  at: string;
  actor: string;
  summary: string;
  kind: "system" | "human" | "broker" | "agent";
}

export interface HumanNote {
  id: string;
  at: string;
  author: string;
  body: string;
}

export interface InvestigationStep {
  sequence: number;
  tool:
    | "openai_plan"
    | "federato_query"
    | "gemini_extract"
    | "elastic_search"
    | "atlas_precedents"
    | "gptzero_authorship"
    | "gptzero_claims"
    | "evaluate_appetite";
  sponsorLabel: string;
  reason: string;
  status: "pending" | "running" | "completed" | "skipped";
  resultSummary?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface AuthenticityFinding {
  documentId: string;
  contentHash: string;
  classification: string;
  score: number;
  highlightedPassage: string;
  applicablePolicy: string;
  policyVersion: string;
  outcome: "CLEAR" | "AUTHENTICITY_REVIEW" | "UNAVAILABLE";
  scannedAt: string;
  unsupportedClaimWarning?: string;
  reviewState: "open" | "verified" | "attestation_requested" | "excluded" | "escalated";
}

export interface CaseSummary {
  id: string;
  accountName: string;
  submissionType: "new_business" | "renewal";
  lineOfBusiness: string;
  state: string;
  premium: number;
  tiv: number;
  broker: string;
  assignee: string;
  decision: DecisionClass;
  appetiteScore: number;
  priorityScore: number;
  completeness: number;
  confidence: number;
  stage: CaseStage;
  decisiveFactors: string[];
  updatedAt: string;
  isDemo: boolean;
}

export interface CaseDetail extends CaseSummary {
  effectiveDate: string;
  expirationDate: string;
  buildingYear: number | null;
  acceptableConstructionPctByTiv: number | null;
  fiveYearLossValue: number | null;
  facts: NormalizedFact[];
  criteria: AppetiteCriterion[];
  explanation: string;
  pathToYes: PathToYesStep[];
  evidence: EvidenceItem[];
  activity: ActivityItem[];
  notes: HumanNote[];
  similarCases: SimilarCase[];
  investigation: {
    id: string | null;
    status: "not_started" | "running" | "completed";
    steps: InvestigationStep[];
    stopReason?: string;
  };
  authenticity: AuthenticityFinding | null;
  override: { reason: string; at: string; author: string } | null;
  simulation: boolean;
  version: number;
  intakeDocumentId?: string;
}

export interface CaseListFilters {
  search?: string;
  state?: string;
  decision?: DecisionClass | "";
  assignee?: string;
  stage?: CaseStage | "";
}

export interface CaseListResponse {
  cases: CaseSummary[];
  totals: {
    all: number;
    new: number;
    investigating: number;
    needsReview: number;
    readyToQuote: number;
  };
  lanes: {
    inAppetite: number;
    investigate: number;
    outOfAppetite: number;
  };
}

export interface GuidelineClause {
  clauseId: string;
  factor: string;
  classification: CriterionStatus | "EXCEPTION";
  version: string;
  effectiveDate: string;
  originalLanguage: string;
  structuredRule: string;
  exceptions: string[];
  sourceDocument: string;
  sourcePassage: string;
  affectedSubmissionIds: string[];
}

export interface AnalyticsSummary {
  generatedAt: string;
  source: "tiger_data_continuous_aggregates";
  disclaimer: string;
  throughput: { hour: string; ingested: number; investigated: number }[];
  investigationLatency: { hour: string; p50Ms: number; p95Ms: number }[];
  sensitiveFieldsRedacted: { type: string; count: number }[];
  cloudRequestsAvoided: number;
  cloudRequestsReleased: number;
  referralRate: number;
  appetiteOutcomes: { decision: DecisionClass; count: number }[];
  frequentlyFailedRules: { rule: string; failures: number }[];
  humanOverrideRate: number;
  ocrRedactionConfidence: { hour: string; ocr: number; redaction: number }[];
}

export interface RedactionSpan {
  id: string;
  type: SensitiveFieldType;
  classification: PrivacyClassification;
  text: string;
  replacement: string;
  start: number;
  end: number;
  enabled: boolean;
  required: boolean;
}

export interface QualityMetrics {
  blur: number;
  glare: number;
  framing: number;
  ocrConfidence: number;
}

export type IntakeStage =
  | "idle"
  | "preview"
  | "captured"
  | "ocr"
  | "detect"
  | "redact"
  | "review"
  | "released";

export interface ReleaseManifest {
  documentId: string;
  caseId: string;
  sourceHash: string;
  sanitizedHash: string;
  classifications: {
    redacted: string[];
    tokenized: string[];
    generalized: string[];
    cloudAllowed: string[];
    localOnly: string[];
  };
  destinations: Record<CloudDestination, string[]>;
  redactionConfidence: number;
  approvedBy: string | null;
  approvedAt: string | null;
  localRetentionUntil: string;
}

export interface IntakeDocument {
  documentId: string;
  caseId: string;
  title: string;
  originalText: string;
  spans: RedactionSpan[];
  quality: QualityMetrics;
  stage: IntakeStage;
  redactionConfidence: number;
  manifest: ReleaseManifest | null;
  released: boolean;
  approved: boolean;
}

export interface OutboundPayload {
  destinations: CloudDestination[];
  gemini: Record<string, unknown>;
  openai: Record<string, unknown>;
  gptzero: Record<string, unknown>;
}

export const MIN_RELEASE_CONFIDENCE = 0.95;

export interface LloydApi {
  listCases(filters?: CaseListFilters): Promise<CaseListResponse>;
  getCase(id: string): Promise<CaseDetail>;
  investigate(id: string, onStep?: (step: InvestigationStep) => void): Promise<CaseDetail>;
  applyBrokerResponse(id: string): Promise<CaseDetail>;
  recalculate(id: string): Promise<CaseDetail>;
  draftInformationRequest(id: string): Promise<{ id: string; questions: string[]; rationale: string[] }>;
  recordOverride(id: string, reason: string): Promise<CaseDetail>;
  addNote(id: string, body: string): Promise<CaseDetail>;
  updateAuthenticity(
    id: string,
    reviewState: AuthenticityFinding["reviewState"],
  ): Promise<CaseDetail>;
  listGuidelines(query?: string): Promise<GuidelineClause[]>;
  getAnalytics(): Promise<AnalyticsSummary>;
  getActivity(): Promise<ActivityItem[]>;
  getIntake(): Promise<IntakeDocument>;
  captureIntake(): Promise<IntakeDocument>;
  rescanIntake(): Promise<IntakeDocument>;
  advanceIntakeProcessing(): Promise<IntakeDocument>;
  toggleRedaction(spanId: string, enabled: boolean): Promise<IntakeDocument>;
  addManualRedaction(start: number, end: number, type: SensitiveFieldType): Promise<IntakeDocument>;
  approveAndRelease(input: {
    destinations: CloudDestination[];
    approvedBy: string;
    acceptLowConfidence: boolean;
  }): Promise<{ document: IntakeDocument; payload: OutboundPayload }>;
  resetDemo(): Promise<void>;
  setLatency(ms: number): void;
  getLatency(): number;
}

export function sanitizedText(original: string, spans: RedactionSpan[]): string {
  const enabled = spans
    .filter((span) => span.enabled)
    .sort((a, b) => b.start - a.start);
  let text = original;
  for (const span of enabled) {
    text = text.slice(0, span.start) + span.replacement + text.slice(span.end);
  }
  return text;
}

export function containsSensitiveLeak(text: string, originalSpans: RedactionSpan[]): boolean {
  return originalSpans
    .filter((span) => span.required)
    .some((span) => text.includes(span.text));
}
