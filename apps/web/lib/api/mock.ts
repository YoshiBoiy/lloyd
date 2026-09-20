import type {
  ActivityItem,
  CaseDetail,
  CaseListFilters,
  CaseListResponse,
  CloudDestination,
  IntakeDocument,
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

function wait(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MockLloydApi implements LloydApi {
  private cases = new Map<string, CaseDetail>();
  private risks = new Map<string, SeedRisk>();
  private intake: IntakeDocument = createIntakeDocument();
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

    const target = this.cases.get(this.intake.caseId);
    if (target) target.intakeDocumentId = this.intake.documentId;

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
