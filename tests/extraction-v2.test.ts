import { describe, expect, it } from "vitest";
import {
  ProvenanceError,
  fixtureExtractionV2,
  numbersIn,
  validateExtractionV2,
  type Block,
} from "../packages/integrations/src/extraction-v2.js";

const blocks: Block[] = [
  { id: "b1", page: 1, text: "Statement of Values" },
  {
    id: "b2",
    page: 1,
    text: "Building A  Year built: 1998  Construction: Frame  TIV: $1,200,000",
  },
  {
    id: "b3",
    page: 1,
    text: "Building B  Year built: 2016  Construction: Steel  TIV: 2.5M",
  },
  { id: "b4", page: 1, text: "Total TIV: $3,700,000" },
  {
    id: "b5",
    page: 2,
    text: "Loss date: 2023-04-02  Paid: 12,000  Reserve: 0  Incurred: 12,000",
  },
  {
    id: "b6",
    page: 2,
    text: "Insured contact: [TOKEN_0123456789abcdef01234567] Year built: 1975",
  },
  {
    id: "b7",
    page: 2,
    text: "Sprinkler system inoperable in the east wing; roof shows moderate ponding.",
  },
];

const row = (over: Record<string, unknown>) => ({
  page: 1,
  blockIds: ["b2"],
  sourceExcerpt: "Year built: 1998  Construction: Frame  TIV: $1,200,000",
  status: "EXTRACTED",
  locationRef: null,
  tiv: 1_200_000,
  yearBuilt: 1998,
  construction: "Frame",
  ...over,
});
const doc = (over: Record<string, unknown>) => ({
  documentType: "statement_of_values",
  sovRows: [],
  lossRunRows: [],
  inspectionFindings: [],
  totals: { tivReported: null, tivComputed: null, consistent: null },
  ...over,
});
const fails = (raw: unknown) => {
  try {
    validateExtractionV2(raw, blocks);
  } catch (e) {
    return e instanceof ProvenanceError
      ? "PROVENANCE"
      : (e as Error).constructor.name;
  }
  return "OK";
};

describe("v2 typed extraction validation", () => {
  it("reads literal numbers with separators and magnitude suffixes", () => {
    expect(numbersIn("TIV: $1,200,000")).toContain(1_200_000);
    expect(numbersIn("TIV: 2.5M")).toContain(2_500_000);
    expect(numbersIn("[TOKEN_0123456789abcdef01234567] 1975")).toEqual([1975]);
  });

  it("accepts rows whose values are literally in the cited excerpt and recomputes totals", () => {
    const out = validateExtractionV2(
      doc({
        sovRows: [
          row({}),
          row({
            blockIds: ["b3"],
            sourceExcerpt: "Year built: 2016  Construction: Steel  TIV: 2.5M",
            tiv: 2_500_000,
            yearBuilt: 2016,
            construction: "steel",
          }),
        ],
        totals: { tivReported: 3_700_000, tivComputed: 999, consistent: false },
      }),
      blocks,
    );
    expect(out.totals).toEqual({
      tivReported: 3_700_000,
      tivComputed: 3_700_000,
      consistent: true,
    });
  });

  it("rejects fabricated numbers, paraphrased text, foreign excerpts and page mismatches", () => {
    expect(fails(doc({ sovRows: [row({ tiv: 1_250_000 })] }))).toBe(
      "PROVENANCE",
    );
    expect(fails(doc({ sovRows: [row({ construction: "Wood frame" })] }))).toBe(
      "PROVENANCE",
    );
    expect(
      fails(
        doc({
          sovRows: [row({ sourceExcerpt: "Year built: 1998 TIV: $1,200,000" })],
        }),
      ),
    ).toBe("PROVENANCE");
    expect(fails(doc({ sovRows: [row({ page: 2 })] }))).toBe("PROVENANCE");
    expect(fails(doc({ sovRows: [row({ blockIds: ["nope"] })] }))).toBe(
      "PROVENANCE",
    );
    expect(fails(doc({ documentType: "invoice" }))).toBe("ZodError");
    expect(fails(doc({ sovRows: [row({ note: "free text" })] }))).toBe(
      "ZodError",
    );
  });

  it("never reads placeholders as values and marks such rows REDACTED; unsupported totals are dropped", () => {
    const out = validateExtractionV2(
      doc({
        sovRows: [
          row({
            page: 2,
            blockIds: ["b6"],
            sourceExcerpt: blocks[5]!.text,
            status: "EXTRACTED",
            tiv: null,
            yearBuilt: 1975,
            construction: null,
          }),
        ],
        totals: { tivReported: 5_000_000, tivComputed: null, consistent: null },
      }),
      blocks,
    );
    expect(out.sovRows[0]!.status).toBe("REDACTED");
    expect(out.totals).toEqual({
      tivReported: null,
      tivComputed: null,
      consistent: null,
    });
    expect(
      fails(
        doc({
          sovRows: [
            row({
              page: 2,
              blockIds: ["b6"],
              sourceExcerpt: blocks[5]!.text,
              tiv: null,
              yearBuilt: 1975,
              construction: "TOKEN_0123456789abcdef01234567",
            }),
          ],
        }),
      ),
    ).toBe("PROVENANCE");
  });

  it("offline fixture extraction produces typed rows across SOV, loss run and findings that pass the validator", () => {
    const out = validateExtractionV2(
      fixtureExtractionV2(blocks, "unknown"),
      blocks,
    );
    expect(out.sovRows.map((r) => r.yearBuilt)).toEqual([1998, 2016, 1975]);
    expect(out.sovRows.map((r) => r.tiv)).toEqual([1_200_000, 2_500_000, null]);
    expect(out.sovRows[2]!.status).toBe("REDACTED");
    expect(out.lossRunRows).toHaveLength(1);
    expect(out.lossRunRows[0]).toMatchObject({
      lossDate: "2023-04-02",
      paid: 12_000,
      reserve: 0,
      incurred: 12_000,
    });
    expect(out.inspectionFindings[0]).toMatchObject({
      category: "fire_protection",
      severity: "high",
      page: 2,
    });
    expect(out.totals).toEqual({
      tivReported: 3_700_000,
      tivComputed: 3_700_000,
      consistent: true,
    });
    expect(out.documentType).toBe("loss_run");
    expect(
      validateExtractionV2(
        fixtureExtractionV2(blocks, "inspection_report"),
        blocks,
      ).documentType,
    ).toBe("inspection_report");
  });
});
