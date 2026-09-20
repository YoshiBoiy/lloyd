import type {
  ActivityItem,
  AnalyticsSummary,
  CaseDetail,
  CaseDocument,
  CaseListFilters,
  CaseListResponse,
  CloudDestination,
  GuidelineClause,
  IntakeCandidatesResponse,
  IntakeDocument,
  IntakeInboxItem,
  IntakeRejection,
  IntakeStage,
  IntakeTab,
  IntakeWorkItem,
  IntakeWorkResult,
  InvestigationStep,
  LloydApi,
  ManifestField,
  OutboundPayload,
  QualityMetrics,
  ReleaseManifest,
  SensitiveFieldType,
} from "./types";
import { MIN_RELEASE_CONFIDENCE } from "./types";
import { getEdgeV2Client } from "./edge-v2";
import {
  mergeIntakeWork,
  type BackendIntakeRow,
  type DeviceIntakeRow,
} from "./intake-work";
import {
  applyCaseFilters,
  mapActivity,
  mapAnalytics,
  mapCaseDetail,
  mapGuidelines,
  mapInvestigationSteps,
  mapListItem,
  summarizeCases,
  type WireCaseRecord,
  type WireListItem,
  type WirePathToYes,
  type WirePrecedent,
  type WireStep,
} from "./backend-map";

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

  private investigationByCase = new Map<string, WireStep[]>();
  private namesById = new Map<string, string>();

  setLatency(ms: number): void {
    this.latencyMs = ms;
  }

  getLatency(): number {
    return this.latencyMs;
  }

  async listCases(filters: CaseListFilters = {}): Promise<CaseListResponse> {
    const items: WireListItem[] = [];
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    while (offset < total) {
      const page = await this.api<{ items: WireListItem[]; total: number }>(`/api/cases?limit=100&offset=${offset}`);
      items.push(...(page.items ?? []));
      total = page.total ?? items.length;
      offset += page.items?.length ?? 0;
      if (!page.items?.length) break;
    }
    const mapped = items.map((item) => {
      const summary = mapListItem(item);
      this.namesById.set(summary.id, summary.accountName);
      return summary;
    });
    return summarizeCases(applyCaseFilters(mapped, filters));
  }

  async getCase(id: string): Promise<CaseDetail> {
    const payload = await this.api<{
      case: WireCaseRecord;
      pathToYes?: WirePathToYes[];
      documents?: CaseDocument[];
    }>(`/api/cases/${encodeURIComponent(id)}`);
    let precedents: WirePrecedent[] = [];
    try {
      const neighbor = await this.api<{ matches?: WirePrecedent[] }>(`/api/cases/${encodeURIComponent(id)}/precedents`);
      precedents = neighbor.matches ?? [];
    } catch {
      precedents = [];
    }
    return mapCaseDetail(payload.case, payload.pathToYes ?? [], {
      steps: this.investigationByCase.get(id),
      precedents,
      names: Object.fromEntries(this.namesById),
      documents: payload.documents ?? [],
    });
  }

  async investigate(id: string, onStep?: (step: InvestigationStep) => void): Promise<CaseDetail> {
    const result = await this.api<{ investigation?: { id: string; steps?: WireStep[] } }>(
      `/api/cases/${encodeURIComponent(id)}/investigate`,
      { method: "POST" },
    );
    const steps = result.investigation?.steps ?? [];
    this.investigationByCase.set(id, steps);
    mapInvestigationSteps(steps).forEach((step) => onStep?.(step));
    return this.getCase(id);
  }

  applyBrokerResponse(_id: string): Promise<CaseDetail> {
    return Promise.reject(new Error("Broker-response simulation is a working-file tool, not a canned demo. Send explicit fact changes from a real reply."));
  }

  recalculate(_id: string): Promise<CaseDetail> {
    return Promise.reject(new Error("Recalculate after recording verified fact changes; there is no scripted replay on live files."));
  }

  async draftInformationRequest(id: string): Promise<{ id: string; questions: string[]; rationale: string[] }> {
    const result = await this.api<{ action: { id: string; questions: string[] } }>(
      `/api/cases/${encodeURIComponent(id)}/actions/draft-information-request`,
      { method: "POST" },
    );
    return { id: result.action.id, questions: result.action.questions ?? [], rationale: [] };
  }

  recordOverride(_id: string, _reason: string): Promise<CaseDetail> {
    return Promise.reject(new Error("Human overrides are recorded in the case file after the live override endpoint is enabled."));
  }

  addNote(_id: string, _body: string): Promise<CaseDetail> {
    return Promise.reject(new Error("Working notes are not persisted on the live API yet."));
  }

  updateAuthenticity(
    _id: string,
    _reviewState: NonNullable<CaseDetail["authenticity"]>["reviewState"],
  ): Promise<CaseDetail> {
    return Promise.reject(new Error("Authenticity review state is set from GPTZero findings on the case, not a local toggle."));
  }

  async listGuidelines(query?: string): Promise<GuidelineClause[]> {
    const list = await this.listCases();
    return mapGuidelines(list.cases, query);
  }

  async getAnalytics(): Promise<AnalyticsSummary> {
    const telemetry = await this.api<{
      analytics: {
        status?: string;
        mode?: string;
        total?: number;
        failures?: number;
        averageDurationMs?: number;
        hourly?: {
          hour: string;
          ingested?: number | string;
          investigated?: number | string;
          throughput?: number | string;
          average_duration_ms?: number | string;
          releases?: number | string;
          redaction_count?: number | string;
          human_overrides?: number | string;
        }[];
      };
    }>("/api/analytics/summary");
    return mapAnalytics(telemetry.analytics ?? {});
  }

  async getActivity(): Promise<ActivityItem[]> {
    const list = await this.listCases();
    return mapActivity(list.cases);
  }

  // Backend inbox routes identify the reviewer by header; the backend maps it to
  // a tenant-scoped binding and refuses unknown identities.
  private reviewerHeaders(): Record<string, string> {
    const reviewer = process.env.NEXT_PUBLIC_LLOYD_REVIEWER_ID;
    return reviewer ? { "x-reviewer-id": reviewer } : {};
  }

  async listIntakes(): Promise<IntakeInboxItem[]> {
    try {
      const result = await this.api<{ items?: IntakeInboxItem[] }>("/api/intakes", { headers: this.reviewerHeaders() });
      return result.items ?? [];
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("403")) return [];
      throw error;
    }
  }

  /**
   * The merged queue. Both domains are queried independently and either may fail: a backend
   * outage must not hide local work awaiting approval, and a gateway that cannot be reached
   * makes device counts unknown rather than zero (workspace TDD §3).
   */
  async listIntakeWork(filter: { tab?: IntakeTab } = {}): Promise<IntakeWorkResult> {
    let deviceReason: string | null = null;
    let backendReason: string | null = null;
    const [device, backend, rejections] = await Promise.all([
      getEdgeV2Client()
        .listIntakes()
        .then((result) => result.items as DeviceIntakeRow[])
        .catch((error: unknown) => {
          deviceReason = silenceReason(error);
          return null;
        }),
      this.api<{ items?: BackendIntakeRow[] }>("/api/intakes?limit=100", { headers: this.reviewerHeaders() })
        .then((result) => result.items ?? [])
        .catch((error: unknown) => {
          backendReason = silenceReason(error);
          return null;
        }),
      this.api<{ items?: IntakeRejection[] }>("/api/intakes/rejections", { headers: this.reviewerHeaders() })
        .then((result) => result.items ?? [])
        .catch(() => null),
    ]);
    const merged = mergeIntakeWork({ device, backend, rejections, deviceReason, backendReason });
    return filter.tab
      ? { ...merged, items: merged.items.filter((item) => item.tab === filter.tab) }
      : merged;
  }

  async getCaseDocuments(caseId: string): Promise<CaseDocument[]> {
    const result = await this.api<{ documents?: CaseDocument[] }>(
      `/api/cases/${encodeURIComponent(caseId)}/documents`,
      { headers: this.reviewerHeaders() },
    );
    return result.documents ?? [];
  }

  /** The gateway retransmits the stored approved envelope; the backend dedupes on digest. */
  async retryIntakeRelease(intakeId: string): Promise<IntakeWorkItem> {
    await getEdgeV2Client().release(intakeId);
    return this.requireWorkItem(intakeId);
  }

  async retryIntakeProcessing(intakeId: string): Promise<IntakeWorkItem> {
    await this.api(`/api/intakes/${encodeURIComponent(intakeId)}/retry`, {
      method: "POST",
      headers: this.reviewerHeaders(),
    });
    return this.requireWorkItem(intakeId);
  }

  private async requireWorkItem(intakeId: string): Promise<IntakeWorkItem> {
    const found = (await this.listIntakeWork()).items.find((item) => item.intakeId === intakeId);
    if (!found) throw new Error(`Intake ${intakeId} is no longer visible in either domain.`);
    return found;
  }

  getIntakeCandidates(intakeId: string): Promise<IntakeCandidatesResponse> {
    return this.api(`/api/intakes/${encodeURIComponent(intakeId)}/candidates`, { headers: this.reviewerHeaders() });
  }

  async associateIntake(intakeId: string, caseId: string, reason: string): Promise<IntakeInboxItem> {
    const result = await this.api<{ intake: IntakeInboxItem }>(`/api/intakes/${encodeURIComponent(intakeId)}/association`, {
      method: "POST",
      headers: this.reviewerHeaders(),
      body: JSON.stringify({ caseId, reason }),
    });
    return result.intake;
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

/**
 * Why a domain produced no rows. Refused and unreachable both leave the count unknown, but they
 * ask for different things from the operator, so the workspace says which one happened.
 */
function silenceReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b401\b|\b403\b|FORBIDDEN|UNAUTHORIZED/i.test(message)) return "refused this browser's identity";
  if (/NOT_CONFIGURED|not enabled/i.test(message)) return "has release contract v2 disabled";
  if (/\b5\d\d\b|fetch failed|NetworkError|Failed to fetch|unreachable|unavailable/i.test(message)) return "did not answer";
  return "could not be read";
}

function defaultIntakeSource(): "camera" | "fixture" | "upload" {
  const configured = process.env.NEXT_PUBLIC_INTAKE_SOURCE;
  return configured === "fixture" || configured === "upload" ? configured : "camera";
}
