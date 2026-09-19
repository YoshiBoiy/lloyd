"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ClipboardList,
  FileSearch,
  LayoutDashboard,
  ScanLine,
  Settings,
  BarChart3,
} from "lucide-react";
import { classNames } from "@/lib/format";

const items = [
  { href: "/dashboard", label: "Submission Queue", icon: LayoutDashboard },
  { href: "/intake", label: "Secure Intake", icon: ScanLine },
  { href: "/guidelines", label: "Appetite Guidelines", icon: ClipboardList },
  { href: "/analytics", label: "Investigation Analytics", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar({ onOpenJourney }: { onOpenJourney: () => void }) {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-[228px] shrink-0 flex-col bg-navy text-paper">
      <div className="border-b border-white/10 px-4 py-4">
        <p className="font-serif text-[22px] leading-none tracking-tight">Lloyd</p>
        <p className="mt-1 text-[11px] text-white/65">Commercial property workstation</p>
      </div>
      <nav className="flex-1 px-2 py-3" aria-label="Primary">
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={classNames(
                "mb-0.5 flex items-center gap-2 rounded-sm px-2.5 py-2 text-[13px]",
                active ? "bg-white/10 text-paper" : "text-white/75 hover:bg-white/5 hover:text-paper",
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
          className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-[12px] text-white/75 hover:bg-white/5 hover:text-paper"
        >
          <FileSearch size={14} />
          How data moves
        </button>
        <p className="mt-2 px-2 text-[11px] text-white/45">A. Chen · Senior UW</p>
      </div>
    </aside>
  );
}
