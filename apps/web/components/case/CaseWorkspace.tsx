"use client";

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { ScanLine } from "lucide-react";
import { getLloydApi } from "@/lib/api";
import { useCase } from "@/lib/hooks";
import { formatPercent, formatScore, formatTimestamp, formatUsdExact } from "@/lib/format";
import type { AppetiteCriterion, CaseDetail, CaseDocument, InvestigationStep } from "@/lib/api/types";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { CriterionBadge, DecisionBadge, EvidenceBadge } from "@/components/ui/Badge";
import { AuthenticityReview } from "./AuthenticityReview";
import { SimilarCases } from "./SimilarCases";
import { PrecedentMap } from "./PrecedentMap";

export function CaseWorkspace({ id }: { id: string }) {
  const { data, error, loading } = useCase(id);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ questions: string[]; rationale: string[] } | null>(null);
  const [liveSteps, setLiveSteps] = useState<InvestigationStep[]>([]);

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

  if (loading && !data) return <p className="text-muted">Opening case…</p>;
  if (error || !data) return <p className="text-crimson">{error ?? "Case not found"}</p>;

  const steps = data.investigation.steps.length > 0 ? data.investigation.steps : liveSteps;

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link href="/dashboard" className="text-[12px] text-muted hover:text-navy">
            Queue
          </Link>
          <h1 className="font-serif text-[26px] text-navy">{data.accountName}</h1>
          <p className="text-sm text-muted">
            {data.submissionType === "new_business" ? "New business" : "Renewal"} · {data.lineOfBusiness} · {data.state} · v{data.version}
            {data.simulation ? " · SIMULATION" : ""}
          </p>
        </div>
        <div className="text-right">
          <DecisionBadge value={data.decision} />
          <p className="mt-1 text-sm tabular">
            {formatScore(data.appetiteScore)} / 100 · confidence {formatPercent(data.confidence * 100)}
          </p>
          <p className="text-[12px] text-muted">
            {formatUsdExact(data.premium)} premium · {formatUsdExact(data.tiv)} TIV
          </p>
        </div>
      </div>

      {message ? <p className="text-sm text-crimson">{message}</p> : null}

      <div className="grid grid-cols-[280px_minmax(0,1fr)_320px] gap-3">
        <FactsColumn detail={data} />
        <div className="space-y-3">
          <Panel title="Decision">
            <p className="text-sm leading-6">{data.explanation}</p>
            {data.override ? (
              <p className="mt-2 border-t border-line pt-2 text-[12px] text-muted">
                Override on file: {data.override.reason} ({data.override.author})
              </p>
            ) : null}
          </Panel>
          <AppetiteMatrix
            criteria={data.criteria}
            expanded={expanded}
            onToggle={(factor) => setExpanded((current) => (current === factor ? null : factor))}
          />
          <Panel
            title="Investigation timeline"
            actions={
              <Button
                tone="primary"
                disabled={busy || data.investigation.status === "running"}
                onClick={() =>
                  run(async () => {
                    setLiveSteps([]);
                    await getLloydApi().investigate(data.id, (step) => {
                      setLiveSteps((current) => {
                        const next = current.filter((item) => item.sequence !== step.sequence);
                        return [...next, step].sort((a, b) => a.sequence - b.sequence);
                      });
                    });
                  })
                }
              >
                Run investigation
              </Button>
            }
          >
            {steps.length === 0 ? (
              <p className="text-sm text-muted">No investigation steps yet. Run an investigation to query Federato, retrieve evidence, and refresh appetite.</p>
            ) : (
              <ol className="space-y-2">
                {steps.map((step) => (
                  <li key={step.sequence} className="border-b border-line pb-2 last:border-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-navy">
                        {step.sponsorLabel}
                        <span className="ml-2 text-[11px] uppercase tracking-[0.12em] text-muted">{step.status}</span>
                      </p>
                      <span className="text-[11px] text-muted">{step.tool}</span>
                    </div>
                    <p className="text-[12.5px] text-ink">{step.reason}</p>
                    {step.resultSummary ? <p className="text-[12px] text-muted">{step.resultSummary}</p> : null}
                  </li>
                ))}
              </ol>
            )}
          </Panel>
          <Panel title="Path to Yes">
            {data.pathToYes.length === 0 ? <p className="text-sm text-muted">No outstanding path-to-yes items.</p> : null}
            <ol className="space-y-2">
              {data.pathToYes.map((step, index) => (
                <li key={index} className="text-sm">
                  <span className="mr-2 text-[11px] uppercase tracking-[0.12em] text-muted">{step.action.replaceAll("_", " ")}</span>
                  {step.description}
                </li>
              ))}
            </ol>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    setDraft(await getLloydApi().draftInformationRequest(data.id));
                  })
                }
              >
                Draft information request
              </Button>
            </div>
            {draft ? (
              <div className="mt-3 border-t border-line pt-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">Draft — not sent</p>
                <ul className="mt-1 list-disc pl-4 text-sm">
                  {draft.questions.map((question) => (
                    <li key={question}>{question}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Panel>
        </div>
        <div className="space-y-3">
          <Panel
            title="Evidence"
            actions={
              <Link
                href={`/cases/${encodeURIComponent(data.id)}/intake`}
                className="inline-flex items-center gap-1.5 text-[12px] text-navy underline decoration-line underline-offset-4 transition-colors duration-150 ease-out hover:text-navy-2"
              >
                <ScanLine size={13} strokeWidth={1.75} />
                Scan supporting document
              </Link>
            }
          >
            <ul className="space-y-2">
              {data.evidence.length === 0 ? <li className="text-sm text-muted">No evidence items on this file yet.</li> : null}
              {data.evidence.map((item) => (
                <li key={item.evidenceId} className="border-b border-line pb-2 last:border-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">{item.title}</p>
                    <EvidenceBadge value={item.verificationStatus} />
                  </div>
                  <p className="text-[12.5px] text-ink">{item.text}</p>
                  <p className="text-[11px] text-muted">{item.sourceUri}</p>
                </li>
              ))}
            </ul>
            <ScannedDocuments documents={data.documents} />
          </Panel>
          {data.authenticity ? <AuthenticityReview detail={data} busy={busy} onAction={(state) => run(() => getLloydApi().updateAuthenticity(data.id, state))} /> : null}
          <SimilarCases cases={data.similarCases} />
          <PrecedentMap current={data} />
          <Panel title="Activity">
            <ul className="space-y-2">
              {data.activity.length === 0 ? <li className="text-sm text-muted">No activity recorded on this file.</li> : null}
              {data.activity.map((item) => (
                <li key={item.id}>
                  <p className="text-[11px] text-muted">{formatTimestamp(item.at)} · {item.actor}</p>
                  <p className="text-[12.5px]">{item.summary}</p>
                </li>
              ))}
            </ul>
          </Panel>
          {data.notes.length > 0 ? (
            <Panel title="Human notes">
              {data.notes.map((item) => (
                <p key={item.id} className="mt-2 border-t border-line pt-2 text-[12.5px] first:mt-0 first:border-0 first:pt-0">
                  <span className="text-muted">{item.author}: </span>
                  {item.body}
                </p>
              ))}
            </Panel>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FactsColumn({ detail }: { detail: CaseDetail }) {
  return (
    <Panel title="Normalized facts">
      <ul className="space-y-2">
        {detail.facts.length === 0 ? <li className="text-sm text-muted">No normalized facts on this file.</li> : null}
        {detail.facts.map((fact) => (
          <li key={fact.id} className="border-b border-line pb-2 last:border-0">
            <div className="flex items-start justify-between gap-2">
              <p className="text-[12px] uppercase tracking-[0.12em] text-muted">{fact.label}</p>
              <EvidenceBadge value={fact.labelStatus} />
            </div>
            <p className="text-sm font-medium">{fact.value}</p>
            <p className="text-[11px] text-muted">
              {fact.provenance.map((item) => item.source).join(" · ")} · {fact.path}
            </p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/**
 * Scanned documents held by this case, newest first. A case can hold several: a new intake
 * appends and a new revision of the same intake supersedes, so two loss runs are two evidence
 * sources with separate provenance rather than one overwriting the other. Attaching a document
 * does not promote any fact on its own — that stays with the deterministic evidence path.
 */
function ScannedDocuments({ documents }: { documents: CaseDocument[] }) {
  if (documents.length === 0) return null;
  return (
    <div className="mt-2 border-t border-line pt-2">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
        Scanned documents ({documents.length})
      </p>
      <ul className="mt-1 space-y-1.5">
        {documents.map((doc) => (
          <li key={doc.intakeId} className="text-[12px]">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{doc.documentType.replaceAll("_", " ")}</span>
              <span className="tabular text-muted">
                {doc.pageCount} page{doc.pageCount === 1 ? "" : "s"} · revision {doc.revision}
              </span>
              {doc.status === "PROCESSED_WITH_WARNINGS" ? (
                <span className="text-amber">processed with warnings</span>
              ) : null}
              {doc.providerDocumentType && doc.providerDocumentType !== doc.documentType ? (
                <span className="text-amber">provider read it as {doc.providerDocumentType.replaceAll("_", " ")}</span>
              ) : null}
            </div>
            <p className="text-[11px] text-muted">
              {doc.attachedBy} · {doc.associationSource.toLowerCase().replaceAll("_", " ")} ·{" "}
              {formatTimestamp(doc.attachedAt)} · <span className="tabular">{doc.digest.slice(0, 12)}…</span>
              {doc.supersedesRevision ? ` · supersedes revision ${doc.supersedesRevision}` : ""}
            </p>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[11px] text-muted">
        Originals stay on the RDK X5. Each document is a separate evidence source; none of them changes a verified fact
        on its own.
      </p>
    </div>
  );
}

function AppetiteMatrix({
  criteria,
  expanded,
  onToggle,
}: {
  criteria: AppetiteCriterion[];
  expanded: string | null;
  onToggle: (factor: string) => void;
}) {
  const total = useMemo(() => criteria.reduce((sum, item) => sum + item.contribution, 0), [criteria]);
  return (
    <Panel title="Appetite matrix">
      <table className="w-full text-left">
        <thead className="text-[11px] uppercase tracking-[0.12em] text-muted">
          <tr>
            <th className="py-1 font-medium">Rule</th>
            <th className="py-1 font-medium">Observed</th>
            <th className="py-1 font-medium">Status</th>
            <th className="py-1 font-medium">Pts</th>
          </tr>
        </thead>
        <tbody>
          {criteria.map((item) => (
            <Fragment key={item.factor}>
              <tr className="border-t border-line">
                <td className="py-1.5">
                  <button type="button" className="text-left text-sm text-navy hover:underline" onClick={() => onToggle(item.factor)}>
                    {item.label}
                  </button>
                </td>
                <td className="py-1.5 text-[12.5px]">{item.observed}</td>
                <td className="py-1.5">
                  <CriterionBadge value={item.status} />
                </td>
                <td className="py-1.5 tabular">{item.contribution.toFixed(1)}</td>
              </tr>
              {expanded === item.factor ? (
                <tr>
                  <td colSpan={4} className="bg-paper px-2 py-2 text-[12.5px]">
                    <p>{item.ruleText}</p>
                    <p className="mt-1 text-muted">
                      {item.ruleId} · {item.evidence.map((entry) => `${entry.source}${entry.path ? `/${entry.path}` : ""}`).join(" · ")}
                    </p>
                    {item.querySummary ? <p className="text-muted">Query: {item.querySummary}</p> : null}
                    <p className="text-muted">
                      Evidence label: {item.evidenceLabel}. High numeric contribution does not cancel a hard failure.
                    </p>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[12px] text-muted">Weighted appetite score {total.toFixed(1)} / 100</p>
    </Panel>
  );
}
