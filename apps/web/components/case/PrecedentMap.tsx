"use client";

import { useMemo, useState } from "react";
import type { CaseDetail, DecisionClass } from "@/lib/api/types";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";

const COLORS: Record<DecisionClass, string> = {
  IN_APPETITE: "#1f6b4a",
  ACCEPT_WITH_CONDITIONS: "#3d7a4f",
  INVESTIGATE: "#9a6700",
  OUT_OF_APPETITE: "#8f3a3a",
};

export function PrecedentMap({ current }: { current: CaseDetail }) {
  const [open, setOpen] = useState(false);
  const nodes = useMemo(() => {
    const neighbors = current.similarCases.slice(0, 5).map((item, index) => {
      const angle = (index / Math.max(current.similarCases.length, 1)) * Math.PI * 2 - Math.PI / 2;
      return {
        id: item.caseId,
        label: item.accountName,
        decision: item.historicalDecision,
        x: 160 + Math.cos(angle) * 95,
        y: 120 + Math.sin(angle) * 78,
      };
    });
    return [{ id: current.id, label: current.accountName, decision: current.decision, x: 160, y: 120 }, ...neighbors];
  }, [current]);

  return (
    <Panel
      title="Explore similar risks"
      actions={
        <Button tone="ghost" onClick={() => setOpen((value) => !value)}>
          {open ? "Hide map" : "Show map"}
        </Button>
      }
    >
      <p className="text-[12px] text-muted">
        Optional layout. Nodes are cases, not document chunks. Edges are nearest neighbors. Color is decision.
        Projected position is approximate and does not determine underwriting outcomes.
      </p>
      {open ? (
        <svg viewBox="0 0 320 240" className="mt-2 h-56 w-full border border-line bg-paper" role="img" aria-label="Approximate precedent map">
          {nodes.slice(1).map((node) => (
            <line key={`e-${node.id}`} x1={160} y1={120} x2={node.x} y2={node.y} stroke="#d4cbbb" strokeWidth="1" />
          ))}
          {nodes.map((node, index) => (
            <g key={node.id}>
              <circle cx={node.x} cy={node.y} r={index === 0 ? 10 : 7} fill={COLORS[node.decision]} />
              <text x={node.x} y={node.y + 18} textAnchor="middle" fontSize="8" fill="#142433">
                {node.label.split(" ").slice(0, 2).join(" ")}
              </text>
            </g>
          ))}
        </svg>
      ) : null}
    </Panel>
  );
}
