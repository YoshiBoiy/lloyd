/**
 * Boundary rules for the same-origin edge proxy (`app/api/edge/[...path]/route.ts`).
 *
 * Raw camera preview and the local review payload (sanitized text beside a proposed manifest)
 * are served by the gateway only to a directly paired local client (TDD §4). The proxy never
 * relays them and marks everything it does relay as forwarded, so the gateway can enforce the
 * same boundary on its side.
 *
 * The rules are an allowlist, not a denylist: a route the proxy has never heard of is refused
 * rather than relayed. A denylist keyed on the last path segment is fail-open — adding a new
 * gateway route would silently make it proxyable, including one that carries sanitized content
 * (workspace TDD §5.1).
 */
/** Mirrors the gateway's PRIVILEGED_SUFFIXES: `/review`, `/preview`, `/preview/stream` (v1 and v2 alike). */
export const PRIVILEGED_SUFFIXES = ["review", "preview", "stream"] as const;
export const FORWARDED_VIA = "1.1 lloyd-web";

/**
 * Routes this proxy may relay, as segment patterns. `:id` matches one segment.
 * Every entry is metadata, control or the release path — never document content.
 */
export const RELAYABLE_ROUTES: readonly string[] = [
  "health",
  // v2 device sessions: enumeration and bounded per-intake metadata plus the control verbs.
  "v2/intakes",
  "v2/intakes/:id/status",
  "v2/intakes/:id/pages",
  "v2/intakes/:id/analyze",
  "v2/intakes/:id/case",
  "v2/intakes/:id/redactions",
  "v2/intakes/:id/approve",
  "v2/intakes/:id/release",
  "v2/intakes/:id/originals",
  // v1 document flow, retained while v1 callers migrate.
  "capture",
  "documents/:id/ocr",
  "documents/:id/redact",
  "documents/:id/release",
  "documents/:id/original",
];

export function isPrivileged(segments: readonly string[]): boolean {
  const last = segments.at(-1);
  if (last === "review" || last === "preview") return true;
  return last === "stream" && segments.at(-2) === "preview";
}

/** True when the path matches an allowlisted route pattern and is not privileged. */
export function isRelayable(segments: readonly string[]): boolean {
  if (isPrivileged(segments)) return false;
  return RELAYABLE_ROUTES.some((route) => {
    const pattern = route.split("/");
    if (pattern.length !== segments.length) return false;
    return pattern.every((part, i) => part === ":id" || part === segments[i]);
  });
}

/** Suffixes that consult the human-approval header: v1 at release, v2 at approve. */
export function wantsApproval(segments: readonly string[]): boolean {
  const last = segments.at(-1);
  return last === "release" || last === "approve";
}

export const DIRECT_PAIRING_REQUIRED = {
  error: {
    code: "DIRECT_PAIRING_REQUIRED",
    message:
      "Raw preview and local review are only served to a directly paired local client; this proxy does not relay them.",
  },
} as const;

export const ROUTE_NOT_RELAYED = {
  error: {
    code: "ROUTE_NOT_RELAYED",
    message:
      "This gateway route is not on the proxy allowlist. Add it to RELAYABLE_ROUTES only if it carries no document content.",
  },
} as const;
