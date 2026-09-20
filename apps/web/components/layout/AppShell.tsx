"use client";

import { useState, type ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Drawer } from "@/components/ui/Drawer";
import { DataJourneyContent } from "./DataJourneyDrawer";

export function AppShell({ children }: { children: ReactNode }) {
  const [journeyOpen, setJourneyOpen] = useState(false);

  return (
    <div className="flex h-screen min-h-0 bg-paper">
      <Sidebar onOpenJourney={() => setJourneyOpen(true)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-slate-200/60 bg-panel px-4">
          <p className="text-[12px] text-muted">Commercial property · 2025 appetite</p>
          <p className="text-[12px] text-muted">Live submissions</p>
        </header>
        <main className="min-h-0 flex-1 overflow-auto p-4">{children}</main>
      </div>
      <Drawer open={journeyOpen} title="Data journey" onClose={() => setJourneyOpen(false)}>
        <DataJourneyContent />
      </Drawer>
    </div>
  );
}
