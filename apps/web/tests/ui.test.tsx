import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DecisionBadge } from "../components/ui/Badge";
import { computeRedactionConfidence } from "../lib/fixtures/intake";
import { INTAKE_SPANS } from "../lib/fixtures/intake";
import { MIN_RELEASE_CONFIDENCE } from "../lib/api/types";
import { getLloydApi } from "../lib/api";

describe("privacy confidence helper", () => {
  it("stays below the release threshold until required signature is enabled", () => {
    const spans = INTAKE_SPANS.map((span) => ({ ...span, enabled: span.id !== "span-signature" }));
    expect(computeRedactionConfidence(spans)).toBeLessThan(MIN_RELEASE_CONFIDENCE);
    spans.find((span) => span.id === "span-signature")!.enabled = true;
    expect(computeRedactionConfidence(spans)).toBeGreaterThanOrEqual(MIN_RELEASE_CONFIDENCE);
  });
});

describe("decision badge", () => {
  it("renders appetite language rather than a chatbot status", () => {
    render(<DecisionBadge value="ACCEPT_WITH_CONDITIONS" />);
    expect(screen.getByText("ACCEPT WITH CONDITIONS")).toBeInTheDocument();
  });
});

describe("analytics fixture hygiene", () => {
  it("does not expose raw customer document text", async () => {
    const summary = await getLloydApi().getAnalytics();
    const blob = JSON.stringify(summary);
    expect(blob).not.toContain("jordan.hale@harbormill.example");
    expect(blob).not.toContain("DL-PA-8829173");
    expect(summary.source).toBe("tiger_data_continuous_aggregates");
  });
});
