import { classNames } from "@/lib/format";

/** Wordmark is black-on-gold; only render on white or off-white. */
export function LloydLogo({
  className,
  heightClass = "h-8",
}: {
  className?: string;
  heightClass?: string;
}) {
  return (
    <div className={classNames("bg-panel", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/lloyd-logo.svg" alt="Lloyd" className={`${heightClass} w-auto`} />
    </div>
  );
}
