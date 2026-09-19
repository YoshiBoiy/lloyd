"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Camera, RotateCcw } from "lucide-react";
import { getLloydApi } from "@/lib/api";
import { useIntake } from "@/lib/hooks";
import { formatPercent } from "@/lib/format";
import type { CloudDestination, IntakeStage, PrivacyClassification, SensitiveFieldType } from "@/lib/api/types";
import { MIN_RELEASE_CONFIDENCE, sanitizedText } from "@/lib/api/types";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { PrivacyBadge } from "@/components/ui/Badge";
import { DEMO_CASE_ID } from "@/lib/fixtures/intake";

const STAGES: { id: IntakeStage; label: string }[] = [
  { id: "captured", label: "Capture" },
  { id: "ocr", label: "OCR" },
  { id: "detect", label: "Sensitive-field detection" },
  { id: "redact", label: "Redaction" },
  { id: "review", label: "Approval" },
  { id: "released", label: "Release" },
];

const DESTINATIONS: { id: CloudDestination; label: string; hint: string }[] = [
  { id: "gemini", label: "Gemini", hint: "Sanitized pages only" },
  { id: "openai", label: "OpenAI", hint: "Normalized facts" },
  { id: "gptzero", label: "GPTZero", hint: "Redacted narrative" },
];

function meterTone(value: number): string {
  if (value >= 0.9) return "bg-emerald";
  if (value >= 0.75) return "bg-amber";
  return "bg-crimson";
}

export function IntakeView() {
  const { data, error } = useIntake();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [payload, setPayload] = useState<unknown>(null);
  const [destinations, setDestinations] = useState<CloudDestination[]>(["gemini", "openai", "gptzero"]);
  const [acceptLow, setAcceptLow] = useState(false);
  const [addType, setAddType] = useState<SensitiveFieldType>("person_name");
  const [selection, setSelection] = useState("");

  const sanitized = useMemo(
    () => (data ? sanitizedText(data.originalText, data.spans) : ""),
    [data],
  );

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  async function captureAndProcess() {
    const api = getLloydApi();
    await api.captureIntake();
    await api.advanceIntakeProcessing();
    await api.advanceIntakeProcessing();
    await api.advanceIntakeProcessing();
    await api.advanceIntakeProcessing();
  }

  if (!data) {
    return <p className="text-muted">{error ?? "Loading scanner…"}</p>;
  }

  const stageIndex = STAGES.findIndex((item) => item.id === data.stage);
  const canRelease = data.stage === "review" || data.stage === "released";
  const lowConfidence = data.redactionConfidence < MIN_RELEASE_CONFIDENCE;
  const releaseDisabled = busy || data.released || !canRelease || destinations.length === 0 || (lowConfidence && !acceptLow);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-serif text-[26px] text-navy">Secure intake</h1>
        <p className="text-sm text-muted">
          Simulated RDK X5 path. Synthetic Harbor Mill inspection only — originals stay local until approved.
        </p>
      </div>

      <div className="grid grid-cols-[1.15fr_0.85fr] gap-3">
        <Panel title="Camera / document preview">
          <div className="relative overflow-hidden rounded-sm border border-line bg-navy">
            <div className="absolute inset-6 border border-dashed border-white/35" />
            <div className="absolute left-6 top-2 text-[10px] uppercase tracking-[0.16em] text-white/55">Document boundary</div>
            <pre className="relative z-10 m-8 max-h-[360px] overflow-auto whitespace-pre-wrap bg-panel p-4 text-[11.5px] leading-5 text-ink">
              {data.originalText}
            </pre>
          </div>
          <div className="mt-3 grid grid-cols-4 gap-2">
            {([
              ["Blur", data.quality.blur],
              ["Glare", data.quality.glare],
              ["Framing", data.quality.framing],
              ["OCR", data.quality.ocrConfidence],
            ] as const).map(([label, value]) => (
              <div key={label}>
                <div className="mb-1 flex justify-between text-[11px] uppercase tracking-[0.12em] text-muted">
                  <span>{label}</span>
                  <span className="tabular">{formatPercent(value * 100)}</span>
                </div>
                <div className="h-1.5 bg-panel-2">
                  <div className={`h-full ${meterTone(value)}`} style={{ width: `${value * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <Button tone="primary" disabled={busy} onClick={() => run(captureAndProcess)}>
              <Camera size={14} /> Capture
            </Button>
            <Button disabled={busy} onClick={() => run(() => getLloydApi().rescanIntake())}>
              <RotateCcw size={14} /> Rescan
            </Button>
          </div>
        </Panel>

        <Panel title="Processing">
          <ol className="space-y-2">
            {STAGES.map((stage, index) => {
              const done = stageIndex > index || data.stage === "released";
              const current = data.stage === stage.id;
              return (
                <li key={stage.id} className="flex items-center gap-2 text-sm">
                  <span className={`h-2 w-2 rounded-full ${done || current ? "bg-emerald" : "bg-line"}`} />
                  <span className={current ? "font-medium text-navy" : "text-ink"}>{stage.label}</span>
                </li>
              );
            })}
          </ol>
          <div className="mt-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">Privacy badges</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(["LOCAL_ONLY", "REDACTED", "TOKENIZED", "GENERALIZED", "CLOUD_ALLOWED"] as PrivacyClassification[]).map(
                (value) => (
                  <PrivacyBadge key={value} value={value} />
                ),
              )}
            </div>
          </div>
          <p className="mt-4 text-sm">
            Redaction confidence{" "}
            <span className="tabular font-medium">{formatPercent(data.redactionConfidence * 100)}</span>
            {lowConfidence ? " — below 0.95 release threshold" : " — automatic release eligible"}
          </p>
        </Panel>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Panel title="Original (local only)">
          <DocumentText text={data.originalText} />
        </Panel>
        <Panel title="Sanitized derivative">
          <DocumentText text={sanitized} />
        </Panel>
      </div>

      <Panel title="Labeled redactions">
        <div className="space-y-2">
          {data.spans.map((span) => (
            <label key={span.id} className="flex items-start gap-3 rounded-sm border border-line px-2 py-2">
              <input
                type="checkbox"
                checked={span.enabled}
                onChange={(event) => run(() => getLloydApi().toggleRedaction(span.id, event.target.checked))}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium capitalize">{span.type.replaceAll("_", " ")}</span>
                  <PrivacyBadge value={span.classification} />
                  {span.required ? <span className="text-[11px] uppercase tracking-[0.12em] text-muted">Required</span> : null}
                </div>
                <p className="truncate text-[12px] text-muted">
                  {span.text} → {span.replacement}
                </p>
              </div>
            </label>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <label className="flex-1 text-[12px]">
            Add redaction from selected original text
            <input
              value={selection}
              onChange={(event) => setSelection(event.target.value)}
              placeholder="e.g. Allegheny County"
              className="mt-1 w-full rounded-sm border border-line bg-paper px-2 py-1.5"
            />
          </label>
          <select
            value={addType}
            onChange={(event) => setAddType(event.target.value as SensitiveFieldType)}
            className="rounded-sm border border-line bg-paper px-2 py-1.5"
          >
            {(["person_name", "email", "phone", "policy_number", "government_id", "signature"] as const).map((type) => (
              <option key={type} value={type}>
                {type.replaceAll("_", " ")}
              </option>
            ))}
          </select>
          <Button
            disabled={!selection}
            onClick={() =>
              run(async () => {
                const start = data.originalText.indexOf(selection);
                if (start < 0) throw new Error("That text is not in the original.");
                await getLloydApi().addManualRedaction(start, start + selection.length, addType);
                setSelection("");
              })
            }
          >
            Add redaction
          </Button>
        </div>
      </Panel>

      <div className="grid grid-cols-[1fr_1fr] gap-3">
        <Panel title="Destination routing">
          <div className="space-y-2">
            {DESTINATIONS.map((item) => (
              <label key={item.id} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={destinations.includes(item.id)}
                  onChange={(event) =>
                    setDestinations((current) =>
                      event.target.checked ? [...current, item.id] : current.filter((value) => value !== item.id),
                    )
                  }
                />
                <span>
                  <span className="font-medium">{item.label}</span>
                  <span className="block text-[12px] text-muted">{item.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input type="checkbox" checked={acceptLow} onChange={(event) => setAcceptLow(event.target.checked)} />
            I have reviewed residual spans and explicitly approve a low-confidence release.
          </label>
          <div className="mt-3 flex items-center gap-2">
            <Button
              tone="primary"
              disabled={releaseDisabled}
              onClick={() =>
                run(async () => {
                  const result = await getLloydApi().approveAndRelease({
                    destinations,
                    approvedBy: "A. Chen",
                    acceptLowConfidence: acceptLow,
                  });
                  setPayload(result.payload);
                })
              }
            >
              Approve sanitized release
            </Button>
            {data.released ? (
              <Link href={`/cases/${encodeURIComponent(DEMO_CASE_ID)}`} className="text-navy underline decoration-line underline-offset-4">
                Open linked submission
              </Link>
            ) : null}
          </div>
          {message ? <p className="mt-2 text-sm text-crimson">{message}</p> : null}
        </Panel>

        <Panel title="Cloud release manifest">
          <pre className="max-h-64 overflow-auto bg-paper p-2 text-[11px] leading-5">
            {JSON.stringify(data.manifest ?? { status: "not_approved" }, null, 2)}
          </pre>
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-medium text-navy">Outbound JSON payload</summary>
            <pre className="mt-2 max-h-64 overflow-auto bg-paper p-2 text-[11px] leading-5">
              {JSON.stringify(payload ?? { status: "not_released" }, null, 2)}
            </pre>
          </details>
        </Panel>
      </div>
    </div>
  );
}

function DocumentText({ text }: { text: string }) {
  return <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap bg-paper p-3 text-[11.5px] leading-5">{text}</pre>;
}
