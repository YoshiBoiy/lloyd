import { describe, it, expect } from "vitest";
import {
  evaluate,
  constructionPercent,
  fiveYearLoss,
  compareCases,
  simulate,
  type Facts,
} from "../packages/engine/src/index.js";
const now = new Date("2026-09-19T15:00:00Z");
export function facts(overrides: Record<string, unknown> = {}): Facts {
  const values = {
    accountName: "Synthetic",
    effectiveDate: "2026-10-01",
    expirationDate: "2027-10-01",
    submissionType: "new_business",
    lineOfBusiness: "property",
    primaryState: "PA",
    tiv: 72e6,
    premium: 84e3,
    buildingYear: 2016,
    construction: [{ tiv: 72e6, construction: "steel" }],
    losses: { complete: true, items: [{ date: "2024-01-01", amount: 24000 }] },
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [
      k,
      {
        value: v,
        evidence: [
          {
            id: `ev:${k}`,
            source: "fixture",
            path: k,
            observedAt: now.toISOString(),
            verified: true,
          },
        ],
        contradicted: false,
      },
    ]),
  ) as Facts;
}
const cases: Array<[string, unknown, string]> = [
  ["tiv", 50e6, "TARGET"],
  ["tiv", 100e6, "TARGET"],
  ["tiv", 150e6, "ACCEPTABLE"],
  ["tiv", 150000001, "NOT_ACCEPTABLE"],
  ["tiv", 49999999, "ACCEPTABLE"],
  ["tiv", 100000001, "ACCEPTABLE"],
  ["premium", 50000, "ACCEPTABLE"],
  ["premium", 75000, "TARGET"],
  ["premium", 100000, "TARGET"],
  ["premium", 175000, "ACCEPTABLE"],
  ["premium", 49999, "NOT_ACCEPTABLE"],
  ["premium", 175001, "NOT_ACCEPTABLE"],
  ["premium", 74999, "ACCEPTABLE"],
  ["premium", 100001, "ACCEPTABLE"],
  ["buildingYear", 1989, "NOT_ACCEPTABLE"],
  ["buildingYear", 1990, "BOUNDARY_REVIEW"],
  ["buildingYear", 1991, "ACCEPTABLE"],
  ["buildingYear", 2010, "ACCEPTABLE"],
  ["buildingYear", 2011, "TARGET"],
  ["submissionType", "renewal", "NOT_ACCEPTABLE"],
  ["lineOfBusiness", "liability", "NOT_ACCEPTABLE"],
  ...["OH", "PA", "MD", "CO", "CA", "FL"].map(
    (s) => ["primaryState", s, "TARGET"] as [string, unknown, string],
  ),
  ...["NC", "SC", "GA", "VA", "UT"].map(
    (s) => ["primaryState", s, "ACCEPTABLE"] as [string, unknown, string],
  ),
  ["primaryState", "NY", "NOT_ACCEPTABLE"],
];
describe("TDD exact appetite thresholds", () => {
  it.each(cases)("%s %s -> %s", (key, value, status) =>
    expect(
      evaluate(facts({ [key]: value }), now).criteria.find((c) => c.key === key)
        ?.status,
    ).toBe(status),
  );
  it.each([
    [99999, "ACCEPTABLE"],
    [100000, "BOUNDARY_REVIEW"],
    [100001, "NOT_ACCEPTABLE"],
  ])("loss boundary %s", (amount, status) =>
    expect(
      evaluate(
        facts({
          losses: { complete: true, items: [{ date: "2024-01-01", amount }] },
        }),
        now,
      ).criteria.at(-1)?.status,
    ).toBe(status),
  );
  it.each([
    [50, "BOUNDARY_REVIEW"],
    [50.01, "ACCEPTABLE"],
    [49.99, "NOT_ACCEPTABLE"],
  ])("construction %s", (n, status) =>
    expect(
      evaluate(
        facts({
          construction: [
            { tiv: n, construction: "steel" },
            { tiv: 100 - Number(n), construction: "frame" },
          ],
        }),
        now,
      ).criteria.find((c) => c.key === "construction")?.status,
    ).toBe(status),
  );
  it.each([null, undefined, "oops", -1, NaN, Infinity])(
    "invalid numeric value %s stays unknown",
    (value) =>
      expect(
        evaluate(facts({ tiv: value }), now).criteria.find(
          (c) => c.key === "tiv",
        )?.status,
      ).toBe("UNKNOWN"),
  );
  it("contradiction does not become acceptable", () => {
    const f = facts();
    f.premium!.contradicted = true;
    expect(evaluate(f, now).class).toBe("INVESTIGATE");
    expect(
      evaluate(f, now).criteria.find((c) => c.key === "premium")?.status,
    ).toBe("CONTRADICTED");
  });
  it("unverified facts remain unknown", () => {
    const f = facts();
    f.tiv!.evidence[0]!.verified = false;
    expect(evaluate(f, now).class).toBe("INVESTIGATE");
  });
  it("weights total 100 and target fixture scores 90", () => {
    const d = evaluate(facts(), now);
    expect(d.criteria.reduce((n, c) => n + c.weight, 0)).toBe(100);
    expect(d.appetiteScore).toBe(90);
    expect(d.priorityScore).toBe(93);
  });
  it("hard failure cannot be canceled by score", () => {
    const d = evaluate(facts({ submissionType: "renewal" }), now);
    expect(d.appetiteScore).toBeGreaterThan(80);
    expect(d.class).toBe("OUT_OF_APPETITE");
  });
  it("construction uses TIV, not building count", () =>
    expect(
      constructionPercent([
        { tiv: 90, construction: "steel" },
        ...Array.from({ length: 9 }, () => ({ tiv: 1, construction: "frame" })),
      ]),
    ).toBe(90 / 99));
  it("missing TIV cannot produce a mix", () =>
    expect(constructionPercent([{ construction: "steel" }])).toBeUndefined());
  it("incomplete loss runs do not imply zero", () =>
    expect(
      fiveYearLoss({ complete: false, items: [] }, "2026-10-01"),
    ).toBeUndefined());
  it("loss aggregation uses exact five-year interval", () =>
    expect(
      fiveYearLoss(
        {
          complete: true,
          items: [
            { date: "2021-09-30", amount: 1e6 },
            { date: "2021-10-01", amount: 100 },
            { date: "2026-09-30", amount: 200 },
            { date: "2026-10-01", amount: 1e6 },
          ],
        },
        "2026-10-01",
      ),
    ).toBe(300));
  it("simulation does not mutate verified facts", () => {
    const f = facts({ buildingYear: 1990 });
    const before = structuredClone(f);
    const result = simulate(
      f,
      { buildingYear: 2011 },
      ["Confirm inspection"],
      now,
    );
    expect(result.label).toBe("SIMULATION");
    expect(result.decision.class).toBe("ACCEPT_WITH_CONDITIONS");
    expect(f).toEqual(before);
  });
  it("conditions cannot hide hard failures", () =>
    expect(
      simulate(facts({ submissionType: "renewal" }), {}, ["condition"], now)
        .decision.class,
    ).toBe("OUT_OF_APPETITE"));
  it("lane wins over numerical score", () => {
    const a = { id: "a", decision: evaluate(facts({ tiv: 1 }), now) },
      b = { id: "b", decision: evaluate(facts({ buildingYear: 1990 }), now) };
    a.decision.priorityScore = 0;
    b.decision.priorityScore = 100;
    expect(compareCases(a, b)).toBeLessThan(0);
  });
});
