"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Link2, RotateCcw, ScanLine } from "lucide-react";
import { getLloydApi } from "@/lib/api";
import { formatPercent, formatTimestamp } from "@/lib/format";
import type {
  IntakeCandidatesResponse,
  IntakeInboxItem,
  IntakeWorkItem,
} from "@/lib/api/types";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";

const RISK_HELP: Record<string, string> = {
  CLASSIFIER_ABSTAINED: "The local classifier would not commit to a document type.",
  LOW_CLASSIFIER_CONFIDENCE: "Confidence is below the policy threshold for this document type.",
  SEMANTIC_ONLY_DETECTIONS:
    "The semantic detector found identifiers the deterministic patterns missed — read those blocks closely.",
  QUALITY_REVIEW: "Page quality needs an explicit acknowledgment before release.",
  HEAVY_REDACTION: "Most blocks are redacted; the derivative may no longer be useful evidence.",
  INSUFFICIENT_HINTS:
    "Hints cannot rank a case, so this release would land in Unmatched. Fixable before release.",
};

/**
 * Allowed action per failure, from the retry semantics table (workspace TDD §7). Only a transport
 * failure may retransmit the same envelope; a digest conflict needs a new intake, because a
 * released revision is immutable and re-signing it would forge provenance.
 */
export function failureGuidance(item: IntakeWorkItem): {
  cause: string;
  action: string;
  retry: "release" | null;
} {
  if (item.rejection) {
    const code = item.rejection.code;
    const cause = `The backend refused this release: ${code}.`;
    if (code === "INTAKE_DIGEST_CONFLICT" || code === "STALE_REVISION")
      return {
        cause,
        action: "The released revision is immutable. Start a new intake; never re-sign this one.",
        retry: null,
      };
    if (code === "BAD_SIGNATURE" || code === "DEVICE_DENIED" || code === "REVIEWER_DENIED")
      return {
        cause,
        action:
          "Administrator action: check the device and reviewer key bindings, and any rotation window.",
        retry: null,
      };
    if (code === "MODEL_UNAVAILABLE")
      return {
        cause,
        action: "Restore the model bundle on the device, then capture and release again.",
        retry: null,
      };
    if (code === "QUALITY_BLOCKED")
      return {
        cause,
        action: "Recapture the page, or acknowledge the quality warnings during review.",
        retry: null,
      };
    return {
      cause,
      action: "The remedy depends on the code; the rejection record itself carries no document content.",
      retry: null,
    };
  }
  if (item.stage === "RELEASE_FAILED")
    return item.releaseError === "TRANSPORT"
      ? {
          cause: "The backend was unreachable or returned a server error.",
          action:
            "Retry the same approved envelope. The backend deduplicates on identity plus digest and returns the stored receipt, so a retry cannot create a second intake.",
          retry: "release",
        }
      : {
          cause: "The backend holds a different digest for this approved revision.",
          action: "The released revision is immutable. Start a new intake; the conflict is recorded.",
          retry: null,
        };
  if (item.stage === "BLOCKED")
    return {
      cause: "Analysis hit a hard limit, or the detector raised.",
      action: "Split the document or recapture it. There is no release path from here.",
      retry: null,
    };
  if (item.stage === "LOCAL_MODEL_UNAVAILABLE")
    return {
      cause: "The on-device classifier or semantic detector is not ready.",
      action:
        "Restore the model bundle. A degraded path may capture but never release; there is no regex fallback.",
      retry: null,
    };
  if (item.stage === "ORIGINAL_EXPIRED")
    return {
      cause: "Retention elapsed before this intake was released.",
      action: "Terminal. The raw pages are gone; the audit metadata is retained.",
      retry: null,
    };
  return {
    cause: "This item is in the failed queue.",
    action: "No automatic action is available.",
    retry: null,
  };
}

/**
 * Everything known about one work item, and the one action its queue allows.
 *
 * Which facts exist depends on which domain holds the item: a device-only row has stages and
 * review risk but no receipt, a backend-only row has a receipt and sanitized text but no stage,
 * and a refused release exists on the device with only a bounded rejection record beside it.
 */
export function IntakeDetailPanel({
  item,
  onChanged,
}: {
  item: IntakeWorkItem;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<IntakeInboxItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setMessage(null);
    if (!item.status) return;
    getLloydApi()
      .listIntakes()
      .then((rows) => {
        if (!cancelled) setDetail(rows.find((row) => row.intakeId === item.intakeId) ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [item.intakeId, item.status, item.revision]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  const guidance = item.tab === "failed" ? failureGuidance(item) : null;

  return (
    <div className="space-y-3">
      <Panel title="Item">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
          <dt className="text-muted">Intake</dt>
          <dd className="tabular">
            {item.intakeId} · revision {item.revision}
          </dd>
          <dt className="text-muted">Known by</dt>
          <dd>
            {item.origin === "both"
              ? "the device and the backend"
              : item.origin === "device"
                ? "the device only — the backend has no record of it"
                : "the backend only — no device record, so the original may already be gone"}
          </dd>
          <dt className="text-muted">Document type</dt>
          <dd>
            {item.documentType.replaceAll("_", " ")}
            {detail ? (
              <>
                {" "}
                · {formatPercent(detail.classification.confidence * 100)} · {detail.classification.modelId} ·{" "}
                {detail.classification.calibration.toLowerCase()}
              </>
            ) : (
              <span className="text-muted"> (local classification, unverified)</span>
            )}
          </dd>
          {item.pageCount ? (
            <>
              <dt className="text-muted">Pages</dt>
              <dd className="tabular">{item.pageCount}</dd>
            </>
          ) : null}
          {item.qualityStatus ? (
            <>
              <dt className="text-muted">Quality</dt>
              <dd>{item.qualityStatus}</dd>
            </>
          ) : null}
          {item.stage === "APPROVED" && item.approvalExpiresAt ? (
            <>
              <dt className="text-muted">Approval expires</dt>
              <dd>
                {formatTimestamp(item.approvalExpiresAt)}{" "}
                <span className="text-muted">
                  — after that the gateway bumps the revision back to review; it is not a failure
                </span>
              </dd>
            </>
          ) : null}
          {detail ? (
            <>
              <dt className="text-muted">Digest</dt>
              <dd className="tabular">{detail.digest.slice(0, 16)}…</dd>
              <dt className="text-muted">Approved by</dt>
              <dd>
                {detail.approval.reviewerId} · {formatTimestamp(detail.approval.approvedAt)}
              </dd>
              <dt className="text-muted">Destinations</dt>
              <dd>{detail.destinations.join(", ")}</dd>
              {detail.supersedes ? (
                <>
                  <dt className="text-muted">Supersedes</dt>
                  <dd className="tabular">revision {detail.supersedes.revision}</dd>
                </>
              ) : null}
            </>
          ) : null}
          <dt className="text-muted">Case</dt>
          <dd>
            {item.caseId ? (
              <Link
                href={`/cases/${encodeURIComponent(item.caseId)}`}
                className="text-navy underline decoration-line underline-offset-4"
              >
                {item.caseId}
              </Link>
            ) : (
              "unassigned"
            )}
          </dd>
        </dl>

        {item.reviewRisk.length ? (
          <div className="mt-3 border-t border-line pt-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
              Review risk{item.riskProvisional ? " · provisional thresholds" : ""}
            </p>
            <ul className="mt-1 space-y-1 text-[12px]">
              {item.reviewRisk.map((reason) => (
                <li key={reason}>
                  <span className="font-medium">{reason.replaceAll("_", " ").toLowerCase()}</span>
                  <span className="text-muted"> — {RISK_HELP[reason] ?? ""}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[11.5px] text-muted">
              These flags order the queue and say where to look first. Approval is still required for every release,
              and no model can clear them.
            </p>
          </div>
        ) : null}

        {detail ? (
          <details className="mt-3">
            <summary className="cursor-pointer text-[12px] font-medium text-navy">
              Sanitized text ({detail.artifacts.length} blocks)
            </summary>
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap bg-paper p-2 text-[11.5px] leading-5">
              {detail.artifacts.map((a) => a.text).join("\n")}
            </pre>
          </details>
        ) : null}
      </Panel>

      {item.tab === "ready" || item.tab === "privacy_review" ? (
        <Panel title={item.tab === "ready" ? "Continue capture" : "Review on the device"}>
          <p className="text-[12.5px] text-muted">
            Sanitized text, redaction and approval are served only to a directly paired local client, so this opens the
            session on the device rather than showing the content here.
          </p>
          <Link
            href={`/intake?intake=${encodeURIComponent(item.intakeId)}`}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-navy px-2.5 py-1.5 text-[12.5px] font-medium text-paper"
          >
            <ScanLine size={14} /> Open intake {item.intakeId.slice(0, 8)}…
          </Link>
        </Panel>
      ) : null}

      {item.tab === "processing" ? (
        <Panel title="Processing">
          <p className="text-[12.5px] text-muted">
            {item.stage
              ? `The device is working: ${item.stage.replaceAll("_", " ").toLowerCase()}. Nothing for a person to do yet.`
              : "Cloud processing is running against the accepted envelope. Nothing for a person to do yet."}
          </p>
        </Panel>
      ) : null}

      {item.tab === "unmatched" ? (
        <AssociationPanel item={item} detail={detail} onChanged={onChanged} onError={setMessage} />
      ) : null}

      {item.tab === "attached" ? (
        <Panel title="Attached">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
            <dt className="text-muted">Accepted by backend</dt>
            <dd>
              <Badge className="bg-emerald-soft text-emerald">yes</Badge>
            </dd>
            <dt className="text-muted">All cloud processing completed</dt>
            <dd>
              {item.warnings.length ? (
                <Badge className="bg-amber-soft text-amber">no — {item.warnings.join(", ")}</Badge>
              ) : (
                <Badge className="bg-emerald-soft text-emerald">yes</Badge>
              )}
            </dd>
          </dl>
          {item.warnings.length ? (
            <div className="mt-3 border-t border-line pt-2">
              <p className="text-[12px] text-muted">
                The document is attached and the case is already affected, so an unavailable provider is a retryable
                warning rather than a failure. Retrying re-runs providers against the stored approved envelope; it
                never re-releases anything.
              </p>
              <Button
                className="mt-2"
                disabled={busy}
                onClick={() => act(() => getLloydApi().retryIntakeProcessing(item.intakeId))}
              >
                <RotateCcw size={14} /> Retry {item.warnings.join(", ")}
              </Button>
            </div>
          ) : null}
        </Panel>
      ) : null}

      {guidance ? (
        <Panel title="Failure">
          <p className="text-[12.5px]">{guidance.cause}</p>
          <p className="mt-1 text-[12.5px] text-muted">{guidance.action}</p>
          {item.rejection ? (
            <p className="mt-2 tabular text-[11.5px] text-muted">
              {item.rejection.code} · {formatTimestamp(item.rejection.at)} · device {item.rejection.deviceId} ·{" "}
              identity {item.rejection.identity.slice(0, 12)}…{" "}
              {item.rejection.verified
                ? "(identity verified)"
                : "(identity only claimed by the refused envelope)"}
            </p>
          ) : null}
          {guidance.retry === "release" ? (
            <Button
              tone="primary"
              className="mt-2"
              disabled={busy}
              onClick={() => act(() => getLloydApi().retryIntakeRelease(item.intakeId))}
            >
              <RotateCcw size={14} /> Retry the same approved release
            </Button>
          ) : null}
        </Panel>
      ) : null}

      {detail && Object.keys(detail.processing).length ? (
        <Panel title="Cloud processing and audit">
          <ul className="space-y-1 text-[12px]">
            {Object.entries(detail.processing).map(([provider, value]) => {
              const status =
                value && typeof value === "object" ? String((value as { status?: string }).status ?? "") : String(value);
              return (
                <li key={provider} className="flex items-center gap-2">
                  <span className="w-28 font-medium">{provider}</span>
                  <Badge
                    className={
                      /UNAVAILABLE|REJECTED/.test(status)
                        ? "bg-crimson-soft text-crimson"
                        : "bg-emerald-soft text-emerald"
                    }
                  >
                    {status || "done"}
                  </Badge>
                  {provider === "gemini" && value && typeof value === "object" && "classificationAgreement" in value ? (
                    <span className="text-muted">
                      local vs provider:{" "}
                      {String((value as { classificationAgreement: string }).classificationAgreement).toLowerCase()}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <ul className="mt-3 border-t border-line pt-2 tabular text-[11px] text-muted">
            {detail.audit.map((entry, i) => (
              <li key={i}>
                {formatTimestamp(entry.at)} · {entry.actorId} · {entry.action}
                {entry.detail ? ` · ${entry.detail}` : ""}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {message ? <p className="text-sm text-crimson">{message}</p> : null}
    </div>
  );
}

/**
 * Unmatched releases are associated here, from privacy-safe hints only: document type, risk
 * state, building-year range, TIV bucket and line of business. Nothing is associated
 * automatically, and every association is an explicit, audited reviewer action.
 */
function AssociationPanel({
  item,
  detail,
  onChanged,
  onError,
}: {
  item: IntakeWorkItem;
  detail: IntakeInboxItem | null;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [candidates, setCandidates] = useState<IntakeCandidatesResponse | null>(null);
  const [chosenCase, setChosenCase] = useState(item.caseId ?? "");
  const [reason, setReason] = useState("");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCandidates(null);
    setChosenCase(item.caseId ?? "");
    getLloydApi()
      .getIntakeCandidates(item.intakeId)
      .then((result) => {
        if (!cancelled) setCandidates(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) onError(err instanceof Error ? err.message : "Could not rank candidates");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.intakeId, item.revision]);

  async function associate() {
    if (!chosenCase) return;
    setWorking(true);
    try {
      await getLloydApi().associateIntake(
        item.intakeId,
        chosenCase,
        reason.trim() || "Selected from ranked candidates",
      );
      setReason("");
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Association failed");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Panel title="Choose a case">
      {detail ? (
        <p className="mb-3 flex flex-wrap gap-1.5">
          {Object.entries(detail.matchHints).map(([key, value]) => (
            <Badge key={key} className="bg-panel-2 text-ink">
              {key}: {Array.isArray(value) ? value.join("–") : String(value)}
            </Badge>
          ))}
        </p>
      ) : null}
      {!candidates ? (
        <p className="text-[12px] text-muted">Ranking candidates…</p>
      ) : !candidates.sufficientHints ? (
        <p className="text-[12px] text-amber">
          Not enough privacy-safe hints to rank candidates at all, which is a different thing from ranking and matching
          nothing. Enter the case ID directly below.
        </p>
      ) : candidates.candidates.length === 0 ? (
        <p className="text-[12px] text-muted">
          Ranked on the available hints, but no authorized case matched. Enter the case ID directly below.
        </p>
      ) : (
        <ul className="space-y-1">
          {candidates.candidates.map((candidate) => (
            <li key={candidate.caseId}>
              <label className="flex items-start gap-2 rounded-sm border border-line px-2 py-1.5 text-[12.5px] hover:bg-panel-2">
                <input
                  type="radio"
                  name="candidate"
                  checked={chosenCase === candidate.caseId}
                  onChange={() => setChosenCase(candidate.caseId)}
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{candidate.accountName ?? candidate.caseId}</span>{" "}
                  <span className="tabular text-muted">{candidate.caseId}</span>{" "}
                  <Badge className="bg-panel-2 text-ink">score {candidate.score}</Badge>{" "}
                  <span className="text-muted">{candidate.decision.replaceAll("_", " ")}</span>
                  <span className="block text-[11.5px] text-muted">{candidate.reasons.join("; ")}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {candidates?.rankedAt ? (
        <p className="mt-2 text-[11.5px] text-muted">
          Ranked {formatTimestamp(candidates.rankedAt)} against revision {candidates.revision}
          {candidates.waitingSince ? `; waiting for a case since ${formatTimestamp(candidates.waitingSince)}` : ""}. The
          choice is recorded with the rank it came from, including an override of the ranking.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
        <label className="text-[12px]">
          Case ID
          <input
            value={chosenCase}
            onChange={(e) => setChosenCase(e.target.value)}
            className="mt-1 w-48 rounded-sm border border-line bg-paper px-2 py-1.5"
          />
        </label>
        <label className="flex-1 text-[12px]">
          Reason
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Optional note for the audit trail"
            className="mt-1 w-full rounded-sm border border-line bg-paper px-2 py-1.5"
          />
        </label>
        <Button tone="primary" disabled={working || !chosenCase} onClick={associate}>
          <Link2 size={14} /> Associate
        </Button>
      </div>
    </Panel>
  );
}
