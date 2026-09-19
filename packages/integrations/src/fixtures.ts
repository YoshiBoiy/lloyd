import type { Schema } from "./schema.js";
export const fixtureSchema: Schema = {
  resources: {
    DemoSubmission: {
      fields: {
        id: { type: "string" },
        accountName: { type: "string" },
        submissionType: { type: "string" },
        lineOfBusiness: { type: "string" },
        primaryState: { type: "string" },
        effectiveDate: { type: "string" },
        expirationDate: { type: "string" },
        tiv: { type: "number" },
        premium: { type: "number" },
        buildingYear: { type: "number" },
        construction: {
          type: "array",
          items: {
            type: "object",
            fields: {
              tiv: { type: "number" },
              construction: { type: "string" },
            },
          },
        },
        losses: {
          type: "object",
          fields: {
            complete: { type: "boolean" },
            items: {
              type: "array",
              items: {
                type: "object",
                fields: {
                  date: { type: "string" },
                  amount: { type: "number" },
                },
              },
            },
          },
        },
      },
    },
  },
};
export const fixtureRows: Record<string, unknown>[] = Array.from(
  { length: 56 },
  (_, i) => ({
    id: `demo-${String(i + 1).padStart(3, "0")}`,
    accountName:
      [
        "Keystone Manufacturing",
        "Front Range Storage",
        "Atlantic Distribution",
        "Citrus Packaging",
      ][i % 4] + ` ${i + 1}`,
    submissionType: i % 13 === 12 ? "renewal" : "new_business",
    lineOfBusiness: i % 17 === 16 ? "casualty" : "property",
    primaryState: ["PA", "CO", "FL", "NC", "NY", "OH", "MD"][i % 7],
    effectiveDate: "2026-10-01",
    expirationDate: "2027-10-01",
    tiv: 72e6 + (i % 6) * 18e6,
    premium: 84e3 + (i % 8) * 12e3,
    buildingYear: [2016, 1990, 2005, 1989, 2011][i % 5],
    construction: [
      { tiv: 59e6, construction: "masonry_noncombustible" },
      { tiv: 13e6, construction: "frame" },
    ],
    losses: {
      complete: i % 4 !== 0,
      items: [
        { date: "2024-06-10", amount: [24e3, 100e3, 100001, 18000][i % 4] },
      ],
    },
  }),
);
