"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Camera, RotateCcw, ShieldCheck, Trash2, Upload } from "lucide-react";
import {
  EdgeV2Client,
  EdgeV2Error,
  V2_STAGE_ORDER,
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
import { formatPercent, formatTimestamp } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";

const BRANCH_STAGES: Partial<Record<V2Stage, { label: string; tone: string; help: string }>> = {
  RECAPTURE_REQUIRED: { label: "Recapture required", tone: "bg-crimson-soft text-crimson", help: "Quality policy refused this capture. Fix the listed reasons and capture again." },
  LOCAL_MODEL_UNAVAILABLE: { label: "Local model unavailable", tone: "bg-amber-soft text-amber", help: "The on-device classifier or detector is not ready. Nothing can be released until it is; there is no regex fallback." },
  BLOCKED: { label: "Blocked", tone: "bg-crimson-soft text-crimson", help: "Analysis failed a hard limit. Start a new intake." },
  RELEASE_PENDING: { label: "Release in flight", tone: "bg-amber-soft text-amber", help: "The approved revision is being transmitted." },
  RELEASE_FAILED: { label: "Release failed", tone: "bg-crimson-soft text-crimson", help: "Retry sends the identical approved envelope; nothing is recomputed." },
  ORIGINAL_EXPIRED: { label: "Original deleted", tone: "bg-panel-2 text-muted", help: "Raw pages are gone; the sanitized record and audit trail remain." },
};

const QUALITY_HELP: Record<string, string> = {
  BLUR: "Focus is too soft for reliable OCR.",
  CLIPPED_PAGE: "A page edge touches the frame; part of the document is cut off.",
  GLARE_OCCLUSION: "A saturated highlight hides text.",
  EMPTY_OCR: "No text was recognized.",
  LOW_TEXT_CONFIDENCE: "OCR confidence is below the policy floor.",
  PERSPECTIVE_UNCERTAIN: "Page corners could not be located; perspective was not corrected.",
  UNCALIBRATED_POLICY: "Quality thresholds are provisional; a reviewer must confirm legibility.",
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
  const [connecting, setConnecting] = useState(
    () => getEdgeV2Client().transport === "direct" && !readSessionTokens().pairingToken,
  );
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
    // Pairing bootstrap runs once per mount; loadHealth after that is driven by setClient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadHealth]);

  const refresh = useCallback(
    async (intakeId: string) => {
      if (client.canReview) {
        const r = await client.review(intakeId);
        setReview(r);
        setStatus(r);
      } else {
        setStatus(await client.status(intakeId));
        setReview(null);
      }
    },
    [client],
  );

  // In-flight work is recovered by listing and linking, not by remembering: the workspace hands
  // this view an intake id in the route, so a reload or a second tab converges on the same
  // device state. Intake identity never goes into session storage — only pairing tokens do.
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

  const caps = health?.capabilities;
  const cameraOk = caps?.camera === true;
  const capabilityRows: { key: string; ok: boolean; detail: string }[] = caps
    ? [
        { key: "camera", ok: cameraOk, detail: caps.camera === null ? "not probed" : caps.camera ? "reachable" : "unavailable" },
        { key: "ocr", ok: caps.ocr.ready, detail: caps.ocr.adapter },
        { key: "classifier", ok: caps.classifier.ready, detail: caps.classifier.modelId ?? caps.classifier.error ?? "not loaded" },
        { key: "detector", ok: caps.detector.ready, detail: caps.detector.modelId ?? caps.detector.error ?? "not loaded" },
        { key: "quality", ok: caps.qualityPolicy.calibrated, detail: caps.qualityPolicy.version },
        { key: "privacy", ok: true, detail: caps.privacyPolicyVersion },
        { key: "images", ok: false, detail: caps.imageRedaction.toLowerCase().replaceAll("_", " ") },
        { key: "v2 release", ok: health.v2Enabled, detail: health.v2Enabled ? "enabled" : "disabled" },
        { key: "pairing", ok: caps.pairing.configured, detail: `${caps.pairing.reviewers} reviewer(s)` },
      ]
    : [];

  const stageIndex = status ? V2_STAGE_ORDER.findIndex((s) => s.id === status.stage) : -1;
  const branch = status ? BRANCH_STAGES[status.stage] : undefined;
  const canApprove = status?.stage === "REVIEW_READY" && client.canReview;
  const needsAck = status?.quality?.status === "REVIEW";
  const canRelease = status && ["APPROVED", "RELEASE_FAILED"].includes(status.stage);
  const canAnalyze = status && status.pageCount > 0 && !["RELEASE_PENDING", "ACCEPTED", "ORIGINAL_EXPIRED", "BLOCKED"].includes(status.stage);
  const canCapture = status && !["RELEASE_PENDING", "ACCEPTED", "ORIGINAL_EXPIRED"].includes(status.stage);
  const classification = status?.classification ?? null;

  return (
    <div className="space-y-4">
      <div>
        {caseId ? (
          <Link href={`/cases/${encodeURIComponent(caseId)}`} className="text-[12px] text-muted hover:text-navy">
            {linkedCase?.accountName ?? caseId}
          </Link>
        ) : (
          <Link href="/intake/inbox" className="text-[12px] text-muted hover:text-navy">
            Unassigned — associate after release from the intake workspace
          </Link>
        )}
        <h1 className="font-serif text-[26px] text-navy">Secure intake</h1>
        <p className="text-sm text-muted">
          Release contract v2. Raw pages, OCR text and token maps never leave the RDK X5; only sanitized text blocks
          with a signed, revision-bound approval are released.
        </p>
      </div>

      <div className="grid grid-cols-[1.15fr_0.85fr] gap-3">
        <Panel
          title={client.transport === "direct" ? "Local device" : "Gateway connection (proxied)"}
          actions={
            <Badge
              className={
                health ? "bg-emerald-soft text-emerald" : connecting ? "bg-amber-soft text-amber" : "bg-crimson-soft text-crimson"
              }
            >
              {health ? `gateway ${String(health.version ?? "")}`.trim() : connecting ? "connecting" : "unreachable"}
            </Badge>
          }
        >
          {client.transport === "direct" && tokens.pairingToken ? (
            <p className="text-[12px] text-muted">
              Paired with this workstation over USB. Live preview and capture use the on-device camera at {client.baseUrl}.
            </p>
          ) : client.transport === "direct" ? (
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
                Reviewer approval token
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
              <p className="col-span-3 text-[11px] text-muted">
                {connecting
                  ? "Connecting to the USB-attached RDK…"
                  : `${client.baseUrl}. Plug the board in, or paste a pairing token if this workstation is not local.`}
              </p>
            </div>
          ) : (
            <p className="text-[12px] text-amber">
              This browser reaches the gateway through the app server, which never relays raw preview or the local
              review payload. You can capture and analyze here, but reviewing sanitized text and approving a release
              require direct pairing: set <code>NEXT_PUBLIC_EDGE_GATEWAY_URL</code> to the gateway&apos;s local origin.
            </p>
          )}
          {healthError ? <p className="mt-2 text-[12px] text-crimson">{healthError}</p> : null}
          {capabilityRows.length ? (
            <dl className="mt-3 grid grid-cols-3 gap-2 text-[11.5px]">
              {capabilityRows.map((row) => (
                <div key={row.key} className="rounded-sm border border-line px-2 py-1.5">
                  <div className="flex items-center justify-between">
                    <span className="uppercase tracking-[0.12em] text-muted">{row.key}</span>
                    <span className={`h-2 w-2 rounded-full ${row.ok ? "bg-emerald" : "bg-line"}`} />
                  </div>
                  <div className="truncate tabular text-muted" title={row.detail}>
                    {row.detail}
                  </div>
                </div>
              ))}
            </dl>
          ) : null}
        </Panel>

        <Panel title="Local processing">
          <ol className="space-y-1.5">
            {V2_STAGE_ORDER.map((stage, index) => {
              const done = stageIndex > index;
              const current = status?.stage === stage.id;
              return (
                <li key={stage.id} className="flex items-center gap-2 text-sm">
                  <span className={`h-2 w-2 rounded-full ${done || current ? "bg-emerald" : "bg-line"}`} />
                  <span className={current ? "font-medium text-navy" : "text-ink"}>{stage.label}</span>
                </li>
              );
            })}
          </ol>
          {branch ? (
            <div className="mt-3 rounded-sm border border-line p-2">
              <Badge className={branch.tone}>{branch.label}</Badge>
              <p className="mt-1 text-[12px] text-muted">{branch.help}</p>
              {status?.releaseError ? <p className="text-[11px] tabular text-crimson">{status.releaseError}</p> : null}
            </div>
          ) : null}
          {status ? (
            <p className="mt-3 text-[11px] tabular text-muted">
              intake {status.intakeId.slice(0, 8)}… · revision {status.revision} · {status.pageCount} page{status.pageCount === 1 ? "" : "s"}
            </p>
          ) : null}
        </Panel>
      </div>

      <div className="grid grid-cols-[1.15fr_0.85fr] gap-3">
        <Panel title="Capture">
          <div className="relative overflow-hidden rounded-sm border border-line bg-navy">
            {previewSrc ? null : <div className="absolute inset-6 border border-dashed border-white/35" />}
            <div className="absolute left-6 top-2 text-[10px] uppercase tracking-[0.16em] text-white/55">
              {previewSrc ? "Detected page edges" : "Document boundary"}
            </div>
            {previewSrc ? (
              <img src={previewSrc} alt="Live camera preview with on-device page edge overlay" className="relative z-10 m-8 max-h-[360px] min-h-[200px] w-[calc(100%-4rem)] rounded-sm object-contain" />
            ) : (
              <div className="relative z-10 m-8 flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-sm bg-panel p-6 text-center">
                <Camera size={28} className="text-muted" />
                <p className="text-[12px] text-muted">
                  {client.canReview
                    ? "Live view is transient: frames are never captured, stored or OCR'd until you press Capture. The yellow box is the page the RDK detected."
                    : "Live preview is only available to a directly paired local client."}
                </p>
              </div>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="text-[12px]">
              Case (optional)
              <input
                value={caseInput}
                onChange={(e) => setCaseInput(e.target.value)}
                placeholder="Leave blank to associate after release"
                className="mt-1 w-56 rounded-sm border border-line bg-paper px-2 py-1.5"
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
          {previewOn ? (
            <p className="mt-2 text-[12px] text-amber">
              Yellow outline is drawn on the RDK from the live page-edge detector. Preview frames are not stored.
            </p>
          ) : null}
          {status?.pageQuality ? (
            <p className="mt-2 text-[12px] text-muted">
              Last page: {status.pageQuality.status}
              {status.pageQuality.reasons.length ? ` — ${status.pageQuality.reasons.join(", ")}` : ""}
            </p>
          ) : null}
          {review?.pages.length ? (
            <ul className="mt-2 space-y-1 text-[11.5px] text-muted">
              {review.pages.map((p) => (
                <li key={p.number} className="flex flex-wrap gap-2">
                  <span>Page {p.number}</span>
                  <span>{p.adapter}</span>
                  <span>{p.mediaType}</span>
                  <Badge className={p.quality.status === "PASS" ? "bg-emerald-soft text-emerald" : p.quality.status === "REVIEW" ? "bg-amber-soft text-amber" : "bg-crimson-soft text-crimson"}>{p.quality.status}</Badge>
                  {p.quality.reasons.map((r) => (
                    <span key={r}>{r}</span>
                  ))}
                  <span className="tabular">sha256:{p.originalSha256.slice(0, 12)}…</span>
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>

        <div className="space-y-3">
          <Panel title="Quality">
            {status?.quality ? (
              <>
                <div className="flex items-center gap-2">
                  <Badge className={status.quality.status === "PASS" ? "bg-emerald-soft text-emerald" : status.quality.status === "REVIEW" ? "bg-amber-soft text-amber" : "bg-crimson-soft text-crimson"}>{status.quality.status}</Badge>
                  <span className="text-[11px] tabular text-muted">{status.quality.policyVersion}</span>
                </div>
                <ul className="mt-2 space-y-1 text-[12px]">
                  {status.quality.reasons.length === 0 ? <li className="text-muted">No quality concerns.</li> : null}
                  {status.quality.reasons.map((r) => (
                    <li key={r}>
                      <span className="font-medium">{r.replaceAll("_", " ")}</span>
                      <span className="text-muted"> — {QUALITY_HELP[r] ?? ""}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-[12px] text-muted">Run analysis to assess blur, glare, clipping, perspective and OCR confidence.</p>
            )}
          </Panel>

          <Panel title="Local classification">
            {classification ? (
              <div className="space-y-1.5 text-[12px]">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className={classification.status === "CLASSIFIED" ? "bg-emerald-soft text-emerald" : "bg-amber-soft text-amber"}>{classification.status}</Badge>
                  <span className="font-medium">{classification.documentType.replaceAll("_", " ")}</span>
                  <span className="tabular text-muted">{formatPercent(classification.confidence * 100)}</span>
                  <span className="text-muted">{classification.calibration.toLowerCase()}</span>
                </div>
                <p className="tabular text-muted">
                  {classification.modelId} · {classification.runtimeVersion} · {classification.artifactDigest.slice(0, 12)}… · {classification.latencyMs.toFixed(0)} ms
                </p>
                <p className="text-muted">
                  {classification.attributes.lineOfBusiness} · {classification.attributes.language} · {classification.attributes.pageCount} page(s)
                  {classification.attributes.hasTables ? " · tables" : ""}
                </p>
                {classification.alternatives.length ? (
                  <p className="text-muted">
                    Alternatives: {classification.alternatives.map((a) => `${a.label} ${formatPercent(a.confidence * 100)}`).join(", ")}
                  </p>
                ) : null}
                {classification.evidenceIds.length ? <p className="tabular text-muted">Evidence blocks: {classification.evidenceIds.join(", ")}</p> : null}
              </div>
            ) : (
              <p className="text-[12px] text-muted">
                {status?.model?.classifier ? `Classifier ${status.model.classifier.ready ? "ready" : "unavailable"}${status.model.classifier.modelId ? ` (${status.model.classifier.modelId})` : ""}` : "Awaiting analysis."}
              </p>
            )}
          </Panel>

          <Panel title="Case-match hints (privacy-safe)">
            {status?.matchHints ? (
              <div className="flex flex-wrap gap-1.5 text-[12px]">
                {Object.entries(status.matchHints).map(([k, v]) => (
                  <Badge key={k} className="bg-panel-2 text-ink">
                    {k}: {Array.isArray(v) ? v.join("–") : String(v)}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-[12px] text-muted">Derived only from the sanitized text after analysis.</p>
            )}
          </Panel>
        </div>
      </div>

      <Panel
        title="Sanitized blocks (what leaves the device)"
        actions={
          review && selectedBlocks.length ? (
            <Button
              disabled={busy || !canCapture}
              onClick={() =>
                run(async () => {
                  const result = await client.addRedactions(review.intakeId, review.revision, selectedBlocks);
                  setSelectedBlocks([]);
                  return result;
                })
              }
            >
              Redact {selectedBlocks.length} selected block{selectedBlocks.length === 1 ? "" : "s"} (new revision)
            </Button>
          ) : undefined
        }
      >
        {!client.canReview ? (
          <p className="text-[12px] text-amber">Sanitized text is reviewed only over a direct pairing.</p>
        ) : review?.artifacts.length ? (
          <div className="max-h-[320px] space-y-1 overflow-auto">
            {review.artifacts.map((a) => (
              <label key={a.id} className="flex items-start gap-2 rounded-sm px-1 py-0.5 hover:bg-panel-2">
                <input
                  type="checkbox"
                  disabled={a.text === "[REDACTED]" || !canCapture}
                  checked={selectedBlocks.includes(a.id)}
                  onChange={(e) => setSelectedBlocks((s) => (e.target.checked ? [...s, a.id] : s.filter((id) => id !== a.id)))}
                />
                <span className="w-24 shrink-0 tabular text-[11px] text-muted">{a.id}</span>
                <span className="whitespace-pre-wrap text-[11.5px] leading-5">{a.text}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-[12px] text-muted">No sanitized derivative yet.</p>
        )}
        {review?.fields.length ? (
          <div className="mt-3 border-t border-line pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">Detections</p>
            <ul className="mt-1 grid grid-cols-2 gap-1 text-[11.5px]">
              {review.fields.map((f) => (
                <li key={f.path} className="flex items-center gap-2">
                  <span className="tabular">{f.path}</span>
                  <Badge className="bg-crimson-soft text-crimson">{f.classification}</Badge>
                  <span className="text-muted">{f.method}</span>
                  <span className="tabular text-muted">{formatPercent(f.confidence * 100)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {status?.limitations?.length ? (
          <details className="mt-3">
            <summary className="cursor-pointer text-[12px] text-muted">Known limitations of this release</summary>
            <ul className="mt-1 list-disc pl-5 text-[11.5px] text-muted">
              {status.limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </Panel>

      <div className="grid grid-cols-2 gap-3">
        <Panel title="Approve and release">
          {review && !review.v2Enabled ? (
            <p className="mb-2 text-[12px] text-amber">This device is not enabled for v2 release; approval is blocked until acceptance gates pass.</p>
          ) : null}
          {needsAck ? (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={acknowledge} onChange={(e) => setAcknowledge(e.target.checked)} />
              I have read the sanitized text at this quality and confirm it is legible enough to release.
            </label>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              tone="primary"
              disabled={busy || !canApprove || (needsAck && !acknowledge) || (review ? !review.v2Enabled : false)}
              onClick={() => status && run(() => client.approve(status.intakeId, status.revision, acknowledge))}
            >
              <ShieldCheck size={14} /> Approve revision {status?.revision ?? ""}
            </Button>
            <Button tone="primary" disabled={busy || !canRelease} onClick={() => status && run(() => client.release(status.intakeId))}>
              {status?.stage === "RELEASE_FAILED" ? "Retry same approved release" : "Release"}
            </Button>
            <Button
              tone="danger"
              disabled={busy || !status || status.stage === "ORIGINAL_EXPIRED"}
              onClick={() => status && run(() => client.deleteOriginals(status.intakeId))}
            >
              <Trash2 size={14} /> Delete originals
            </Button>
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
          {status?.approval && status.stage !== "REVIEW_READY" ? (
            <p className="mt-2 text-[12px] text-muted">
              Approved by {status.approval.reviewerId} at {formatTimestamp(status.approval.approvedAt)}, valid until {formatTimestamp(status.approval.expiresAt)}.
              {status.approval.acknowledgedQuality ? " Quality acknowledged." : ""}
            </p>
          ) : null}
          {message ? <p className="mt-2 text-sm text-crimson">{message}</p> : null}
        </Panel>

        <Panel title="Backend receipt">
          {status?.receipt ? (
            <div className="space-y-1 text-[12px]">
              <p>
                <Badge className="bg-emerald-soft text-emerald">{status.receipt.status ?? "ACCEPTED"}</Badge>{" "}
                <span className="tabular text-muted">digest {status.receipt.digest?.slice(0, 16)}…</span>
              </p>
              <p className="text-muted">Received {status.receipt.receivedAt ? formatTimestamp(status.receipt.receivedAt) : ""}</p>
              {status.receipt.association ? (
                <p>
                  Associated with{" "}
                  <Link href={`/cases/${encodeURIComponent(status.receipt.association.caseId)}`} className="text-navy underline decoration-line underline-offset-4">
                    {status.receipt.association.caseId}
                  </Link>{" "}
                  <span className="text-muted">({status.receipt.association.source.toLowerCase()})</span>
                </p>
              ) : (
                <p>
                  Awaiting association.{" "}
                  <Link
                    href={`/intake/inbox?intake=${encodeURIComponent(status.intakeId)}&tab=unmatched`}
                    className="text-navy underline decoration-line underline-offset-4"
                  >
                    Choose a case in the intake workspace
                  </Link>
                </p>
              )}
            </div>
          ) : (
            <p className="text-[12px] text-muted">The backend acknowledges accepted releases with a digest bound to this exact revision.</p>
          )}
          {review?.proposedManifest ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-medium text-navy">{review.approved ? "Signed manifest" : "Proposed manifest"}</summary>
              <pre className="mt-2 max-h-64 overflow-auto bg-paper p-2 text-[11px] leading-5">{JSON.stringify(review.proposedManifest, null, 2)}</pre>
            </details>
          ) : null}
          {review?.stageHistory.length ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-medium text-navy">Stage history</summary>
              <ul className="mt-2 max-h-40 overflow-auto text-[11px] tabular text-muted">
                {review.stageHistory.map((h, i) => (
                  <li key={i}>
                    r{h.revision} · {h.stage} · {formatTimestamp(h.at)}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Panel>
      </div>
    </div>
  );
}
