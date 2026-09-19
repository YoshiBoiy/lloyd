import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const Destination = z.enum([
  "lloyd-api",
  "gemini",
  "openai",
  "gptzero",
  "elasticsearch",
]);
export type Destination = z.infer<typeof Destination>;
export const Classification = z.enum([
  "local_only",
  "redacted",
  "tokenized",
  "generalized",
  "cloud_allowed",
]);
const Field = z
  .object({
    path: z.string().min(1).max(200),
    classification: Classification,
    method: z.string().max(120).optional(),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export const ReleaseManifest = z
  .object({
    version: z.literal(1),
    documentId: z.string().uuid(),
    caseId: z.string().min(1).max(100),
    sanitizedSha256: z.string().regex(/^[a-f0-9]{64}$/),
    fields: z.array(Field).max(1000),
    destinations: z.array(Destination).min(1),
    confidence: z.number().min(0).max(1),
    approval: z
      .object({
        approvedBy: z.string().min(1).max(100),
        approvedAt: z.string().datetime(),
      })
      .strict()
      .optional(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;
// Bytes are UTF-8 text exactly as sent: no JSON canonicalization ambiguity.
export const SanitizedIntake = z
  .object({
    manifest: ReleaseManifest,
    artifact: z
      .object({
        mediaType: z.literal("text/plain"),
        text: z.string().max(2_000_000),
      })
      .strict(),
  })
  .strict();
export type SanitizedIntake = z.infer<typeof SanitizedIntake>;
export const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const MIN_RELEASE_CONFIDENCE = 0.95;
export function verifyIntake(
  input: unknown,
  allowed: readonly Destination[],
  destination: Destination = "lloyd-api",
  trustedApproval = false,
): SanitizedIntake {
  const data = SanitizedIntake.parse(input);
  if (
    !timingSafeEqual(
      Buffer.from(sha256(data.artifact.text)),
      Buffer.from(data.manifest.sanitizedSha256),
    )
  )
    throw new DomainError(
      "HASH_MISMATCH",
      "Sanitized artifact hash does not match",
    );
  if (
    data.manifest.fields.some(
      (f) =>
        f.classification === "local_only" ||
        /token.?map|raw|exact.?address|ocr.?body|secret/i.test(f.path),
    )
  )
    throw new DomainError(
      "LOCAL_ONLY",
      "Local-only field metadata cannot be released",
    );
  if (
    !data.manifest.destinations.includes(destination) ||
    data.manifest.destinations.some((d) => !allowed.includes(d))
  )
    throw new DomainError("DESTINATION_DENIED", "Destination is not approved");
  if (
    (data.manifest.confidence < MIN_RELEASE_CONFIDENCE ||
      data.manifest.fields.some(
        (f) => f.confidence < MIN_RELEASE_CONFIDENCE,
      )) &&
    !(data.manifest.approval && trustedApproval)
  )
    throw new DomainError(
      "APPROVAL_REQUIRED",
      "Low-confidence release requires authenticated human approval",
      403,
    );
  assertSanitizedText(data.artifact.text);
  return data;
}
export const Preference = z
  .object({
    userId: z.string().regex(/^[a-f0-9]{64}$/),
    key: z.enum(["queue_sort", "density", "theme"]),
    value: z.enum([
      "priority",
      "newest",
      "compact",
      "comfortable",
      "light",
      "dark",
    ]),
    approved: z.literal(true),
  })
  .strict()
  .superRefine((p, ctx) => {
    const legal = {
      queue_sort: ["priority", "newest"],
      density: ["compact", "comfortable"],
      theme: ["light", "dark"],
    };
    if (!legal[p.key].includes(p.value))
      ctx.addIssue({ code: "custom", message: "Invalid preference value" });
  });
export const TelemetryEvent = z
  .object({
    eventId: z.string().uuid(),
    casePseudonym: z.string().regex(/^[a-f0-9]{64}$/),
    event: z.enum([
      "ingested",
      "investigated",
      "simulated",
      "released",
      "provider_failure",
      "human_override",
      "redacted",
    ]),
    durationMs: z.number().nonnegative().max(3_600_000),
    at: z.string().datetime(),
    outcome: z.enum(["success", "blocked", "unavailable"]),
  })
  .strict();

export function approvalMessage(manifest: ReleaseManifest): string {
  return JSON.stringify([
    manifest.documentId,
    manifest.caseId,
    manifest.sanitizedSha256,
    manifest.confidence.toFixed(6),
    [...manifest.destinations].sort().join(","),
    manifest.approval?.approvedBy ?? "",
    manifest.approval?.approvedAt ?? "",
  ]);
}

export function assertSanitizedText(text: string): void {
  const forbidden =
    /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b\d{3}-\d{2}-\d{4}\b|\b(?:sk|api_key|secret)[-_=:][A-Za-z0-9_-]{8,}|(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}/i;
  const labeled =
    /(?:home address|property address|street address|government id|signature|date of birth|dob|policy(?: number)?|claim(?: number)?|contact|person name)\s*:\s*([^\n]+)/gi;
  if (
    forbidden.test(text) ||
    [...text.matchAll(labeled)].some(
      (m) =>
        !/^\[(?:REDACTED|TOKEN_[a-f0-9]+|AGE_BAND_[A-Z0-9_]+)\]$/.test(
          m[1]!.trim(),
        ),
    )
  )
    throw new DomainError(
      "SENSITIVE_CONTENT",
      "Sanitized artifact contains a prohibited sensitive pattern",
    );
}
