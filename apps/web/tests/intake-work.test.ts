import { describe, expect, it } from "vitest";
import {
  INTAKE_TABS,
  mergeIntakeWork,
  type BackendIntakeRow,
  type DeviceIntakeRow,
} from "../lib/api/intake-work";
import type { IntakeRejection, IntakeStatusValue, IntakeTab } from "../lib/api/types";
import type { V2Stage } from "../lib/api/edge-v2";

const STAGES: V2Stage[] = [
  "CAPTURED",
  "PREPROCESSED",
  "OCR_COMPLETE",
  "RECAPTURE_REQUIRED",
  "ANALYZED",
  "LOCAL_MODEL_UNAVAILABLE",
  "SANITIZED",
  "REVIEW_READY",
  "APPROVED",
  "RELEASE_PENDING",
  "RELEASE_FAILED",
  "ACCEPTED",
  "BLOCKED",
  "ORIGINAL_EXPIRED",
];

const STATUSES: IntakeStatusValue[] = [
  "AWAITING_ASSOCIATION",
  "PROCESSING",
  "PROCESSED",
  "PROCESSED_WITH_WARNINGS",
];

function deviceRow(intakeId: string, stage: V2Stage, over: Partial<DeviceIntakeRow> = {}): DeviceIntakeRow {
  return {
    intakeId,
    documentId: `doc-${intakeId}`,
    revision: 1,
    stage,
    caseId: null,
    pageCount: 1,
    quality: { status: "PASS", reasons: [] },
    classification: null,
    matchHints: null,
    reviewRisk: { reasons: [], policyVersion: "review-risk-v1-provisional", provisional: true },
    approvalExpiresAt: null,
    releaseError: null,
    updatedAt: "2026-09-19T15:00:00.000Z",
    retentionUntil: null,
    originalDeleted: false,
    ...over,
  };
}

function backendRow(
  intakeId: string,
  status: IntakeStatusValue,
  over: Partial<BackendIntakeRow> = {},
): BackendIntakeRow {
  return {
    intakeId,
    documentId: `doc-${intakeId}`,
    deviceId: "rdk-x5-test",
    revision: 1,
    receivedAt: "2026-09-19T15:01:00.000Z",
    status,
    association: null,
    classification: { documentType: "loss_run" },
    processing: {},
    audit: [],
    ...over,
  };
}

const rejection = (intakeId: string, code: string): IntakeRejection => ({
  at: "2026-09-19T14:00:00.000Z",
  tenantId: "tenant-test",
  deviceId: "rdk-x5-test",
  intakeId,
  revision: 1,
  identity: "f".repeat(64),
  code,
  verified: false,
});

describe("intake work partition", () => {
  it("places every stage/status combination in exactly one tab, with counts summing to the total", () => {
    const device: DeviceIntakeRow[] = [];
    const backend: BackendIntakeRow[] = [];
    // Every device stage on its own, every backend status on its own, and all 56 pairs.
    STAGES.forEach((stage, i) => device.push(deviceRow(`device-${i}`, stage)));
    STATUSES.forEach((status, i) => backend.push(backendRow(`backend-${i}`, status)));
    for (const [i, stage] of STAGES.entries())
      for (const [j, status] of STATUSES.entries()) {
        const id = `both-${i}-${j}`;
        device.push(deviceRow(id, stage));
        backend.push(backendRow(id, status));
      }

    const work = mergeIntakeWork({ device, backend });
    const expectedTotal = STAGES.length + STATUSES.length + STAGES.length * STATUSES.length;
    expect(work.items).toHaveLength(expectedTotal);
    // One row per intake: the two domains collapse rather than double-count.
    expect(new Set(work.items.map((item) => item.intakeId)).size).toBe(expectedTotal);
    const tabs = new Set(INTAKE_TABS.map((entry) => entry.id));
    for (const item of work.items) expect(tabs.has(item.tab)).toBe(true);
    const sum = (Object.values(work.counts) as (number | null)[]).reduce<number>(
      (total, value) => total + (value ?? 0),
      0,
    );
    expect(sum).toBe(expectedTotal);
    expect(work.counts).toEqual(work.knownCounts);
  });

  it("lets the device own the queue until it hands the document over", () => {
    const one = (stage: V2Stage, status: IntakeStatusValue): IntakeTab =>
      mergeIntakeWork({
        device: [deviceRow("x", stage)],
        backend: [backendRow("x", status)],
      }).items[0]!.tab;
    // A device still holding work keeps it, whatever the backend says about an earlier revision.
    expect(one("REVIEW_READY", "PROCESSED")).toBe("privacy_review");
    expect(one("RECAPTURE_REQUIRED", "PROCESSED")).toBe("ready");
    expect(one("RELEASE_FAILED", "AWAITING_ASSOCIATION")).toBe("failed");
    // Once released and accepted, the backend record decides who acts next.
    expect(one("ACCEPTED", "AWAITING_ASSOCIATION")).toBe("unmatched");
    expect(one("ACCEPTED", "PROCESSED_WITH_WARNINGS")).toBe("attached");
    expect(one("ORIGINAL_EXPIRED", "PROCESSED")).toBe("attached");
  });

  it("keeps an expired approval out of Failed, because the gateway reopens it for review", () => {
    // The gateway bumps the revision back to REVIEW_READY rather than failing the intake.
    const work = mergeIntakeWork({ device: [deviceRow("x", "REVIEW_READY", { revision: 2 })], backend: [] });
    expect(work.items[0]!.tab).toBe("privacy_review");
    expect(work.counts.failed).toBe(0);
  });

  it("files a refused release under Failed even though the inbox never recorded it", () => {
    const work = mergeIntakeWork({
      device: [deviceRow("x", "RELEASE_FAILED", { releaseError: "BAD_SIGNATURE" })],
      backend: [],
      rejections: [rejection("x", "BAD_SIGNATURE"), rejection("y", "DEVICE_DENIED")],
    });
    expect(work.items.map((item) => item.tab)).toEqual(["failed", "failed"]);
    // A cloud-only refusal still has a row, joined to the device one by intakeId where both exist.
    const cloudOnly = work.items.find((item) => item.intakeId === "y")!;
    expect(cloudOnly.origin).toBe("backend");
    expect(cloudOnly.rejection?.code).toBe("DEVICE_DENIED");
  });

  it("reports unknown counts for a silent domain and leaves the other domain's tabs intact", () => {
    const device = [deviceRow("d", "REVIEW_READY")];
    const backend = [backendRow("b", "AWAITING_ASSOCIATION")];

    const deviceDown = mergeIntakeWork({ device: null, backend });
    expect(deviceDown.deviceReachable).toBe(false);
    // Device-only queues are unknown, never a false zero.
    expect(deviceDown.counts.ready).toBeNull();
    expect(deviceDown.counts.privacy_review).toBeNull();
    // Tabs both domains fill are unknown too: the known rows are still listed.
    expect(deviceDown.counts.failed).toBeNull();
    expect(deviceDown.counts.unmatched).toBe(1);
    expect(deviceDown.counts.attached).toBe(0);
    expect(deviceDown.items).toHaveLength(1);

    const backendDown = mergeIntakeWork({ device, backend: null });
    expect(backendDown.counts.privacy_review).toBe(1);
    expect(backendDown.counts.unmatched).toBeNull();
    expect(backendDown.counts.attached).toBeNull();
    expect(backendDown.knownCounts.privacy_review).toBe(1);
  });

  it("treats an unavailable provider on an attached document as a warning, not a failure", () => {
    const work = mergeIntakeWork({
      device: [],
      backend: [
        backendRow("x", "PROCESSED_WITH_WARNINGS", {
          association: { caseId: "case:1001" },
          processing: {
            gemini: { status: "CANDIDATE_UNVERIFIED" },
            elasticsearch: { status: "UNAVAILABLE" },
          },
        }),
      ],
    });
    expect(work.items[0]!.tab).toBe("attached");
    expect(work.items[0]!.warnings).toEqual(["elasticsearch"]);
    expect(work.items[0]!.caseId).toBe("case:1001");
  });
});
