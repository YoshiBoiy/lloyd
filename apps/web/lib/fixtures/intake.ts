import type { CloudDestination, IntakeDocument, RedactionSpan, SensitiveFieldType } from "../api/types";
import { sha256Lite } from "../format";

export const DEMO_CASE_ID = "case:harbor-mill";
export const DEMO_DOCUMENT_ID = "doc:harbor-mill-inspection";

export const SYNTHETIC_INSPECTION_TEXT = `HARBOR MILL WORKS LLC
Commercial Property Inspection Report
Prepared for underwriting review — synthetic sample

Account: Harbor Mill Works LLC
Inspection date: 12 August 2026
Risk location: Allegheny County, Pennsylvania
Line: Commercial Property — New Business

Named contact: Jordan Hale
Email: jordan.hale@harbormill.example
Phone: (412) 555-0148
Policy number: CMP-2026-441908
Government ID (producer license): DL-PA-8829173

Occupancy: Light manufacturing and finished-goods storage.
Construction: Joisted masonry and masonry non-combustible on the main mill (Building A) representing the majority of stated values. Building B, a leased storage shed, is frame and is not intended for coverage.

TIV (stated): $72,000,000
Quoted premium: $84,000
Year built (controlling structure): 2016
Sprinklered: Yes, wet system, Buildings A and C.

Loss commentary (broker narrative):
"The account has enjoyed a quiet five-year period with only minor maintenance claims. Construction quality is consistent with post-2010 mill conversion standards and the occupancy is stable."

Inspector: M. Lang
Signature block: M. Lang
`;

function span(
  id: string,
  type: SensitiveFieldType,
  text: string,
  classification: RedactionSpan["classification"],
  replacement: string,
  required = true,
): RedactionSpan {
  const start = SYNTHETIC_INSPECTION_TEXT.indexOf(text);
  if (start < 0) {
    throw new Error(`Fixture text missing span: ${text}`);
  }
  return {
    id,
    type,
    classification,
    text,
    replacement,
    start,
    end: start + text.length,
    enabled: true,
    required,
  };
}

export const INTAKE_SPANS: RedactionSpan[] = [
  span("span-name", "person_name", "Jordan Hale", "TOKENIZED", "{{PERSON_01}}"),
  span("span-email", "email", "jordan.hale@harbormill.example", "REDACTED", "[EMAIL REDACTED]"),
  span("span-phone", "phone", "(412) 555-0148", "REDACTED", "[PHONE REDACTED]"),
  span("span-policy", "policy_number", "CMP-2026-441908", "TOKENIZED", "{{POLICY_01}}"),
  span("span-id", "government_id", "DL-PA-8829173", "LOCAL_ONLY", "[GOVERNMENT ID REMOVED]"),
  span("span-signature", "signature", "Signature block: M. Lang", "LOCAL_ONLY", "[SIGNATURE REMOVED]"),
];

export const DEFAULT_DESTINATIONS: Record<CloudDestination, string[]> = {
  gemini: ["redacted_page_1"],
  openai: ["normalized_risk_facts"],
  gptzero: ["redacted_narrative"],
};

export function createIntakeDocument(): IntakeDocument {
  const spans = INTAKE_SPANS.map((item) => ({ ...item }));
  const signature = spans.find((item) => item.id === "span-signature");
  if (signature) signature.enabled = false;
  return {
    documentId: DEMO_DOCUMENT_ID,
    caseId: DEMO_CASE_ID,
    title: "Harbor Mill inspection report (synthetic)",
    originalText: SYNTHETIC_INSPECTION_TEXT,
    spans,
    quality: {
      blur: 0.93,
      glare: 0.88,
      framing: 0.91,
      ocrConfidence: 0.94,
    },
    stage: "idle",
    redactionConfidence: computeRedactionConfidence(spans),
    manifest: null,
    released: false,
    approved: false,
  };
}

export function computeRedactionConfidence(spans: RedactionSpan[]): number {
  const required = spans.filter((item) => item.required);
  const enabledRequired = required.filter((item) => item.enabled);
  if (enabledRequired.length !== required.length) {
    return Number((0.55 + (enabledRequired.length / required.length) * 0.2).toFixed(2));
  }
  const localOnly = spans.filter((item) => item.classification === "LOCAL_ONLY" && item.enabled);
  return localOnly.length >= 2 ? 0.97 : 0.95;
}

export function buildSourceHash(): string {
  return sha256Lite(SYNTHETIC_INSPECTION_TEXT);
}
