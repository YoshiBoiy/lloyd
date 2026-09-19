import { CaseWorkspace } from "@/components/case/CaseWorkspace";

export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CaseWorkspace id={decodeURIComponent(id)} />;
}
