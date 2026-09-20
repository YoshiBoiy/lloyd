"use client";

import Link from "next/link";
import { type ReactNode, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useCaseList, useLloydSnapshot } from "@/lib/hooks";
import { getLloydApi } from "@/lib/api";
import { formatPercent, formatScore, formatTimestamp, formatUsd } from "@/lib/format";
import type { CaseListFilters, CaseStage, DecisionClass } from "@/lib/api/types";
import { DecisionBadge, StageBadge } from "@/components/ui/Badge";
import { Panel } from "@/components/ui/Panel";

const DECISIONS: Array<DecisionClass | ""> = [
  "",
  "IN_APPETITE",
  "ACCEPT_WITH_CONDITIONS",
  "INVESTIGATE",
  "OUT_OF_APPETITE",
];
const STAGES: Array<CaseStage | ""> = ["", "NEW", "INVESTIGATING", "NEEDS_REVIEW", "READY_TO_QUOTE"];
const STATES = ["", "PA", "OH", "MD", "CO", "CA", "FL", "NC", "SC", "GA", "VA", "UT", "NY", "TX", "AZ", "ID"];

const controlClass =
  "h-8 rounded-md border border-slate-200/80 bg-white text-[12.5px] text-ink transition-colors duration-150 ease-out hover:border-slate-300 hover:bg-slate-50/70";
const selectClass =
  `${controlClass} appearance-none bg-[length:14px] bg-[right_8px_center] bg-no-repeat py-0 pl-2.5 pr-7 [background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%238b949e' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")]`;

export function DashboardView() {
  const [filters, setFilters] = useState<CaseListFilters>({ search: "" });
  const { data, loading, error } = useCaseList(filters);
  const activity = useLloydSnapshot(() => getLloydApi().getActivity(), []);

  const cards = useMemo(
    () => [
      { label: "New", value: data?.totals.new ?? "—", hint: "Not yet investigated" },
      { label: "Investigating", value: data?.totals.investigating ?? "—", hint: "Agent loop running" },
      { label: "Needs Review", value: data?.totals.needsReview ?? "—", hint: "Unknown, contradicted, or authenticity" },
      { label: "Ready to Quote", value: data?.totals.readyToQuote ?? "—", hint: "In appetite or conditions" },
    ],
    [data],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-[26px] text-navy">Submission queue</h1>
          <p className="text-sm text-muted">
            {data ? `${data.totals.all} commercial property files` : "Loading ranked queue"} · lanes precede numeric score
          </p>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        {cards.map((card) => (
          <Panel key={card.label} elevated>
            <div className="px-3.5 py-3.5">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-slate-500">{card.label}</p>
              <p className="mt-1.5 text-[32px] font-bold leading-none tracking-tight tabular text-navy">{card.value}</p>
              <p className="mt-1.5 text-[11px] text-faint">{card.hint}</p>
            </div>
          </Panel>
        ))}
      </div>

      <div className="grid grid-cols-[1fr_280px] gap-3">
        <Panel elevated>
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2.5">
            <label className="relative min-w-[220px] flex-1">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
              <input
                value={filters.search ?? ""}
                onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
                placeholder="Search account, broker, state"
                className={`${controlClass} w-full py-0 pl-8 pr-2.5`}
              />
            </label>
            <FilterSelect
              value={filters.state ?? ""}
              onChange={(state) => setFilters((current) => ({ ...current, state }))}
            >
              {STATES.map((state) => (
                <option key={state || "all"} value={state}>
                  {state || "All states"}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect
              value={filters.decision ?? ""}
              onChange={(decision) =>
                setFilters((current) => ({ ...current, decision: decision as DecisionClass | "" }))
              }
            >
              {DECISIONS.map((value) => (
                <option key={value || "all"} value={value}>
                  {value ? value.replaceAll("_", " ") : "All decisions"}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect
              value={filters.stage ?? ""}
              onChange={(stage) => setFilters((current) => ({ ...current, stage: stage as CaseStage | "" }))}
            >
              {STAGES.map((value) => (
                <option key={value || "all"} value={value}>
                  {value ? value.replaceAll("_", " ") : "All stages"}
                </option>
              ))}
            </FilterSelect>
          </div>
          <div className="overflow-x-auto">
            {error ? <p className="px-3 py-6 text-crimson">{error}</p> : null}
            {loading && !data ? <p className="px-3 py-6 text-muted">Loading submissions…</p> : null}
            <table className="w-full min-w-[960px] text-left">
              <thead className="text-[10px] font-medium uppercase tracking-[0.16em] text-slate-500">
                <tr>
                  <th className="px-3 py-2.5 text-left font-medium">Account</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-left font-medium">Appetite</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-left font-medium">Stage</th>
                  <th className="w-[1%] whitespace-nowrap px-3 py-2.5 text-right font-medium">Score</th>
                  <th className="w-[1%] whitespace-nowrap px-3 py-2.5 text-right font-medium">Complete</th>
                  <th className="w-[1%] whitespace-nowrap px-3 py-2.5 text-right font-medium">Premium</th>
                  <th className="w-[1%] whitespace-nowrap px-3 py-2.5 pr-5 text-right font-medium">Tiv</th>
                  <th className="whitespace-nowrap px-3 py-2.5 pl-4 text-left font-medium">State</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-left font-medium">Broker</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-left font-medium">Assignee</th>
                </tr>
              </thead>
              <tbody>
                {data?.cases.map((item) => (
                  <tr
                    key={item.id}
                    className="border-b border-slate-100 transition-colors duration-150 ease-out last:border-0 hover:bg-slate-50/80"
                  >
                    <td className="px-3 py-2.5">
                      <Link
                        href={`/cases/${encodeURIComponent(item.id)}`}
                        className="font-medium text-navy transition-colors duration-150 ease-out hover:text-navy-2"
                      >
                        {item.accountName}
                      </Link>
                      <p className="text-[11px] text-faint">
                        {item.submissionType === "new_business" ? "New business" : "Renewal"}
                      </p>
                    </td>
                    <td className="px-3 py-2.5">
                      <DecisionBadge value={item.decision} />
                    </td>
                    <td className="px-3 py-2.5">
                      <StageBadge value={item.stage} />
                    </td>
                    <td className="w-[1%] whitespace-nowrap px-3 py-2.5 text-right tabular">{formatScore(item.appetiteScore)}</td>
                    <td className="w-[1%] whitespace-nowrap px-3 py-2.5 text-right tabular">{formatPercent(item.completeness)}</td>
                    <td className="w-[1%] whitespace-nowrap px-3 py-2.5 text-right tabular">{item.premium ? formatUsd(item.premium) : "—"}</td>
                    <td className="w-[1%] whitespace-nowrap px-3 py-2.5 pr-5 text-right tabular">{item.tiv ? formatUsd(item.tiv) : "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 pl-4">{item.state}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">{item.broker === "—" ? "—" : item.broker}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">{item.assignee === "—" ? "—" : item.assignee}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel elevated title="Recent activity">
          <ul className="space-y-3">
            {(activity.data ?? []).length === 0 ? (
              <li className="text-sm text-muted">No recent file activity.</li>
            ) : (
              (activity.data ?? []).map((item) => (
              <li key={item.id}>
                <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">{formatTimestamp(item.at)}</p>
                <p className="text-sm text-ink">{item.summary}</p>
                <p className="text-xs text-faint">{item.actor}</p>
              </li>
              ))
            )}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function FilterSelect({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} className={selectClass}>
      {children}
    </select>
  );
}
