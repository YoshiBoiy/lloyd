import { IntakeEntry } from "@/components/intake/IntakeEntry";

export default async function CaseIntakePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caseId = decodeURIComponent(id);
  return <IntakeEntry caseId={caseId} fallbackCaseId={caseId} />;
}
