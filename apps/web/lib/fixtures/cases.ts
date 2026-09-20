import type {
  AppetiteCriterion,
  AuthenticityFinding,
  CaseDetail,
  CaseDocument,
  CaseSummary,
  CaseStage,
  DecisionClass,
  EvidenceItem,
  EvidenceLabel,
  NormalizedFact,
  SimilarCase,
} from "../api/types";
import {
  appetiteScore,
  classifyBuildingYear,
  classifyConstructionMix,
  classifyFiveYearLoss,
  classifyLineOfBusiness,
  classifyPremium,
  classifyState,
  classifySubmissionType,
  classifyTiv,
  completenessScore,
  CRITERION_WEIGHTS,
  decideClass,
  opportunityScore,
  priorityScore,
  STATUS_MULTIPLIER,
} from "../appetite";
import { DEMO_CASE_ID } from "./intake";

const NOW = "2026-09-19T14:20:00.000Z";

const ACCOUNT_NAMES = [
  "Keystone Cold Storage",
  "Allegheny Tool & Die",
  "Monongahela Paper Co.",
  "Three Rivers Plastics",
  "Ohio Valley Grain",
  "Cuyahoga Stamping",
  "Mahoning Metal Works",
  "Scioto Packaging",
  "Frederick Food Hub",
  "Chesapeake Light Assembly",
  "Annapolis Marine Supply",
  "Front Range Logistics",
  "Pikes Peak Components",
  "Boulder Precision",
  "Denver West Bindery",
  "Sacramento Valley Cold",
  "East Bay Conversion",
  "Central Valley Packing",
  "Tampa Bay Warehousing",
  "Lakeland Citrus Pack",
  "Orlando Light Mfg",
  "Charlotte Textile Lofts",
  "Greenville Assembly",
  "Columbia Distribution",
  "Savannah Port Storage",
  "Macon Wood Products",
  "Roanoke Machine",
  "Richmond Paper Converting",
  "Norfolk Marine Gear",
  "Salt Lake Fulfillment",
  "Provo Composites",
  "Ogden Cold Chain",
  "Harrisburg Bindery",
  "Erie Foundry Partners",
  "Reading Apparel Cut",
  "York Agricultural Supply",
  "Canton Bearing Works",
  "Toledo Glass & Mirror",
  "Akron Rubber Goods",
  "Dayton Tool Crib",
  "Columbus Carton",
  "Cincinnati Soap Works",
  "Baltimore Spice Mill",
  "Hagerstown Knit",
  "Wilmington Plastics",
  "Raleigh Furniture RTA",
  "Durham Lab Fit-Out",
  "Asheville Craft Production",
  "Boise Valley Seed",
  "Phoenix Desert Storage",
  "Dallas Metro Pack",
];

const BROKERS = ["Aon Risk", "Marsh", "WTW", "Lockton", "Alliant", "Brown & Brown"];
const ASSIGNEES = ["A. Chen", "M. Okonkwo", "S. Patel", "J. Reyes", "Unassigned"];
const STATES = ["PA", "OH", "MD", "CO", "CA", "FL", "NC", "SC", "GA", "VA", "UT", "NY", "TX", "AZ", "ID"];

function mulberry32(seed: number) {
  return function rng() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

export interface SeedRisk {
  id: string;
  accountName: string;
  submissionType: "new_business" | "renewal";
  lineOfBusiness: string;
  state: string;
  premium: number;
  tiv: number;
  buildingYear: number | null;
  constructionPct: number | null;
  fiveYearLossValue: number | null;
  broker: string;
  assignee: string;
  isDemo: boolean;
  lossLabel: EvidenceLabel;
  constructionLabel: EvidenceLabel;
}

function buildHarborMill(): SeedRisk {
  return {
    id: DEMO_CASE_ID,
    accountName: "Harbor Mill Works LLC",
    submissionType: "new_business",
    lineOfBusiness: "property",
    state: "PA",
    premium: 84_000,
    tiv: 72_000_000,
    buildingYear: 2016,
    constructionPct: 0.82,
    fiveYearLossValue: 24_000,
    broker: "Marsh",
    assignee: "A. Chen",
    isDemo: true,
    lossLabel: "VERIFIED",
    constructionLabel: "INFERRED",
  };
}

export function buildSeedRisks(): SeedRisk[] {
  const rng = mulberry32(20260919);
  const risks: SeedRisk[] = [buildHarborMill()];
  for (let i = 0; i < ACCOUNT_NAMES.length; i += 1) {
    const state = STATES[i % STATES.length]!;
    const renewal = rng() < 0.12;
    const nonProperty = rng() < 0.08;
    const missingLoss = rng() < 0.16;
    const missingConstruction = rng() < 0.12;
    const oldBuilding = rng() < 0.14;
    const highTiv = rng() < 0.1;
    const lowPremium = rng() < 0.08;
    const tivBase = highTiv ? 160_000_000 + rng() * 40_000_000 : 35_000_000 + rng() * 110_000_000;
    const premiumBase = lowPremium ? 32_000 + rng() * 12_000 : 55_000 + rng() * 110_000;
    risks.push({
      id: `case:${1000 + i}`,
      accountName: ACCOUNT_NAMES[i]!,
      submissionType: renewal ? "renewal" : "new_business",
      lineOfBusiness: nonProperty ? "casualty" : "property",
      state,
      premium: roundTo(premiumBase, 1000),
      tiv: roundTo(tivBase, 1_000_000),
      buildingYear: oldBuilding ? 1978 + Math.floor(rng() * 12) : 1994 + Math.floor(rng() * 30),
      constructionPct: missingConstruction ? null : Number((0.42 + rng() * 0.5).toFixed(2)),
      fiveYearLossValue: missingLoss ? null : roundTo(rng() * 160_000, 1000),
      broker: pick(rng, BROKERS),
      assignee: pick(rng, ASSIGNEES),
      isDemo: false,
      lossLabel: missingLoss ? "UNKNOWN" : "VERIFIED",
      constructionLabel: missingConstruction ? "UNKNOWN" : "VERIFIED",
    });
  }
  return risks;
}

function criterion(
  factor: AppetiteCriterion["factor"],
  label: string,
  observed: string,
  status: AppetiteCriterion["status"],
  evidenceLabel: EvidenceLabel,
  ruleId: string,
  ruleText: string,
  evidence: AppetiteCriterion["evidence"],
  querySummary?: string,
): AppetiteCriterion {
  return {
    factor,
    label,
    observed,
    status,
    evidenceLabel,
    weight: CRITERION_WEIGHTS[factor],
    contribution: CRITERION_WEIGHTS[factor] * STATUS_MULTIPLIER[status],
    ruleId,
    ruleText,
    evidence,
    querySummary,
  };
}

export function criteriaForRisk(risk: SeedRisk, phase: "preliminary" | "investigated" | "resolved"): AppetiteCriterion[] {
  const constructionStatus =
    phase === "investigated" && risk.isDemo
      ? "CONTRADICTED"
      : classifyConstructionMix(risk.constructionPct);
  const constructionLabel: EvidenceLabel =
    phase === "investigated" && risk.isDemo ? "CONTRADICTED" : risk.constructionLabel;
  const constructionObserved =
    phase === "investigated" && risk.isDemo
      ? "Federato 82% masonry NC vs Gemini frame shed"
      : risk.constructionPct === null
        ? "Unknown"
        : `${Math.round(risk.constructionPct * 100)}% acceptable construction by TIV`;

  return [
    criterion(
      "submission_type",
      "Submission type",
      risk.submissionType === "new_business" ? "New business" : "Renewal",
      classifySubmissionType(risk.submissionType),
      "VERIFIED",
      "property.submission_type.acceptable.2025",
      "Renewal business is not acceptable. New business is acceptable.",
      [{ source: "federato", resource: "Policy", path: "submissionType", observedAt: NOW }],
      "where submission_type exists",
    ),
    criterion(
      "line_of_business",
      "Line of business",
      risk.lineOfBusiness === "property" ? "Property" : risk.lineOfBusiness,
      classifyLineOfBusiness(risk.lineOfBusiness),
      "VERIFIED",
      "property.lob.acceptable.2025",
      "Property is acceptable. Any other line is not acceptable.",
      [{ source: "federato", resource: "Policy", path: "lineOfBusiness", observedAt: NOW }],
    ),
    criterion(
      "primary_state",
      "Primary risk state",
      risk.state,
      classifyState(risk.state),
      "VERIFIED",
      "property.state.target.2025",
      "OH, PA, MD, CO, CA, FL are target; NC, SC, GA, VA, UT are acceptable.",
      [{ source: "federato", resource: "Location", path: "primaryState", observedAt: NOW }],
    ),
    criterion(
      "tiv",
      "Total insured value",
      risk.tiv.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }),
      classifyTiv(risk.tiv),
      "VERIFIED",
      "property.tiv.2025",
      "Target $50M–$100M; acceptable up to $150M; over $150M is not acceptable.",
      [{ source: "federato", resource: "Policy", path: "tiv", queryId: "qry_tiv", observedAt: NOW }],
    ),
    criterion(
      "premium",
      "Total premium",
      risk.premium.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }),
      classifyPremium(risk.premium),
      "VERIFIED",
      "property.total_premium.acceptable.2025",
      "Target $75K–$100K; acceptable $50K–$175K inclusive.",
      [{ source: "federato", resource: "Policy", path: "premium", observedAt: NOW }],
    ),
    criterion(
      "building_year",
      "Building age",
      risk.buildingYear === null ? "Unknown" : String(risk.buildingYear),
      classifyBuildingYear(risk.buildingYear),
      risk.buildingYear === null ? "UNKNOWN" : "VERIFIED",
      "property.building_year.2025",
      "Newer than 2010 is target; newer than 1990 is acceptable; 1990 is boundary review.",
      [{ source: "federato", resource: "Building", path: "yearBuilt", observedAt: NOW }],
    ),
    criterion(
      "construction_mix",
      "Construction mix",
      constructionObserved,
      constructionStatus,
      constructionLabel,
      "property.construction.2025",
      "More than 50% of TIV must be joisted masonry, non-combustible/steel, or masonry non-combustible.",
      [
        { source: "federato", resource: "Building", path: "constructionType", observedAt: NOW },
        ...(phase === "investigated" && risk.isDemo
          ? [{ source: "gemini" as const, path: "candidate_facts.construction", observedAt: NOW, note: "Page 1 excerpt" }]
          : []),
      ],
    ),
    criterion(
      "five_year_loss_value",
      "Five-year loss value",
      risk.fiveYearLossValue === null
        ? "Unknown"
        : risk.fiveYearLossValue.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }),
      classifyFiveYearLoss(risk.fiveYearLossValue),
      risk.lossLabel,
      "property.five_year_loss.2025",
      "Under $100,000 is acceptable; $100,000 is boundary review; over $100,000 is not acceptable.",
      risk.fiveYearLossValue === null
        ? [{ source: "federato", resource: "Loss", path: "incurred", observedAt: NOW, note: "No loss runs in dataset" }]
        : [{ source: "federato", resource: "Loss", path: "incurred", queryId: "qry_loss", observedAt: NOW }],
    ),
  ];
}

export function stageFor(decision: DecisionClass, investigationStatus: CaseDetail["investigation"]["status"]): CaseStage {
  if (investigationStatus === "running") return "INVESTIGATING";
  if (investigationStatus === "not_started") return "NEW";
  if (decision === "IN_APPETITE" || decision === "ACCEPT_WITH_CONDITIONS") return "READY_TO_QUOTE";
  return "NEEDS_REVIEW";
}

export function summarize(detail: CaseDetail): CaseSummary {
  return {
    id: detail.id,
    accountName: detail.accountName,
    submissionType: detail.submissionType,
    lineOfBusiness: detail.lineOfBusiness,
    state: detail.state,
    premium: detail.premium,
    tiv: detail.tiv,
    broker: detail.broker,
    assignee: detail.assignee,
    decision: detail.decision,
    appetiteScore: detail.appetiteScore,
    priorityScore: detail.priorityScore,
    completeness: detail.completeness,
    confidence: detail.confidence,
    stage: detail.stage,
    decisiveFactors: detail.decisiveFactors,
    updatedAt: detail.updatedAt,
    isDemo: detail.isDemo,
  };
}

function factsFor(risk: SeedRisk, phase: "preliminary" | "investigated" | "resolved"): NormalizedFact[] {
  return [
    {
      id: "fact-account",
      label: "Account name",
      path: "account.name",
      value: risk.accountName,
      rawValue: risk.accountName,
      labelStatus: "VERIFIED",
      provenance: [{ source: "federato", resource: "Policy", path: "accountName", observedAt: NOW }],
    },
    {
      id: "fact-type",
      label: "Submission type",
      path: "account.submissionType",
      value: risk.submissionType === "new_business" ? "New business" : "Renewal",
      rawValue: risk.submissionType,
      labelStatus: "VERIFIED",
      provenance: [{ source: "federato", resource: "Policy", path: "submissionType", observedAt: NOW }],
    },
    {
      id: "fact-lob",
      label: "Line of business",
      path: "account.lineOfBusiness",
      value: risk.lineOfBusiness,
      rawValue: risk.lineOfBusiness,
      labelStatus: "VERIFIED",
      provenance: [{ source: "federato", resource: "Policy", path: "lineOfBusiness", observedAt: NOW }],
    },
    {
      id: "fact-state",
      label: "Primary state",
      path: "normalizedRisk.primaryState",
      value: risk.state,
      rawValue: risk.state,
      labelStatus: "VERIFIED",
      provenance: [{ source: "federato", resource: "Location", path: "state", observedAt: NOW }],
    },
    {
      id: "fact-tiv",
      label: "TIV",
      path: "normalizedRisk.tiv",
      value: risk.tiv.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }),
      rawValue: risk.tiv,
      unit: "USD",
      labelStatus: "VERIFIED",
      provenance: [{ source: "federato", resource: "Policy", path: "tiv", queryId: "qry_tiv", observedAt: NOW }],
    },
    {
      id: "fact-premium",
      label: "Premium",
      path: "normalizedRisk.premium",
      value: risk.premium.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }),
      rawValue: risk.premium,
      unit: "USD",
      labelStatus: "VERIFIED",
      provenance: [{ source: "federato", resource: "Policy", path: "premium", observedAt: NOW }],
    },
    {
      id: "fact-year",
      label: "Building year",
      path: "normalizedRisk.buildingYear",
      value: risk.buildingYear === null ? "—" : String(risk.buildingYear),
      rawValue: risk.buildingYear,
      labelStatus: risk.buildingYear === null ? "UNKNOWN" : "VERIFIED",
      provenance: [{ source: "federato", resource: "Building", path: "yearBuilt", observedAt: NOW }],
    },
    {
      id: "fact-construction",
      label: "Acceptable construction by TIV",
      path: "normalizedRisk.acceptableConstructionPctByTiv",
      value:
        phase === "investigated" && risk.isDemo
          ? "Contradicted: 82% vs frame shed"
          : risk.constructionPct === null
            ? "Unknown"
            : `${Math.round(risk.constructionPct * 100)}%`,
      rawValue: risk.constructionPct,
      labelStatus: phase === "investigated" && risk.isDemo ? "CONTRADICTED" : risk.constructionLabel,
      provenance: [
        { source: "federato", resource: "Building", path: "constructionType", observedAt: NOW },
        ...(phase === "investigated" && risk.isDemo
          ? [
              {
                source: "gemini" as const,
                path: "page 1",
                observedAt: NOW,
                note: "Inspection report excerpt: leased shed is frame",
              },
            ]
          : []),
      ],
    },
    {
      id: "fact-loss",
      label: "Five-year loss value",
      path: "normalizedRisk.fiveYearLossValue",
      value:
        risk.fiveYearLossValue === null
          ? "Unknown"
          : risk.fiveYearLossValue.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }),
      rawValue: risk.fiveYearLossValue,
      unit: "USD",
      labelStatus: risk.lossLabel,
      provenance: [{ source: "federato", resource: "Loss", path: "incurred", observedAt: NOW }],
    },
  ];
}

function evidenceFor(risk: SeedRisk, phase: "preliminary" | "investigated" | "resolved"): EvidenceItem[] {
  const items: EvidenceItem[] = [
    {
      evidenceId: `ev:${risk.id}:premium`,
      title: "Quoted premium",
      text: `Federato policy premium ${risk.premium.toLocaleString("en-US")}.`,
      sourceType: "federato_submission",
      sourceUri: `federato://Policy/${risk.id}`,
      verificationStatus: "VERIFIED",
      observedAt: NOW,
      reliability: 1,
    },
  ];
  if (phase !== "preliminary") {
    items.push({
      evidenceId: `ev:${risk.id}:elastic`,
      title: "Inspection construction note",
      text: "Masonry non-combustible construction on the main mill; leased shed described as frame and not for coverage.",
      sourceType: "elasticsearch_hybrid",
      sourceUri: "elastic://risk-evidence-v1/ev_construction",
      verificationStatus: phase === "investigated" ? "CONTRADICTED" : "VERIFIED",
      observedAt: NOW,
      reliability: 0.82,
    });
  }
  return items;
}

function similarCasesFor(risk: SeedRisk): SimilarCase[] {
  if (!risk.isDemo) {
    return [
      {
        caseId: "case:precedent-a",
        accountName: "Peer mill conversion",
        similarity: 0.81,
        sharedFactors: ["PA", "new business", "TIV band"],
        materialDifferences: ["Lower five-year losses"],
        historicalDecision: "IN_APPETITE",
        humanApprovedRationale: "Accepted after confirming masonry mix by TIV.",
        humanApproved: true,
      },
    ];
  }
  return [
    {
      caseId: "case:1003",
      accountName: "Three Rivers Plastics",
      similarity: 0.88,
      sharedFactors: ["PA", "new property", "TIV $50–100M", "post-2010"],
      materialDifferences: ["No authenticity finding", "Loss runs attached at intake"],
      historicalDecision: "IN_APPETITE",
      humanApprovedRationale: "Quoted with a sprinkler warranty after masonry mix confirmed.",
      humanApproved: true,
    },
    {
      caseId: "case:1010",
      accountName: "Chesapeake Light Assembly",
      similarity: 0.79,
      sharedFactors: ["Target premium", "joisted masonry", "broker Marsh"],
      materialDifferences: ["Maryland vs Pennsylvania CAT charge"],
      historicalDecision: "ACCEPT_WITH_CONDITIONS",
      humanApprovedRationale: "Conditions limited to updated inspection photos.",
      humanApproved: true,
    },
    {
      caseId: "case:1022",
      accountName: "Charlotte Textile Lofts",
      similarity: 0.71,
      sharedFactors: ["Adaptive reuse occupancy", "premium band"],
      materialDifferences: ["NC is acceptable, not target", "older secondary building"],
      historicalDecision: "INVESTIGATE",
      humanApprovedRationale: "Held for construction-mix evidence; later quoted.",
      humanApproved: true,
    },
    {
      caseId: "case:1048",
      accountName: "Dallas Metro Pack",
      similarity: 0.64,
      sharedFactors: ["Manufacturing occupancy"],
      materialDifferences: ["Texas is out of appetite", "renewal"],
      historicalDecision: "OUT_OF_APPETITE",
      humanApprovedRationale: "Declined on state and submission type; not a pricing issue.",
      humanApproved: true,
    },
  ];
}

function authenticityFor(phase: "preliminary" | "investigated" | "resolved"): AuthenticityFinding | null {
  if (phase === "preliminary") return null;
  return {
    documentId: "doc:harbor-mill-inspection",
    contentHash: "sha256:8f3c1a9e0b7d2c4a6e1f0d8c7b6a5948",
    classification: "ai_likely",
    score: 0.78,
    highlightedPassage:
      '"The account has enjoyed a quiet five-year period with only minor maintenance claims. Construction quality is consistent with post-2010 mill conversion standards and the occupancy is stable."',
    applicablePolicy: "human_authored_or_disclosed",
    policyVersion: "carrier-demo-2026.09",
    outcome: phase === "resolved" ? "CLEAR" : "AUTHENTICITY_REVIEW",
    scannedAt: NOW,
    unsupportedClaimWarning:
      phase === "investigated"
        ? "The phrase “quiet five-year period” is not yet supported by indexed loss-run evidence."
        : undefined,
    reviewState: phase === "resolved" ? "verified" : "open",
  };
}

function explanationFor(risk: SeedRisk, decision: DecisionClass, phase: "preliminary" | "investigated" | "resolved"): string {
  if (risk.isDemo && phase === "preliminary") {
    return "Preliminary Federato facts place Harbor Mill in appetite: new Pennsylvania property, $72M TIV and $84K premium in target bands, post-2010 mill, inferred 82% acceptable construction, and $24K five-year losses. Confidence is limited until the supporting inspection is investigated.";
  }
  if (risk.isDemo && phase === "investigated") {
    return "Investigation moved the file to Investigate. Gemini extracted a frame shed on page 1 that contradicts the Federato masonry mix, Elasticsearch retrieved the same construction note, and GPTZero flagged the broker narrative under the carrier’s human-authorship/disclosure policy. No hard appetite failure is verified.";
  }
  if (risk.isDemo && phase === "resolved") {
    return "Broker response confirms the frame shed is leased and uninsured, restoring 82% masonry NC by covered TIV. Loss runs remain $24K. The narrative’s AI assistance is disclosed, so authenticity is cleared with an operational condition rather than a hard decline.";
  }
  if (decision === "OUT_OF_APPETITE") {
    return `${risk.accountName} is out of appetite on a verified hard rule. Numeric score must not be read as a quote signal.`;
  }
  if (decision === "INVESTIGATE") {
    return `${risk.accountName} needs investigation because required evidence is unknown, contradicted, or on a documented boundary.`;
  }
  return `${risk.accountName} currently maps to ${decision.replaceAll("_", " ").toLowerCase()} on the 2025 commercial property guidelines.`;
}

export function detailFromRisk(
  risk: SeedRisk,
  phase: "preliminary" | "investigated" | "resolved" = "preliminary",
): CaseDetail {
  const criteria = criteriaForRisk(risk, phase);
  const conditionsRemain = risk.isDemo && phase === "resolved";
  const decision = decideClass(criteria, { conditionsRemain });
  const appetite = appetiteScore(criteria);
  const completeness = completenessScore(criteria);
  const investigationStatus = phase === "preliminary" ? "not_started" : "completed";
  const confidence =
    phase === "preliminary" ? 0.62 : phase === "investigated" ? 0.71 : 0.91;
  return {
    id: risk.id,
    accountName: risk.accountName,
    submissionType: risk.submissionType,
    lineOfBusiness: risk.lineOfBusiness,
    state: risk.state,
    premium: risk.premium,
    tiv: risk.tiv,
    broker: risk.broker,
    assignee: risk.assignee,
    decision,
    appetiteScore: appetite,
    priorityScore: priorityScore({
      appetite,
      completeness,
      opportunity: opportunityScore(risk.premium),
      freshness: 86,
    }),
    completeness,
    confidence,
    stage: stageFor(decision, investigationStatus),
    decisiveFactors: criteria
      .filter((item) => item.status !== "TARGET" && item.status !== "ACCEPTABLE")
      .map((item) => item.label)
      .slice(0, 3),
    updatedAt: NOW,
    isDemo: risk.isDemo,
    effectiveDate: "2026-10-01",
    expirationDate: "2027-10-01",
    buildingYear: risk.buildingYear,
    acceptableConstructionPctByTiv: risk.constructionPct,
    fiveYearLossValue: risk.fiveYearLossValue,
    facts: factsFor(risk, phase),
    criteria,
    explanation: explanationFor(risk, decision, phase),
    pathToYes:
      decision === "INVESTIGATE" || decision === "OUT_OF_APPETITE"
        ? [
            {
              action: "REQUEST_EVIDENCE",
              criterion: "construction_mix",
              description: "Confirm that more than 50% of covered TIV is acceptable construction and identify any uninsured structures.",
            },
            {
              action: "CONFIRM_DISCLOSURE",
              description: "If AI assistance was used on the broker narrative, disclose it under carrier policy human_authored_or_disclosed.",
            },
            {
              action: "REQUEST_EVIDENCE",
              criterion: "five_year_loss_value",
              description: "Provide current five-year loss runs showing total incurred losses below $100,000.",
            },
          ]
        : [
            {
              action: "OPERATIONAL_CONDITION",
              description: "Issue with a condition that the leased frame shed remains excluded and AI-assisted narrative disclosure stays on file.",
            },
          ],
    evidence: evidenceFor(risk, phase),
    activity: [
      {
        id: `act:${risk.id}:ingest`,
        at: "2026-09-19T13:02:00.000Z",
        actor: "RiskGraph ingest",
        summary: "Normalized from Federato queue query and scored deterministically.",
        kind: "system",
      },
    ],
    notes: [],
    similarCases: similarCasesFor(risk),
    investigation: {
      id: phase === "preliminary" ? null : `inv:${risk.id}:1`,
      status: investigationStatus,
      steps: [],
      stopReason: phase === "preliminary" ? undefined : "material_gaps_require_review",
    },
    authenticity: risk.isDemo ? authenticityFor(phase) : null,
    override: null,
    simulation: false,
    version: phase === "preliminary" ? 1 : phase === "investigated" ? 2 : 3,
    documents: risk.isDemo ? demoDocuments() : [],
  };
}

/**
 * The demo case holds two scans of different types, so the evidence list shows what a case with
 * more than one document actually looks like: separate provenance per document, nothing merged.
 */
function demoDocuments(): CaseDocument[] {
  return [
    {
      intakeId: "0f6a9d8e-3c21-4f6b-9a3e-7d2c1b0a5e44",
      documentId: "doc:harbor-mill-inspection",
      revision: 2,
      digest: "9b2f0c4e7a1d3f5b8c6e0a2d4f6b8c0e1a3d5f7b9c1e3a5d7f9b1c3e5a7d9f1b",
      documentType: "inspection_report",
      providerDocumentType: "inspection_report",
      pageCount: 2,
      receivedAt: "2026-09-19T13:44:00.000Z",
      attachedAt: "2026-09-19T13:45:00.000Z",
      attachedBy: "A. Chen",
      associationSource: "REVIEWER",
      status: "PROCESSED",
      supersedesRevision: 1,
    },
    {
      intakeId: "b7c8d9e0-1f23-4456-8789-0abcdef12345",
      documentId: "doc:harbor-mill-loss-run",
      revision: 1,
      digest: "5a7d9f1b9b2f0c4e7a1d3f5b8c6e0a2d4f6b8c0e1a3d5f7b9c1e3a5d7f9b1c3e",
      documentType: "loss_run",
      pageCount: 4,
      receivedAt: "2026-09-19T11:20:00.000Z",
      attachedAt: "2026-09-19T11:22:00.000Z",
      attachedBy: "A. Chen",
      associationSource: "REVIEWER",
      status: "PROCESSED_WITH_WARNINGS",
    },
  ];
}

export const LANE_ORDER: Record<DecisionClass, number> = {
  IN_APPETITE: 0,
  ACCEPT_WITH_CONDITIONS: 1,
  INVESTIGATE: 2,
  OUT_OF_APPETITE: 3,
};
