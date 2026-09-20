/**
 * Release-contract-v2 client for the RDK X5 privacy gateway (TDD §5.5, §8).
 *
 * Two transports:
 *  - "direct": the browser is paired straight to the gateway on the local network
 *    (`NEXT_PUBLIC_EDGE_GATEWAY_URL`). The pairing token and the reviewer's approval token are
 *    entered by the operator and kept in `sessionStorage` only — never in server config, never
 *    persisted. This is the only transport that may load raw preview or the local review payload.
 *  - "proxy": same-origin `/api/edge/*`, which injects the server-held pairing token. The proxy
 *    refuses `/review`, `/preview` and `/preview/stream` by design, so a proxied session can
 *    capture and analyze but cannot review or approve; the UI explains how to pair directly.
 */

export type V2Stage =
  | "CAPTURED"
  | "PREPROCESSED"
  | "OCR_COMPLETE"
  | "RECAPTURE_REQUIRED"
  | "ANALYZED"
  | "LOCAL_MODEL_UNAVAILABLE"
  | "SANITIZED"
  | "REVIEW_READY"
  | "APPROVED"
  | "RELEASE_PENDING"
  | "RELEASE_FAILED"
  | "ACCEPTED"
  | "BLOCKED"
  | "ORIGINAL_EXPIRED";

export const V2_STAGE_ORDER: { id: V2Stage; label: string }[] = [
  { id: "CAPTURED", label: "Capture" },
  { id: "PREPROCESSED", label: "Perspective & quality" },
  { id: "OCR_COMPLETE", label: "OCR (on device)" },
  { id: "ANALYZED", label: "Local classification" },
  { id: "SANITIZED", label: "Sensitive-field sanitization" },
  { id: "REVIEW_READY", label: "Human review" },
  { id: "APPROVED", label: "Signed approval" },
  { id: "ACCEPTED", label: "Accepted by backend" },
];

export interface V2Classification {
  status: "CLASSIFIED" | "ABSTAINED" | "UNAVAILABLE";
  documentType: string;
  confidence: number;
  calibration: "UNCALIBRATED" | "CALIBRATED";
  alternatives: { label: string; confidence: number }[];
  attributes: { language: string; pageCount: number; hasTables: boolean; lineOfBusiness: string };
  modelId: string;
  artifactDigest: string;
  runtimeVersion: string;
  latencyMs: number;
  evidenceIds: string[];
}
export interface V2Quality {
  status: "PASS" | "REVIEW" | "RECAPTURE";
  reasons: string[];
  policyVersion: string;
  pageCount: number;
}
export interface V2MatchHints {
  documentType: string;
  riskState?: string;
  lineOfBusiness?: string;
  yearRange?: [number, number];
  tivBucket?: string;
}
export interface V2ModelCapability {
  ready: boolean;
  modelId: string | null;
  artifactDigest: string | null;
  runtimeVersion: string | null;
  calibration?: string | null;
  error: string | null;
}
export interface V2Status {
  intakeId: string;
  documentId: string;
  revision: number;
  stage: V2Stage;
  caseId: string | null;
  pageCount: number;
  quality: V2Quality | null;
  classification: V2Classification | null;
  matchHints: V2MatchHints | null;
  approval: { reviewerId: string; approvedAt: string; expiresAt: string; acknowledgedQuality: boolean } | null;
  receipt: {
    intakeId?: string;
    revision?: number;
    digest?: string;
    status?: string;
    association?: { caseId: string; source: string } | null;
    receivedAt?: string;
  } | null;
  releaseError: string | null;
  limitations: string[];
  model: { classifier: V2ModelCapability; detector: V2ModelCapability };
  pageQuality?: { status: string; reasons: string[] };
}
/**
 * Bounded enumeration row from `GET /v2/intakes` (gateway `intake_summary`).
 *
 * Metadata only: no sanitized text, OCR, layout boxes, token maps, page bytes or hashes of
 * originals. That is what allows this one route — unlike `/review` and `/preview` — to cross
 * the same-origin proxy so a hosted workspace can still count local work.
 */
export interface V2IntakeSummary {
  intakeId: string;
  documentId: string;
  revision: number;
  stage: V2Stage;
  caseId: string | null;
  pageCount: number;
  quality: { status: string | null; reasons: string[] } | null;
  classification: {
    status: string | null;
    documentType: string | null;
    confidence: number | null;
    calibration: string | null;
    modelId: string | null;
  } | null;
  matchHints: V2MatchHints | null;
  reviewRisk: { reasons: string[]; policyVersion: string | null; provisional: boolean };
  /** Set once approved: an approved intake waits on a human, and expiry reopens it for review. */
  approvalExpiresAt: string | null;
  releaseError: string | null;
  updatedAt: string;
  retentionUntil: string | null;
  originalDeleted: boolean;
}
export interface V2Field {
  path: string;
  classification: string;
  method: string;
  confidence: number;
}
export interface V2Review extends V2Status {
  destinations: string[];
  artifacts: { id: string; mediaType: "text/plain"; text: string }[];
  fields: V2Field[];
  stageHistory: { stage: V2Stage; at: string; revision: number }[];
  pages: {
    number: number;
    mediaType: string;
    adapter: string;
    quality: { status: string; reasons: string[] };
    originalSha256: string;
  }[];
  proposedManifest: Record<string, unknown> | null;
  approved: boolean;
  v2Enabled: boolean;
}
export interface V2Health {
  status: string;
  version: string;
  outbound: string;
  deviceId: string | null;
  tenantId: string | null;
  v2Enabled: boolean;
  capabilities: {
    camera: boolean | null;
    ocr: { adapter: string; ready: boolean };
    classifier: V2ModelCapability;
    detector: V2ModelCapability;
    qualityPolicy: { version: string; calibrated: boolean; [key: string]: unknown };
    privacyPolicyVersion: string;
    imageRedaction: string;
    pairing: { configured: boolean; reviewers: number; allowedOrigins: string[] };
  };
}

export function mergeGatewayHealth(previous: V2Health | null, next: V2Health): V2Health {
  if (next.capabilities.camera === true) {
    cameraKnownGoodUntil = Date.now() + 30_000;
    return next;
  }
  if (previous?.capabilities.camera === true || Date.now() < cameraKnownGoodUntil) {
    return { ...next, capabilities: { ...next.capabilities, camera: true } };
  }
  return next;
}

let cameraKnownGoodUntil = 0;
export function resetGatewayHealthMerge(): void {
  cameraKnownGoodUntil = 0;
}

export type V2Transport = "direct" | "proxy";
export interface EdgeV2Config {
  transport: V2Transport;
  baseUrl: string;
  pairingToken?: string;
  approvalToken?: string;
}

export const PRIVILEGED_SUFFIXES = ["/review", "/preview", "/preview/stream"] as const;
const SESSION_KEYS = { pairing: "lloyd.edge.pairingToken", approval: "lloyd.edge.approvalToken" } as const;

export class EdgeV2Error extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function readSessionTokens(): { pairingToken: string; approvalToken: string } {
  if (typeof window === "undefined") return { pairingToken: "", approvalToken: "" };
  return {
    pairingToken: window.sessionStorage.getItem(SESSION_KEYS.pairing) ?? "",
    approvalToken: window.sessionStorage.getItem(SESSION_KEYS.approval) ?? "",
  };
}
export function writeSessionTokens(tokens: { pairingToken?: string; approvalToken?: string }): void {
  if (typeof window === "undefined") return;
  if (tokens.pairingToken !== undefined) window.sessionStorage.setItem(SESSION_KEYS.pairing, tokens.pairingToken);
  if (tokens.approvalToken !== undefined) window.sessionStorage.setItem(SESSION_KEYS.approval, tokens.approvalToken);
}

/** Direct when a gateway origin is published to the browser; otherwise the same-origin proxy. */
export function resolveEdgeV2Config(env?: Record<string, string | undefined>): EdgeV2Config {
  // Next.js only inlines NEXT_PUBLIC_* when the identifier is written as
  // `process.env.NEXT_PUBLIC_EDGE_GATEWAY_URL`. Reading `process.env` as an object
  // works on the server and in tests, then hydrates the browser into proxy mode.
  const published = env ? env.NEXT_PUBLIC_EDGE_GATEWAY_URL : process.env.NEXT_PUBLIC_EDGE_GATEWAY_URL;
  const direct = published?.replace(/\/+$/, "");
  if (direct) return { transport: "direct", baseUrl: direct, ...readSessionTokens() };
  return { transport: "proxy", baseUrl: "/api/edge" };
}

export class EdgeV2Client {
  constructor(
    private readonly config: EdgeV2Config,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  get transport(): V2Transport {
    return this.config.transport;
  }
  get baseUrl(): string {
    return this.config.baseUrl;
  }
  /** Review, preview and approval need the directly paired path; the proxy deliberately refuses them. */
  get canReview(): boolean {
    return this.config.transport === "direct";
  }
  /**
   * Transient camera view over the directly paired connection. Frames are handed to `onFrame` and
   * never stored; the stream ends when `signal` aborts or the gateway's preview budget expires.
   */
  async streamPreview(onFrame: (jpeg: Blob) => void, signal: AbortSignal): Promise<void> {
    this.requireDirect("Live preview");
    const headers = new Headers();
    if (this.config.pairingToken) headers.set("authorization", `Bearer ${this.config.pairingToken}`);
    const response = await this.fetchImpl(`${this.config.baseUrl}/preview/stream`, { headers, signal, cache: "no-store" });
    if (!response.ok || !response.body) throw new EdgeV2Error(response.status, "Camera preview unavailable", "PREVIEW_UNAVAILABLE");
    for await (const frame of parseMixedReplace(response.body, signal)) onFrame(new Blob([frame.slice().buffer as ArrayBuffer], { type: "image/jpeg" }));
  }

  health(): Promise<V2Health> {
    return this.call("/health");
  }
  start(input: { caseId?: string | null; destinations?: string[] }): Promise<V2Status> {
    return this.call("/v2/intakes", {
      method: "POST",
      body: JSON.stringify({
        caseId: input.caseId || null,
        destinations: input.destinations ?? ["lloyd-api", "gemini", "gptzero", "elasticsearch"],
      }),
    });
  }
  capturePage(intakeId: string): Promise<V2Status> {
    return this.call(`/v2/intakes/${encodeURIComponent(intakeId)}/pages`, {
      method: "POST",
      body: JSON.stringify({ source: "camera" }),
    });
  }
  uploadPage(intakeId: string, contentBase64: string, mediaType: "image/png" | "image/jpeg" | "text/plain"): Promise<V2Status> {
    return this.call(`/v2/intakes/${encodeURIComponent(intakeId)}/pages`, {
      method: "POST",
      body: JSON.stringify({ source: "upload", contentBase64, mediaType }),
    });
  }
  selectCase(intakeId: string, revision: number, caseId: string | null): Promise<V2Status> {
    return this.call(`/v2/intakes/${encodeURIComponent(intakeId)}/case`, {
      method: "POST",
      body: JSON.stringify({ revision, caseId }),
    });
  }
  analyze(intakeId: string): Promise<V2Status> {
    return this.call(`/v2/intakes/${encodeURIComponent(intakeId)}/analyze`, { method: "POST" });
  }
  status(intakeId: string): Promise<V2Status> {
    return this.call(`/v2/intakes/${encodeURIComponent(intakeId)}/status`);
  }
  /**
   * Enumerate local intakes. This is how the workspace resolves "my in-flight intake" after a
   * reload, a second browser tab or a shift change: by listing, not by remembering an id.
   */
  listIntakes(input: { stage?: V2Stage; limit?: number } = {}): Promise<{ items: V2IntakeSummary[]; total: number }> {
    const query = new URLSearchParams();
    if (input.stage) query.set("stage", input.stage);
    query.set("limit", String(input.limit ?? 100));
    return this.call(`/v2/intakes?${query.toString()}`);
  }
  async review(intakeId: string): Promise<V2Review> {
    this.requireDirect("Sanitized review");
    return this.call(`/v2/intakes/${encodeURIComponent(intakeId)}/review`);
  }
  addRedactions(intakeId: string, revision: number, blockIds: string[]): Promise<V2Status> {
    return this.call(`/v2/intakes/${encodeURIComponent(intakeId)}/redactions`, {
      method: "POST",
      body: JSON.stringify({ revision, blockIds }),
    });
  }
  /** Approval is bound to the exact reviewed revision and signed by the reviewer's own key on the gateway. */
  async approve(intakeId: string, revision: number, acknowledgedQuality: boolean): Promise<V2Status> {
    this.requireDirect("Approval");
    if (!this.config.approvalToken) throw new EdgeV2Error(403, "Enter your reviewer approval token to approve.", "REVIEWER_TOKEN_REQUIRED");
    return this.call(`/v2/intakes/${encodeURIComponent(intakeId)}/approve`, {
      method: "POST",
      headers: { "x-human-approval": this.config.approvalToken },
      body: JSON.stringify({ revision, acknowledgedQuality }),
    });
  }
  release(intakeId: string): Promise<V2Status> {
    return this.call(`/v2/intakes/${encodeURIComponent(intakeId)}/release`, { method: "POST" });
  }
  deleteOriginals(intakeId: string): Promise<V2Status> {
    return this.call(`/v2/intakes/${encodeURIComponent(intakeId)}/originals`, { method: "DELETE" });
  }

  private requireDirect(action: string): void {
    if (!this.canReview)
      throw new EdgeV2Error(
        403,
        `${action} is only available to a directly paired local client. Set NEXT_PUBLIC_EDGE_GATEWAY_URL and pair this browser with the gateway.`,
        "DIRECT_PAIRING_REQUIRED",
      );
  }

  private async call<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
    const headers = new Headers(init.headers ?? {});
    if (init.body) headers.set("content-type", "application/json");
    if (this.config.transport === "direct" && this.config.pairingToken)
      headers.set("authorization", `Bearer ${this.config.pairingToken}`);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}${path}`, { ...init, headers, cache: "no-store" });
    } catch {
      if (!retried && this.config.transport === "direct") {
        const boot = await bootstrapLocalPairing(this.fetchImpl);
        if (boot) {
          writeSessionTokens(boot);
          this.config.pairingToken = boot.pairingToken;
          this.config.approvalToken = boot.approvalToken;
          return this.call(path, init, true);
        }
      }
      throw new EdgeV2Error(0, "The privacy gateway is unreachable.", "EDGE_UNREACHABLE");
    }
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      const detail =
        body && typeof body === "object"
          ? ((body as { detail?: unknown; error?: { message?: string; code?: string } }).detail ??
            (body as { error?: { message?: string } }).error?.message)
          : undefined;
      const code = body && typeof body === "object" ? (body as { error?: { code?: string } }).error?.code : undefined;
      throw new EdgeV2Error(
        response.status,
        typeof detail === "string" ? detail : `Gateway returned ${response.status}`,
        code,
      );
    }
    return body as T;
  }
}

/** Parse a `multipart/x-mixed-replace` JPEG stream whose parts carry Content-Length (the gateway's format). */
export async function* parseMixedReplace(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let buffer = new Uint8Array(0);
  const decoder = new TextDecoder();
  const indexOf = (needle: string, from = 0) => {
    const bytes = new TextEncoder().encode(needle);
    outer: for (let i = from; i <= buffer.length - bytes.length; i++) {
      for (let j = 0; j < bytes.length; j++) if (buffer[i + j] !== bytes[j]) continue outer;
      return i;
    }
    return -1;
  };
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      const merged = new Uint8Array(buffer.length + value.length);
      merged.set(buffer);
      merged.set(value, buffer.length);
      buffer = merged;
      for (;;) {
        const headerEnd = indexOf("\r\n\r\n");
        if (headerEnd < 0) break;
        const header = decoder.decode(buffer.subarray(0, headerEnd));
        const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1]);
        if (!Number.isFinite(length)) {
          buffer = buffer.subarray(headerEnd + 4);
          continue;
        }
        const start = headerEnd + 4;
        if (buffer.length < start + length) break;
        yield buffer.slice(start, start + length);
        buffer = buffer.subarray(start + length);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

let client: EdgeV2Client | null = null;
export function getEdgeV2Client(fresh = false): EdgeV2Client {
  if (!client || fresh) client = new EdgeV2Client(resolveEdgeV2Config());
  return client;
}

/**
 * USB workstation bootstrap: the Next server already holds EDGE_LOCAL_TOKEN.
 * Loopback-only `/api/edge/local-pairing` copies it into this tab so the operator
 * does not paste a secret after plugging the board in.
 */
export async function bootstrapLocalPairing(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<{ pairingToken: string; approvalToken: string } | null> {
  try {
    const response = await fetchImpl("/api/edge/local-pairing", { cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as { pairingToken?: unknown; approvalToken?: unknown };
    if (typeof body.pairingToken !== "string" || body.pairingToken.length === 0) return null;
    return {
      pairingToken: body.pairingToken,
      approvalToken: typeof body.approvalToken === "string" ? body.approvalToken : "",
    };
  } catch {
    return null;
  }
}

export async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
