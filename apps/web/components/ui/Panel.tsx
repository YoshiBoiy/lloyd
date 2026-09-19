import type { ReactNode } from "react";
import { classNames } from "@/lib/format";

export function Panel({
  children,
  className,
  title,
  actions,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  actions?: ReactNode;
}) {
  return (
    <section className={classNames("rounded-sm border border-line bg-panel paper-shadow", className)}>
      {title ? (
        <header className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">{title}</h2>
          {actions}
        </header>
      ) : null}
      <div className={title ? "p-3" : "p-0"}>{children}</div>
    </section>
  );
}
