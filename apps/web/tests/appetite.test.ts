import { describe, expect, it } from "vitest";
import {
  classifyBuildingYear,
  classifyConstructionMix,
  classifyFiveYearLoss,
  classifyPremium,
  classifyTiv,
  decideClass,
  appetiteScore,
} from "../lib/appetite";

describe("appetite boundary classification", () => {
  it("classifies TIV target, acceptable, and hard-fail boundaries", () => {
    expect(classifyTiv(50_000_000)).toBe("TARGET");
    expect(classifyTiv(100_000_000)).toBe("TARGET");
    expect(classifyTiv(150_000_000)).toBe("ACCEPTABLE");
    expect(classifyTiv(150_000_001)).toBe("NOT_ACCEPTABLE");
  });

  it("classifies premium target and hard-fail boundaries", () => {
    expect(classifyPremium(50_000)).toBe("ACCEPTABLE");
    expect(classifyPremium(75_000)).toBe("TARGET");
    expect(classifyPremium(100_000)).toBe("TARGET");
    expect(classifyPremium(175_000)).toBe("ACCEPTABLE");
    expect(classifyPremium(49_999)).toBe("NOT_ACCEPTABLE");
    expect(classifyPremium(175_001)).toBe("NOT_ACCEPTABLE");
  });

  it("treats building year 1990 as boundary review", () => {
    expect(classifyBuildingYear(1989)).toBe("NOT_ACCEPTABLE");
    expect(classifyBuildingYear(1990)).toBe("BOUNDARY_REVIEW");
    expect(classifyBuildingYear(1991)).toBe("ACCEPTABLE");
    expect(classifyBuildingYear(2010)).toBe("ACCEPTABLE");
    expect(classifyBuildingYear(2011)).toBe("TARGET");
  });

  it("treats $100,000 loss as boundary review", () => {
    expect(classifyFiveYearLoss(99_999)).toBe("ACCEPTABLE");
    expect(classifyFiveYearLoss(100_000)).toBe("BOUNDARY_REVIEW");
    expect(classifyFiveYearLoss(100_001)).toBe("NOT_ACCEPTABLE");
  });

  it("requires more than 50% acceptable construction", () => {
    expect(classifyConstructionMix(0.5)).toBe("BOUNDARY_REVIEW");
    expect(classifyConstructionMix(0.5001)).toBe("ACCEPTABLE");
    expect(classifyConstructionMix(0.49)).toBe("NOT_ACCEPTABLE");
  });

  it("does not let a high score hide a hard failure", () => {
    const criteria = [
      { factor: "submission_type" as const, status: "ACCEPTABLE" as const },
      { factor: "line_of_business" as const, status: "ACCEPTABLE" as const },
      { factor: "primary_state" as const, status: "TARGET" as const },
      { factor: "tiv" as const, status: "TARGET" as const },
      { factor: "premium" as const, status: "TARGET" as const },
      { factor: "building_year" as const, status: "TARGET" as const },
      { factor: "construction_mix" as const, status: "ACCEPTABLE" as const },
      { factor: "five_year_loss_value" as const, status: "NOT_ACCEPTABLE" as const },
    ];
    expect(appetiteScore(criteria)).toBeGreaterThan(70);
    expect(decideClass(criteria)).toBe("OUT_OF_APPETITE");
  });

  it("moves unknown required evidence to investigate", () => {
    const criteria = [
      { status: "TARGET" as const },
      { status: "ACCEPTABLE" as const },
      { status: "UNKNOWN" as const },
    ];
    expect(decideClass(criteria)).toBe("INVESTIGATE");
  });
});
