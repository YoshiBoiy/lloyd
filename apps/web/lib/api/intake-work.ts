/**
 * The six-queue projection over two trust domains (workspace TDD §3, §4).
 *
 * Tabs are a projection, never new state: nothing here invents a device stage or a backend
 * status, every work item lands in exactly one tab, and the counts therefore sum to the total.
 * Membership answers one question — who must act next.
 *
 * The merge happens in the browser because the browser is the only component that legitimately
 * sees both domains: the gateway answers a locally paired client, the backend answers a
 * tenant-scoped reviewer, and no hosted server may stand between the operator and device
 * review data. Either domain can fail without hiding the other's work, and a domain that did
 * not answer produces a `null` count rather than a zero.
 */
import type { V2IntakeSummary, V2Stage } from "./edge-v2";
import type {
  IntakeRejection,
  IntakeStatusValue,
  IntakeTab,
  IntakeWorkItem,
  IntakeWorkResult,
} from "./types";

export const INTAKE_TABS: {
  id: IntakeTab;
  label: string;
  owner: string;
  help: string;
}[] = [
  {
    id: "ready",
    label: "Ready to Scan",
    owner: "Operator",
    help: "Capture or upload another page, then analyze. Quality rejections land here too: photographing the page again is the normal capture loop, not a failure.",
  },
  {
    id: "processing",
    label: "Processing",
    owner: "Machine",
    help: "On-device OCR, classification and sanitization, or cloud processing after acceptance. Nothing to do but watch which stage and which domain.",
  },
  {
    id: "privacy_review",
    label: "Needs Privacy Review",
    owner: "Reviewer",
    help: "Read the sanitized blocks, add redactions, approve and release. Approval is required for every release; the risk flags only say where to look first.",
  },
  {
    id: "unmatched",
    label: "Unmatched",
    owner: "Reviewer",
    help: "Accepted releases with no case. Confirm a ranked candidate or enter a case id; nothing is associated automatically.",
  },
  {
    id: "attached",
    label: "Attached",
    owner: "None",
    help: "Attached to a case. Accepted by the backend and all cloud processing completed are separate facts; an unavailable provider is a retryable warning on an attached document.",
  },
  {
    id: "failed",
    label: "Failed",
    owner: "Operator or administrator",
    help: "Device failures and refused releases. Transport failures retry the same approved envelope; a digest conflict needs a new intake.",
  },
];

/**
 * Device stages the operator or the device still owns. `ACCEPTED` and `ORIGINAL_EXPIRED` are
 * absent on purpose: once the cloud holds the release, the backend record says who acts next.
 */
export const DEVICE_TAB: Partial<Record<V2Stage, IntakeTab>> = {
  CAPTURED: "ready",
  PREPROCESSED: "ready",
  RECAPTURE_REQUIRED: "ready",
  OCR_COMPLETE: "processing",
  ANALYZED: "processing",
  SANITIZED: "processing",
  RELEASE_PENDING: "processing",
  REVIEW_READY: "privacy_review",
  APPROVED: "privacy_review",
  BLOCKED: "failed",
  RELEASE_FAILED: "failed",
  LOCAL_MODEL_UNAVAILABLE: "failed",
  ORIGINAL_EXPIRED: "failed",
};

export const BACKEND_TAB: Record<IntakeStatusValue, IntakeTab> = {
  AWAITING_ASSOCIATION: "unmatched",
  PROCESSING: "processing",
  PROCESSED: "attached",
  PROCESSED_WITH_WARNINGS: "attached",
};

/** Stages after which the device has handed the document over and stops deciding the queue. */
const HANDED_OVER: V2Stage[] = ["ACCEPTED", "ORIGINAL_EXPIRED"];

export function tabForStage(stage: V2Stage): IntakeTab | null {
  return DEVICE_TAB[stage] ?? null;
}

export function tabForStatus(status: IntakeStatusValue): IntakeTab {
  return BACKEND_TAB[status];
}

/** Bounded metadata row from `GET /v2/intakes`; see gateway `intake_summary`. */
export type DeviceIntakeRow = V2IntakeSummary;

/** Backend row, narrowed to what the queue needs from `GET /api/intakes`. */
export interface BackendIntakeRow {
  intakeId: string;
  documentId: string;
  deviceId: string;
  revision: number;
  receivedAt: string;
  status: IntakeStatusValue;
  association: { caseId: string } | null;
  classification: { documentType: string };
  processing: Record<string, unknown>;
  audit: { at: string }[];
}

const EMPTY_COUNTS = (): Record<IntakeTab, number> => ({
  ready: 0,
  processing: 0,
  privacy_review: 0,
  unmatched: 0,
  attached: 0,
  failed: 0,
});

/** Which domains can put an item in a given tab, and therefore whose silence makes it unknown. */
const TAB_DOMAINS: Record<IntakeTab, ("device" | "backend")[]> = {
  ready: ["device"],
  processing: ["device", "backend"],
  privacy_review: ["device"],
  unmatched: ["backend"],
  attached: ["backend"],
  failed: ["device", "backend"],
};

export function warningsOf(processing: Record<string, unknown>): string[] {
  return Object.entries(processing)
    .filter(([, value]) =>
      /UNAVAILABLE|REJECTED/.test(
        String(
          (value as { status?: string } | null)?.status ?? "",
        ),
      ),
    )
    .map(([provider]) => provider);
}

/**
 * Join the two domains on `intakeId` and place each item in exactly one tab.
 *
 * `deviceReachable` / `backendReachable` are separate from empty results: an unreachable domain
 * makes every tab it contributes to unknown (`null`), because rendering `0` would assert there
 * is no local work when the truth is simply unknown.
 */
export function mergeIntakeWork(input: {
  device: DeviceIntakeRow[] | null;
  backend: BackendIntakeRow[] | null;
  rejections?: IntakeRejection[] | null;
  /** Why a domain is silent, so the UI can say "not authorized" rather than "did not answer". */
  deviceReason?: string | null;
  backendReason?: string | null;
}): IntakeWorkResult {
  const device = input.device ?? [];
  const backend = input.backend ?? [];
  const rejections = input.rejections ?? [];
  const deviceReachable = input.device !== null;
  const backendReachable = input.backend !== null;

  interface Group {
    device?: DeviceIntakeRow;
    backend?: BackendIntakeRow;
    rejection?: IntakeRejection;
  }
  const byId = new Map<string, Group>();
  const slot = (intakeId: string): Group => {
    const existing = byId.get(intakeId);
    if (existing) return existing;
    const created: Group = {};
    byId.set(intakeId, created);
    return created;
  };
  for (const row of device) slot(row.intakeId).device = row;
  for (const row of backend) slot(row.intakeId).backend = row;
  for (const row of rejections) {
    // Only the newest rejection per intake is shown; the rest stay in the audit list.
    const target = slot(row.intakeId);
    if (!target.rejection || row.at > target.rejection.at)
      target.rejection = row;
  }

  const items: IntakeWorkItem[] = [];
  for (const [intakeId, group] of byId) {
    const { device: d, backend: b, rejection } = group;
    const deviceOwns = d ? !HANDED_OVER.includes(d.stage) : false;
    const tab: IntakeTab = deviceOwns
      ? (tabForStage(d!.stage) ?? "failed")
      : rejection
        ? "failed"
        : b
          ? tabForStatus(b.status)
          : d?.stage === "ACCEPTED"
            ? // The device holds a receipt; the cloud has not reported yet.
              "processing"
            : "failed";
    items.push({
      intakeId,
      origin: d && b ? "both" : d ? "device" : "backend",
      tab,
      ...(d ? { stage: d.stage } : {}),
      ...(b ? { status: b.status } : {}),
      revision: d?.revision ?? b?.revision ?? 0,
      reviewRisk: d?.reviewRisk.reasons ?? [],
      riskProvisional: d?.reviewRisk.provisional ?? false,
      caseId: d?.caseId ?? b?.association?.caseId ?? null,
      documentType:
        d?.classification?.documentType ??
        b?.classification.documentType ??
        "unknown",
      pageCount: d?.pageCount ?? 0,
      deviceId: b?.deviceId ?? null,
      qualityStatus: d?.quality?.status ?? null,
      approvalExpiresAt: d?.approvalExpiresAt ?? null,
      releaseError: d?.releaseError ?? null,
      rejection: rejection ?? null,
      warnings: b ? warningsOf(b.processing) : [],
      updatedAt: d?.updatedAt ?? b?.receivedAt ?? "",
    });
  }
  items.sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.intakeId.localeCompare(b.intakeId),
  );

  const known = EMPTY_COUNTS();
  for (const item of items) known[item.tab] += 1;
  const counts = {} as Record<IntakeTab, number | null>;
  for (const tab of Object.keys(known) as IntakeTab[]) {
    const silent = TAB_DOMAINS[tab].some((domain) =>
      domain === "device" ? !deviceReachable : !backendReachable,
    );
    counts[tab] = silent ? null : known[tab];
  }
  return {
    items,
    counts,
    knownCounts: known,
    deviceReachable,
    backendReachable,
    deviceReason: deviceReachable ? null : (input.deviceReason ?? null),
    backendReason: backendReachable ? null : (input.backendReason ?? null),
  };
}
