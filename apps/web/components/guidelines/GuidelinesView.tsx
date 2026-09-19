"use client";

import { useState } from "react";
import { getLloydApi } from "@/lib/api";
import { useLloydSnapshot } from "@/lib/hooks";
import { Panel } from "@/components/ui/Panel";
import { CriterionBadge } from "@/components/ui/Badge";
import Link from "next/link";

export function GuidelinesView() {
  const [query, setQuery] = useState("");
  const { data, loading } = useLloydSnapshot(() => getLloydApi().listGuidelines(query), [query]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-serif text-[26px] text-navy">Appetite guidelines</h1>
        <p className="text-sm text-muted">2025 commercial property clauses plus the demo authenticity policy pack.</p>
      </div>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search original language, factor, or source passage"
        className="w-full max-w-xl rounded-sm border border-line bg-panel px-3 py-2"
      />
      {loading && !data ? <p className="text-muted">Loading clauses…</p> : null}
      <div className="space-y-3">
        {(data ?? []).map((clause) => (
          <Panel key={clause.clauseId}>
            <div className="px-3 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-serif text-lg text-navy">{clause.factor.replaceAll("_", " ")}</h2>
                {clause.classification === "EXCEPTION" ? (
                  <span className="text-[10.5px] font-medium uppercase tracking-wide text-amber">Carrier policy pack</span>
                ) : (
                  <CriterionBadge value={clause.classification} />
                )}
              </div>
              <p className="text-[12px] text-muted">
                Version {clause.version} · effective {clause.effectiveDate} · {clause.sourceDocument}
              </p>
              <p className="mt-2 text-sm">{clause.originalLanguage}</p>
              <p className="mt-2 font-mono text-[12px] text-navy">{clause.structuredRule}</p>
              {clause.exceptions.length > 0 ? (
                <ul className="mt-2 list-disc pl-4 text-[12.5px] text-muted">
                  {clause.exceptions.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : null}
              <blockquote className="mt-2 border-l-2 border-line px-2 text-[12.5px] italic">{clause.sourcePassage}</blockquote>
              <p className="mt-2 text-[12px] text-muted">Affected submissions</p>
              <div className="mt-1 flex flex-wrap gap-2">
                {clause.affectedSubmissionIds.length === 0 ? (
                  <span className="text-[12px] text-muted">None in current fixture slice</span>
                ) : (
                  clause.affectedSubmissionIds.map((id) => (
                    <Link key={id} href={`/cases/${encodeURIComponent(id)}`} className="text-[12px] text-navy underline decoration-line underline-offset-4">
                      {id}
                    </Link>
                  ))
                )}
              </div>
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}
