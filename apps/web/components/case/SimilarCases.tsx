import type { SimilarCase } from "@/lib/api/types";
import { DecisionBadge } from "@/components/ui/Badge";
import { Panel } from "@/components/ui/Panel";
import { formatPercent } from "@/lib/format";

export function SimilarCases({ cases }: { cases: SimilarCase[] }) {
  return (
    <Panel title="Similar cases">
      <p className="mb-2 text-[12px] text-muted">
        Atlas nearest neighbors are advisory. A precedent never overrides the current appetite document.
      </p>
      <ul className="space-y-3">
        {cases.length === 0 ? (
          <li className="text-sm text-muted">No neighboring cases yet. Run an investigation to retrieve Atlas precedents.</li>
        ) : null}
        {cases.map((item) => (
          <li key={item.caseId} className="border-b border-line pb-2 last:border-0">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-medium">{item.accountName}</p>
              <span className="tabular text-[12px]">{formatPercent(item.similarity * 100)}</span>
            </div>
            <div className="mt-1">
              <DecisionBadge value={item.historicalDecision} />
            </div>
            <p className="mt-1 text-[12px]">
              <span className="text-muted">Shared: </span>
              {item.sharedFactors.join(" · ")}
            </p>
            <p className="text-[12px]">
              <span className="text-muted">Different: </span>
              {item.materialDifferences.join(" · ")}
            </p>
            <p className="text-[12px] text-ink">
              {item.humanApproved ? "Human-approved: " : "Unapproved rationale: "}
              {item.humanApprovedRationale}
            </p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
