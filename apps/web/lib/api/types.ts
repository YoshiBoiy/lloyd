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
  /** Scanned documents attached to this case, newest first. A case may hold several. */
  documents: CaseDocument[];
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
  source: "tiger_data_continuous_aggregates" | "case_store";
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

export interface ManifestField {
  path: string;
  classification: PrivacyClassification;
  confidence: number;
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
  /**
   * Live RDK X5 capture only. The gateway never returns raw pixels or
   * unredacted OCR text — only `originalText` (already sanitized) and this
   * capture metadata. Undefined when running against `MockLloydApi`'s
   * synthetic text fixture, which has no notion of a captured media type.
   */
  source?: "camera" | "fixture" | "upload";
  mediaType?: "text/plain" | "image/png" | "image/jpeg";
  sourceHash?: string;
  /**
   * Live-mode redaction detections. Unlike the mock's character-offset
   * `spans`, the real gateway's manifest fields are path-labeled and
   * deterministic (server-computed at `/redact` time) — they cannot be
   * individually toggled through the wire contract, so the UI renders them
   * read-only instead of as interactive checkboxes.
   */
  manifestFields?: ManifestField[];
}

export interface OutboundPayload {
  destinations: CloudDestination[];
  gemini: Record<string, unknown>;
  openai: Record<string, unknown>;
  gptzero: Record<string, unknown>;
}

export const MIN_RELEASE_CONFIDENCE = 0.95;

/** Backend view of an accepted v2 release (sanitized text only), awaiting or holding a case association. */
export interface IntakeInboxItem {
  intakeId: string;
  documentId: string;
  tenantId: string;
  deviceId: string;
  revision: number;
  digest: string;
  receivedAt: string;
  status: "AWAITING_ASSOCIATION" | "PROCESSING" | "PROCESSED" | "PROCESSED_WITH_WARNINGS";
  association: { caseId: string; source: string; actorId: string; reason: string; at: string } | null;
  classification: { status: string; documentType: string; confidence: number; modelId: string; calibration: string };
  matchHints: { documentType: string; riskState?: string; lineOfBusiness?: string; yearRange?: [number, number]; tivBucket?: string };
  quality: { status: string; reasons: string[]; policyVersion: string; pageCount: number };
  approval: { reviewerId: string; approvedAt: string; expiresAt: string; acknowledgedQuality: boolean };
  destinations: string[];
  fields: { path: string; classification: string; method: string; confidence: number }[];
  artifacts: { id: string; mediaType: string; text: string }[];
  processing: Record<string, unknown>;
  audit: { at: string; actorId: string; action: string; detail?: string }[];
  supersedes: { revision: number; digest: string } | null;
}
export type IntakeStatusValue = IntakeInboxItem["status"];

/** One operator queue in the intake workspace. Membership is defined by who must act next. */
export type IntakeTab =
  | "ready"
  | "processing"
  | "privacy_review"
  | "unmatched"
  | "attached"
  | "failed";

/** Bounded, content-free record of a release the backend refused (workspace TDD §7.1). */
export interface IntakeRejection {
  at: string;
  tenantId: string;
  deviceId: string;
  intakeId: string;
  revision: number;
  identity: string;
  code: string;
  /** False when the failure was a signature or device rejection, so the identity is only claimed. */
  verified: boolean;
}

/**
 * One row of the merged queue. Device and backend rows for the same `intakeId` collapse into a
 * single item; an item may legitimately exist in one domain only (a released-but-rejected
 * intake exists on the device and not in the inbox).
 */
export interface IntakeWorkItem {
  intakeId: string;
  origin: "device" | "backend" | "both";
  tab: IntakeTab;
  /** Device stage, when the gateway answered for this intake. */
  stage?: string;
  /** Backend status, when the inbox holds this intake. */
  status?: IntakeStatusValue;
  revision: number;
  reviewRisk: string[];
  riskProvisional: boolean;
  caseId: string | null;
  documentType: string;
  pageCount: number;
  deviceId: string | null;
  qualityStatus: string | null;
  /** When an approved-but-unreleased intake's signature lapses and the revision reopens. */
  approvalExpiresAt: string | null;
  releaseError: string | null;
  rejection: IntakeRejection | null;
  /** Providers that reported UNAVAILABLE or REJECTED on an attached document. */
  warnings: string[];
  updatedAt: string;
}

export interface IntakeWorkResult {
  items: IntakeWorkItem[];
  /** `null` means the domain owning that tab did not answer; the UI renders unknown, never zero. */
  counts: Record<IntakeTab, number | null>;
  /** Counts of what is actually known, for tabs whose other domain is silent. */
  knownCounts: Record<IntakeTab, number>;
  deviceReachable: boolean;
  backendReachable: boolean;
  /** Short explanation for a silent domain: refused, not configured, or simply unreachable. */
  deviceReason: string | null;
  backendReason: string | null;
}

/** One document attached to a case; a case may hold several (workspace TDD §8). */
export interface CaseDocument {
  intakeId: string;
  documentId: string;
  revision: number;
  digest: string;
  /** Local classification, unverified. */
  documentType: string;
  /** Provider confirmation; disagreements with the local label are preserved, never merged. */
  providerDocumentType?: string;
  pageCount: number;
  receivedAt: string;
  attachedAt: string;
  attachedBy: string;
  associationSource: "PRESELECTED" | "REVIEWER" | "CARRIED_FORWARD";
  status: IntakeStatusValue;
  supersedesRevision?: number;
}

export interface IntakeCandidate {
  caseId: string;
  accountName: string | null;
  score: number;
  reasons: string[];
  decision: string;
}
export interface IntakeCandidatesResponse {
  intakeId: string;
  revision: number;
  candidates: IntakeCandidate[];
  /** False means the hints cannot rank at all — different from ranking and matching nothing. */
  sufficientHints: boolean;
  /** When this ranking was recorded, so Unmatched has memory rather than a fresh guess. */
  rankedAt?: string;
  /** When the release arrived, so the operator can see how long it has waited for a case. */
  waitingSince?: string;
}

export interface LloydApi {
  /** Backend inbox of accepted v2 releases; requires a reviewer identity on the backend. */
  listIntakes(): Promise<IntakeInboxItem[]>;
  /**
   * The merged operator queue across the device and the backend. Assembled in the browser,
   * because only the browser legitimately sees both domains (workspace TDD §3).
   */
  listIntakeWork(filter?: { tab?: IntakeTab }): Promise<IntakeWorkResult>;
  /** Documents attached to a case, newest first. */
  getCaseDocuments(caseId: string): Promise<CaseDocument[]>;
  /** Retransmit the same approved envelope after a transport failure; nothing is recomputed. */
  retryIntakeRelease(intakeId: string): Promise<IntakeWorkItem>;
  /** Re-run cloud processing for an attached document whose providers were unavailable. */
  retryIntakeProcessing(intakeId: string): Promise<IntakeWorkItem>;
  getIntakeCandidates(intakeId: string): Promise<IntakeCandidatesResponse>;
  associateIntake(intakeId: string, caseId: string, reason: string): Promise<IntakeInboxItem>;
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
  /**
   * Intake is scoped to the case the document will be attached to. Only the
   * entry points that start a document take a `caseId`; the stages after
   * capture operate on whatever document that adapter instance has in flight.
   */
  getIntake(caseId: string): Promise<IntakeDocument>;
  captureIntake(caseId: string): Promise<IntakeDocument>;
  rescanIntake(caseId: string): Promise<IntakeDocument>;
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
