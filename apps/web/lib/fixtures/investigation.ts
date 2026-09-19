import type { InvestigationStep } from "../api/types";

export const DEMO_INVESTIGATION_STEPS: Omit<InvestigationStep, "status" | "startedAt" | "completedAt">[] = [
  {
    sequence: 1,
    tool: "openai_plan",
    sponsorLabel: "OpenAI",
    reason: "Plan the minimum tools needed to resolve construction mix, authenticity, and loss-run support.",
    resultSummary: "Selected Federato query, Gemini extraction, Elasticsearch hybrid search, Atlas precedents, and GPTZero review.",
  },
  {
    sequence: 2,
    tool: "federato_query",
    sponsorLabel: "Federato",
    reason: "Query buildings and TIV-weighted construction after schema validation.",
    resultSummary: "4 buildings. Controlling mill 2016 masonry NC. Query hash qry_bldg_19 validated against schema.",
  },
  {
    sequence: 3,
    tool: "gemini_extract",
    sponsorLabel: "Gemini",
    reason: "Extract candidate facts from the sanitized inspection page with page provenance.",
    resultSummary: "Page 1: leased storage shed described as frame and not intended for coverage.",
  },
  {
    sequence: 4,
    tool: "elastic_search",
    sponsorLabel: "Elasticsearch",
    reason: "Hybrid BM25 + dense retrieval for construction and occupancy notes.",
    resultSummary: "Top hit restates the frame-shed exclusion language; provenance ev_construction.",
  },
  {
    sequence: 5,
    tool: "atlas_precedents",
    sponsorLabel: "MongoDB Atlas",
    reason: "Retrieve nearest normalized case versions, excluding the current file.",
    resultSummary: "Three human-approved mill conversions in PA/MD with conditions on excluded structures.",
  },
  {
    sequence: 6,
    tool: "gptzero_authorship",
    sponsorLabel: "GPTZero",
    reason: "Scan the redacted broker narrative under carrier policy human_authored_or_disclosed.",
    resultSummary: "AI-authorship probability 0.78. Outcome AUTHENTICITY_REVIEW — not an accusation.",
  },
  {
    sequence: 7,
    tool: "gptzero_claims",
    sponsorLabel: "GPTZero",
    reason: "Check the draft recommendation for unsupported claims before display.",
    resultSummary: "Flagged “quiet five-year period” until loss-run evidence is cited.",
  },
  {
    sequence: 8,
    tool: "evaluate_appetite",
    sponsorLabel: "Appetite engine",
    reason: "Re-run only affected deterministic rules. Hard failures still require verified NOT_ACCEPTABLE facts.",
    resultSummary: "Construction mix CONTRADICTED. Authenticity review open. Decision INVESTIGATE.",
  },
];
