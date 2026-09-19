import type { ReactNode } from "react";
import { classNames } from "@/lib/format";
import type { DecisionClass, EvidenceLabel, CriterionStatus, CaseStage, PrivacyClassification } from "@/lib/api/types";

const decision: Record<DecisionClass, string> = {
  IN_APPETITE: "bg-emerald-soft text-emerald",
  ACCEPT_WITH_CONDITIONS: "bg-emerald-soft text-emerald",
  INVESTIGATE: "bg-amber-soft text-amber",
  OUT_OF_APPETITE: "bg-crimson-soft text-crimson",
};

const evidence: Record<EvidenceLabel, string> = {
  VERIFIED: "bg-emerald-soft text-emerald",
  INFERRED: "bg-panel-2 text-muted",
  CONTRADICTED: "bg-crimson-soft text-crimson",
  UNKNOWN: "bg-amber-soft text-amber",
  STALE: "bg-amber-soft text-amber",
};

const criterion: Record<CriterionStatus, string> = {
  TARGET: "bg-emerald-soft text-emerald",
  ACCEPTABLE: "bg-emerald-soft text-emerald",
  NOT_ACCEPTABLE: "bg-crimson-soft text-crimson",
  UNKNOWN: "bg-amber-soft text-amber",
  CONTRADICTED: "bg-crimson-soft text-crimson",
  BOUNDARY_REVIEW: "bg-amber-soft text-amber",
};

const stage: Record<CaseStage, string> = {
  NEW: "bg-panel-2 text-ink",
  INVESTIGATING: "bg-amber-soft text-amber",
  NEEDS_REVIEW: "bg-amber-soft text-amber",
  READY_TO_QUOTE: "bg-emerald-soft text-emerald",
};

const privacy: Record<PrivacyClassification, string> = {
  LOCAL_ONLY: "bg-navy text-paper",
  REDACTED: "bg-crimson-soft text-crimson",
  TOKENIZED: "bg-panel-2 text-ink",
  GENERALIZED: "bg-amber-soft text-amber",
  CLOUD_ALLOWED: "bg-emerald-soft text-emerald",
};

export function Badge({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={classNames("inline-flex items-center rounded-sm px-1.5 py-0.5 text-[10.5px] font-medium tracking-wide uppercase", className)}>
      {children}
    </span>
  );
}

export function DecisionBadge({ value }: { value: DecisionClass }) {
  return <Badge className={decision[value]}>{value.replaceAll("_", " ")}</Badge>;
}

export function EvidenceBadge({ value }: { value: EvidenceLabel }) {
  return <Badge className={evidence[value]}>{value}</Badge>;
}

export function CriterionBadge({ value }: { value: CriterionStatus }) {
  return <Badge className={criterion[value]}>{value.replaceAll("_", " ")}</Badge>;
}

export function StageBadge({ value }: { value: CaseStage }) {
  return <Badge className={stage[value]}>{value.replaceAll("_", " ")}</Badge>;
}

export function PrivacyBadge({ value }: { value: PrivacyClassification }) {
  return <Badge className={privacy[value]}>{value.replaceAll("_", " ")}</Badge>;
}
