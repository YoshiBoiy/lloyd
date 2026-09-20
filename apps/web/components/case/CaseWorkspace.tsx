"use client";

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { ScanLine } from "lucide-react";
import { getLloydApi } from "@/lib/api";
import { useCase } from "@/lib/hooks";
import { formatPercent, formatScore, formatTimestamp, formatUsdExact } from "@/lib/format";
import type { AppetiteCriterion, CaseDetail, InvestigationStep } from "@/lib/api/types";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { Modal } from "@/components/ui/Modal";
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
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [note, setNote] = useState("");
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
              <p className="text-sm text-muted">No investigation steps yet. Run the mocked agent loop to populate Federato, Gemini, Elasticsearch, Atlas, OpenAI, and GPTZero.</p>
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
            <ol className="space-y-2">
              {data.pathToYes.map((step, index) => (
                <li key={index} className="text-sm">
                  <span className="mr-2 text-[11px] uppercase tracking-[0.12em] text-muted">{step.action.replaceAll("_", " ")}</span>
                  {step.description}
                </li>
              ))}
            </ol>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => run(() => getLloydApi().applyBrokerResponse(data.id))}>
                Simulate broker response
              </Button>
              <Button disabled={busy} onClick={() => run(() => getLloydApi().recalculate(data.id))}>
                Recalculate decision
              </Button>
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
              <Button disabled={busy} onClick={() => setOverrideOpen(true)}>
                Record human override
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
            {data.intakeDocumentId ? (
              <p className="mt-2 border-t border-line pt-2 text-[11px] text-muted">
                Sanitized scan attached: <span className="tabular">{data.intakeDocumentId}</span>. The original stays on
                the RDK X5; rescanning replaces this attachment.
              </p>
            ) : null}
          </Panel>
          {data.authenticity ? <AuthenticityReview detail={data} busy={busy} onAction={(state) => run(() => getLloydApi().updateAuthenticity(data.id, state))} /> : null}
          <SimilarCases cases={data.similarCases} />
          <PrecedentMap current={data} />
          <Panel title="Activity">
            <ul className="space-y-2">
              {data.activity.map((item) => (
                <li key={item.id}>
                  <p className="text-[11px] text-muted">{formatTimestamp(item.at)} · {item.actor}</p>
                  <p className="text-[12.5px]">{item.summary}</p>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="Human notes">
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!note.trim()) return;
                run(async () => {
                  await getLloydApi().addNote(data.id, note.trim());
                  setNote("");
                });
              }}
            >
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                className="h-20 w-full rounded-sm border border-line bg-paper p-2"
                placeholder="Working note — not a decision"
              />
              <Button type="submit" disabled={busy || !note.trim()}>
                Add note
              </Button>
            </form>
            {data.notes.map((item) => (
              <p key={item.id} className="mt-2 border-t border-line pt-2 text-[12.5px]">
                <span className="text-muted">{item.author}: </span>
                {item.body}
              </p>
            ))}
          </Panel>
        </div>
      </div>

      <Modal open={overrideOpen} title="Human override" onClose={() => setOverrideOpen(false)}>
        <p className="text-sm text-muted">
          Overrides require a reason and never rewrite the original agent recommendation.
        </p>
        <textarea
          value={overrideReason}
          onChange={(event) => setOverrideReason(event.target.value)}
          className="mt-3 h-24 w-full rounded-sm border border-line bg-paper p-2"
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button onClick={() => setOverrideOpen(false)}>Cancel</Button>
          <Button
            tone="primary"
            disabled={!overrideReason.trim()}
            onClick={() =>
              run(async () => {
                await getLloydApi().recordOverride(data.id, overrideReason);
                setOverrideOpen(false);
                setOverrideReason("");
              })
            }
          >
            Record override
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function FactsColumn({ detail }: { detail: CaseDetail }) {
  return (
    <Panel title="Normalized facts">
      <ul className="space-y-2">
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
