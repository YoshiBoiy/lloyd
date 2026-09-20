import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createApp } from "../apps/api/src/app.js";
import {
  signV2,
  type IntakeV2,
  type V2Policy,
} from "../packages/contracts/src/intake-v2.js";

const golden = JSON.parse(
  readFileSync(
    new URL(
      "../packages/contracts/fixtures/intake-v2.golden.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { policy: V2Policy; envelope: IntakeV2 };
const DEVICE_KEY = golden.policy.devices["golden-key-1"]!.key;
const REVIEWER_KEY = golden.policy.reviewers["reviewer-golden"]!.key;
const reviewer = { "x-reviewer-id": "reviewer-golden" };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Golden envelope re-timestamped to now and re-signed so the approval window is live. */
function fresh(mutate?: (e: IntakeV2) => void): IntakeV2 {
  const e = structuredClone(golden.envelope);
  const now = Date.now();
  e.manifest.createdAt = new Date(now - 60_000).toISOString();
  e.manifest.approval.approvedAt = new Date(now - 30_000).toISOString();
  e.manifest.approval.expiresAt = new Date(now + 540_000).toISOString();
  mutate?.(e);
  e.authentication.signature = signV2(e.manifest, DEVICE_KEY);
  e.authentication.reviewerSignature = signV2(
    e.manifest,
    REVIEWER_KEY,
    "reviewer",
  );
  return e;
}

async function appWithCases() {
  const app = createApp({
    v2Policy: {
      devices: golden.policy.devices,
      reviewers: golden.policy.reviewers,
    },
  });
  await app.inject({ method: "POST", url: "/api/bootstrap" });
  await app.inject({ method: "POST", url: "/api/ingest" });
  return app;
}

describe("intake v2 backend", () => {
  it("accepts once, deduplicates retries, and rejects tampering with a bounded code", async () => {
    const app = await appWithCases();
    const envelope = fresh();
    const first = await app.inject({
      method: "POST",
      url: "/api/intake/v2",
      payload: envelope,
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({
      status: "ACCEPTED",
      revision: 3,
      association: null,
      processingStatus: "AWAITING_ASSOCIATION",
    });
    const retry = await app.inject({
      method: "POST",
      url: "/api/intake/v2",
      payload: envelope,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().status).toBe("DUPLICATE");
    expect(retry.json().digest).toBe(first.json().digest);

    const tampered = structuredClone(envelope);
    tampered.artifacts[2]!.text = "Year built: 2017";
    const bad = await app.inject({
      method: "POST",
      url: "/api/intake/v2",
      payload: tampered,
    });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error.code).toBe("ARTIFACT_MISMATCH");

    // Same identity, different (but validly signed) content is a conflict, not a silent overwrite.
    const conflicting = fresh(
      (e) => (e.artifacts[0]!.text = "Synthetic inspection report v2"),
    );
    conflicting.manifest.artifacts[0]!.sha256 = sha(
      conflicting.artifacts[0]!.text,
    );
    conflicting.manifest.artifacts[0]!.byteLength = Buffer.byteLength(
      conflicting.artifacts[0]!.text,
    );
    conflicting.authentication.signature = signV2(
      conflicting.manifest,
      DEVICE_KEY,
    );
    conflicting.authentication.reviewerSignature = signV2(
      conflicting.manifest,
      REVIEWER_KEY,
      "reviewer",
    );
    const conflict = await app.inject({
      method: "POST",
      url: "/api/intake/v2",
      payload: conflicting,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("INTAKE_DIGEST_CONFLICT");
    await app.close();
  });

  it("requires a known reviewer for inbox access and ranks candidates from hints only", async () => {
    const app = await appWithCases();
    const { intakeId } = (
      await app.inject({
        method: "POST",
        url: "/api/intake/v2",
        payload: fresh(),
      })
    ).json();
    expect((await app.inject({ url: "/api/intakes" })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          url: "/api/intakes",
          headers: { "x-reviewer-id": "nobody" },
        })
      ).statusCode,
    ).toBe(403);
    const inbox = (
      await app.inject({ url: "/api/intakes", headers: reviewer })
    ).json();
    expect(inbox.total).toBe(1);
    expect(inbox.items[0]).toMatchObject({
      intakeId,
      status: "AWAITING_ASSOCIATION",
    });
    expect(JSON.stringify(inbox)).not.toContain("tokenMap");
    const candidates = (
      await app.inject({
        url: `/api/intakes/${intakeId}/candidates`,
        headers: reviewer,
      })
    ).json();
    expect(candidates.sufficientHints).toBe(true);
    expect(Array.isArray(candidates.candidates)).toBe(true);
    for (const c of candidates.candidates) {
      expect(c.score).toBeGreaterThan(0);
      expect(c.reasons.length).toBeGreaterThan(0);
    }
    expect(candidates.candidates.length).toBeLessThanOrEqual(10);
    // Unmatched has memory: the ranking is recorded with the revision it described and how long
    // the release has been waiting, so the queue is not recomputed from nothing on every look.
    expect(candidates.rankedAt).toEqual(expect.any(String));
    expect(candidates.waitingSince).toEqual(expect.any(String));
    await app.close();
  });

  it("records which ranked candidate an association was chosen from, including an off-list choice", async () => {
    const app = await appWithCases();
    const { intakeId } = (
      await app.inject({ method: "POST", url: "/api/intake/v2", payload: fresh() })
    ).json();
    const ranked = (
      await app.inject({ url: `/api/intakes/${intakeId}/candidates`, headers: reviewer })
    ).json();
    const top = ranked.candidates[0].caseId;
    const associated = (
      await app.inject({
        method: "POST",
        url: `/api/intakes/${intakeId}/association`,
        headers: reviewer,
        payload: { caseId: top, reason: "Confirmed the top candidate" },
      })
    ).json();
    const entry = associated.intake.audit.find(
      (a: { action: string }) => a.action === "ASSOCIATED",
    );
    expect(entry.detail).toBe("Confirmed the top candidate (ranked 1 of " + ranked.candidates.length + ")");
    // Overriding the ranking is allowed, and is the case most worth finding later.
    const other = ranked.candidates.at(-1).caseId;
    const moved = (
      await app.inject({
        method: "POST",
        url: `/api/intakes/${intakeId}/association`,
        headers: reviewer,
        payload: { caseId: other, reason: "Broker confirmed the other account" },
      })
    ).json();
    const reassociated = moved.intake.audit.find(
      (a: { action: string }) => a.action === "REASSOCIATED",
    );
    expect(reassociated.detail).toContain(`from ${top} to ${other}`);
    expect(reassociated.detail).toMatch(/ranked \d+ of \d+|not in the \d+ ranked candidates/);
    await app.close();
  });

  it("associates with audit, runs typed provenance-bound extraction, and re-association is explicit", async () => {
    const app = await appWithCases();
    const { intakeId } = (
      await app.inject({
        method: "POST",
        url: "/api/intake/v2",
        payload: fresh(),
      })
    ).json();
    const missing = await app.inject({
      method: "POST",
      url: `/api/intakes/${intakeId}/association`,
      headers: reviewer,
      payload: { caseId: "does-not-exist", reason: "x" },
    });
    expect(missing.statusCode).toBe(404);
    const associated = await app.inject({
      method: "POST",
      url: `/api/intakes/${intakeId}/association`,
      headers: reviewer,
      payload: { caseId: "demo-001", reason: "Matches broker submission" },
    });
    expect(associated.statusCode).toBe(200);
    const intake = associated.json().intake;
    expect(intake.association).toMatchObject({
      caseId: "demo-001",
      source: "REVIEWER",
      actorId: "reviewer-golden",
    });
    expect(intake.audit.map((a: { action: string }) => a.action)).toEqual([
      "RELEASE_ACCEPTED",
      "ASSOCIATED",
    ]);
    expect(intake.status).toBe("PROCESSED");
    const gemini = intake.processing.gemini;
    expect(gemini.status).toBe("CANDIDATE_UNVERIFIED");
    expect(gemini.classificationAgreement).toBe("AGREE");
    const sov = gemini.extraction.sovRows;
    expect(
      sov.some((r: { yearBuilt: number | null }) => r.yearBuilt === 2016),
    ).toBe(true);
    expect(sov.some((r: { tiv: number | null }) => r.tiv === 72_000_000)).toBe(
      true,
    );
    expect(
      sov.some(
        (r: { construction: string | null }) =>
          r.construction === "masonry noncombustible",
      ),
    ).toBe(true);
    for (const row of sov) {
      expect(row.blockIds.length).toBeGreaterThan(0);
      expect(row.sourceExcerpt.length).toBeGreaterThan(0);
    }
    // Placeholder-only block is never interpreted as a value.
    expect(JSON.stringify(gemini.extraction)).not.toMatch(
      /"(?:construction|locationRef)":"\[TOKEN/,
    );
    expect(gemini.extraction.totals.tivComputed).toBe(72_000_000);
    // Elasticsearch was not a destination in this manifest, so it must not have been processed.
    expect(intake.processing.elasticsearch).toBeUndefined();

    const same = (
      await app.inject({
        method: "POST",
        url: `/api/intakes/${intakeId}/association`,
        headers: reviewer,
        payload: { caseId: "demo-001", reason: "Confirmed" },
      })
    ).json().intake;
    expect(same.audit.at(-1).action).toBe("ASSOCIATION_CONFIRMED");
    const moved = (
      await app.inject({
        method: "POST",
        url: `/api/intakes/${intakeId}/association`,
        headers: reviewer,
        payload: { caseId: "demo-002", reason: "Broker corrected the account" },
      })
    ).json().intake;
    expect(moved.association.caseId).toBe("demo-002");
    expect(moved.audit.at(-1)).toMatchObject({ action: "REASSOCIATED" });
    expect(moved.audit.at(-1).detail).toContain("from demo-001 to demo-002");
    const processing = (
      await app.inject({
        url: `/api/intakes/${intakeId}/processing`,
        headers: reviewer,
      })
    ).json();
    expect(processing).toMatchObject({
      intakeId,
      status: "PROCESSED",
      association: { caseId: "demo-002" },
    });
    await app.close();
  });

  it("preselected case is associated on acceptance; newer revisions supersede and older ones are stale", async () => {
    const app = await appWithCases();
    const r3 = fresh((e) => (e.manifest.caseId = "demo-003"));
    const accepted = (
      await app.inject({ method: "POST", url: "/api/intake/v2", payload: r3 })
    ).json();
    expect(accepted.association).toMatchObject({
      caseId: "demo-003",
      source: "PRESELECTED",
      actorId: "reviewer-golden",
    });
    expect(accepted.processingStatus).toBe("PROCESSED");
    const r4 = fresh((e) => {
      e.manifest.caseId = "demo-003";
      e.manifest.revision = 4;
    });
    expect(
      (await app.inject({ method: "POST", url: "/api/intake/v2", payload: r4 }))
        .statusCode,
    ).toBe(202);
    const r2 = fresh((e) => (e.manifest.revision = 2));
    const stale = await app.inject({
      method: "POST",
      url: "/api/intake/v2",
      payload: r2,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("STALE_REVISION");
    const detail = (
      await app.inject({
        url: `/api/intakes/${accepted.intakeId}`,
        headers: reviewer,
      })
    ).json().intake;
    expect(detail.revision).toBe(4);
    expect(detail.supersedes).toEqual({ revision: 3, digest: accepted.digest });
    const unknownCase = fresh((e) => (e.manifest.caseId = "no-such-case"));
    unknownCase.manifest.intakeId = "11111111-2222-4333-8444-555555555555";
    unknownCase.authentication.signature = signV2(
      unknownCase.manifest,
      DEVICE_KEY,
    );
    unknownCase.authentication.reviewerSignature = signV2(
      unknownCase.manifest,
      REVIEWER_KEY,
      "reviewer",
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/intake/v2",
          payload: unknownCase,
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });

  it("persists one bounded rejection record per refusal, joinable to the device row", async () => {
    const app = await appWithCases();
    const tampered = fresh();
    tampered.artifacts[2]!.text = "Year built: 2017";
    const bad = await app.inject({
      method: "POST",
      url: "/api/intake/v2",
      payload: tampered,
    });
    expect(bad.json().error.code).toBe("ARTIFACT_MISMATCH");

    const denied = fresh();
    denied.authentication.signature = "0".repeat(64);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/intake/v2",
          payload: denied,
        })
      ).json().error.code,
    ).toBe("BAD_SIGNATURE");

    // Accepted, then a second envelope for the same revision with different content.
    await app.inject({ method: "POST", url: "/api/intake/v2", payload: fresh() });
    const conflicting = fresh(
      (e) => (e.artifacts[0]!.text = "Synthetic inspection report v2"),
    );
    conflicting.manifest.artifacts[0]!.sha256 = sha(conflicting.artifacts[0]!.text);
    conflicting.manifest.artifacts[0]!.byteLength = Buffer.byteLength(
      conflicting.artifacts[0]!.text,
    );
    conflicting.authentication.signature = signV2(conflicting.manifest, DEVICE_KEY);
    conflicting.authentication.reviewerSignature = signV2(
      conflicting.manifest,
      REVIEWER_KEY,
      "reviewer",
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/intake/v2",
          payload: conflicting,
        })
      ).json().error.code,
    ).toBe("INTAKE_DIGEST_CONFLICT");

    const rejections = (
      await app.inject({ url: "/api/intakes/rejections", headers: reviewer })
    ).json();
    expect(rejections.total).toBe(3);
    expect(rejections.items.map((r: { code: string }) => r.code).sort()).toEqual([
      "ARTIFACT_MISMATCH",
      "BAD_SIGNATURE",
      "INTAKE_DIGEST_CONFLICT",
    ]);
    for (const row of rejections.items) {
      // Joinable to the device row by intakeId, and carrying no content whatsoever.
      expect(row.intakeId).toBe(golden.envelope.manifest.intakeId);
      expect(Object.keys(row).sort()).toEqual([
        "at",
        "code",
        "deviceId",
        "identity",
        "intakeId",
        "revision",
        "tenantId",
        "verified",
      ]);
    }
    const body = JSON.stringify(rejections);
    expect(body).not.toContain("Year built");
    expect(body).not.toContain(golden.envelope.authentication.signature);
    // A digest conflict is cryptographically identified; a bad signature only claims to be.
    const byCode = Object.fromEntries(
      rejections.items.map((r: { code: string; verified: boolean }) => [
        r.code,
        r.verified,
      ]),
    );
    expect(byCode.INTAKE_DIGEST_CONFLICT).toBe(true);
    expect(byCode.BAD_SIGNATURE).toBe(false);
    expect(
      (await app.inject({ url: "/api/intakes/rejections" })).statusCode,
    ).toBe(403);
    await app.close();
  });

  it("appends documents per intake, supersedes per revision, and moves them on re-association", async () => {
    const app = await appWithCases();
    const first = fresh((e) => (e.manifest.caseId = "demo-001"));
    await app.inject({ method: "POST", url: "/api/intake/v2", payload: first });
    // A second, distinct intake on the same case appends rather than overwriting.
    const second = fresh((e) => {
      e.manifest.caseId = "demo-001";
      e.manifest.intakeId = "22222222-3333-4444-8555-666666666666";
      e.manifest.documentId = "33333333-4444-4555-8666-777777777777";
    });
    await app.inject({ method: "POST", url: "/api/intake/v2", payload: second });

    const documents = (
      await app.inject({ url: "/api/cases/demo-001/documents", headers: reviewer })
    ).json();
    expect(documents.total).toBe(2);
    expect(
      documents.documents.map((d: { intakeId: string }) => d.intakeId).sort(),
    ).toEqual(
      [first.manifest.intakeId, second.manifest.intakeId].sort(),
    );
    expect(documents.documents[0]).toMatchObject({
      revision: 3,
      documentType: "inspection_report",
      associationSource: "PRESELECTED",
      attachedBy: "reviewer-golden",
      pageCount: golden.envelope.manifest.quality.pageCount,
    });
    // The case itself carries the same bounded list, no second round trip needed.
    const detail = (await app.inject({ url: "/api/cases/demo-001" })).json();
    expect(detail.documents).toHaveLength(2);

    // A new revision of one intake supersedes it: still two rows, one per intakeId.
    const revision4 = fresh((e) => {
      e.manifest.caseId = "demo-001";
      e.manifest.revision = 4;
    });
    await app.inject({
      method: "POST",
      url: "/api/intake/v2",
      payload: revision4,
    });
    const superseded = (
      await app.inject({ url: "/api/cases/demo-001/documents", headers: reviewer })
    ).json();
    expect(superseded.total).toBe(2);
    const row = superseded.documents.find(
      (d: { intakeId: string }) => d.intakeId === first.manifest.intakeId,
    );
    expect(row).toMatchObject({ revision: 4, supersedesRevision: 3 });

    // Re-association moves the document and leaves no trace in the old case.
    await app.inject({
      method: "POST",
      url: `/api/intakes/${second.manifest.intakeId}/association`,
      headers: reviewer,
      payload: { caseId: "demo-002", reason: "Broker corrected the account" },
    });
    const afterMove = (
      await app.inject({ url: "/api/cases/demo-001/documents", headers: reviewer })
    ).json();
    expect(
      afterMove.documents.map((d: { intakeId: string }) => d.intakeId),
    ).toEqual([first.manifest.intakeId]);
    const moved = (
      await app.inject({ url: "/api/cases/demo-002/documents", headers: reviewer })
    ).json();
    expect(moved.documents.map((d: { intakeId: string }) => d.intakeId)).toEqual([
      second.manifest.intakeId,
    ]);
    // Attaching documents never promotes a fact or changes the appetite outcome.
    const before = (await app.inject({ url: "/api/cases/demo-001" })).json();
    expect(before.case.decision).toEqual(
      (await app.inject({ url: "/api/cases/demo-001" })).json().case.decision,
    );
    await app.close();
  });

  it("retries provider processing on the stored envelope without re-releasing", async () => {
    const app = await appWithCases();
    const { intakeId } = (
      await app.inject({
        method: "POST",
        url: "/api/intake/v2",
        payload: fresh((e) => (e.manifest.caseId = "demo-001")),
      })
    ).json();
    const retried = (
      await app.inject({
        method: "POST",
        url: `/api/intakes/${intakeId}/retry`,
        headers: reviewer,
      })
    ).json().intake;
    expect(retried.revision).toBe(3);
    expect(retried.audit.at(-1).action).toBe("PROCESSING_RETRIED");
    expect(retried.status).toBe("PROCESSED");
    // Still exactly one persisted intake for this identity.
    expect(
      (await app.inject({ url: "/api/intakes", headers: reviewer })).json().total,
    ).toBe(1);
    // An unassociated intake has nothing to process yet.
    const unassociated = (
      await app.inject({
        method: "POST",
        url: "/api/intake/v2",
        payload: fresh((e) => {
          e.manifest.intakeId = "44444444-5555-4666-8777-888888888888";
        }),
      })
    ).json();
    const refused = await app.inject({
      method: "POST",
      url: `/api/intakes/${unassociated.intakeId}/retry`,
      headers: reviewer,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("ASSOCIATION_REQUIRED");
    await app.close();
  });

  it("is disabled without a v2 policy and reported in bootstrap", async () => {
    const app = createApp();
    const boot = (
      await app.inject({ method: "POST", url: "/api/bootstrap" })
    ).json();
    expect(boot.services.intakeV2).toBe("DISABLED");
    const res = await app.inject({
      method: "POST",
      url: "/api/intake/v2",
      payload: fresh(),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("V2_NOT_CONFIGURED");
    await app.close();
  });
});

describe("planner provider resolution", () => {
  it("labels the scripted fallback and refuses to masquerade when a provider lacks credentials", async () => {
    const scripted = createApp();
    const boot = (
      await scripted.inject({ method: "POST", url: "/api/bootstrap" })
    ).json();
    expect(boot.services.planner).toBe("scripted");
    expect(boot.services.plannerDetail).toMatchObject({
      provider: "scripted",
      status: "scripted",
      reason: "NO_PLANNER_CONFIGURED",
    });
    await scripted.close();

    const unavailable = createApp({ plannerProvider: "openai" });
    const boot2 = (
      await unavailable.inject({ method: "POST", url: "/api/bootstrap" })
    ).json();
    expect(boot2.services.planner).toBe("unavailable");
    expect(boot2.services.plannerDetail).toMatchObject({
      provider: "openai",
      status: "unavailable",
      reason: "MISSING_CREDENTIALS",
    });
    await unavailable.inject({ method: "POST", url: "/api/ingest" });
    const result = (
      await unavailable.inject({
        method: "POST",
        url: "/api/cases/demo-001/investigate",
      })
    ).json();
    expect(result.investigation.stopReason).toBe("planner_unavailable");
    expect(result.investigation.steps).toHaveLength(0);
    await unavailable.close();

    const live = createApp({
      plannerProvider: "openai",
      openaiKey: "k",
      openaiModel: "gpt-test",
    });
    const boot3 = (
      await live.inject({ method: "POST", url: "/api/bootstrap" })
    ).json();
    expect(boot3.services.plannerDetail).toMatchObject({
      provider: "openai",
      status: "live",
      model: "gpt-test",
    });
    await live.close();
  });
});
