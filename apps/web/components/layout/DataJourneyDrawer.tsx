"use client";

import { Panel } from "@/components/ui/Panel";

const JOURNEY = [
  {
    name: "RDK X5",
    role: "Local capture, OCR, redaction, and release approval. Originals never leave the device by default.",
  },
  {
    name: "Gemini",
    role: "Sanitized document extraction with page-level provenance. Does not decide appetite.",
  },
  {
    name: "OpenAI",
    role: "Normalized-fact investigation planning, tool selection, and cited synthesis.",
  },
  {
    name: "GPTZero",
    role: "Redacted narrative integrity checks. Review signals, not accusations.",
  },
  {
    name: "Elasticsearch",
    role: "Sanitized evidence retrieval with BM25, dense vectors, and provenance.",
  },
  {
    name: "MongoDB Atlas",
    role: "Case state, audit versions, and precedent vectors. Not a document store for originals.",
  },
  {
    name: "Tiger Data",
    role: "Pseudonymous operational telemetry and continuous aggregates. Never raw documents.",
  },
  {
    name: "Backboard",
    role: "Approved non-case-specific underwriter preferences only. Optional and disable-safe.",
  },
];

export function DataJourneyContent() {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Sponsor systems are purpose-limited. Deterministic code still owns appetite, privacy release, and audit.
        This map is explanatory, not a second navigation.
      </p>
      {JOURNEY.map((item, index) => (
        <Panel key={item.name} className="!shadow-none">
          <div className="px-3 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
              {String(index + 1).padStart(2, "0")}
            </p>
            <h3 className="mt-1 font-serif text-base text-navy">{item.name}</h3>
            <p className="mt-1 text-sm text-ink">{item.role}</p>
          </div>
        </Panel>
      ))}
    </div>
  );
}
