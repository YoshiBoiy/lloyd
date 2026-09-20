"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Camera, RotateCcw, ShieldCheck, Trash2, Upload } from "lucide-react";
import {
  EdgeV2Client,
  EdgeV2Error,
  bootstrapLocalPairing,
  fileToBase64,
  getEdgeV2Client,
  readSessionTokens,
  writeSessionTokens,
  type V2Health,
  type V2Review,
  type V2Stage,
  type V2Status,
} from "@/lib/api/edge-v2";
import { useCase } from "@/lib/hooks";
import { formatTimestamp } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";

const BRANCH_STAGES: Partial<Record<V2Stage, { label: string; tone: string; help: string }>> = {
  RECAPTURE_REQUIRED: { label: "Recapture required", tone: "bg-crimson-soft text-crimson", help: "Photograph the page again." },
  LOCAL_MODEL_UNAVAILABLE: { label: "Device models unavailable", tone: "bg-amber-soft text-amber", help: "Nothing can be released until the on-device models are restored." },
  BLOCKED: { label: "Blocked", tone: "bg-crimson-soft text-crimson", help: "Start a new intake." },
  RELEASE_PENDING: { label: "Releasing…", tone: "bg-amber-soft text-amber", help: "" },
  RELEASE_FAILED: { label: "Release failed", tone: "bg-crimson-soft text-crimson", help: "Retry sends the same approved package." },
  ORIGINAL_EXPIRED: { label: "Originals deleted", tone: "bg-panel-2 text-muted", help: "" },
};

function describe(error: unknown): string {
  if (error instanceof EdgeV2Error) return error.message;
  return error instanceof Error ? error.message : "Action failed";
}

export function IntakeV2View({ caseId, intakeId }: { caseId?: string; intakeId?: string }) {
  const { data: linkedCase } = useCase(caseId ?? "");
  const [client, setClient] = useState<EdgeV2Client>(() => getEdgeV2Client());
  const [tokens, setTokens] = useState(() => readSessionTokens());
  const [health, setHealth] = useState<V2Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [status, setStatus] = useState<V2Status | null>(null);
  const [review, setReview] = useState<V2Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedBlocks, setSelectedBlocks] = useState<string[]>([]);
  const [acknowledge, setAcknowledge] = useState(false);
  const [caseInput, setCaseInput] = useState(caseId ?? "");
  const [previewOn, setPreviewOn] = useState(false);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const previewAbort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadHealth = useCallback(async (c: EdgeV2Client) => {
    try {
      setHealth(await c.health());
      setHealthError(null);
    } catch (error) {
      setHealth(null);
      setHealthError(describe(error));
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setHydrated(true);
      let next = client;
      if (next.transport === "direct" && !readSessionTokens().pairingToken) {
        setConnecting(true);
        const boot = await bootstrapLocalPairing();
        if (cancelled) return;
        if (boot) {
          writeSessionTokens(boot);
          setTokens(boot);
          next = getEdgeV2Client(true);
          setClient(next);
        }
      }
      if (cancelled) return;
      setConnecting(false);
      await loadHealth(next);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadHealth]);

  const refresh = useCallback(
    async (id: string) => {
      if (client.canReview) {
        const r = await client.review(id);
        setReview(r);
        setStatus(r);
      } else {
        setStatus(await client.status(id));
        setReview(null);
      }
    },
    [client],
  );

  useEffect(() => {
    if (!intakeId) return;
    refresh(intakeId).catch((error: unknown) => setMessage(describe(error)));
  }, [intakeId, refresh]);

  async function run(fn: () => Promise<V2Status | void>) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await fn();
      if (result) {
        setStatus(result);
        await refresh(result.intakeId);
      } else if (status) await refresh(status.intakeId);
    } catch (error) {
      setMessage(describe(error));
    } finally {
      setBusy(false);
    }
  }

  function pair() {
    writeSessionTokens(tokens);
    const next = getEdgeV2Client(true);
    setClient(next);
    setMessage(null);
    setConnecting(false);
    void loadHealth(next);
  }

  useEffect(() => {
    if (!previewOn) {
      previewAbort.current?.abort();
      previewAbort.current = null;
      setPreviewSrc((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
      return;
    }
    const controller = new AbortController();
    previewAbort.current = controller;
    client
      .streamPreview((frame) => {
        const url = URL.createObjectURL(frame);
        setPreviewSrc((current) => {
          if (current) URL.revokeObjectURL(current);
          return url;
        });
      }, controller.signal)
      .catch((error) => {
        if (!controller.signal.aborted) setMessage(describe(error));
      })
      .finally(() => setPreviewOn(false));
    const stop = () => setPreviewOn(false);
    const onVisibility = () => document.visibilityState === "hidden" && stop();
    window.addEventListener("pagehide", stop);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      controller.abort();
      window.removeEventListener("pagehide", stop);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [previewOn, client]);

  const cameraOk = health?.capabilities.camera === true;
  const needsPairing = client.transport === "direct" && !tokens.pairingToken;
  const branch = status ? BRANCH_STAGES[status.stage] : undefined;
  const canApprove = status?.stage === "REVIEW_READY" && client.canReview;
  const needsAck = status?.quality?.status === "REVIEW";
  const canRelease = status && ["APPROVED", "RELEASE_FAILED"].includes(status.stage);
  const canAnalyze = status && status.pageCount > 0 && !["RELEASE_PENDING", "ACCEPTED", "ORIGINAL_EXPIRED", "BLOCKED"].includes(status.stage);
  const canCapture = status && !["RELEASE_PENDING", "ACCEPTED", "ORIGINAL_EXPIRED"].includes(status.stage);
  const qualityReasons = status?.quality?.reasons?.length ? status.quality.reasons : status?.pageQuality?.reasons ?? [];
  const showReview = Boolean(review?.artifacts.length);
  const showReleaseActions = Boolean(canApprove || canRelease || needsAck);

  return (
    <div className="space-y-4">
      <div>
        {caseId ? (
          <Link href={`/cases/${encodeURIComponent(caseId)}`} className="text-[12px] text-muted hover:text-navy">
            {linkedCase?.accountName ?? caseId}
          </Link>
        ) : (
          <Link href="/intake/inbox" className="text-[12px] text-muted hover:text-navy">
            Unassigned
          </Link>
        )}
        <h1 className="font-serif text-[26px] text-navy">Intake</h1>
      </div>

      {hydrated && needsPairing ? (
        <Panel title="Pair this workstation">
          <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
            <label className="text-[12px]">
              Pairing token
              <input
                type="password"
                value={tokens.pairingToken}
                onChange={(e) => setTokens((t) => ({ ...t, pairingToken: e.target.value }))}
                className="mt-1 w-full rounded-sm border border-line bg-paper px-2 py-1.5"
                autoComplete="off"
              />
            </label>
            <label className="text-[12px]">
              Reviewer token
              <input
                type="password"
                value={tokens.approvalToken}
                onChange={(e) => setTokens((t) => ({ ...t, approvalToken: e.target.value }))}
                className="mt-1 w-full rounded-sm border border-line bg-paper px-2 py-1.5"
                autoComplete="off"
              />
            </label>
            <Button onClick={pair}>
              <ShieldCheck size={14} /> Pair
            </Button>
          </div>
          {connecting ? <p className="mt-2 text-[12px] text-muted">Connecting…</p> : null}
        </Panel>
      ) : null}

      {healthError ? <p className="text-sm text-crimson">{healthError}</p> : null}
      {branch ? (
        <div className="rounded-sm border border-line px-3 py-2">
          <Badge className={branch.tone}>{branch.label}</Badge>
          {branch.help ? <p className="mt-1 text-[12px] text-muted">{branch.help}</p> : null}
          {status?.releaseError ? <p className="text-[12px] text-crimson">{status.releaseError}</p> : null}
        </div>
      ) : null}

      <Panel>
        <div className="space-y-3 p-3">
        <div className="relative overflow-hidden rounded-sm bg-navy">
          {previewSrc ? (
            <img
              src={previewSrc}
              alt="Live camera preview"
              className="relative z-10 max-h-[420px] min-h-[240px] w-full object-contain"
            />
          ) : (
            <div className="flex min-h-[240px] items-center justify-center">
              <Camera size={28} className="text-white/40" />
            </div>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-[12px]">
            Case
            <input
              value={caseInput}
              onChange={(e) => setCaseInput(e.target.value)}
              placeholder="Optional"
              className="mt-1 w-48 rounded-sm border border-line bg-paper px-2 py-1.5"
            />
          </label>
          {!status ? (
            <Button tone="primary" disabled={busy || !health} onClick={() => run(() => client.start({ caseId: caseInput || null }))}>
              Start intake
            </Button>
          ) : (
            <Button
              disabled={busy || !canCapture || status.caseId === (caseInput || null)}
              onClick={() => run(() => client.selectCase(status.intakeId, status.revision, caseInput || null))}
            >
              Set case
            </Button>
          )}
          <Button disabled={busy || !client.canReview || !cameraOk} onClick={() => setPreviewOn((v) => !v)}>
            <Camera size={14} /> {previewOn ? "Stop preview" : "Live preview"}
          </Button>
          <Button tone="primary" disabled={busy || !status || !canCapture || !cameraOk} onClick={() => status && run(() => client.capturePage(status.intakeId))}>
            <Camera size={14} /> Capture page
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,text/plain"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file || !status) return;
              void run(async () => {
                const mediaType = file.type === "image/jpeg" ? "image/jpeg" : file.type === "text/plain" ? "text/plain" : "image/png";
                return client.uploadPage(status.intakeId, await fileToBase64(file), mediaType);
              });
            }}
          />
          <Button disabled={busy || !status || !canCapture} onClick={() => fileInput.current?.click()}>
            <Upload size={14} /> Upload page
          </Button>
          <Button disabled={busy || !canAnalyze} onClick={() => status && run(() => client.analyze(status.intakeId))}>
            <RotateCcw size={14} /> Analyze
          </Button>
        </div>
        {health && !cameraOk ? <p className="mt-2 text-[12px] text-muted">Camera unavailable — upload a page instead.</p> : null}
        {qualityReasons.length ? (
          <p className="mt-2 text-[12px] text-crimson">{qualityReasons.map((r) => r.replaceAll("_", " ").toLowerCase()).join(" · ")}</p>
        ) : null}
        {status?.classification?.documentType ? (
          <p className="mt-2 text-[12px] text-muted">{status.classification.documentType.replaceAll("_", " ")}</p>
        ) : null}
        </div>
      </Panel>

      {showReview ? (
        <Panel
          title="Text to release"
          actions={
            selectedBlocks.length ? (
              <Button
                disabled={busy || !canCapture}
                onClick={() =>
                  run(async () => {
                    const result = await client.addRedactions(review!.intakeId, review!.revision, selectedBlocks);
                    setSelectedBlocks([]);
                    return result;
                  })
                }
              >
                Redact {selectedBlocks.length}
              </Button>
            ) : undefined
          }
        >
          <div className="max-h-[320px] space-y-1 overflow-auto">
            {review!.artifacts.map((a) => (
              <label key={a.id} className="flex items-start gap-2 rounded-sm px-1 py-0.5 hover:bg-panel-2">
                <input
                  type="checkbox"
                  disabled={a.text === "[REDACTED]" || !canCapture}
                  checked={selectedBlocks.includes(a.id)}
                  onChange={(e) => setSelectedBlocks((s) => (e.target.checked ? [...s, a.id] : s.filter((id) => id !== a.id)))}
                />
                <span className="whitespace-pre-wrap text-[12px] leading-5">{a.text}</span>
              </label>
            ))}
          </div>
        </Panel>
      ) : status && status.pageCount > 0 && !client.canReview ? (
        <p className="text-[12px] text-muted">Review and approve from the paired workstation.</p>
      ) : null}

      {status ? (
        <div className="flex flex-wrap items-center gap-2">
          {needsAck ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={acknowledge} onChange={(e) => setAcknowledge(e.target.checked)} />
              Text is legible enough to release
            </label>
          ) : null}
          {showReleaseActions ? (
            <>
              <Button
                tone="primary"
                disabled={busy || !canApprove || (needsAck && !acknowledge) || (review ? !review.v2Enabled : false)}
                onClick={() => run(() => client.approve(status.intakeId, status.revision, acknowledge))}
              >
                <ShieldCheck size={14} /> Approve
              </Button>
              <Button tone="primary" disabled={busy || !canRelease} onClick={() => run(() => client.release(status.intakeId))}>
                {status.stage === "RELEASE_FAILED" ? "Retry release" : "Release"}
              </Button>
            </>
          ) : null}
          {status.pageCount > 0 && status.stage !== "ORIGINAL_EXPIRED" ? (
            <Button tone="danger" disabled={busy} onClick={() => run(() => client.deleteOriginals(status.intakeId))}>
              <Trash2 size={14} /> Delete originals
            </Button>
          ) : null}
          <Button
            disabled={busy}
            onClick={() => {
              setStatus(null);
              setReview(null);
              setSelectedBlocks([]);
              setAcknowledge(false);
              setMessage(null);
            }}
          >
            New intake
          </Button>
        </div>
      ) : null}

      {status?.approval && status.stage !== "REVIEW_READY" ? (
        <p className="text-[12px] text-muted">Approved until {formatTimestamp(status.approval.expiresAt)}.</p>
      ) : null}
      {status?.receipt ? (
        <p className="text-[12px] text-muted">
          Released
          {status.receipt.association ? (
            <>
              {" "}
              ·{" "}
              <Link href={`/cases/${encodeURIComponent(status.receipt.association.caseId)}`} className="text-navy underline decoration-line underline-offset-4">
                {status.receipt.association.caseId}
              </Link>
            </>
          ) : (
            <>
              {" "}
              ·{" "}
              <Link
                href={`/intake/inbox?intake=${encodeURIComponent(status.intakeId)}&tab=unmatched`}
                className="text-navy underline decoration-line underline-offset-4"
              >
                Choose a case
              </Link>
            </>
          )}
        </p>
      ) : null}
      {message ? <p className="text-sm text-crimson">{message}</p> : null}
    </div>
  );
}
