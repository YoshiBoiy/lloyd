import { IntakeWorkspaceView } from "@/components/intake/IntakeWorkspaceView";
import { INTAKE_TABS } from "@/lib/api/intake-work";
import type { IntakeTab } from "@/lib/api/types";

export default async function IntakeWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<{ intake?: string; tab?: string }>;
}) {
  const { intake, tab } = await searchParams;
  const initialTab = INTAKE_TABS.find((entry) => entry.id === tab)?.id as IntakeTab | undefined;
  return <IntakeWorkspaceView initialIntakeId={intake} initialTab={initialTab} />;
}
