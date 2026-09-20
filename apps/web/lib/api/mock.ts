import type {
  ActivityItem,
  CaseDetail,
  CaseDocument,
  CaseListFilters,
  CaseListResponse,
  CloudDestination,
  IntakeCandidate,
  IntakeCandidatesResponse,
  IntakeDocument,
  IntakeInboxItem,
  IntakeRejection,
  IntakeTab,
  IntakeWorkItem,
  IntakeWorkResult,
  InvestigationStep,
  LloydApi,
  OutboundPayload,
  SensitiveFieldType,
} from "./types";
import {
  MIN_RELEASE_CONFIDENCE,
  containsSensitiveLeak,
  sanitizedText,
} from "./types";
import { mergeIntakeWork, type DeviceIntakeRow } from "./intake-work";
import { sha256Lite } from "../format";
import {
  LANE_ORDER,
  buildSeedRisks,
  detailFromRisk,
  summarize,
  type SeedRisk,
} from "../fixtures/cases";
import { GUIDELINE_CLAUSES } from "../fixtures/guidelines";
import { createAnalytics } from "../fixtures/analytics";
import { DEMO_INVESTIGATION_STEPS } from "../fixtures/investigation";
import {
  DEFAULT_DESTINATIONS,
  DEMO_CASE_ID,
  buildSourceHash,
  computeRedactionConfidence,
  createIntakeDocument,
} from "../fixtures/intake";

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** One unassigned release in the demo inbox: a scanned inspection report whose hints point at Pennsylvania mid-size property risks. */
const SEED_INBOX_ITEM: IntakeInboxItem = {
  intakeId: "0f6a9d8e-3c21-4f6b-9a3e-7d2c1b0a5e44",
  documentId: "5c1e2a74-8b9f-4d3a-a6e1-2f7b9c0d4e11",
  tenantId: "tenant-demo",
  deviceId: "rdk-x5-demo",
  revision: 2,
  digest: "9b2f0c4e7a1d3f5b8c6e0a2d4f6b8c0e1a3d5f7b9c1e3a5d7f9b1c3e5a7d9f1b",
  receivedAt: "2026-09-19T15:02:11.000Z",
  status: "AWAITING_ASSOCIATION",
  association: null,
  classification: { status: "CLASSIFIED", documentType: "inspection_report", confidence: 0.91, modelId: "local-text-v1", calibration: "UNCALIBRATED" },
  matchHints: { documentType: "inspection_report", riskState: "PA", lineOfBusiness: "property", yearRange: [2010, 2019], tivBucket: "10m_100m" },
  quality: { status: "REVIEW", reasons: ["UNCALIBRATED_POLICY"], policyVersion: "quality-v2-provisional", pageCount: 2 },
  approval: { reviewerId: "reviewer-demo", approvedAt: "2026-09-19T15:01:40.000Z", expiresAt: "2026-09-19T15:11:40.000Z", acknowledgedQuality: true },
  destinations: ["lloyd-api", "gemini", "elasticsearch"],
  fields: [
    { path: "field_0.person_name", classification: "redacted", method: "deterministic-pattern-v1", confidence: 0.99 },
    { path: "field_1.address", classification: "redacted", method: "local-semantic-v1", confidence: 0.86 },
  ],
  artifacts: [
    { id: "p1_line_0", mediaType: "text/plain", text: "Property inspection report" },
    { id: "p1_line_1", mediaType: "text/plain", text: "Contact: [TOKEN_4f2a9c1e8b7d6a5f3c2e1d0b9a8c7e6f]" },
    { id: "p1_line_2", mediaType: "text/plain", text: "Year built: 2016   Construction: masonry noncombustible" },
    { id: "p1_line_3", mediaType: "text/plain", text: "Primary risk state: PA   TIV: 72,000,000 USD" },
    { id: "p2_line_0", mediaType: "text/plain", text: "Sprinkler system inoperable in the east wing; roof shows moderate ponding." },
  ],
  processing: {},
  audit: [{ at: "2026-09-19T15:02:11.000Z", actorId: "rdk-x5-demo", action: "RELEASE_ACCEPTED", detail: "revision 2" }],
  supersedes: { revision: 1, digest: "1a3d5f7b9c1e3a5d7f9b1c3e5a7d9f1b9b2f0c4e7a1d3f5b8c6e0a2d4f6b8c0e" },
};

/**
 * Synthetic device rows so the demo and the tests exercise all six tabs — including Failed and
 * the device-only queues — with no RDK X5 attached. These stand in for `GET /v2/intakes`; the
 * live adapter merges the real thing.
 */
const SEED_DEVICE_ROWS: DeviceIntakeRow[] = [
  {
    intakeId: "7c3d9b1a-5e42-4f8c-9d01-6a2b3c4d5e60",
    documentId: "8d4e0c2b-6f53-4a9d-8e12-7b3c4d5e6f71",
    revision: 1,
    stage: "PREPROCESSED",
    caseId: null,
    pageCount: 1,
    quality: { status: "PASS", reasons: [] },
    classification: null,
    matchHints: null,
    reviewRisk: { reasons: [], policyVersion: "review-risk-v1-provisional", provisional: true },
    approvalExpiresAt: null,
    releaseError: null,
    updatedAt: "2026-09-19T15:20:00.000Z",
    retentionUntil: "2026-09-20T15:20:00.000Z",
    originalDeleted: false,
  },
  {
    intakeId: "1b2c3d4e-5f60-4712-8834-95a6b7c8d9e0",
    documentId: "2c3d4e5f-6071-4823-8945-a6b7c8d9e0f1",
    revision: 2,
    stage: "RECAPTURE_REQUIRED",
    caseId: null,
    pageCount: 2,
    quality: { status: "RECAPTURE", reasons: ["BLUR", "CLIPPED_PAGE"] },
    classification: null,
    matchHints: null,
    reviewRisk: { reasons: [], policyVersion: "review-risk-v1-provisional", provisional: true },
    approvalExpiresAt: null,
    releaseError: null,
    updatedAt: "2026-09-19T15:18:00.000Z",
    retentionUntil: "2026-09-20T15:18:00.000Z",
    originalDeleted: false,
  },
  {
    intakeId: "3d4e5f60-7182-4934-8a56-b7c8d9e0f1a2",
    documentId: "4e5f6071-8293-4a45-8b67-c8d9e0f1a2b3",
    revision: 3,
    stage: "ANALYZED",
    caseId: null,
    pageCount: 1,
    quality: { status: "REVIEW", reasons: ["UNCALIBRATED_POLICY"] },
    classification: { status: "CLASSIFIED", documentType: "loss_run", confidence: 0.88, calibration: "UNCALIBRATED", modelId: "local-text-v1" },
    matchHints: null,
    reviewRisk: { reasons: [], policyVersion: "review-risk-v1-provisional", provisional: true },
    approvalExpiresAt: null,
    releaseError: null,
    updatedAt: "2026-09-19T15:16:00.000Z",
    retentionUntil: "2026-09-20T15:16:00.000Z",
    originalDeleted: false,
  },
  {
    intakeId: "5f607182-93a4-4b56-8c78-d9e0f1a2b3c4",
    documentId: "60718293-a4b5-4c67-8d89-e0f1a2b3c4d5",
    revision: 4,
    stage: "REVIEW_READY",
    caseId: null,
    pageCount: 3,
    quality: { status: "REVIEW", reasons: ["UNCALIBRATED_POLICY"] },
    classification: { status: "ABSTAINED", documentType: "unknown", confidence: 0.41, calibration: "UNCALIBRATED", modelId: "local-text-v1" },
    matchHints: { documentType: "unknown" },
    reviewRisk: {
      reasons: ["CLASSIFIER_ABSTAINED", "INSUFFICIENT_HINTS", "QUALITY_REVIEW", "SEMANTIC_ONLY_DETECTIONS"],
      policyVersion: "review-risk-v1-provisional",
      provisional: true,
    },
    approvalExpiresAt: null,
    releaseError: null,
    updatedAt: "2026-09-19T15:14:00.000Z",
    retentionUntil: "2026-09-20T15:14:00.000Z",
    originalDeleted: false,
  },
  {
    // Approved but not released: waiting on a person to release it, and the signature lapses.
    intakeId: "93a4b5c6-d7e8-49fa-8bcd-e0f1a2b3c4d5",
    documentId: "a4b5c6d7-e8f9-4a0b-8cde-f1a2b3c4d5e6",
    revision: 1,
    stage: "APPROVED",
    caseId: "demo-001",
    pageCount: 2,
    quality: { status: "PASS", reasons: [] },
    classification: { status: "CLASSIFIED", documentType: "loss_run", confidence: 0.94, calibration: "UNCALIBRATED", modelId: "local-text-v1" },
    matchHints: { documentType: "loss_run", riskState: "PA", tivBucket: "10m_100m" },
    reviewRisk: { reasons: [], policyVersion: "review-risk-v1-provisional", provisional: true },
    approvalExpiresAt: "2026-09-19T15:25:00.000Z",
    releaseError: null,
    updatedAt: "2026-09-19T15:15:00.000Z",
    retentionUntil: "2026-09-20T15:15:00.000Z",
    originalDeleted: false,
  },
  {
    intakeId: "718293a4-b5c6-4d78-8e9a-f1a2b3c4d5e6",
    documentId: "8293a4b5-c6d7-4e89-8fab-a2b3c4d5e6f7",
    revision: 2,
    stage: "RELEASE_FAILED",
    caseId: "demo-002",
    pageCount: 2,
    quality: { status: "REVIEW", reasons: ["UNCALIBRATED_POLICY"] },
    classification: { status: "CLASSIFIED", documentType: "statement_of_values", confidence: 0.93, calibration: "UNCALIBRATED", modelId: "local-text-v1" },
    matchHints: { documentType: "statement_of_values", riskState: "OH", tivBucket: "10m_100m" },
    reviewRisk: { reasons: ["QUALITY_REVIEW"], policyVersion: "review-risk-v1-provisional", provisional: true },
    approvalExpiresAt: null,
    releaseError: "TRANSPORT",
    updatedAt: "2026-09-19T15:12:00.000Z",
    retentionUntil: "2026-09-20T15:12:00.000Z",
    originalDeleted: false,
  },
  {
    // Released and accepted: the backend row below decides which queue this lands in.
    intakeId: SEED_INBOX_ITEM.intakeId,
    documentId: SEED_INBOX_ITEM.documentId,
    revision: SEED_INBOX_ITEM.revision,
    stage: "ACCEPTED",
    caseId: null,
    pageCount: 2,
    quality: { status: "REVIEW", reasons: ["UNCALIBRATED_POLICY"] },
    classification: { status: "CLASSIFIED", documentType: "inspection_report", confidence: 0.91, calibration: "UNCALIBRATED", modelId: "local-text-v1" },
    matchHints: SEED_INBOX_ITEM.matchHints,
    reviewRisk: { reasons: ["QUALITY_REVIEW"], policyVersion: "review-risk-v1-provisional", provisional: true },
    approvalExpiresAt: null,
    releaseError: null,
    updatedAt: SEED_INBOX_ITEM.receivedAt,
    retentionUntil: "2026-09-20T15:02:11.000Z",
    originalDeleted: false,
  },
];

/** One refused release, so `Failed` has a cloud-side row with no device row beside it. */
const SEED_REJECTION: IntakeRejection = {
  at: "2026-09-19T14:58:03.000Z",
  tenantId: "tenant-demo",
  deviceId: "rdk-x5-demo",
  intakeId: "9a8b7c6d-5e4f-4312-8201-fedcba987654",
  revision: 1,
  identity: "c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5",
  code: "DEVICE_DENIED",
  verified: false,
};

function wait(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MockLloydApi implements LloydApi {
  private cases = new Map<string, CaseDetail>();
  private risks = new Map<string, SeedRisk>();
  private intake: IntakeDocument = createIntakeDocument();
  private inbox = new Map<string, IntakeInboxItem>();
  private deviceRows: DeviceIntakeRow[] = [];
  private rejections: IntakeRejection[] = [];
  private deviceReachable = true;
  private activity: ActivityItem[] = [
    {
      id: "live-1",
      at: "2026-09-19T14:12:00.000Z",
      actor: "Queue watcher",
      summary: "52 commercial property submissions ranked from Federato ingest.",
      kind: "system",
    },
  ];
  private analyticsReleased = 11;
  private analyticsAvoided = 37;
  private latencyMs: number;
  private listeners = new Set<() => void>();

  constructor(options?: { latencyMs?: number }) {
    this.latencyMs = options?.latencyMs ?? 160;
    this.seed();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setLatency(ms: number): void {
    this.latencyMs = Math.max(0, ms);
  }

  getLatency(): number {
    return this.latencyMs;
  }

  async resetDemo(): Promise<void> {
    this.seed();
    this.notify();
  }

  async listCases(filters: CaseListFilters = {}): Promise<CaseListResponse> {
    await wait(this.latencyMs);
    let cases = [...this.cases.values()].map(summarize);
    if (filters.search) {
      const q = filters.search.toLowerCase();
      cases = cases.filter(
        (item) =>
          item.accountName.toLowerCase().includes(q) ||
          item.broker.toLowerCase().includes(q) ||
          item.id.toLowerCase().includes(q) ||
          item.state.toLowerCase().includes(q),
      );
    }
    if (filters.state) cases = cases.filter((item) => item.state === filters.state);
    if (filters.decision) cases = cases.filter((item) => item.decision === filters.decision);
    if (filters.assignee) cases = cases.filter((item) => item.assignee === filters.assignee);
    if (filters.stage) cases = cases.filter((item) => item.stage === filters.stage);

    cases.sort((a, b) => {
      const lane = LANE_ORDER[a.decision] - LANE_ORDER[b.decision];
      if (lane !== 0) return lane;
      return b.priorityScore - a.priorityScore;
    });

    const all = [...this.cases.values()];
    return {
      cases,
      totals: {
        all: all.length,
        new: all.filter((item) => item.stage === "NEW").length,
        investigating: all.filter((item) => item.stage === "INVESTIGATING").length,
        needsReview: all.filter((item) => item.stage === "NEEDS_REVIEW").length,
        readyToQuote: all.filter((item) => item.stage === "READY_TO_QUOTE").length,
      },
      lanes: {
        inAppetite: all.filter((item) => item.decision === "IN_APPETITE" || item.decision === "ACCEPT_WITH_CONDITIONS").length,
        investigate: all.filter((item) => item.decision === "INVESTIGATE").length,
        outOfAppetite: all.filter((item) => item.decision === "OUT_OF_APPETITE").length,
      },
    };
  }

  async getCase(id: string): Promise<CaseDetail> {
    await wait(this.latencyMs);
    const found = this.cases.get(id);
    if (!found) throw new Error(`Case not found: ${id}`);
    return clone(found);
  }

  async investigate(id: string, onStep?: (step: InvestigationStep) => void): Promise<CaseDetail> {
    const current = this.require(id);
    current.investigation.status = "running";
    current.investigation.id = `inv:${id}:1`;
    current.investigation.steps = [];
    current.stage = "INVESTIGATING";
    this.pushActivity("RiskGraph", `Investigation started for ${current.accountName}.`, "agent");
    this.notify();

    const now = new Date("2026-09-19T14:26:00.000Z").getTime();
    for (const [index, template] of DEMO_INVESTIGATION_STEPS.entries()) {
      const step: InvestigationStep = {
        ...template,
        status: "running",
        startedAt: new Date(now + index * 1000).toISOString(),
      };
      current.investigation.steps.push(step);
      this.notify();
      onStep?.(clone(step));
      await wait(this.latencyMs);
      step.status = "completed";
      step.completedAt = new Date(now + index * 1000 + 400).toISOString();
      this.notify();
      onStep?.(clone(step));
    }

    const risk = this.requireRisk(id);
    const next = detailFromRisk(risk, current.isDemo ? "investigated" : "investigated");
    next.investigation = {
      id: current.investigation.id,
      status: "completed",
      steps: current.investigation.steps,
      stopReason: "material_gaps_require_review",
    };
    next.activity = [
      ...current.activity,
      {
        id: `act:${id}:investigated`,
        at: "2026-09-19T14:27:00.000Z",
        actor: "OpenAI planner",
        summary: "Bounded investigation completed. Case moved to Investigate.",
        kind: "agent",
      },
    ];
    next.notes = current.notes;
    next.override = current.override;
    this.cases.set(id, next);
    this.pushActivity("Appetite engine", `${next.accountName} is now ${next.decision}.`, "system");
    this.notify();
    return clone(next);
  }

  async applyBrokerResponse(id: string): Promise<CaseDetail> {
    await wait(this.latencyMs);
    const current = this.require(id);
    if (current.investigation.status !== "completed") {
      throw new Error("Broker response requires a completed investigation.");
    }
    const risk = this.requireRisk(id);
    const next = detailFromRisk(risk, "resolved");
    next.investigation = current.investigation;
    next.activity = [
      ...current.activity,
      {
        id: `act:${id}:broker`,
        at: "2026-09-19T14:31:00.000Z",
        actor: "Marsh (simulated)",
        summary: "Loss runs $24,000; leased shed excluded; AI narrative assistance disclosed.",
        kind: "broker",
      },
    ];
    next.notes = current.notes;
    next.override = current.override;
    next.simulation = true;
    next.facts = next.facts.map((fact) =>
      fact.id === "fact-construction"
        ? {
            ...fact,
            value: "82% masonry NC of covered TIV",
            labelStatus: "VERIFIED",
            provenance: [
              ...fact.provenance,
              { source: "broker", observedAt: "2026-09-19T14:31:00.000Z", note: "Simulated broker response" },
            ],
          }
        : fact,
    );
    this.cases.set(id, next);
    this.pushActivity("Broker desk", `Simulated response applied to ${next.accountName}.`, "broker");
    this.notify();
    return clone(next);
  }

  async recalculate(id: string): Promise<CaseDetail> {
    await wait(this.latencyMs);
    const current = this.require(id);
    current.version += 1;
    current.updatedAt = "2026-09-19T14:32:00.000Z";
    current.simulation = true;
    current.activity.push({
      id: `act:${id}:recalc-${current.version}`,
      at: current.updatedAt,
      actor: "Appetite engine",
      summary: `Recalculated to ${current.decision}. Only affected rules were re-run.`,
      kind: "system",
    });
    this.pushActivity("Appetite engine", `Recalculated ${current.accountName} → ${current.decision}.`, "system");
    this.notify();
    return clone(current);
  }

  async draftInformationRequest(id: string): Promise<{ id: string; questions: string[]; rationale: string[] }> {
    await wait(this.latencyMs);
    const current = this.require(id);
    const questions = current.pathToYes
      .filter((step) => step.action === "REQUEST_EVIDENCE" || step.action === "CONFIRM_DISCLOSURE")
      .map((step) => step.description);
    const draft = {
      id: `act_req_${id}`,
      questions: questions.length > 0 ? questions : ["Please confirm any remaining outstanding underwriting items."],
      rationale: current.criteria
        .filter((item) => item.status === "UNKNOWN" || item.status === "CONTRADICTED" || item.status === "BOUNDARY_REVIEW")
        .map((item) => item.factor),
    };
    current.activity.push({
      id: `act:${id}:draft`,
      at: "2026-09-19T14:33:00.000Z",
      actor: "A. Chen",
      summary: "Drafted broker information request. Not sent.",
      kind: "human",
    });
    this.notify();
    return draft;
  }

  async recordOverride(id: string, reason: string): Promise<CaseDetail> {
    await wait(this.latencyMs);
    if (!reason.trim()) throw new Error("Override reason is required.");
    const current = this.require(id);
    current.override = {
      reason: reason.trim(),
      at: "2026-09-19T14:34:00.000Z",
      author: "A. Chen",
    };
    current.activity.push({
      id: `act:${id}:override`,
      at: current.override.at,
      actor: "A. Chen",
      summary: `Human override recorded. Original recommendation ${current.decision} retained.`,
      kind: "human",
    });
    this.notify();
    return clone(current);
  }

  async addNote(id: string, body: string): Promise<CaseDetail> {
    await wait(this.latencyMs);
    const current = this.require(id);
    current.notes.push({
      id: `note:${id}:${current.notes.length + 1}`,
      at: "2026-09-19T14:35:00.000Z",
      author: "A. Chen",
      body,
    });
    this.notify();
    return clone(current);
  }

  async updateAuthenticity(
    id: string,
    reviewState: NonNullable<CaseDetail["authenticity"]>["reviewState"],
  ): Promise<CaseDetail> {
    await wait(this.latencyMs);
    const current = this.require(id);
    if (!current.authenticity) throw new Error("No authenticity finding on this case.");
    current.authenticity = { ...current.authenticity, reviewState };
    current.activity.push({
      id: `act:${id}:auth-${reviewState}`,
      at: "2026-09-19T14:36:00.000Z",
      actor: "A. Chen",
      summary: `Authenticity finding marked ${reviewState.replaceAll("_", " ")}.`,
      kind: "human",
    });
    this.notify();
    return clone(current);
  }

  async listGuidelines(query?: string): Promise<typeof GUIDELINE_CLAUSES> {
    await wait(this.latencyMs);
    if (!query) return clone(GUIDELINE_CLAUSES);
    const q = query.toLowerCase();
    return clone(
      GUIDELINE_CLAUSES.filter(
        (clause) =>
          clause.clauseId.includes(q) ||
          clause.factor.includes(q) ||
          clause.originalLanguage.toLowerCase().includes(q) ||
          clause.sourcePassage.toLowerCase().includes(q),
      ),
    );
  }

  async getAnalytics() {
    await wait(this.latencyMs);
    const all = [...this.cases.values()];
    const outcomes = {
      IN_APPETITE: all.filter((item) => item.decision === "IN_APPETITE").length,
      ACCEPT_WITH_CONDITIONS: all.filter((item) => item.decision === "ACCEPT_WITH_CONDITIONS").length,
      INVESTIGATE: all.filter((item) => item.decision === "INVESTIGATE").length,
      OUT_OF_APPETITE: all.filter((item) => item.decision === "OUT_OF_APPETITE").length,
    };
    const overrides = all.filter((item) => item.override).length;
    return createAnalytics({
      investigatedDelta: all.some((item) => item.investigation.status === "completed") ? 1 : 0,
      cloudAvoided: this.analyticsAvoided,
      cloudReleased: this.analyticsReleased,
      overrideRate: all.length === 0 ? 0 : overrides / all.length,
      referralRate: all.length === 0 ? 0 : outcomes.INVESTIGATE / all.length,
      outcomes,
    });
  }

  async listIntakes(): Promise<IntakeInboxItem[]> {
    await wait(this.latencyMs);
    return clone([...this.inbox.values()]).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }

  async getIntakeCandidates(intakeId: string): Promise<IntakeCandidatesResponse> {
    await wait(this.latencyMs);
    const item = this.inbox.get(intakeId);
    if (!item) throw new Error("Intake not found.");
    const hints = item.matchHints;
    const usable = [hints.riskState, hints.yearRange, hints.tivBucket, hints.lineOfBusiness].filter(Boolean).length;
    if (!usable) return { intakeId, revision: item.revision, candidates: [], sufficientHints: false };
    const bucket = (tiv: number) => (tiv < 1e6 ? "lt_1m" : tiv < 1e7 ? "1m_10m" : tiv < 1e8 ? "10m_100m" : "gte_100m");
    const candidates: IntakeCandidate[] = [];
    for (const c of this.cases.values()) {
      let score = 0;
      const reasons: string[] = [];
      if (hints.riskState && c.state === hints.riskState) {
        score += 3;
        reasons.push(`Risk state ${hints.riskState} matches`);
      }
      if (hints.yearRange && c.buildingYear !== null && c.buildingYear >= hints.yearRange[0] && c.buildingYear <= hints.yearRange[1]) {
        score += 2;
        reasons.push(`Building year ${c.buildingYear} within ${hints.yearRange[0]}-${hints.yearRange[1]}`);
      }
      if (hints.tivBucket && bucket(c.tiv) === hints.tivBucket) {
        score += 2;
        reasons.push(`TIV bucket ${hints.tivBucket} matches`);
      }
      if (hints.lineOfBusiness && /property/i.test(c.lineOfBusiness) && hints.lineOfBusiness === "property") {
        score += 1;
        reasons.push("Line of business property matches");
      }
      if (score > 0) candidates.push({ caseId: c.id, accountName: c.accountName, score, reasons, decision: c.decision });
    }
    candidates.sort((a, b) => b.score - a.score || a.caseId.localeCompare(b.caseId));
    return {
      intakeId,
      revision: item.revision,
      candidates: candidates.slice(0, 10),
      sufficientHints: true,
      rankedAt: new Date().toISOString(),
      waitingSince: item.receivedAt,
    };
  }

  async listIntakeWork(filter: { tab?: IntakeTab } = {}): Promise<IntakeWorkResult> {
    await wait(this.latencyMs);
    const merged = mergeIntakeWork({
      device: this.deviceReachable ? clone(this.deviceRows) : null,
      backend: [...this.inbox.values()].map((item) => ({
        intakeId: item.intakeId,
        documentId: item.documentId,
        deviceId: item.deviceId,
        revision: item.revision,
        receivedAt: item.receivedAt,
        status: item.status,
        association: item.association ? { caseId: item.association.caseId } : null,
        classification: { documentType: item.classification.documentType },
        processing: item.processing,
        audit: item.audit,
      })),
      rejections: clone(this.rejections),
    });
    return filter.tab
      ? { ...merged, items: merged.items.filter((item) => item.tab === filter.tab) }
      : merged;
  }

  /** Demo control: pull the gateway offline to show unknown device counts (workspace TDD §3). */
  setDeviceReachable(reachable: boolean): void {
    this.deviceReachable = reachable;
    this.notify();
  }

  async getCaseDocuments(caseId: string): Promise<CaseDocument[]> {
    await wait(this.latencyMs / 2);
    return clone(this.require(caseId).documents);
  }

  async retryIntakeRelease(intakeId: string): Promise<IntakeWorkItem> {
    await wait(this.latencyMs);
    const row = this.deviceRows.find((item) => item.intakeId === intakeId);
    if (!row) throw new Error("This intake is not on the device.");
    if (row.stage !== "RELEASE_FAILED") throw new Error("Only a failed release can be retried.");
    if (row.releaseError !== "TRANSPORT")
      throw new Error("The backend holds a different digest for this revision; start a new intake rather than re-signing.");
    // The same approved envelope is retransmitted; the revision never changes.
    row.stage = "ACCEPTED";
    row.releaseError = null;
    row.updatedAt = new Date().toISOString();
    const accepted: IntakeInboxItem = {
      ...clone(SEED_INBOX_ITEM),
      intakeId: row.intakeId,
      documentId: row.documentId,
      revision: row.revision,
      receivedAt: row.updatedAt,
      status: row.caseId ? "PROCESSED" : "AWAITING_ASSOCIATION",
      association: row.caseId
        ? { caseId: row.caseId, source: "PRESELECTED", actorId: "reviewer-demo", reason: "Case selected at capture", at: row.updatedAt }
        : null,
      processing: row.caseId ? { gemini: { status: "CANDIDATE_UNVERIFIED" }, elasticsearch: { status: "UNAVAILABLE" } } : {},
      supersedes: null,
      audit: [{ at: row.updatedAt, actorId: "rdk-x5-demo", action: "RELEASE_ACCEPTED", detail: `revision ${row.revision}` }],
    };
    this.inbox.set(accepted.intakeId, accepted);
    if (row.caseId) this.attachDocument(row.caseId, accepted);
    this.pushActivity("RDK X5", "Retried the same approved envelope after a transport failure.", "system");
    this.notify();
    return this.requireWorkItem(intakeId);
  }

  async retryIntakeProcessing(intakeId: string): Promise<IntakeWorkItem> {
    await wait(this.latencyMs);
    const item = this.inbox.get(intakeId);
    if (!item) throw new Error("Intake not found.");
    if (!item.association) throw new Error("Associate this intake with a case before processing it.");
    item.processing = {
      gemini: { status: "CANDIDATE_UNVERIFIED", mode: "fixture", classificationAgreement: "AGREE" },
      elasticsearch: { status: "INDEXED", indexed: item.artifacts.length },
    };
    item.status = "PROCESSED";
    item.audit.push({ at: new Date().toISOString(), actorId: "A. Chen", action: "PROCESSING_RETRIED", detail: `revision ${item.revision}` });
    this.attachDocument(item.association.caseId, item);
    this.notify();
    return this.requireWorkItem(intakeId);
  }

  private async requireWorkItem(intakeId: string): Promise<IntakeWorkItem> {
    const found = (await this.listIntakeWork()).items.find((item) => item.intakeId === intakeId);
    if (!found) throw new Error(`Intake ${intakeId} is no longer visible in either domain.`);
    return found;
  }

  /**
   * A new intake appends a document; a new revision of the same intake supersedes it, so a case
   * shows one row per intakeId at its highest accepted revision.
   */
  private attachDocument(caseId: string, item: IntakeInboxItem): void {
    const target = this.cases.get(caseId);
    if (!target) return;
    const document: CaseDocument = {
      intakeId: item.intakeId,
      documentId: item.documentId,
      revision: item.revision,
      digest: item.digest,
      documentType: item.classification.documentType,
      pageCount: item.quality.pageCount,
      receivedAt: item.receivedAt,
      attachedAt: item.association?.at ?? item.receivedAt,
      attachedBy: item.association?.actorId ?? item.approval.reviewerId,
      associationSource: (item.association?.source as CaseDocument["associationSource"]) ?? "PRESELECTED",
      status: item.status,
      ...(item.supersedes ? { supersedesRevision: item.supersedes.revision } : {}),
    };
    const documents = target.documents.filter((d) => d.intakeId !== document.intakeId);
    target.documents = [document, ...documents].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    // Re-association moves the document; it never leaves a copy behind on the old case.
    for (const other of this.cases.values())
      if (other.id !== caseId && other.documents.some((d) => d.intakeId === document.intakeId))
        other.documents = other.documents.filter((d) => d.intakeId !== document.intakeId);
  }

  async associateIntake(intakeId: string, caseId: string, reason: string): Promise<IntakeInboxItem> {
    await wait(this.latencyMs);
    const item = this.inbox.get(intakeId);
    if (!item) throw new Error("Intake not found.");
    if (!this.cases.has(caseId)) throw new Error("Case not found.");
    if (!reason.trim()) throw new Error("A reason is required.");
    const at = new Date().toISOString();
    const previous = item.association;
    if (previous?.caseId === caseId) {
      item.audit.push({ at, actorId: "A. Chen", action: "ASSOCIATION_CONFIRMED", detail: reason });
    } else {
      item.association = { caseId, source: "REVIEWER", actorId: "A. Chen", reason, at };
      item.audit.push({
        at,
        actorId: "A. Chen",
        action: previous ? "REASSOCIATED" : "ASSOCIATED",
        detail: previous ? `from ${previous.caseId} to ${caseId}: ${reason}` : reason,
      });
      item.status = "PROCESSED";
      item.processing = {
        gemini: { status: "CANDIDATE_UNVERIFIED", mode: "fixture", classificationAgreement: "AGREE" },
        elasticsearch: { status: "INDEXED", indexed: item.artifacts.length },
      };
      this.attachDocument(caseId, item);
      this.pushActivity("A. Chen", `Associated scanned ${item.classification.documentType.replaceAll("_", " ")} with ${this.require(caseId).accountName}.`, "human");
    }
    this.notify();
    return clone(item);
  }

  async getActivity(): Promise<ActivityItem[]> {
    await wait(this.latencyMs / 2);
    return clone(this.activity);
  }

  async getIntake(caseId: string): Promise<IntakeDocument> {
    await wait(this.latencyMs / 2);
    this.scopeIntake(caseId);
    this.syncIntakeConfidence();
    return clone(this.intake);
  }

  async captureIntake(caseId: string): Promise<IntakeDocument> {
    await wait(this.latencyMs);
    this.scopeIntake(caseId);
    this.intake.stage = "captured";
    this.intake.quality = { blur: 0.93, glare: 0.88, framing: 0.91, ocrConfidence: 0.94 };
    this.notify();
    return clone(this.intake);
  }

  async rescanIntake(caseId: string): Promise<IntakeDocument> {
    await wait(this.latencyMs);
    this.scopeIntake(caseId);
    this.intake.stage = "captured";
    this.intake.quality = { blur: 0.96, glare: 0.94, framing: 0.97, ocrConfidence: 0.96 };
    this.intake.released = false;
    this.intake.approved = false;
    this.intake.manifest = null;
    this.notify();
    return clone(this.intake);
  }

  async advanceIntakeProcessing(): Promise<IntakeDocument> {
    const order: IntakeDocument["stage"][] = ["captured", "ocr", "detect", "redact", "review"];
    const index = order.indexOf(this.intake.stage);
    await wait(this.latencyMs);
    if (index >= 0 && index < order.length - 1) {
      this.intake.stage = order[index + 1]!;
    }
    this.syncIntakeConfidence();
    this.notify();
    return clone(this.intake);
  }

  async toggleRedaction(spanId: string, enabled: boolean): Promise<IntakeDocument> {
    await wait(this.latencyMs / 3);
    const span = this.intake.spans.find((item) => item.id === spanId);
    if (!span) throw new Error(`Span not found: ${spanId}`);
    span.enabled = enabled;
    this.syncIntakeConfidence();
    this.notify();
    return clone(this.intake);
  }

  async addManualRedaction(start: number, end: number, type: SensitiveFieldType): Promise<IntakeDocument> {
    await wait(this.latencyMs / 3);
    if (end <= start) throw new Error("Invalid span.");
    const text = this.intake.originalText.slice(start, end);
    this.intake.spans.push({
      id: `span-manual-${this.intake.spans.length + 1}`,
      type,
      classification: "REDACTED",
      text,
      replacement: `[${type.replaceAll("_", " ").toUpperCase()} REDACTED]`,
      start,
      end,
      enabled: true,
      required: false,
    });
    this.syncIntakeConfidence();
    this.notify();
    return clone(this.intake);
  }

  async approveAndRelease(input: {
    destinations: CloudDestination[];
    approvedBy: string;
    acceptLowConfidence: boolean;
  }): Promise<{ document: IntakeDocument; payload: OutboundPayload }> {
    await wait(this.latencyMs);
    this.syncIntakeConfidence();
    if (this.intake.redactionConfidence < MIN_RELEASE_CONFIDENCE && !input.acceptLowConfidence) {
      throw new Error("Low-confidence release requires explicit human approval.");
    }
    const sanitized = sanitizedText(this.intake.originalText, this.intake.spans);
    if (containsSensitiveLeak(sanitized, this.intake.spans)) {
      throw new Error("Required sensitive values remain in the sanitized artifact.");
    }
    if (input.destinations.length === 0) {
      throw new Error("Select at least one destination.");
    }

    const destinations = { ...DEFAULT_DESTINATIONS };
    (Object.keys(destinations) as CloudDestination[]).forEach((key) => {
      if (!input.destinations.includes(key)) destinations[key] = [];
    });

    this.intake.approved = true;
    this.intake.released = true;
    this.intake.stage = "released";
    this.intake.manifest = {
      documentId: this.intake.documentId,
      caseId: this.intake.caseId,
      sourceHash: buildSourceHash(),
      sanitizedHash: sha256Lite(sanitized),
      classifications: {
        redacted: this.intake.spans.filter((s) => s.enabled && s.classification === "REDACTED").map((s) => s.type),
        tokenized: this.intake.spans.filter((s) => s.enabled && s.classification === "TOKENIZED").map((s) => s.type),
        generalized: this.intake.spans.filter((s) => s.enabled && s.classification === "GENERALIZED").map((s) => s.type),
        cloudAllowed: ["state", "tiv", "construction_type", "year_built"],
        localOnly: this.intake.spans.filter((s) => s.enabled && s.classification === "LOCAL_ONLY").map((s) => s.type),
      },
      destinations,
      redactionConfidence: this.intake.redactionConfidence,
      approvedBy: input.approvedBy,
      approvedAt: "2026-09-19T14:40:00.000Z",
      localRetentionUntil: "2026-09-20T14:40:00.000Z",
    };

    const payload: OutboundPayload = {
      destinations: input.destinations,
      gemini: {
        task: "extract_underwriting_facts",
        pages: destinations.gemini,
        text: sanitized,
      },
      openai: {
        task: "plan_investigation",
        facts: {
          account: "Harbor Mill Works LLC",
          state: "PA",
          tiv: 72_000_000,
          premium: 84_000,
          year_built: 2016,
        },
      },
      gptzero: {
        task: "authorship_and_claim_support",
        narrative: sanitized.split("Loss commentary")[1] ?? sanitized,
      },
    };

    // The v1 flow releases one document per case; it appends to the same document list the v2
    // inbox writes to, so a case shows every scan it holds rather than only the newest.
    const target = this.cases.get(this.intake.caseId);
    if (target) {
      const document: CaseDocument = {
        intakeId: `intake:${this.intake.documentId}`,
        documentId: this.intake.documentId,
        revision: 1,
        digest: this.intake.manifest.sanitizedHash,
        documentType: "inspection_report",
        pageCount: 2,
        receivedAt: this.intake.manifest.approvedAt ?? new Date().toISOString(),
        attachedAt: this.intake.manifest.approvedAt ?? new Date().toISOString(),
        attachedBy: input.approvedBy,
        associationSource: "PRESELECTED",
        status: "PROCESSED",
      };
      target.documents = [document, ...target.documents.filter((d) => d.documentId !== document.documentId)].sort(
        (a, b) => b.receivedAt.localeCompare(a.receivedAt),
      );
    }

    this.analyticsReleased += 1;
    this.analyticsAvoided += 2;
    this.pushActivity("RDK X5", "Sanitized inspection released to approved destinations.", "system");
    this.notify();
    return { document: clone(this.intake), payload };
  }

  private seed() {
    this.cases.clear();
    this.risks.clear();
    for (const risk of buildSeedRisks()) {
      this.risks.set(risk.id, risk);
      this.cases.set(risk.id, detailFromRisk(risk, "preliminary"));
    }
    this.intake = createIntakeDocument();
    this.inbox = new Map([[SEED_INBOX_ITEM.intakeId, clone(SEED_INBOX_ITEM)]]);
    this.deviceRows = clone(SEED_DEVICE_ROWS);
    this.rejections = [clone(SEED_REJECTION)];
    this.deviceReachable = true;
    this.analyticsReleased = 11;
    this.analyticsAvoided = 37;
    this.activity = [
      {
        id: "live-1",
        at: "2026-09-19T14:12:00.000Z",
        actor: "Queue watcher",
        summary: "52 commercial property submissions ranked from Federato ingest.",
        kind: "system",
      },
    ];
  }

  private require(id: string): CaseDetail {
    const found = this.cases.get(id);
    if (!found) throw new Error(`Case not found: ${id}`);
    return found;
  }

  private requireRisk(id: string): SeedRisk {
    const found = this.risks.get(id);
    if (!found) throw new Error(`Risk not found: ${id}`);
    return found;
  }

  /**
   * The demo keeps a single synthetic document in flight, so pointing intake
   * at another case restarts it there instead of re-labelling a document that
   * is already partway through the previous case's pipeline.
   */
  private scopeIntake(caseId: string) {
    if (!caseId || this.intake.caseId === caseId) return;
    const fixture = createIntakeDocument();
    this.intake = {
      ...fixture,
      caseId,
      documentId: caseId === DEMO_CASE_ID ? fixture.documentId : `doc:${caseId}-scan`,
    };
  }

  private syncIntakeConfidence() {
    this.intake.redactionConfidence = computeRedactionConfidence(this.intake.spans);
  }

  private pushActivity(actor: string, summary: string, kind: ActivityItem["kind"]) {
    this.activity.unshift({
      id: `live-${this.activity.length + 1}`,
      at: new Date().toISOString(),
      actor,
      summary,
      kind,
    });
    this.activity = this.activity.slice(0, 12);
  }

  private notify() {
    this.listeners.forEach((listener) => listener());
  }
}
