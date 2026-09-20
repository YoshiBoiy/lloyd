import { IntakeView } from "@/components/intake/IntakeView";

export default async function CaseIntakePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <IntakeView caseId={decodeURIComponent(id)} />;
}
