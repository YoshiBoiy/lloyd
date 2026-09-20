"use client";
import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  FileText,
  Info,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import type {
  AskLloydResponse,
  Source,
  Trace,
  Precedent,
} from "../../../../packages/ask/src/contracts";
const labels: Record<string, string> = {
  ANSWERED: "Sources found",
  PARTIAL: "Some information is missing",
  NOT_ENOUGH_EVIDENCE: "More evidence needed",
  CONTRADICTED: "Conflicting evidence",
  VERIFIED: "Verified",
  UNVERIFIED: "Not yet verified",
  UNKNOWN: "Not established",
  BOUNDARY_REVIEW: "Needs review",
  HUMAN_APPROVED: "Human reviewed",
  UNAPPROVED: "Awaiting human review",
  RECORDED: "Recorded",
  IN_APPETITE: "In appetite",
  OUT_OF_APPETITE: "Outside appetite",
  INVESTIGATE: "Under investigation",
  ACCEPT_WITH_CONDITIONS: "Accept with conditions",
  NOT_ACCEPTABLE: "Not acceptable",
  ACCEPTABLE: "Acceptable",
  TARGET: "Target appetite",
  AVAILABLE: "Complete",
  UNAVAILABLE: "Unavailable",
  submissionType: "Submission type",
  lineOfBusiness: "Line of business",
  primaryState: "Primary state",
  tiv: "Total insured value",
  premium: "Premium",
  buildingYear: "Building year",
  construction: "Construction",
  losses: "Five-year losses",
  canonical_fact: "Case fact",
  canonical_case: "Case record",
  inspection_report: "Inspection report",
  loss_run: "Loss run",
  fixture: "Demo record",
};
export const readable = (value: string) =>
  labels[value] ??
  value
    .replaceAll("_", " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
export function StatusTag({ value }: { value: string }) {
  const warning =
    /CONTRADICTED|UNKNOWN|UNVERIFIED|PARTIAL|NOT_ENOUGH|BOUNDARY|UNAVAILABLE|UNAPPROVED/.test(
      value,
    );
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${warning ? "border-amber-200 bg-amber-50 text-amber-900" : "border-teal-200 bg-teal-50 text-teal-900"}`}
    >
      {warning ? <Info size={12} /> : <CheckCircle2 size={12} />}{" "}
      {readable(value)}
    </span>
  );
}
export function TechnicalDetails({
  value,
  label = "Technical details · JSON",
}: {
  value: unknown;
  label?: string;
}) {
  return (
    <details className="group rounded-lg border border-slate-200 bg-slate-50/70 text-xs">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 font-medium text-slate-600">
        {label}
        <ChevronDown
          size={14}
          className="transition-transform group-open:rotate-180"
        />
      </summary>
      <pre className="max-h-72 overflow-auto border-t border-slate-200 p-3 font-mono text-[11px] leading-5 text-slate-600">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}
function textValue(value: unknown, key: string): string {
  if (value == null) return "Not established";
  if (typeof value === "number")
    return ["premium", "tiv", "losses"].includes(key)
      ? new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 0,
        }).format(value)
      : String(value);
  if (typeof value === "string")
    return value.includes("_") ? readable(value) : value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value))
    return value.map((v) => textValue(v, key)).join("; ");
  if (typeof value === "object")
    return Object.entries(value)
      .map(([k, v]) => `${readable(k)}: ${textValue(v, k)}`)
      .join(" · ");
  return String(value);
}
/** Presentation-only formatting; original claims and exact excerpts remain available for audit. */
export function friendlyClaim(claim: string) {
  const fact = claim.match(/^([a-zA-Z]+): (.+?); ([A-Z_]+)\./);
  if (fact) {
    try {
      return `${readable(fact[1])}: ${textValue(JSON.parse(fact[2]), fact[1])}. ${readable(fact[3])}.${claim.includes("Sources:") ? ` Recorded by ${claim.split("Sources:")[1].trim().split(", ").map(readable).join(", ")}.` : ""}`;
    } catch {
      /* Source prose is displayed as written when it is not a structured fact. */
    }
  }
  return claim
    .replace(/^Inspector observed /, "The inspector noted ")
    .replace(
      /^Sprinkler questionnaire states that /,
      "The sprinkler questionnaire says ",
    )
    .replace(
      /\b(CONTRADICTED|BOUNDARY_REVIEW|IN_APPETITE|OUT_OF_APPETITE|ACCEPT_WITH_CONDITIONS|INVESTIGATE|NOT_ACCEPTABLE|UNVERIFIED|UNKNOWN|VERIFIED)\b/g,
      (s) => (s === "CONTRADICTED" ? "disputed" : readable(s).toLowerCase()),
    );
}
export function AnswerCards({
  answer,
  onSource,
}: {
  answer: AskLloydResponse;
  onSource: (source: Source) => void;
}) {
  const conflict = answer.citations.some(
    (s) => s.verificationStatus === "CONTRADICTED",
  );
  const intro =
    answer.status === "NOT_ENOUGH_EVIDENCE"
      ? "I can’t establish that from the evidence available yet."
      : conflict
        ? "There’s a conflict to review here. I’ve brought the relevant sources together so you can compare what each one says."
        : answer.status === "PARTIAL"
          ? "I found some useful information, but there are gaps. Here’s what you can review so far."
          : "Here’s what I found in the available records. Open a source below to check the details.";
  return (
    <section
      aria-label="Answer"
      className="overflow-hidden rounded-xl border border-slate-200"
    >
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/80 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-navy">
          <span className="rounded-lg bg-teal-100 p-1.5 text-teal-800">
            <Sparkles size={16} />
          </span>
          Lloyd
        </div>
        <StatusTag value={answer.status} />
      </div>
      <div className="space-y-4 p-4">
        <p className="text-sm leading-6 text-slate-700">{intro}</p>
        {answer.claims.length ? (
          <div className="space-y-3">
            {answer.claims.map((claim, i) => {
              const sources = claim.evidenceIds.flatMap((id) =>
                answer.citations.filter((s) => s.evidenceId === id),
              );
              return (
                <article
                  key={i}
                  className="rounded-lg border border-slate-200 bg-white p-3.5"
                >
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    {sources[0]
                      ? readable(sources[0].sourceType)
                      : "Source finding"}
                  </p>
                  <p className="text-sm leading-6 text-slate-800">
                    {friendlyClaim(claim.claim)}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {sources.map((s) => (
                      <button
                        key={s.evidenceId}
                        onClick={() => onSource(s)}
                        aria-label={`Open source: ${s.label}${s.page ? `, page ${s.page}` : ""}`}
                        className="inline-flex max-w-full items-center gap-2 rounded-md border border-teal-200 bg-teal-50 px-2.5 py-2 text-left text-xs font-medium text-teal-900 hover:border-teal-400 hover:bg-teal-100 focus-visible:outline-2 focus-visible:outline-teal-700"
                      >
                        <FileText size={14} className="shrink-0" />
                        <span>
                          {s.label}
                          {s.page && (
                            <span className="ml-1.5 text-teal-700">
                              · p. {s.page}
                            </span>
                          )}
                        </span>
                        <ArrowUpRight size={13} className="shrink-0" />
                      </button>
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
            <p className="mb-1 font-semibold">What would help next</p>
            {answer.answerMarkdown}
          </div>
        )}
        <TechnicalDetails value={answer} label="Original answer · JSON" />
      </div>
    </section>
  );
}
const operations: Record<string, string> = {
  GET_CASE: "Checked the case record",
  GET_DECISION_EVIDENCE: "Reviewed decision evidence",
  SEARCH_EVIDENCE: "Searched source documents",
  SEARCH_GUIDELINES: "Checked appetite guidelines",
  FILTER_CASES: "Reviewed matching cases",
  FIND_PRECEDENTS: "Found comparable cases",
  COMPARE_CASES: "Compared historical cases",
};
export function SearchCards({ trace }: { trace: Trace }) {
  return (
    <section
      className="rounded-xl border border-slate-200 p-4"
      aria-label="Search details"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-navy">
          <Search size={15} />
          How I checked
        </h2>
        <span className="text-xs text-slate-500">
          {trace.steps.reduce((n, s) => n + s.count, 0)} results reviewed
        </span>
      </div>
      <div className="space-y-2">
        {trace.steps.map((s, i) => (
          <div
            key={i}
            className="flex items-start gap-3 rounded-lg bg-slate-50 p-3"
          >
            <span
              className={`mt-0.5 rounded-full p-1 ${s.status === "AVAILABLE" ? "bg-teal-100 text-teal-800" : "bg-amber-100 text-amber-900"}`}
            >
              {s.status === "AVAILABLE" ? (
                <Check size={12} />
              ) : (
                <Info size={12} />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-slate-800">
                {operations[s.operation] ?? readable(s.operation)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {s.status === "UNAVAILABLE"
                  ? "This source wasn’t available for this question."
                  : `${s.count} ${s.count === 1 ? "result" : "results"} found`}
              </p>
              {Object.keys(s.filters).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {Object.entries(s.filters).map(([k, v]) => (
                    <span
                      key={k}
                      className="rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600"
                    >
                      {readable(k)}: {textValue(v, k)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {trace.warnings.length > 0 && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
          Some services or checks weren’t available. The answer uses the sources
          I could verify; see technical details for the full record.
        </p>
      )}
      <div className="mt-3">
        <TechnicalDetails value={trace} label="Search audit trail · JSON" />
      </div>
    </section>
  );
}
function FactBox({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
      <dt className="mb-1 text-[11px] font-medium text-slate-500">{label}</dt>
      <dd className="text-sm font-semibold text-slate-800">{children}</dd>
    </div>
  );
}
export function PrecedentFacts({ precedent: p }: { precedent: Precedent }) {
  return (
    <div className="mt-3 space-y-3">
      <div className="flex flex-wrap gap-2">
        <StatusTag value={p.decision} />
        <StatusTag value={p.humanApproved ? "HUMAN_APPROVED" : "UNAPPROVED"} />
      </div>
      {[
        ["Shared factors", p.sharedFactors],
        ["Material differences", p.materialDifferences],
        ["Missing information", p.missingDimensions],
      ].map(([label, values]) => (
        <div key={String(label)}>
          <h3 className="mb-1.5 text-xs font-semibold text-slate-600">
            {String(label)}
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {(values as string[]).length ? (
              (values as string[]).map((v) => (
                <span
                  key={v}
                  className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs"
                >
                  {readable(v)}
                </span>
              ))
            ) : (
              <span className="text-xs text-slate-500">None recorded</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
export function SourceCard({
  source,
  detail,
  precedent,
  onClose,
  onUse,
}: {
  source: Source;
  detail: unknown;
  precedent?: Precedent;
  onClose: () => void;
  onUse: () => void;
}) {
  const date = new Date(source.observedAt);
  const observed = Number.isFinite(+date)
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(date)
    : "Not recorded";
  return (
    <section
      aria-label="Selected source"
      className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-50/70 p-5">
        <div className="flex items-start gap-3">
          <span className="rounded-lg border border-teal-200 bg-teal-50 p-2 text-teal-800">
            <FileText size={20} />
          </span>
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Source review
            </p>
            <h2 className="text-lg font-semibold text-navy">
              {source.label}
              {source.page ? ` · Page ${source.page}` : ""}
            </h2>
            <div className="mt-2 flex flex-wrap gap-2">
              <StatusTag value={source.verificationStatus} />
              <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-600">
                {readable(source.sourceType)}
              </span>
            </div>
          </div>
        </div>
        <button
          aria-label="Close source"
          className="rounded-md p-2 text-slate-500 hover:bg-slate-200"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <div className="space-y-4 p-5">
        <div className="rounded-lg border border-slate-200 bg-[#fafaf7] p-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Exact source passage
          </p>
          <blockquote className="border-l-2 border-teal-600 pl-3 text-sm leading-7 text-slate-800">
            {source.excerpt}
          </blockquote>
        </div>
        <dl className="grid gap-3 sm:grid-cols-3">
          <FactBox label="Page">{source.page ?? "Not recorded"}</FactBox>
          <FactBox label="Source reliability">
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck size={14} className="text-teal-700" />
              {Math.round(source.reliability * 100)} / 100
            </span>
          </FactBox>
          <FactBox label="Observed on">{observed}</FactBox>
        </dl>
        <p className="text-[11px] text-slate-500">
          Reliability describes the source, not whether the reported fact is
          verified.
        </p>
        {precedent && <PrecedentFacts precedent={precedent} />}
        <button
          onClick={onUse}
          className="inline-flex items-center gap-2 rounded-lg bg-navy px-3 py-2 text-xs font-medium text-white hover:opacity-90"
        >
          Ask about this source
          <ArrowUpRight size={14} />
        </button>
        <TechnicalDetails
          value={detail ?? source}
          label="Source provenance · JSON"
        />
      </div>
    </section>
  );
}
