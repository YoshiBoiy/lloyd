"use client";

import type { AuthenticityFinding, CaseDetail } from "@/lib/api/types";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { formatPercent } from "@/lib/format";

export function AuthenticityReview({
  detail,
  busy,
  onAction,
}: {
  detail: CaseDetail;
  busy: boolean;
  onAction: (state: AuthenticityFinding["reviewState"]) => void;
}) {
  const finding = detail.authenticity;
  if (!finding) return null;

  return (
    <Panel title="Authenticity review">
      <p className="text-[12px] text-muted">
        Signals are review indicators, not accusations of fraud or authorship conclusions.
      </p>
      <dl className="mt-2 space-y-1 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-muted">AI-authorship probability</dt>
          <dd className="tabular">{formatPercent(finding.score * 100)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Outcome</dt>
          <dd>{finding.outcome.replaceAll("_", " ")}</dd>
        </div>
        <div>
          <dt className="text-muted">Applicable carrier policy</dt>
          <dd>
            {finding.applicablePolicy} · {finding.policyVersion}
          </dd>
        </div>
      </dl>
      {finding.unsupportedClaimWarning ? (
        <p className="mt-2 border border-amber bg-amber-soft px-2 py-1.5 text-[12.5px]">{finding.unsupportedClaimWarning}</p>
      ) : null}
      <blockquote className="mt-2 border-l-2 border-amber bg-amber-soft/60 px-2 py-2 text-[12.5px] italic">
        {finding.highlightedPassage}
      </blockquote>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button disabled={busy} onClick={() => onAction("verified")}>
          Mark verified
        </Button>
        <Button disabled={busy} onClick={() => onAction("attestation_requested")}>
          Request broker attestation
        </Button>
        <Button disabled={busy} onClick={() => onAction("excluded")}>
          Exclude from evidence
        </Button>
        <Button tone="danger" disabled={busy} onClick={() => onAction("escalated")}>
          Escalate
        </Button>
      </div>
      <p className="mt-2 text-[11px] uppercase tracking-[0.12em] text-muted">Review state · {finding.reviewState.replaceAll("_", " ")}</p>
    </Panel>
  );
}
