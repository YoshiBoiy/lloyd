import { sha256 } from "../../contracts/src/index.js";
import { evaluate, type Facts } from "../../engine/src/index.js";
import {
  CaseStore,
  EvidenceStore,
  embed,
} from "../../integrations/src/data.js";
export const DEMO_CASE = "case:harrisburg-bindery";
export const demoQuestions = [
  [
    "What evidence contradicts sprinkler coverage?",
    "EVIDENCE_SEARCH",
    ["ev_questionnaire", "ev_inspection"],
  ],
  [
    "What percentage of TIV is acceptable construction?",
    "CASE_FACT_LOOKUP",
    ["case:case:harrisburg-bindery:v1:construction"],
  ],
  [
    "Show similar accepted cases and explain how they resolved sprinkler uncertainty.",
    "COMBINED_INVESTIGATION",
    ["precedent:case:accepted-1:v1"],
  ],
  [
    "Why is this case still under investigation?",
    "CASE_EXPLANATION",
    ["case:case:harrisburg-bindery:v1:decision"],
  ],
  [
    "Show the loss documents supporting the five-year total.",
    "EVIDENCE_SEARCH",
    ["ev_loss"],
  ],
  [
    "Which appetite guideline applies to this premium?",
    "GUIDELINE_LOOKUP",
    ["ev_guideline"],
  ],
  [
    "Find similar risks with acceptable construction and lower losses.",
    "PRECEDENT_SEARCH",
    ["precedent:case:accepted-1:v1"],
  ],
  [
    "How is this case different from its three closest precedents?",
    "PRECEDENT_COMPARISON",
    [
      "precedent:case:accepted-1:v1",
      "precedent:case:accepted-2:v1",
      "precedent:case:accepted-3:v1",
    ],
  ],
  [
    "Which facts came from Gemini rather than Federato?",
    "CASE_FACT_LOOKUP",
    ["case:case:harrisburg-bindery:v1:submissionType"],
  ],
  [
    "Do we have enough evidence to verify the building year?",
    "CASE_FACT_LOOKUP",
    ["case:case:harrisburg-bindery:v1:buildingYear"],
  ],
  [
    "Find protection impairment in the annex.",
    "EVIDENCE_SEARCH",
    ["ev_inspection"],
  ],
  ["Find guideline GL-PREMIUM-01.", "GUIDELINE_LOOKUP", ["ev_guideline"]],
  [
    "What is the normalized five-year loss total?",
    "CASE_FACT_LOOKUP",
    ["case:case:harrisburg-bindery:v1:losses"],
  ],
  [
    "Compare this case with its closest precedent.",
    "PRECEDENT_COMPARISON",
    ["precedent:case:accepted-1:v1"],
  ],
  [
    "Find the sprinkler questionnaire.",
    "EVIDENCE_SEARCH",
    ["ev_questionnaire"],
  ],
  [
    "What evidence supports masonry construction?",
    "EVIDENCE_SEARCH",
    ["ev_construction"],
  ],
  [
    "What is the verified premium fact?",
    "CASE_FACT_LOOKUP",
    ["case:case:harrisburg-bindery:v1:premium"],
  ],
  [
    "Which PA cases need review?",
    "PORTFOLIO_FILTER",
    ["case:case:harrisburg-bindery:v1:decision"],
  ],
] as const;
export async function seedAskDemo(cases: CaseStore, evidence: EvidenceStore) {
  const at = "2026-09-20T12:00:00Z";
  const fact = (value: unknown, id: string): NonNullable<Facts["premium"]> => ({
    value,
    contradicted: false,
    evidence: [
      { id, source: "fixture", path: id, observedAt: at, verified: true },
    ],
  });
  const facts: Facts = {
    submissionType: fact("new_business", "type"),
    lineOfBusiness: fact("property", "lob"),
    primaryState: fact("PA", "state"),
    effectiveDate: fact("2026-10-01", "effective"),
    tiv: fact(90e6, "tiv"),
    premium: fact(176000, "premium"),
    buildingYear: fact(1990, "year"),
    losses: fact(
      { complete: true, items: [{ date: "2024-01-01", amount: 24000 }] },
      "ev_loss",
    ),
  };
  for (let i = 0; i < 4; i++) {
    const id = i ? `case:accepted-${i}` : DEMO_CASE;
    if (await cases.get(id)) continue;
    const f: Facts = i
      ? {
          ...facts,
          premium: fact(96000 + i * 1000, "premium"),
          losses: fact(
            {
              complete: true,
              items: [{ date: "2024-01-01", amount: 18000 + i * 1000 }],
            },
            "losses",
          ),
          buildingYear: fact(2010 + i, "year"),
          construction: fact(
            [{ tiv: 90e6, construction: "masonry_noncombustible" }],
            "construction",
          ),
        }
      : facts;
    await cases.put({
      id,
      tenantId: "carrier-demo",
      humanApproved: i > 0,
      approvedRationale:
        i > 0
          ? [
              {
                evidenceId: `resolution:${id}`,
                text: "Sprinkler uncertainty was resolved after a human reviewer verified an inspection confirming annex sprinkler installation and commissioning.",
              },
            ]
          : [],
      version: 1,
      schemaHash: "ask-demo-v1",
      mode: "fixture",
      facts: f,
      decision: evaluate(f),
      updatedAt: at,
      sourceHash: sha256(JSON.stringify(f)),
    });
  }
  const rows = [
    [
      "ev_questionnaire",
      "doc:questionnaire",
      "Sprinkler and Protection Questionnaire",
      "questionnaire",
      "Sprinkler questionnaire states that the entire building has full sprinkler protection.",
      "CONTRADICTED",
    ],
    [
      "ev_inspection",
      "doc:inspection",
      "Inspector note — annex",
      "inspection_report",
      "Inspector observed an unprotected annex with no sprinkler coverage. This contradicts the questionnaire; sprinkler protection remains CONTRADICTED.",
      "CONTRADICTED",
    ],
    [
      "ev_construction",
      "doc:construction",
      "Construction statement",
      "statement",
      "The main building is described as masonry. No TIV allocation or construction percentage is established for the annex.",
      "UNVERIFIED",
    ],
    [
      "ev_loss",
      "doc:loss",
      "Five-year loss run",
      "loss_run",
      "Five-year loss total is $24,000 for the period before 2026-10-01.",
      "VERIFIED",
    ],
    [
      "ev_guideline",
      "doc:guideline",
      "GL-PREMIUM-01",
      "guideline",
      "GL-PREMIUM-01: Premium above $175,000 is outside the configured premium appetite band.",
      "VERIFIED",
    ],
  ];
  for (const [
    evidenceId,
    documentId,
    title,
    sourceType,
    text,
    verificationStatus,
  ] of rows)
    await evidence.add({
      evidenceId: evidenceId!,
      documentId: documentId!,
      title: title!,
      sourceType: sourceType!,
      text: text!,
      verificationStatus: verificationStatus!,
      caseId: DEMO_CASE,
      tenantId: "carrier-demo",
      sourceUri: `sanitized://${documentId}`,
      sourceField: "text",
      observedAt: at,
      contentHash: sha256(text!),
      vector: embed(text!),
      page: 1,
      reliability: 0.9,
    });
  return {
    caseId: DEMO_CASE,
    mode: "fixture",
    notice: "Synthetic demonstration data",
  };
}
