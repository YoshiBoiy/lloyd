import { z } from "zod";
import { DomainError } from "../../contracts/src/index.js";
import {
  reviewerMayAccess,
  type IntakeV2,
  type ManifestV2,
  type ReviewerBinding,
  type VerifiedV2,
} from "../../contracts/src/intake-v2.js";
import type { CaseRecord, CaseStore } from "./data.js";

/**
 * Backend intake inbox for v2 releases (TDD §7.1, §7.3).
 *
 * Accepted releases are persisted before acknowledgement, deduplicated by (tenant, device, intake,
 * revision) identity plus canonical digest, and only ever hold sanitized text. Case association is
 * either preselected at capture (and carried in the signed manifest) or chosen by an authorized
 * reviewer after release; every association is audited and never rewrites the original manifest.
 */

export interface Association {
  caseId: string;
  source: "PRESELECTED" | "REVIEWER" | "CARRIED_FORWARD";
  actorId: string;
  reason: string;
  at: string;
}
export interface AuditEntry {
  at: string;
  actorId: string;
  action: string;
  detail?: string;
}
export type IntakeStatus =
  | "AWAITING_ASSOCIATION"
  | "PROCESSING"
  | "PROCESSED"
  | "PROCESSED_WITH_WARNINGS";
export interface IntakeRecord {
  intakeId: string;
  documentId: string;
  tenantId: string;
  deviceId: string;
  revision: number;
  digest: string;
  identity: string;
  receivedAt: string;
  manifest: ManifestV2;
  artifacts: IntakeV2["artifacts"];
  authentication: IntakeV2["authentication"];
  association: Association | null;
  processing: Record<string, unknown>;
  status: IntakeStatus;
  audit: AuditEntry[];
  supersedes?: { revision: number; digest: string };
  /**
   * The last ranking a reviewer was shown, so `Unmatched` has memory: without it the ranking is
   * recomputed and discarded on every look, and nothing records which list an association was
   * actually chosen from. Bounded to case ids and scores — no account names, no reasons text.
   */
  candidateRanks?: {
    at: string;
    revision: number;
    sufficientHints: boolean;
    ranks: { caseId: string; score: number }[];
  };
}
export interface CandidateCase {
  caseId: string;
  accountName: string | null;
  score: number;
  reasons: string[];
  decision: string;
}
/**
 * A refused release, so the operator workspace's `Failed` queue has a cloud-side source of
 * truth (workspace TDD §7.1). Bounded metadata and one rejection code only: no rejected
 * content, no signatures, no artifact text. A suspected leak is never uploaded for debugging.
 *
 * `verified` says whether the identity was cryptographically established (a digest conflict or
 * stale revision) or merely claimed by the refused envelope (a signature or device failure).
 */
export interface RejectionRecord {
  at: string;
  tenantId: string;
  deviceId: string;
  intakeId: string;
  revision: number;
  identity: string;
  code: string;
  verified: boolean;
}
/** One attached document on a case; identity is (tenantId, intakeId) (workspace TDD §8). */
export interface CaseDocument {
  intakeId: string;
  documentId: string;
  revision: number;
  digest: string;
  /** Local classification, unverified by the backend. */
  documentType: string;
  /** Provider confirmation when extraction ran; disagreements are preserved, never merged. */
  providerDocumentType?: string;
  pageCount: number;
  receivedAt: string;
  attachedAt: string;
  attachedBy: string;
  associationSource: Association["source"];
  status: IntakeStatus;
  supersedesRevision?: number;
}
/** Bounded rejection history per tenant; older rows fall off rather than growing without limit. */
const MAX_REJECTIONS = 200;

export const AssociateBody = z
  .object({
    caseId: z.string().min(1).max(100),
    reason: z.string().min(1).max(500),
  })
  .strict();

export type Processor = (
  record: IntakeRecord,
) => Promise<Record<string, unknown>>;

const tivBucketOf = (tiv: unknown) =>
  typeof tiv !== "number" || !Number.isFinite(tiv)
    ? null
    : tiv < 1e6
      ? "lt_1m"
      : tiv < 1e7
        ? "1m_10m"
        : tiv < 1e8
          ? "10m_100m"
          : "gte_100m";

const lobOf = (value: unknown) => {
  if (typeof value !== "string") return null;
  const v = value.toLowerCase();
  return /property|commercial_property|cp\b/.test(v)
    ? "property"
    : /casualty|liability|gl\b/.test(v)
      ? "casualty"
      : /package|mixed|bop/.test(v)
        ? "mixed"
        : null;
};

/** Deterministic, explainable ranking of authorized cases from privacy-safe hints only (§5.4, §7.3). */
export function rankCandidates(
  manifest: ManifestV2,
  cases: CaseRecord[],
  reviewer: ReviewerBinding,
  limit = 10,
): { candidates: CandidateCase[]; sufficientHints: boolean } {
  const hints = manifest.matchHints;
  const usable = [
    hints.riskState,
    hints.yearRange,
    hints.tivBucket,
    hints.lineOfBusiness,
  ].filter((h) => h !== undefined).length;
  if (usable === 0) return { candidates: [], sufficientHints: false };
  const ranked: CandidateCase[] = [];
  for (const c of cases) {
    if (!reviewerMayAccess(reviewer, c.id)) continue;
    let score = 0;
    const reasons: string[] = [];
    const state = c.facts.primaryState?.value;
    if (
      hints.riskState &&
      typeof state === "string" &&
      state.toUpperCase() === hints.riskState
    ) {
      score += 3;
      reasons.push(`Risk state ${hints.riskState} matches`);
    }
    const year = c.facts.buildingYear?.value;
    if (
      hints.yearRange &&
      typeof year === "number" &&
      year >= hints.yearRange[0] &&
      year <= hints.yearRange[1]
    ) {
      score += 2;
      reasons.push(
        `Building year ${year} within ${hints.yearRange[0]}-${hints.yearRange[1]}`,
      );
    }
    const bucket = tivBucketOf(c.facts.tiv?.value);
    if (hints.tivBucket && bucket === hints.tivBucket) {
      score += 2;
      reasons.push(`TIV bucket ${bucket} matches`);
    }
    const lob = lobOf(c.facts.lineOfBusiness?.value);
    if (
      hints.lineOfBusiness &&
      hints.lineOfBusiness !== "unknown" &&
      lob === hints.lineOfBusiness
    ) {
      score += 1;
      reasons.push(`Line of business ${lob} matches`);
    }
    if (score > 0)
      ranked.push({
        caseId: c.id,
        accountName:
          typeof c.facts.accountName?.value === "string"
            ? c.facts.accountName.value
            : null,
        score,
        reasons,
        decision: c.decision.class,
      });
  }
  ranked.sort((a, b) => b.score - a.score || a.caseId.localeCompare(b.caseId));
  return { candidates: ranked.slice(0, limit), sufficientHints: true };
}

export class IntakeInbox {
  constructor(private store: CaseStore) {}

  async get(intakeId: string): Promise<IntakeRecord | undefined> {
    return this.store.getExtra<IntakeRecord>("intakes", intakeId);
  }
  async require(intakeId: string): Promise<IntakeRecord> {
    const record = await this.get(intakeId);
    if (!record) throw new DomainError("NOT_FOUND", "Intake not found", 404);
    return record;
  }
  async list(tenantId?: string): Promise<IntakeRecord[]> {
    const ids =
      (await this.store.getExtra<string[]>("intake_index", "all")) ?? [];
    const records: IntakeRecord[] = [];
    for (const id of ids) {
      const r = await this.get(id);
      if (r && (!tenantId || r.tenantId === tenantId)) records.push(r);
    }
    return records.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }
  /**
   * Persist the record and both indexes. `previousCaseId` is the case this intake was attached
   * to before this operation: re-association removes it from that case's index in the same
   * save that adds it to the new one, so a document never appears under two cases.
   */
  private async save(record: IntakeRecord, previousCaseId?: string | null) {
    await this.store.saveExtra("intakes", record.intakeId, record);
    await this.store.saveExtra("intake_identities", record.identity, {
      intakeId: record.intakeId,
      revision: record.revision,
      digest: record.digest,
    });
    const ids =
      (await this.store.getExtra<string[]>("intake_index", "all")) ?? [];
    if (!ids.includes(record.intakeId))
      await this.store.saveExtra("intake_index", "all", [
        ...ids,
        record.intakeId,
      ]);
    const caseId = record.association?.caseId ?? null;
    if (previousCaseId && previousCaseId !== caseId)
      await this.writeCaseIndex(
        previousCaseId,
        (await this.caseIndex(previousCaseId)).filter(
          (id) => id !== record.intakeId,
        ),
      );
    if (caseId) {
      const attached = await this.caseIndex(caseId);
      if (!attached.includes(record.intakeId))
        await this.writeCaseIndex(caseId, [...attached, record.intakeId]);
    }
  }
  async caseIndex(caseId: string): Promise<string[]> {
    return (
      (await this.store.getExtra<string[]>("intake_case_index", caseId)) ?? []
    );
  }
  private async writeCaseIndex(caseId: string, ids: string[]) {
    await this.store.saveExtra("intake_case_index", caseId, ids);
  }

  /**
   * Documents attached to a case, newest first. A new intake appends; a new revision of the
   * same intake supersedes, so there is exactly one row per intakeId at its highest accepted
   * revision (workspace TDD §8.1).
   */
  async documents(caseId: string): Promise<CaseDocument[]> {
    const rows: CaseDocument[] = [];
    for (const intakeId of await this.caseIndex(caseId)) {
      const r = await this.get(intakeId);
      const association = r?.association;
      if (!r || !association || association.caseId !== caseId) continue;
      const gemini = r.processing.gemini as
        | { providerDocumentType?: unknown }
        | undefined;
      const provider =
        gemini && typeof gemini.providerDocumentType === "string"
          ? gemini.providerDocumentType
          : undefined;
      rows.push({
        intakeId: r.intakeId,
        documentId: r.documentId,
        revision: r.revision,
        digest: r.digest,
        documentType: r.manifest.classification.documentType,
        ...(provider ? { providerDocumentType: provider } : {}),
        pageCount: r.manifest.quality.pageCount,
        receivedAt: r.receivedAt,
        attachedAt: association.at,
        attachedBy: association.actorId,
        associationSource: association.source,
        status: r.status,
        ...(r.supersedes ? { supersedesRevision: r.supersedes.revision } : {}),
      });
    }
    return rows.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }

  /** Bounded, content-free record of a refused release (§7.1). */
  async recordRejection(rejection: RejectionRecord): Promise<RejectionRecord> {
    const rows = await this.rejections(rejection.tenantId);
    await this.store.saveExtra("intake_rejections", rejection.tenantId, {
      rows: [rejection, ...rows].slice(0, MAX_REJECTIONS),
    });
    return rejection;
  }
  async rejections(tenantId: string): Promise<RejectionRecord[]> {
    return (
      (
        await this.store.getExtra<{ rows: RejectionRecord[] }>(
          "intake_rejections",
          tenantId,
        )
      )?.rows ?? []
    );
  }

  /**
   * Accept a verified release. Same identity and digest returns the stored result without
   * reprocessing; same identity with a different digest is a conflict; an older revision than the
   * one already stored is rejected.
   */
  async accept(
    verified: VerifiedV2,
    caseExists: (caseId: string) => Promise<boolean>,
    process: Processor,
  ): Promise<{ record: IntakeRecord; duplicate: boolean }> {
    const m = verified.data.manifest;
    const seen = await this.store.getExtra<{
      intakeId: string;
      revision: number;
      digest: string;
    }>("intake_identities", verified.identity);
    if (seen) {
      if (seen.digest !== verified.digest)
        throw new DomainError(
          "INTAKE_DIGEST_CONFLICT",
          "This approved revision was already released with different content",
          409,
        );
      return { record: await this.require(seen.intakeId), duplicate: true };
    }
    const previous = await this.get(m.intakeId);
    if (previous) {
      if (previous.tenantId !== m.tenantId || previous.deviceId !== m.deviceId)
        throw new DomainError(
          "INTAKE_IDENTITY_MISMATCH",
          "Intake belongs to another device",
          409,
        );
      if (m.revision <= previous.revision)
        throw new DomainError(
          "STALE_REVISION",
          "A newer revision of this intake was already accepted",
          409,
        );
    }
    const now = new Date().toISOString();
    let association: Association | null = null;
    const audit: AuditEntry[] = [
      {
        at: now,
        actorId: m.deviceId,
        action: "RELEASE_ACCEPTED",
        detail: `revision ${m.revision}`,
      },
    ];
    if (m.caseId) {
      if (!(await caseExists(m.caseId)))
        throw new DomainError(
          "UNKNOWN_CASE",
          "Preselected case does not exist",
          404,
        );
      association = {
        caseId: m.caseId,
        source: "PRESELECTED",
        actorId: m.approval.reviewerId,
        reason: "Case selected at capture and confirmed by reviewer approval",
        at: now,
      };
      audit.push({
        at: now,
        actorId: m.approval.reviewerId,
        action: "ASSOCIATED",
        detail: "preselected",
      });
    } else if (previous?.association) {
      association = {
        ...previous.association,
        source: "CARRIED_FORWARD",
        at: now,
        reason: `Carried forward from revision ${previous.revision}; ${previous.association.reason}`,
      };
      audit.push({
        at: now,
        actorId: previous.association.actorId,
        action: "ASSOCIATED",
        detail: "carried forward",
      });
    }
    const record: IntakeRecord = {
      intakeId: m.intakeId,
      documentId: m.documentId,
      tenantId: m.tenantId,
      deviceId: m.deviceId,
      revision: m.revision,
      digest: verified.digest,
      identity: verified.identity,
      receivedAt: now,
      manifest: m,
      artifacts: verified.data.artifacts,
      authentication: verified.data.authentication,
      association,
      processing: {},
      status: association ? "PROCESSING" : "AWAITING_ASSOCIATION",
      audit: previous ? [...previous.audit, ...audit] : audit,
      ...(previous
        ? {
            supersedes: {
              revision: previous.revision,
              digest: previous.digest,
            },
          }
        : {}),
    };
    // Durable before acknowledgement; processing may fail and be retried without a re-release.
    await this.save(record, previous?.association?.caseId ?? null);
    if (association) await this.run(record, process);
    return { record, duplicate: false };
  }

  /**
   * Re-run cloud processing for an already accepted, associated release. A retryable warning
   * (an unavailable provider) is not a re-release: the stored manifest and digest are reused
   * untouched, so nothing is re-signed and no new intake is created.
   */
  async retryProcessing(
    intakeId: string,
    actor: { id: string; binding: ReviewerBinding },
    process: Processor,
  ): Promise<IntakeRecord> {
    const record = await this.require(intakeId);
    if (actor.binding.tenantId !== record.tenantId)
      throw new DomainError("FORBIDDEN", "Reviewer is not in this tenant", 403);
    if (!record.association)
      throw new DomainError(
        "ASSOCIATION_REQUIRED",
        "Associate this intake with a case before processing it",
        409,
      );
    if (!reviewerMayAccess(actor.binding, record.association.caseId))
      throw new DomainError(
        "FORBIDDEN",
        "Reviewer is not authorized for this case",
        403,
      );
    record.audit.push({
      at: new Date().toISOString(),
      actorId: actor.id,
      action: "PROCESSING_RETRIED",
      detail: `revision ${record.revision}`,
    });
    record.processing = {};
    record.status = "PROCESSING";
    await this.save(record);
    await this.run(record, process);
    return record;
  }

  private async run(record: IntakeRecord, process: Processor) {
    let processing: Record<string, unknown>;
    try {
      processing = await process(record);
    } catch {
      processing = { pipeline: { status: "UNAVAILABLE" } };
    }
    record.processing = processing;
    record.status = Object.values(processing).some(
      (p) =>
        p &&
        typeof p === "object" &&
        /UNAVAILABLE|REJECTED/.test(
          String((p as { status?: string }).status ?? ""),
        ),
    )
      ? "PROCESSED_WITH_WARNINGS"
      : "PROCESSED";
    await this.save(record);
  }

  async candidates(
    intakeId: string,
    cases: CaseRecord[],
    reviewer: ReviewerBinding,
  ) {
    const record = await this.require(intakeId);
    if (reviewer.tenantId !== record.tenantId)
      throw new DomainError("FORBIDDEN", "Reviewer is not in this tenant", 403);
    const ranked = rankCandidates(
      record.manifest,
      cases.filter((c) => c),
      reviewer,
    );
    // Remember what was shown, bound to the revision it described, and how long this release has
    // been waiting for a case. `sufficientHints: false` is kept distinct from "ranked and nothing
    // matched": the first cannot be fixed by looking harder at the case list.
    record.candidateRanks = {
      at: new Date().toISOString(),
      revision: record.revision,
      sufficientHints: ranked.sufficientHints,
      ranks: ranked.candidates
        .slice(0, 10)
        .map((c) => ({ caseId: c.caseId, score: c.score })),
    };
    await this.save(record);
    return {
      intakeId,
      revision: record.revision,
      ...ranked,
      rankedAt: record.candidateRanks.at,
      waitingSince: record.receivedAt,
    };
  }

  /**
   * Where the chosen case sat in the ranking the reviewer was last shown, for the audit trail.
   * Off-list choices are recorded as such: the operator overrode the ranking, which is allowed
   * and is exactly the case worth being able to find later.
   */
  private chosenRank(record: IntakeRecord, caseId: string): string {
    const memory = record.candidateRanks;
    if (!memory || memory.revision !== record.revision) return "";
    const index = memory.ranks.findIndex((r) => r.caseId === caseId);
    return index < 0
      ? ` (not in the ${memory.ranks.length} ranked candidates)`
      : ` (ranked ${index + 1} of ${memory.ranks.length})`;
  }

  /** Associate (or re-associate) with an authorized case. Re-processing runs only when the case changes. */
  async associate(
    intakeId: string,
    input: unknown,
    actor: { id: string; binding: ReviewerBinding },
    caseExists: (caseId: string) => Promise<boolean>,
    process: Processor,
  ) {
    const body = AssociateBody.parse(input);
    const record = await this.require(intakeId);
    if (actor.binding.tenantId !== record.tenantId)
      throw new DomainError("FORBIDDEN", "Reviewer is not in this tenant", 403);
    if (!reviewerMayAccess(actor.binding, body.caseId))
      throw new DomainError(
        "FORBIDDEN",
        "Reviewer is not authorized for this case",
        403,
      );
    if (!(await caseExists(body.caseId)))
      throw new DomainError("NOT_FOUND", "Case not found", 404);
    const now = new Date().toISOString();
    if (record.association?.caseId === body.caseId) {
      record.audit.push({
        at: now,
        actorId: actor.id,
        action: "ASSOCIATION_CONFIRMED",
        detail: body.reason,
      });
      await this.save(record);
      return record;
    }
    const previous = record.association;
    record.association = {
      caseId: body.caseId,
      source: "REVIEWER",
      actorId: actor.id,
      reason: body.reason,
      at: now,
    };
    record.audit.push({
      at: now,
      actorId: actor.id,
      action: previous ? "REASSOCIATED" : "ASSOCIATED",
      detail: `${previous ? `from ${previous.caseId} to ${body.caseId}: ` : ""}${body.reason}${this.chosenRank(record, body.caseId)}`,
    });
    record.processing = {};
    record.status = "PROCESSING";
    await this.save(record, previous?.caseId ?? null);
    await this.run(record, process);
    return record;
  }
}
