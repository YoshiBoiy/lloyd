import type {
  ActivityItem,
  AnalyticsSummary,
  CaseDetail,
  CaseListFilters,
  CaseListResponse,
  CloudDestination,
  GuidelineClause,
  IntakeDocument,
  IntakeStage,
  InvestigationStep,
  LloydApi,
  ManifestField,
  OutboundPayload,
  QualityMetrics,
  ReleaseManifest,
  SensitiveFieldType,
} from "./types";
import { MIN_RELEASE_CONFIDENCE } from "./types";

/**
 * HTTP adapter for the integration pass.
 * Backend base URL is read from NEXT_PUBLIC_LLOYD_API_URL.
 * Intake calls go same-origin to `/api/edge/...`, a Next.js route handler
 * (`app/api/edge/[...path]/route.ts`) that proxies to wherever the RDK X5
 * privacy gateway is actually reachable (`EDGE_GATEWAY_URL`, server-side
 * only) and injects its local pairing/human-approval tokens. The browser
 * never receives an edge-gateway origin or credential directly.
 */

/** Real gateway wire shape for `Manifest` (see `gateway/contracts.py`). */
interface WireManifest {
  sanitizedSha256: string;
  fields: { path: string; classification: string; confidence: number }[];
  destinations: string[];
  confidence: number;
  approval?: { approvedBy: string; approvedAt: string };
}

const CLASSIFICATION_MAP: Record<string, ManifestField["classification"]> = {
  local_only: "LOCAL_ONLY",
  redacted: "REDACTED",
  tokenized: "TOKENIZED",
  generalized: "GENERALIZED",
  cloud_allowed: "CLOUD_ALLOWED",
};

// The gateway's default destination allowlist excludes OpenAI (its planner
// gets bounded normalized context server-side instead, never raw documents).
const LIVE_REDACT_DESTINATIONS = ["lloyd-api", "gemini", "gptzero", "elasticsearch"];

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export class HttpLloydApi implements LloydApi {
  private intakeDocumentId: string | null = null;
  private intakeCaseId: string | null = null;
  private intakeStage: IntakeStage = "idle";
  private intakeSource: IntakeDocument["source"];
  private intakeMediaType: IntakeDocument["mediaType"];
  private intakeQuality: QualityMetrics = { blur: 0, glare: 0, framing: 0, ocrConfidence: 0 };
  private intakeConfidence = 0;
  private intakeSanitizedText = "";
  private intakeManifest: ReleaseManifest | null = null;
  private intakeManifestFields: ManifestField[] = [];
  private intakeReleased = false;

  constructor(
    private readonly apiBase: string,
    private latencyMs = 0,
  ) {}

  setLatency(ms: number): void {
    this.latencyMs = ms;
  }

  getLatency(): number {
    return this.latencyMs;
  }

  async listCases(filters: CaseListFilters = {}): Promise<CaseListResponse> {
    const params = new URLSearchParams();
    if (filters.search) params.set("search", filters.search);
    if (filters.state) params.set("state", filters.state);
    if (filters.decision) params.set("decision", filters.decision);
    if (filters.assignee) params.set("assignee", filters.assignee);
    if (filters.stage) params.set("stage", filters.stage);
    return this.api(`/api/cases?${params.toString()}`);
  }

  getCase(id: string): Promise<CaseDetail> {
    return this.api(`/api/cases/${encodeURIComponent(id)}`);
  }

  async investigate(id: string, onStep?: (step: InvestigationStep) => void): Promise<CaseDetail> {
    const investigation = await this.api<{ id: string }>(`/api/cases/${encodeURIComponent(id)}/investigate`, {
      method: "POST",
    });
    const detail = await this.pollInvestigation(id, investigation.id, onStep);
    return detail;
  }

  applyBrokerResponse(id: string): Promise<CaseDetail> {
    return this.api(`/api/cases/${encodeURIComponent(id)}/simulate`, {
      method: "POST",
      body: JSON.stringify({ scenario: "broker_response" }),
    });
  }

  recalculate(id: string): Promise<CaseDetail> {
    return this.api(`/api/cases/${encodeURIComponent(id)}/simulate`, {
      method: "POST",
      body: JSON.stringify({ scenario: "recalculate" }),
    });
  }

  draftInformationRequest(id: string): Promise<{ id: string; questions: string[]; rationale: string[] }> {
    return this.api(`/api/cases/${encodeURIComponent(id)}/actions/draft-information-request`, {
      method: "POST",
    });
  }

  recordOverride(id: string, reason: string): Promise<CaseDetail> {
    return this.api(`/api/cases/${encodeURIComponent(id)}/override`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
  }

  addNote(id: string, body: string): Promise<CaseDetail> {
    return this.api(`/api/cases/${encodeURIComponent(id)}/notes`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  updateAuthenticity(
    id: string,
    reviewState: NonNullable<CaseDetail["authenticity"]>["reviewState"],
  ): Promise<CaseDetail> {
    return this.api(`/api/cases/${encodeURIComponent(id)}/authenticity`, {
      method: "POST",
      body: JSON.stringify({ reviewState }),
    });
  }

  listGuidelines(query?: string): Promise<GuidelineClause[]> {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    return this.api(`/api/guidelines?${params.toString()}`);
  }

  getAnalytics(): Promise<AnalyticsSummary> {
    return this.api("/api/analytics/summary");
  }

  getActivity(): Promise<ActivityItem[]> {
    return this.api("/api/activity");
  }

  getIntake(caseId: string): Promise<IntakeDocument> {
    // One adapter instance is shared across the whole session, so a reviewer
    // who opens intake for case B must not inherit case A's in-flight
    // document. Anything belonging to another case starts over as idle.
    if (!this.intakeDocumentId || this.intakeCaseId !== caseId) {
      this.clearIntake();
      this.intakeCaseId = caseId;
    }
    return Promise.resolve(this.snapshotIntake());
  }

  captureIntake(caseId: string): Promise<IntakeDocument> {
    return this.capture(caseId, defaultIntakeSource());
  }

  rescanIntake(caseId: string): Promise<IntakeDocument> {
    // A fresh /capture always creates a new document on the gateway; there
    // is no "rescan the same document" wire operation.
    return this.capture(caseId, defaultIntakeSource());
  }

  async advanceIntakeProcessing(): Promise<IntakeDocument> {
    if (!this.intakeDocumentId) return this.snapshotIntake();
    switch (this.intakeStage) {
      case "captured": {
        const result = await this.edge<{ confidence: number; adapter: string }>(
          `/documents/${this.intakeDocumentId}/ocr`,
          { method: "POST" },
        );
        this.intakeQuality = { ...this.intakeQuality, ocrConfidence: result.confidence };
        this.intakeStage = "ocr";
        break;
      }
      case "ocr":
        // Sensitive-field detection is bundled into the gateway's single
        // /redact call below; this transition is presentation-only — no
        // separate wire step exists for it.
        this.intakeStage = "detect";
        break;
      case "detect": {
        const result = await this.edge<{ manifest: WireManifest; requiresApproval: boolean }>(
          `/documents/${this.intakeDocumentId}/redact`,
          { method: "POST", body: JSON.stringify({ destinations: LIVE_REDACT_DESTINATIONS }) },
        );
        this.applyManifest(result.manifest);
        this.intakeStage = "redact";
        break;
      }
      case "redact": {
        const result = await this.edge<{
          intake: { artifact: { text: string }; manifest: WireManifest };
          requiresApproval: boolean;
        }>(`/documents/${this.intakeDocumentId}/preview`);
        this.intakeSanitizedText = result.intake.artifact.text;
        this.applyManifest(result.intake.manifest);
        this.intakeStage = "review";
        break;
      }
      default:
        break;
    }
    return this.snapshotIntake();
  }

  // The real gateway computes redactions deterministically inside /redact;
  // there is no per-field toggle in the wire contract, so these reject
  // clearly rather than silently no-op-ing controls the UI still shows.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  toggleRedaction(spanId: string, enabled: boolean): Promise<IntakeDocument> {
    return Promise.reject(new Error("Per-field redaction toggling isn't available for live RDK X5 captures."));
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  addManualRedaction(start: number, end: number, type: SensitiveFieldType): Promise<IntakeDocument> {
    return Promise.reject(new Error("Manual redaction editing isn't available for live RDK X5 captures."));
  }

  async approveAndRelease(input: {
    destinations: CloudDestination[];
    approvedBy: string;
    acceptLowConfidence: boolean;
  }): Promise<{ document: IntakeDocument; payload: OutboundPayload }> {
    if (!this.intakeDocumentId) throw new Error("Capture a document before releasing it.");
    if (this.intakeConfidence < MIN_RELEASE_CONFIDENCE && !input.acceptLowConfidence) {
      throw new Error("Automatic release requires trusted human approval below the confidence threshold.");
    }
    try {
      await this.edge<{ status: string }>(`/documents/${this.intakeDocumentId}/release`, {
        method: "POST",
        body: JSON.stringify({ approve: true, approvedBy: input.approvedBy }),
      });
    } catch (err) {
      throw new Error(await this.describeReleaseFailure(err));
    }
    this.intakeReleased = true;
    this.intakeStage = "released";
    if (this.intakeManifest) {
      this.intakeManifest = {
        ...this.intakeManifest,
        approvedBy: input.approvedBy,
        approvedAt: new Date().toISOString(),
      };
    }
    // The real gateway sends one identical sanitized artifact to every
    // approved destination (no per-destination field breakdown exists on
    // the wire); OpenAI never receives raw documents, matching the
    // gateway's destination allowlist.
    const attachment = { documentId: this.intakeDocumentId, text: this.intakeSanitizedText };
    const payload: OutboundPayload = {
      destinations: input.destinations,
      gemini: input.destinations.includes("gemini") ? attachment : {},
      openai: {},
      gptzero: input.destinations.includes("gptzero") ? attachment : {},
    };
    return { document: this.snapshotIntake(), payload };
  }

  async resetDemo(): Promise<void> {
    await this.api("/api/bootstrap", { method: "POST" });
    this.clearIntake();
  }

  private snapshotIntake(): IntakeDocument {
    return {
      documentId: this.intakeDocumentId ?? "",
      caseId: this.intakeCaseId ?? "",
      title: "RDK X5 capture",
      originalText: this.intakeSanitizedText,
      spans: [],
      quality: this.intakeQuality,
      stage: this.intakeStage,
      redactionConfidence: this.intakeConfidence,
      manifest: this.intakeManifest,
      released: this.intakeReleased,
      approved: this.intakeReleased,
      source: this.intakeSource,
      mediaType: this.intakeMediaType,
      manifestFields: this.intakeManifestFields,
    };
  }

  private async capture(
    caseId: string,
    source: "camera" | "fixture" | "upload",
  ): Promise<IntakeDocument> {
    if (!caseId) throw new Error("Secure intake needs a case to attach the document to.");
    let result: { documentId: string; quality: Record<string, number> };
    try {
      result = await this.edge(`/capture`, {
        method: "POST",
        body: JSON.stringify({ caseId, source }),
      });
    } catch (err) {
      if (source === "camera") {
        // No RDK camera attached / no /dev/video device reachable: fall
        // back to the packaged text fixture so the pipeline still runs.
        return this.capture(caseId, "fixture");
      }
      throw err;
    }
    this.clearIntake();
    this.intakeCaseId = caseId;
    this.intakeDocumentId = result.documentId;
    this.intakeSource = source;
    this.intakeMediaType = source === "fixture" ? "text/plain" : "image/png";
    this.intakeQuality = {
      blur: clamp01((result.quality?.blurVariance ?? 0) / 300),
      glare: clamp01(1 - (result.quality?.glareFraction ?? 0)),
      framing: result.quality?.confidence ?? (result.quality?.cropped ? 1 : 0.5),
      ocrConfidence: 0,
    };
    this.intakeStage = "captured";
    return this.snapshotIntake();
  }

  /**
   * The gateway collapses every backend rejection into one opaque 502
   * ("Release failed; sanitized content retained locally") so it never
   * echoes backend detail to the device. The most common cause is a case id
   * the backend doesn't know, so check that here and say so plainly.
   */
  private async describeReleaseFailure(err: unknown): Promise<string> {
    const caseId = this.intakeCaseId;
    if (caseId) {
      const known = await this.getCase(caseId).then(
        () => true,
        () => false,
      );
      if (!known) {
        return `Case ${caseId} was not found, so the sanitized document can't be attached to it. The original stays on the device.`;
      }
    }
    const detail = err instanceof Error ? err.message : "";
    return `Release was refused by the gateway; the original stays on the device.${detail ? ` (${detail})` : ""}`;
  }

  private clearIntake(): void {
    this.intakeDocumentId = null;
    this.intakeCaseId = null;
    this.intakeStage = "idle";
    this.intakeSource = undefined;
    this.intakeMediaType = undefined;
    this.intakeQuality = { blur: 0, glare: 0, framing: 0, ocrConfidence: 0 };
    this.intakeConfidence = 0;
    this.intakeSanitizedText = "";
    this.intakeManifest = null;
    this.intakeManifestFields = [];
    this.intakeReleased = false;
  }

  private applyManifest(wire: WireManifest): void {
    this.intakeConfidence = wire.confidence;
    this.intakeManifestFields = wire.fields.map((field) => ({
      path: field.path,
      classification: CLASSIFICATION_MAP[field.classification] ?? "REDACTED",
      confidence: field.confidence,
    }));
    const byDestination = Object.fromEntries(
      (["gemini", "openai", "gptzero"] as CloudDestination[]).map((destination) => [
        destination,
        wire.destinations.includes(destination)
          ? wire.fields.filter((f) => f.classification !== "local_only").map((f) => f.path)
          : [],
      ]),
    ) as Record<CloudDestination, string[]>;
    this.intakeManifest = {
      documentId: this.intakeDocumentId ?? "",
      caseId: this.intakeCaseId ?? "",
      sourceHash: this.intakeManifest?.sourceHash ?? "",
      sanitizedHash: wire.sanitizedSha256,
      classifications: {
        redacted: wire.fields.filter((f) => f.classification === "redacted").map((f) => f.path),
        tokenized: wire.fields.filter((f) => f.classification === "tokenized").map((f) => f.path),
        generalized: wire.fields.filter((f) => f.classification === "generalized").map((f) => f.path),
        cloudAllowed: wire.fields.filter((f) => f.classification === "cloud_allowed").map((f) => f.path),
        localOnly: wire.fields.filter((f) => f.classification === "local_only").map((f) => f.path),
      },
      destinations: byDestination,
      redactionConfidence: wire.confidence,
      approvedBy: wire.approval?.approvedBy ?? null,
      approvedAt: wire.approval?.approvedAt ?? null,
      // Not present on this wire response; matches the gateway's default
      // EDGE_RETENTION_SECONDS (24h) rather than a server-confirmed value.
      localRetentionUntil: new Date(Date.now() + 86_400_000).toISOString(),
    };
  }

  private async pollInvestigation(
    caseId: string,
    investigationId: string,
    onStep?: (step: InvestigationStep) => void,
  ): Promise<CaseDetail> {
    const investigation = await this.api<{ steps: InvestigationStep[] }>(
      `/api/cases/${encodeURIComponent(caseId)}/investigations/${encodeURIComponent(investigationId)}`,
    );
    investigation.steps.forEach((step) => onStep?.(step));
    return this.getCase(caseId);
  }

  private api<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request<T>(this.apiBase, path, init);
  }

  /** Same-origin call into `app/api/edge/[...path]/route.ts`, see class docstring. */
  private edge<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request<T>("", `/api/edge${path}`, init);
  }

  private async request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      let detail = "";
      try {
        detail = JSON.stringify(await response.json());
      } catch {
        // Non-JSON error body; fall back to the status line below.
      }
      throw new Error(`${response.status} ${response.statusText} for ${path}${detail ? `: ${detail}` : ""}`);
    }
    return response.json() as Promise<T>;
  }
}

function defaultIntakeSource(): "camera" | "fixture" | "upload" {
  const configured = process.env.NEXT_PUBLIC_INTAKE_SOURCE;
  return configured === "fixture" || configured === "upload" ? configured : "camera";
}
