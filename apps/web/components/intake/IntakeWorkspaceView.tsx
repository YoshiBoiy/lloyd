"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ScanLine } from "lucide-react";
import { getLloydApi } from "@/lib/api";
import { INTAKE_TABS } from "@/lib/api/intake-work";
import { useLloydSnapshot } from "@/lib/hooks";
import { formatTimestamp } from "@/lib/format";
import type { IntakeTab, IntakeWorkItem } from "@/lib/api/types";
import { Panel } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";
import { IntakeDetailPanel } from "./IntakeDetailPanel";

/**
 * The operator's intake workspace: one queue over two trust domains (workspace TDD §3, §4).
 *
 * Every scanned document in flight appears in exactly one of six queues, chosen by who must act
 * next, so the operator never has to know whether a given fact lives on the device or in the
 * cloud. The merge happens in the browser because the browser is the only component that
 * legitimately sees both: the gateway answers a locally paired client and the backend answers a
 * tenant-scoped reviewer. When a domain does not answer, its queues read unknown rather than
 * zero — a zero would claim there is no work waiting when nobody actually asked.
 */
export function IntakeWorkspaceView({
  initialIntakeId,
  initialTab,
}: {
  initialIntakeId?: string;
  initialTab?: IntakeTab;
}) {
  const { data: work, error, reload } = useLloydSnapshot(() => getLloydApi().listIntakeWork(), []);
  const [tab, setTab] = useState<IntakeTab>(initialTab ?? "privacy_review");
  const [selectedId, setSelectedId] = useState<string | null>(initialIntakeId ?? null);

  const rows = useMemo(() => (work?.items ?? []).filter((item) => item.tab === tab), [work, tab]);
  const selected = rows.find((item) => item.intakeId === selectedId) ?? rows[0] ?? null;

  // An intake named in the URL opens in whichever queue actually holds it, so a reloaded browser
  // can find its in-flight work again without knowing which stage it reached.
  useEffect(() => {
    if (!initialIntakeId || !work) return;
    const found = work.items.find((item) => item.intakeId === initialIntakeId);
    if (found) setTab(found.tab);
  }, [initialIntakeId, work]);

  const tabMeta = INTAKE_TABS.find((entry) => entry.id === tab)!;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-serif text-[26px] text-navy">Intake workspace</h1>
        <p className="text-sm text-muted">
          Every scanned document in flight, from the page on the platen to the document attached to a case. Device
          stages come from the paired gateway and cloud statuses from the tenant inbox; each item sits in the one queue
          whose owner must act next.
        </p>
      </div>

      {error ? <p className="text-sm text-crimson">{error}</p> : null}
      {work && !work.deviceReachable ? (
        <p className="rounded-sm border border-line bg-amber-soft px-3 py-2 text-[12.5px] text-amber">
          The privacy gateway {work.deviceReason ?? "did not answer"}, so device-owned queues are unknown rather than
          empty. Pair this browser with the gateway to see work awaiting capture or approval; backend work is
          unaffected.
        </p>
      ) : null}
      {work && !work.backendReachable ? (
        <p className="rounded-sm border border-line bg-amber-soft px-3 py-2 text-[12.5px] text-amber">
          The backend inbox {work.backendReason ?? "did not answer"}, so cloud-owned queues are unknown rather than
          empty. Local capture and review still work.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Intake queues">
        {INTAKE_TABS.map((entry) => {
          const count = work?.counts[entry.id] ?? null;
          const unknown = Boolean(work) && count === null;
          const known = work?.knownCounts[entry.id] ?? 0;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              onClick={() => {
                setTab(entry.id);
                setSelectedId(null);
              }}
              className={`rounded-md border px-2.5 py-1.5 text-[12.5px] transition-colors duration-150 ease-out ${
                tab === entry.id ? "border-navy bg-panel-2 text-navy" : "border-line hover:bg-panel-2"
              }`}
            >
              {entry.label}{" "}
              <span
                className="tabular text-muted"
                title={
                  unknown
                    ? `Unknown: a domain that fills this queue did not answer. ${known} known.`
                    : undefined
                }
              >
                {unknown ? `— (${known} known)` : (count ?? "")}
              </span>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-[0.9fr_1.1fr] gap-3">
        <Panel title={`${tabMeta.label} · acts next: ${tabMeta.owner.toLowerCase()}`}>
          <p className="mb-2 text-[11.5px] text-muted">{tabMeta.help}</p>
          {tab === "ready" ? (
            <Link
              href="/intake"
              className="mb-2 inline-flex items-center gap-1.5 rounded-md bg-navy px-2.5 py-1.5 text-[12.5px] font-medium text-paper"
            >
              <ScanLine size={14} /> Start a scan
            </Link>
          ) : null}
          {!work ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted">
              {work.counts[tab] === null
                ? "Unknown — the domain that fills this queue did not answer."
                : "Nothing in this queue."}
            </p>
          ) : (
            <ul className="space-y-1">
              {rows.map((item) => (
                <li key={item.intakeId}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(item.intakeId)}
                    className={`w-full rounded-sm border px-2 py-2 text-left text-[12.5px] ${
                      selected?.intakeId === item.intakeId ? "border-navy bg-panel-2" : "border-line hover:bg-panel-2"
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{item.documentType.replaceAll("_", " ")}</span>
                      {item.stage === "APPROVED" ? (
                        <Badge className="bg-emerald-soft text-emerald">
                          approved, not released
                          {item.approvalExpiresAt ? ` · expires ${formatTimestamp(item.approvalExpiresAt)}` : ""}
                        </Badge>
                      ) : null}
                      {item.reviewRisk.map((reason) => (
                        <Badge key={reason} className="bg-amber-soft text-amber">
                          {reason.replaceAll("_", " ").toLowerCase()}
                        </Badge>
                      ))}
                      {item.warnings.length ? (
                        <Badge className="bg-amber-soft text-amber">{item.warnings.join(", ")} unavailable</Badge>
                      ) : null}
                      {item.rejection ? (
                        <Badge className="bg-crimson-soft text-crimson">{item.rejection.code}</Badge>
                      ) : null}
                    </div>
                    <WorkItemLine item={item} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {selected ? <IntakeDetailPanel item={selected} onChanged={reload} /> : null}
      </div>
    </div>
  );
}

function WorkItemLine({ item }: { item: IntakeWorkItem }) {
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted">
      <span className="tabular">{item.intakeId.slice(0, 8)}…</span>
      <span className="tabular">r{item.revision}</span>
      {item.stage ? <span>device: {item.stage.replaceAll("_", " ").toLowerCase()}</span> : null}
      {item.status ? <span>cloud: {item.status.replaceAll("_", " ").toLowerCase()}</span> : null}
      {item.caseId ? <span className="tabular">{item.caseId}</span> : null}
      {item.updatedAt ? <span>{formatTimestamp(item.updatedAt)}</span> : null}
    </div>
  );
}
