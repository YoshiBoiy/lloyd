/**
 * Intake release contract v2 (Lloyd_Edge_Cloud_TDD_v2.md §6).
 *
 * v2 lives alongside v1 (`ReleaseManifest` / `SanitizedIntake` in index.ts);
 * the two are never overloaded. Every collection and string here is bounded,
 * every enum is closed, and evidence references may only point at released
 * sanitized blocks. The Python gateway validates the same shape through the
 * JSON schema generated from these definitions (scripts/generate-v2-schema.ts),
 * and both sides sign the RFC 8785 canonical form of the manifest with a
 * domain-separated prefix.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import { z } from "zod";
import {
  Destination,
  DomainError,
  assertNoForbiddenValues,
  assertSanitizedText,
  sha256,
} from "./index.js";

export const V2_LIMITS = {
  pages: 20,
  blocks: 2000,
  textBytes: 2_000_000,
  imageBytes: 10_000_000,
  envelopeBytes: 25_000_000,
  approvalWindowMs: 15 * 60_000,
  clockSkewMs: 60_000,
} as const;

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const score = z.number().finite().min(0).max(1);

export const DocumentType = z.enum([
  "inspection_report",
  "loss_run",
  "statement_of_values",
  "application",
  "policy_document",
  "correspondence",
  "mixed",
  "unknown",
]);
export type DocumentType = z.infer<typeof DocumentType>;

export const LineOfBusiness = z.enum([
  "property",
  "casualty",
  "mixed",
  "unknown",
]);
export const RiskState = z.enum([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
]);
export const TivBucket = z.enum(["lt_1m", "1m_10m", "10m_100m", "gte_100m"]);

/** Bounded, enum-only attributes a local model may propose (§5.2). */
export const SafeAttributes = z
  .object({
    language: z.enum(["en", "unknown"]),
    pageCount: z.number().int().min(1).max(V2_LIMITS.pages),
    hasTables: z.boolean(),
    lineOfBusiness: LineOfBusiness,
  })
  .strict();

export const SafeClassification = z
  .object({
    status: z.enum(["CLASSIFIED", "ABSTAINED", "UNAVAILABLE"]),
    documentType: DocumentType,
    confidence: score,
    calibration: z.enum(["CALIBRATED", "UNCALIBRATED"]),
    alternatives: z
      .array(z.object({ label: DocumentType, confidence: score }).strict())
      .max(8),
    attributes: SafeAttributes,
    modelId: id,
    artifactDigest: hash.nullable(),
    runtimeVersion: id,
    latencyMs: z.number().finite().min(0).max(3_600_000),
    evidenceIds: z.array(id).max(V2_LIMITS.blocks),
  })
  .strict();
export type SafeClassification = z.infer<typeof SafeClassification>;

/** Minimal generalized hints for case matching (§5.4). Combinations are shown to the reviewer. */
export const SafeMatchHints = z
  .object({
    documentType: DocumentType,
    riskState: RiskState.optional(),
    lineOfBusiness: LineOfBusiness.optional(),
    yearRange: z
      .tuple([
        z.number().int().min(1900).max(2200),
        z.number().int().min(1900).max(2200),
      ])
      .optional(),
    tivBucket: TivBucket.optional(),
  })
  .strict();
export type SafeMatchHints = z.infer<typeof SafeMatchHints>;

export const QualityReason = z.enum([
  "BLUR",
  "CLIPPED_PAGE",
  "GLARE_OCCLUSION",
  "EMPTY_OCR",
  "LOW_TEXT_CONFIDENCE",
  "PERSPECTIVE_UNCERTAIN",
  "UNCALIBRATED_POLICY",
]);
export const SafeQuality = z
  .object({
    status: z.enum(["PASS", "REVIEW", "RECAPTURE"]),
    reasons: z.array(QualityReason).max(7),
    policyVersion: z.literal("quality-v2-provisional"),
    pageCount: z.number().int().min(1).max(V2_LIMITS.pages),
  })
  .strict();
export type SafeQuality = z.infer<typeof SafeQuality>;

export const PrivacyFieldV2 = z
  .object({
    path: z.string().regex(/^field_[0-9]+\.[a-z_]+$/),
    classification: z.enum([
      "redacted",
      "tokenized",
      "generalized",
      "cloud_allowed",
    ]),
    method: z.enum([
      "deterministic-pattern-v1",
      "local-semantic-v1",
      "operator-v2",
    ]),
    confidence: score,
  })
  .strict();

export const ArtifactDescriptor = z
  .object({
    id,
    mediaType: z.literal("text/plain"),
    byteLength: z.number().int().min(1).max(V2_LIMITS.textBytes),
    sha256: hash,
    page: z.number().int().min(1).max(V2_LIMITS.pages),
    blockId: id,
    box: z
      .tuple([
        z.number().int().nonnegative(),
        z.number().int().nonnegative(),
        z.number().int().positive(),
        z.number().int().positive(),
      ])
      .nullable(),
  })
  .strict();

export const ManifestV2 = z
  .object({
    version: z.literal(2),
    intakeId: z.string().uuid(),
    documentId: z.string().uuid(),
    revision: z.number().int().min(1),
    deviceId: id,
    tenantId: id,
    caseId: id.nullable(),
    policyVersion: z.literal("privacy-v2-text-only"),
    createdAt: z.string().datetime(),
    classification: SafeClassification,
    matchHints: SafeMatchHints,
    quality: SafeQuality,
    fields: z.array(PrivacyFieldV2).max(V2_LIMITS.blocks),
    artifacts: z.array(ArtifactDescriptor).min(1).max(V2_LIMITS.blocks),
    destinations: z.array(Destination).min(1).max(5),
    approval: z
      .object({
        reviewerId: id,
        approvedAt: z.string().datetime(),
        expiresAt: z.string().datetime(),
        acknowledgedQuality: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type ManifestV2 = z.infer<typeof ManifestV2>;

export const IntakeV2 = z
  .object({
    manifest: ManifestV2,
    artifacts: z
      .array(
        z
          .object({
            id,
            mediaType: z.literal("text/plain"),
            text: z.string().min(1).max(V2_LIMITS.textBytes),
          })
          .strict(),
      )
      .min(1)
      .max(V2_LIMITS.blocks),
    authentication: z
      .object({
        keyId: id,
        algorithm: z.literal("HMAC-SHA256"),
        signature: hash,
        reviewerSignature: hash,
      })
      .strict(),
  })
  .strict();
export type IntakeV2 = z.infer<typeof IntakeV2>;

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** RFC 8785 canonical JSON. Rejects non-finite numbers and lone surrogates before serializing. */
export function canonicalV2(value: unknown): string {
  const visit = (v: unknown): void => {
    if (typeof v === "number" && !Number.isFinite(v))
      throw new DomainError("INVALID_CANONICAL_VALUE", "Invalid number");
    if (typeof v === "string" && LONE_SURROGATE.test(v))
      throw new DomainError("INVALID_CANONICAL_VALUE", "Invalid Unicode");
    if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        visit(k);
        visit(x);
      }
  };
  visit(value);
  return canonicalize(value);
}

export type SignerRole = "device" | "reviewer";
export function signV2(
  manifest: ManifestV2,
  key: string,
  role: SignerRole = "device",
): string {
  return createHmac("sha256", key)
    .update(`lloyd:intake:v2:${role}\0`)
    .update(canonicalV2(manifest))
    .digest("hex");
}

export interface DeviceBinding {
  tenantId: string;
  deviceId: string;
  key: string;
  notBefore?: string;
  notAfter?: string;
}
export interface ReviewerBinding {
  tenantId: string;
  key: string;
  /** Allowed case IDs, or ["*"] for every case in the tenant. */
  caseIds: string[];
}
export interface V2Policy {
  devices: Record<string, DeviceBinding>;
  reviewers: Record<string, ReviewerBinding>;
  destinations: readonly Destination[];
  now?: number;
  clockSkewMs?: number;
}

export function reviewerMayAccess(
  reviewer: ReviewerBinding,
  caseId: string,
): boolean {
  return reviewer.caseIds.includes("*") || reviewer.caseIds.includes(caseId);
}

export interface VerifiedV2 {
  data: IntakeV2;
  /** SHA-256 of the canonical envelope; bound to identity for idempotency. */
  digest: string;
  /** SHA-256 over (tenantId, deviceId, intakeId, revision). */
  identity: string;
}

/**
 * Backend-side independent validation (§6). Schema, size, device/reviewer
 * binding, constant-time signatures, approval window and clock tolerance,
 * quality/model gates, destination policy, artifact hashes and provenance,
 * then sanitized-content scanning per block and across block boundaries.
 * Failures carry only a bounded rejection code.
 */
export function verifyV2(input: unknown, policy: V2Policy): VerifiedV2 {
  const fail = (code: string): never => {
    throw new DomainError(code, code, 403);
  };
  const data = IntakeV2.parse(input);
  const m = data.manifest;
  const canonical = canonicalV2(data);
  if (Buffer.byteLength(canonical) > V2_LIMITS.envelopeBytes)
    fail("ENVELOPE_TOO_LARGE");

  const now = policy.now ?? Date.now();
  const skew = policy.clockSkewMs ?? V2_LIMITS.clockSkewMs;
  const device = policy.devices[data.authentication.keyId];
  if (
    !device ||
    device.tenantId !== m.tenantId ||
    device.deviceId !== m.deviceId ||
    device.key.length < 32 ||
    (device.notBefore && now < Date.parse(device.notBefore)) ||
    (device.notAfter && now > Date.parse(device.notAfter))
  )
    return fail("DEVICE_DENIED");
  const reviewer = policy.reviewers[m.approval.reviewerId];
  if (
    !reviewer ||
    reviewer.tenantId !== m.tenantId ||
    reviewer.key.length < 32 ||
    (m.caseId !== null && !reviewerMayAccess(reviewer, m.caseId))
  )
    return fail("REVIEWER_DENIED");

  const eq = (a: string, b: string) =>
    timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  if (
    !eq(data.authentication.signature, signV2(m, device.key)) ||
    !eq(
      data.authentication.reviewerSignature,
      signV2(m, reviewer.key, "reviewer"),
    )
  )
    fail("BAD_SIGNATURE");

  const created = Date.parse(m.createdAt);
  const approved = Date.parse(m.approval.approvedAt);
  const expires = Date.parse(m.approval.expiresAt);
  if (
    created > now + skew ||
    approved > now + skew ||
    approved < created ||
    expires <= now ||
    expires <= approved ||
    expires - approved > V2_LIMITS.approvalWindowMs
  )
    fail("APPROVAL_EXPIRED_OR_CLOCK_INVALID");

  if (
    m.quality.status === "RECAPTURE" ||
    (m.quality.status === "REVIEW" && !m.approval.acknowledgedQuality)
  )
    fail("QUALITY_BLOCKED");
  if (
    m.classification.status === "UNAVAILABLE" ||
    !m.classification.artifactDigest
  )
    fail("MODEL_UNAVAILABLE");
  if (
    !m.destinations.includes("lloyd-api") ||
    new Set(m.destinations).size !== m.destinations.length ||
    m.destinations.some((d) => !policy.destinations.includes(d))
  )
    fail("DESTINATION_DENIED");
  if (m.matchHints.documentType !== m.classification.documentType)
    fail("CLASSIFICATION_MISMATCH");
  if (m.classification.attributes.pageCount !== m.quality.pageCount)
    fail("PAGE_MISMATCH");

  const ids = new Set(m.artifacts.map((a) => a.id));
  const blocks = new Set(m.artifacts.map((a) => a.blockId));
  if (
    ids.size !== m.artifacts.length ||
    blocks.size !== m.artifacts.length ||
    data.artifacts.length !== ids.size ||
    new Set(data.artifacts.map((a) => a.id)).size !== ids.size
  )
    fail("ARTIFACT_MISMATCH");
  if (m.classification.evidenceIds.some((b) => !blocks.has(b)))
    fail("INVALID_PROVENANCE");
  const pages = new Set(m.artifacts.map((a) => a.page));
  if (
    pages.size !== m.quality.pageCount ||
    m.artifacts.some((a) => a.page > m.quality.pageCount)
  )
    fail("PAGE_MISMATCH");

  const byId = new Map(data.artifacts.map((a) => [a.id, a]));
  let bytes = 0;
  const ordered: string[] = [];
  for (const d of m.artifacts) {
    const a = byId.get(d.id);
    if (
      !a ||
      d.byteLength !== Buffer.byteLength(a.text) ||
      d.sha256 !== sha256(a.text)
    )
      return fail("ARTIFACT_MISMATCH");
    assertSanitizedText(a.text);
    bytes += d.byteLength;
    ordered.push(a.text);
  }
  if (bytes > V2_LIMITS.textBytes) fail("TEXT_TOO_LARGE");
  // Also scan across block boundaries so splitting a value cannot bypass detection. Blocks may be
  // adjacent lines or adjacent column segments, so whitespace and direct joins are checked for
  // value shapes; the line-anchored label rule runs on the line-preserving join only.
  assertSanitizedText(ordered.join("\n"));
  for (const separator of [" ", ""])
    assertNoForbiddenValues(ordered.join(separator));

  return {
    data,
    digest: sha256(canonical),
    identity: sha256(
      canonicalV2([m.tenantId, m.deviceId, m.intakeId, m.revision]),
    ),
  };
}
