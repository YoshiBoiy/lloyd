"use client";

import { getLloydApi } from "@/lib/api";
import { useLloydSnapshot } from "@/lib/hooks";
import { formatPercent } from "@/lib/format";
import { Panel } from "@/components/ui/Panel";
import { DecisionBadge } from "@/components/ui/Badge";

export function AnalyticsView() {
  const { data, loading, error } = useLloydSnapshot(() => getLloydApi().getAnalytics(), []);

  if (loading && !data) return <p className="text-muted">Loading Tiger Data aggregates…</p>;
  if (error || !data) return <p className="text-crimson">{error ?? "Analytics unavailable"}</p>;

  const maxThroughput = Math.max(...data.throughput.map((row) => Math.max(row.ingested, row.investigated)), 1);
  const maxLatency = Math.max(...data.investigationLatency.map((row) => row.p95Ms), 1);
  const maxRedacted = Math.max(...data.sensitiveFieldsRedacted.map((row) => row.count), 1);
  const maxFailed = Math.max(...data.frequentlyFailedRules.map((row) => row.failures), 1);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-serif text-[26px] text-navy">Investigation analytics</h1>
        <p className="text-sm text-muted">{data.disclaimer}</p>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <Stat label="Cloud requests avoided" value={String(data.cloudRequestsAvoided)} />
        <Stat label="Cloud requests released" value={String(data.cloudRequestsReleased)} />
        <Stat label="Referral rate" value={formatPercent(data.referralRate * 100)} />
        <Stat label="Human override rate" value={formatPercent(data.humanOverrideRate * 100)} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        {data.throughput.length > 0 ? (
          <Panel title="Submission throughput">
            <BarRows
              rows={data.throughput.map((row) => ({
                label: row.hour,
                value: row.investigated,
                secondary: row.ingested,
                max: maxThroughput,
              }))}
              caption="Investigated (fill) vs ingested (track)"
            />
          </Panel>
        ) : null}
        {data.investigationLatency.length > 0 ? (
          <Panel title="Investigation latency">
            <BarRows
              rows={data.investigationLatency.map((row) => ({
                label: row.hour,
                value: row.p50Ms,
                secondary: row.p95Ms,
                max: maxLatency,
              }))}
              caption="p50 fill · p95 track (ms)"
            />
          </Panel>
        ) : null}
        {data.sensitiveFieldsRedacted.length > 0 ? (
          <Panel title="Sensitive fields redacted">
            <BarRows
              rows={data.sensitiveFieldsRedacted.map((row) => ({
                label: row.type.replaceAll("_", " "),
                value: row.count,
                max: maxRedacted,
              }))}
            />
          </Panel>
        ) : null}
        <Panel title="Appetite outcomes">
          <ul className="space-y-2">
            {data.appetiteOutcomes.map((row) => (
              <li key={row.decision} className="flex items-center justify-between">
                <DecisionBadge value={row.decision} />
                <span className="tabular">{row.count}</span>
              </li>
            ))}
          </ul>
        </Panel>
        {data.frequentlyFailedRules.length > 0 ? (
          <Panel title="Frequently failed rules">
            <BarRows
              rows={data.frequentlyFailedRules.map((row) => ({
                label: row.rule,
                value: row.failures,
                max: maxFailed,
              }))}
            />
          </Panel>
        ) : null}
        {data.ocrRedactionConfidence.length > 0 ? (
          <Panel title="OCR / redaction confidence trend">
            <svg viewBox={`0 0 ${data.ocrRedactionConfidence.length * 28} 80`} className="h-28 w-full">
              <polyline
                fill="none"
                stroke="#1f6b4a"
                strokeWidth="1.5"
                points={data.ocrRedactionConfidence
                  .map((row, i) => `${i * 28 + 8},${80 - row.ocr * 70}`)
                  .join(" ")}
              />
              <polyline
                fill="none"
                stroke="#9a6700"
                strokeWidth="1.5"
                points={data.ocrRedactionConfidence
                  .map((row, i) => `${i * 28 + 8},${80 - row.redaction * 70}`)
                  .join(" ")}
              />
            </svg>
            <p className="text-[12px] text-muted">Emerald OCR · amber redaction. Source: {data.source}</p>
          </Panel>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Panel elevated>
      <div className="px-3.5 py-3.5">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</p>
        <p className="mt-1.5 text-[32px] font-bold leading-none tracking-tight tabular text-navy">{value}</p>
      </div>
    </Panel>
  );
}

function BarRows({
  rows,
  caption,
}: {
  rows: { label: string; value: number; secondary?: number; max: number }[];
  caption?: string;
}) {
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.label}>
          <div className="mb-0.5 flex justify-between text-[12px]">
            <span>{row.label}</span>
            <span className="tabular">{row.value}{row.secondary !== undefined ? ` / ${row.secondary}` : ""}</span>
          </div>
          <div className="h-1.5 bg-panel-2">
            {row.secondary !== undefined ? (
              <div className="h-full bg-line" style={{ width: `${(row.secondary / row.max) * 100}%` }}>
                <div className="h-full bg-navy" style={{ width: `${(row.value / Math.max(row.secondary, 1)) * 100}%` }} />
              </div>
            ) : (
              <div className="h-full bg-navy" style={{ width: `${(row.value / row.max) * 100}%` }} />
            )}
          </div>
        </div>
      ))}
      {caption ? <p className="text-[11px] text-muted">{caption}</p> : null}
    </div>
  );
}
