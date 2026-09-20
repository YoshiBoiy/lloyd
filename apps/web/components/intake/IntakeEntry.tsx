"use client";

import { getApiMode } from "@/lib/api";
import { IntakeView } from "@/components/intake/IntakeView";
import { IntakeV2View } from "@/components/intake/IntakeV2View";

export type IntakeContract = "v1" | "v2";

/**
 * Release contract v2 is the default against a live gateway.
 */
export function resolveIntakeContract(env: Record<string, string | undefined> = process.env): IntakeContract {
  const forced = env.NEXT_PUBLIC_INTAKE_CONTRACT;
  if (forced === "v1" || forced === "v2") return forced;
  return getApiMode() === "http" ? "v2" : "v1";
}

export function IntakeEntry({
  caseId,
  fallbackCaseId,
  intakeId,
}: {
  caseId?: string;
  fallbackCaseId?: string;
  /** An in-flight intake to resume, normally linked from the intake workspace. */
  intakeId?: string;
}) {
  return resolveIntakeContract() === "v2" ? (
    <IntakeV2View caseId={caseId} intakeId={intakeId} />
  ) : (
    <IntakeView caseId={caseId ?? fallbackCaseId ?? ""} />
  );
}
