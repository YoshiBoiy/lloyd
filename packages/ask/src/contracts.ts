import { z } from "zod";
export const intents = [
  "CASE_EXPLANATION",
  "EVIDENCE_SEARCH",
  "GUIDELINE_LOOKUP",
  "CASE_FACT_LOOKUP",
  "PRECEDENT_SEARCH",
  "PRECEDENT_COMPARISON",
  "PORTFOLIO_FILTER",
  "COMBINED_INVESTIGATION",
] as const;
export const operations = [
  "GET_CASE",
  "GET_DECISION_EVIDENCE",
  "SEARCH_EVIDENCE",
  "SEARCH_GUIDELINES",
  "FILTER_CASES",
  "FIND_PRECEDENTS",
  "COMPARE_CASES",
] as const;
const range = z
  .object({
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .strict()
  .refine((v) => v.min === undefined || v.max === undefined || v.min <= v.max);
export const Filters = z
  .object({
    caseId: z.string().max(200).optional(),
    sourceTypes: z.array(z.string().max(80)).max(10).optional(),
    finalDecision: z
      .array(
        z.enum([
          "IN_APPETITE",
          "INVESTIGATE",
          "OUT_OF_APPETITE",
          "ACCEPT_WITH_CONDITIONS",
        ]),
      )
      .max(4)
      .optional(),
    state: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    lineOfBusiness: z.string().max(60).optional(),
    submissionType: z.string().max(60).optional(),
    premium: range.optional(),
    tiv: range.optional(),
    buildingYear: range.optional(),
    losses: range.optional(),
    completeness: range.optional(),
    confidence: range.optional(),
    constructionStatus: z
      .enum([
        "TARGET",
        "ACCEPTABLE",
        "UNKNOWN",
        "CONTRADICTED",
        "NOT_ACCEPTABLE",
        "BOUNDARY_REVIEW",
      ])
      .optional(),
    criterionState: z
      .enum([
        "TARGET",
        "ACCEPTABLE",
        "UNKNOWN",
        "CONTRADICTED",
        "NOT_ACCEPTABLE",
        "BOUNDARY_REVIEW",
      ])
      .optional(),
    after: z.string().datetime().optional(),
    before: z.string().datetime().optional(),
    humanApproved: z.boolean().optional(),
  })
  .strict();
export type Filters = z.infer<typeof Filters>;
export const Step = z
  .object({
    operation: z.enum(operations),
    query: z.string().max(1500).optional(),
    sourceCaseId: z.string().max(200).optional(),
    caseIds: z.array(z.string().max(200)).max(5).optional(),
    filters: Filters.default({}),
    limit: z.number().int().min(1).max(20),
  })
  .strict();
export const Plan = z
  .object({
    intent: z.enum(intents),
    question: z.string().min(1).max(1500),
    scope: z
      .object({ tenantId: z.string(), caseId: z.string().optional() })
      .strict(),
    steps: z.array(Step).min(1).max(3),
  })
  .strict();
export type Plan = z.infer<typeof Plan>;
export interface Scope {
  tenantId: string;
  userId: string;
  caseIds: string[];
  precedentAccess: boolean;
  portfolioAccess: boolean;
  caseId?: string;
}
export const AskRequest = z
  .object({
    question: z.string().trim().min(3).max(1500),
    caseId: z.string().max(200).optional(),
    activeMode: z.enum(["evidence", "precedents"]).default("evidence"),
    pinnedNodeIds: z.array(z.string().max(250)).max(5).default([]),
    filters: Filters.default({}),
  })
  .strict();
export type AskRequest = z.infer<typeof AskRequest>;
export interface Source {
  evidenceId: string;
  documentId?: string;
  caseId: string;
  label: string;
  page?: number;
  boundingBox?: number[];
  sourceUri?: string;
  sourceField?: string;
  excerpt: string;
  sourceType: string;
  verificationStatus: string;
  reliability: number;
  observedAt: string;
}
export interface Document {
  id: string;
  caseId: string;
  title: string;
  sourceType: string;
  score: number;
  vector: number[];
  passages: Source[];
  verificationStatus: string;
  reliability: number;
}
export interface Precedent {
  caseId: string;
  caseVersion: number;
  similarity: number;
  sharedFactors: string[];
  materialDifferences: string[];
  decision: string;
  decisionDate: string;
  humanApproved: boolean;
  rationaleEvidenceIds: string[];
  missingDimensions: string[];
  vector: number[];
}
export interface AnswerEvidencePacket {
  question: string;
  effectiveScope: { tenantId: string; caseId?: string };
  caseFacts: Array<{
    factId: string;
    name: string;
    value: unknown;
    status: string;
    evidenceIds: string[];
  }>;
  evidence: Source[];
  precedents: Precedent[];
}
export interface Claim {
  claim: string;
  evidenceIds: string[];
}
export interface AskLloydResponse {
  answerId: string;
  status: "ANSWERED" | "PARTIAL" | "NOT_ENOUGH_EVIDENCE";
  answerMarkdown: string;
  claims: Claim[];
  citations: Source[];
  focusNodes: string[];
  suggestedQuestions: string[];
  retrievalTraceId: string;
}
export interface ExploreGraph {
  mode: "evidence" | "precedents";
  projectionVersion: string;
  nodes: Array<{
    id: string;
    x: number;
    y: number;
    z: number;
    label: string;
    type: string;
    relevance: number;
    cited: boolean;
    metadataPreview: Record<string, string | number | boolean>;
  }>;
  edges: Array<{
    source: string;
    target: string;
    relationship: "SIMILARITY" | "PROVENANCE" | "QUERY_MATCH";
    score?: number;
  }>;
  notice: string;
}
export interface Trace {
  id: string;
  intent: string;
  effectiveScope: { tenantId: string; caseId?: string };
  planner: string;
  steps: Array<{
    operation: string;
    purpose: string;
    filters: Filters;
    count: number;
    durationMs: number;
    status: string;
  }>;
  warnings: string[];
  firstResultMs: number;
  completedMs: number;
  modelVersion: string;
  promptVersion: string;
  retrievalIds: string[];
}
export const NOTICE =
  "Layout is an approximate projection. Similarity scores and edges use the original vector space.";
