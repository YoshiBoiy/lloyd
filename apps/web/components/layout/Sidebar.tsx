"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ClipboardList,
  FileSearch,
  Inbox,
  LayoutDashboard,
  ScanLine,
  Settings,
  BarChart3,
} from "lucide-react";
import { classNames } from "@/lib/format";
import { LloydLogo } from "./LloydLogo";

const items = [
  { href: "/explore", label: "Evidence Explorer", icon: FileSearch },
  { href: "/dashboard", label: "Submission Queue", icon: LayoutDashboard },
  { href: "/intake", label: "Secure Intake", icon: ScanLine },
  { href: "/intake/inbox", label: "Intake Workspace", icon: Inbox },
  { href: "/guidelines", label: "Appetite Guidelines", icon: ClipboardList },
  { href: "/analytics", label: "Investigation Analytics", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar({ onOpenJourney }: { onOpenJourney: () => void }) {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-[228px] shrink-0 flex-col border-r border-slate-200/60 bg-sidebar text-paper">
      <div className="px-3 pb-3 pt-4">
        <div className="rounded-md bg-panel px-2.5 py-2.5">
          <LloydLogo />
          <p className="mt-1.5 text-[11px] text-muted">Commercial property workstation</p>
        </div>
      </div>
      <nav className="flex-1 px-2 py-1" aria-label="Primary">
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={classNames(
                "mb-0.5 flex items-center gap-2 rounded-md px-2.5 py-2 text-[13px] transition-colors duration-150 ease-out",
                active ? "bg-white/10 text-paper" : "text-paper/70 hover:bg-white/5 hover:text-paper",
              )}
            >
              <Icon size={15} strokeWidth={1.75} />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-white/10 px-3 py-3">
        <button
          type="button"
          onClick={onOpenJourney}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[12px] text-paper/70 transition-colors duration-150 ease-out hover:bg-white/5 hover:text-paper"
        >
          <FileSearch size={14} />
          How data moves
        </button>
        <p className="mt-2 px-2 text-[11px] text-paper/40">Underwriter workstation</p>
      </div>
    </aside>
  );
}
