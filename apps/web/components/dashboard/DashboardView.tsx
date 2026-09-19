"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useCaseList, useLloydSnapshot } from "@/lib/hooks";
import { getLloydApi } from "@/lib/api";
import { formatPercent, formatScore, formatTimestamp, formatUsd } from "@/lib/format";
import type { CaseListFilters, CaseStage, DecisionClass } from "@/lib/api/types";
import { DecisionBadge, StageBadge } from "@/components/ui/Badge";
import { Panel } from "@/components/ui/Panel";
import { DEMO_CASE_ID } from "@/lib/fixtures/intake";

const DECISIONS: Array<DecisionClass | ""> = [
  "",
  "IN_APPETITE",
  "ACCEPT_WITH_CONDITIONS",
  "INVESTIGATE",
  "OUT_OF_APPETITE",
];
const STAGES: Array<CaseStage | ""> = ["", "NEW", "INVESTIGATING", "NEEDS_REVIEW", "READY_TO_QUOTE"];
const STATES = ["", "PA", "OH", "MD", "CO", "CA", "FL", "NC", "SC", "GA", "VA", "UT", "NY", "TX", "AZ", "ID"];

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
        <Link href={`/cases/${encodeURIComponent(DEMO_CASE_ID)}`} className="text-[12.5px] text-navy underline decoration-line underline-offset-4">
          Open seeded demo case
        </Link>
      </div>

      <div className="grid grid-cols-4 gap-3">
        {cards.map((card) => (
          <Panel key={card.label}>
            <div className="px-3 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">{card.label}</p>
              <p className="mt-1 font-serif text-3xl tabular text-navy">{card.value}</p>
              <p className="text-[12px] text-muted">{card.hint}</p>
            </div>
          </Panel>
        ))}
      </div>

      <div className="grid grid-cols-[1fr_280px] gap-3">
        <Panel>
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
            <label className="relative min-w-[220px] flex-1">
              <Search size={14} className="absolute left-2 top-2.5 text-muted" />
              <input
                value={filters.search ?? ""}
                onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
                placeholder="Search account, broker, state"
                className="w-full rounded-sm border border-line bg-paper py-1.5 pl-7 pr-2"
              />
            </label>
            <select
              className="rounded-sm border border-line bg-paper px-2 py-1.5"
              value={filters.state ?? ""}
              onChange={(event) => setFilters((current) => ({ ...current, state: event.target.value }))}
            >
              {STATES.map((state) => (
                <option key={state || "all"} value={state}>
                  {state || "All states"}
                </option>
              ))}
            </select>
            <select
              className="rounded-sm border border-line bg-paper px-2 py-1.5"
              value={filters.decision ?? ""}
              onChange={(event) => setFilters((current) => ({ ...current, decision: event.target.value as DecisionClass | "" }))}
            >
              {DECISIONS.map((value) => (
                <option key={value || "all"} value={value}>
                  {value ? value.replaceAll("_", " ") : "All decisions"}
                </option>
              ))}
            </select>
            <select
              className="rounded-sm border border-line bg-paper px-2 py-1.5"
              value={filters.stage ?? ""}
              onChange={(event) => setFilters((current) => ({ ...current, stage: event.target.value as CaseStage | "" }))}
            >
              {STAGES.map((value) => (
                <option key={value || "all"} value={value}>
                  {value ? value.replaceAll("_", " ") : "All stages"}
                </option>
              ))}
            </select>
          </div>
          <div className="overflow-x-auto">
            {error ? <p className="px-3 py-6 text-crimson">{error}</p> : null}
            {loading && !data ? <p className="px-3 py-6 text-muted">Loading submissions…</p> : null}
            <table className="w-full min-w-[960px] text-left">
              <thead className="border-b border-line bg-panel-2 text-[11px] uppercase tracking-[0.12em] text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Account</th>
                  <th className="px-3 py-2 font-medium">Appetite</th>
                  <th className="px-3 py-2 font-medium">Stage</th>
                  <th className="px-3 py-2 font-medium">Score</th>
                  <th className="px-3 py-2 font-medium">Complete</th>
                  <th className="px-3 py-2 font-medium">Premium</th>
                  <th className="px-3 py-2 font-medium">TIV</th>
                  <th className="px-3 py-2 font-medium">State</th>
                  <th className="px-3 py-2 font-medium">Broker</th>
                  <th className="px-3 py-2 font-medium">Assignee</th>
                </tr>
              </thead>
              <tbody>
                {data?.cases.map((item) => (
                  <tr key={item.id} className="border-b border-line last:border-0 hover:bg-paper">
                    <td className="px-3 py-2">
                      <Link href={`/cases/${encodeURIComponent(item.id)}`} className="font-medium text-navy hover:underline">
                        {item.accountName}
                      </Link>
                      <p className="text-[11px] text-muted">
                        {item.submissionType === "new_business" ? "New business" : "Renewal"}
                        {item.isDemo ? " · Demo" : ""}
                      </p>
                    </td>
                    <td className="px-3 py-2">
                      <DecisionBadge value={item.decision} />
                    </td>
                    <td className="px-3 py-2">
                      <StageBadge value={item.stage} />
                    </td>
                    <td className="px-3 py-2 tabular">{formatScore(item.appetiteScore)}</td>
                    <td className="px-3 py-2 tabular">{formatPercent(item.completeness)}</td>
                    <td className="px-3 py-2 tabular">{formatUsd(item.premium)}</td>
                    <td className="px-3 py-2 tabular">{formatUsd(item.tiv)}</td>
                    <td className="px-3 py-2">{item.state}</td>
                    <td className="px-3 py-2">{item.broker}</td>
                    <td className="px-3 py-2">{item.assignee}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Live investigation activity">
          <ul className="space-y-3">
            {(activity.data ?? []).map((item) => (
              <li key={item.id}>
                <p className="text-[11px] uppercase tracking-[0.12em] text-muted">{formatTimestamp(item.at)}</p>
                <p className="text-sm text-ink">{item.summary}</p>
                <p className="text-[12px] text-muted">{item.actor}</p>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
