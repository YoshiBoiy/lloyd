import { IntakeEntry } from "@/components/intake/IntakeEntry";

/**
 * Unscoped entry for documents that arrive before a case is chosen. v2 intake can start
 * unassigned and be matched from the workspace after release. `?intake=` resumes an in-flight
 * intake, so a reloaded browser returns to the same revision instead of orphaning the work.
 */
export default async function IntakePage({
  searchParams,
}: {
  searchParams: Promise<{ intake?: string }>;
}) {
  const { intake } = await searchParams;
  return <IntakeEntry intakeId={intake} />;
}
