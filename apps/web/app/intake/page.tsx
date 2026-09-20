import { IntakeView } from "@/components/intake/IntakeView";
import { DEMO_CASE_ID } from "@/lib/fixtures/intake";

/**
 * Unscoped entry point for documents that arrive before anyone has picked a
 * case (broker mail, batch scanning). It stands in the seeded demo case until
 * intake can suggest a match from the sanitized capture itself.
 */
export default function IntakePage() {
  return <IntakeView caseId={DEMO_CASE_ID} />;
}
