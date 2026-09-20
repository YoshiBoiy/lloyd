import { classNames } from "@/lib/format";
import type { ButtonHTMLAttributes } from "react";

type Tone = "primary" | "secondary" | "ghost" | "danger" | "amber";

const tones: Record<Tone, string> = {
  primary: "bg-navy text-paper hover:bg-navy-2",
  secondary: "bg-panel text-ink border border-line hover:bg-panel-2",
  ghost: "bg-transparent text-ink hover:bg-panel-2",
  danger: "bg-crimson text-paper hover:opacity-90",
  amber: "bg-amber text-paper hover:opacity-90",
};

export function Button({
  tone = "secondary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone }) {
  return (
    <button
      className={classNames(
        "inline-flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-45",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
