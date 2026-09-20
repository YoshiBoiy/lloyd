import type { ReactNode } from "react";
import { classNames } from "@/lib/format";

export function Panel({
  children,
  className,
  title,
  actions,
  elevated = false,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  actions?: ReactNode;
  elevated?: boolean;
}) {
  return (
    <section
      className={classNames(
        "rounded-md",
        elevated
          ? "border border-slate-200/60 bg-white shadow-sm"
          : "border border-line bg-panel paper-shadow",
        className,
      )}
    >
      {title ? (
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-3 py-2">
          <h2 className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-slate-500">{title}</h2>
          {actions}
        </header>
      ) : null}
      <div className={title ? "p-3" : "p-0"}>{children}</div>
    </section>
  );
}
