import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AskWorkspace } from "../components/ask-lloyd/AskWorkspace";
vi.mock("next/dynamic", () => ({ default: () => () => null }));
const source = {
  evidenceId: "ev-inspection",
  documentId: "doc-inspection",
  caseId: "case-demo",
  label: "Annex inspection",
  page: 2,
  excerpt: "The annex is not sprinkler protected.",
  sourceType: "inspection",
  verificationStatus: "CONTRADICTED",
  reliability: 0.9,
  observedAt: "2026-09-20",
};
const result = {
  answerId: "answer-1",
  status: "ANSWERED",
  answerMarkdown: source.excerpt,
  claims: [{ claim: source.excerpt, evidenceIds: [source.evidenceId] }],
  citations: [source],
  sources: [source],
  precedents: [],
  suggestedQuestions: [],
  focusNodes: [source.documentId],
  trace: {
    intent: "EVIDENCE_SEARCH",
    planner: "deterministic-v1",
    completedMs: 2,
    steps: [],
    warnings: [],
  },
  graphs: {
    evidence: {
      mode: "evidence",
      projectionVersion: "evidence-pca-v1",
      notice: "Layout is an approximate projection.",
      nodes: [
        {
          id: source.documentId,
          label: source.label,
          type: source.sourceType,
          relevance: 0.8,
          metadataPreview: {},
        },
      ],
      edges: [],
    },
    precedents: { nodes: [], edges: [], projectionVersion: "precedent-pca-v1" },
  },
};
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("Ask Lloyd accessible workflow", () => {
  it("streams an answer, opens its exact citation page, pins and filters list sources, and deletes history", async () => {
    const user = userEvent.setup();
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "DELETE")
          return new Response(null, { status: 204 });
        if (url.endsWith("/sessions"))
          return Response.json({ sessionId: "session-1" });
        if (url.endsWith("/messages"))
          return new Response(
            `event: intent\ndata: ${JSON.stringify({ intent: "EVIDENCE_SEARCH", effectiveScope: { caseId: "case-demo" } })}\n\nevent: completed\ndata: ${JSON.stringify(result)}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        return Response.json({ passages: [source] });
      },
    );
    vi.stubGlobal("fetch", fetch);
    render(<AskWorkspace caseId="case-demo" />);
    await user.type(
      screen.getByLabelText("Ask an underwriting question"),
      "Find sprinkler evidence",
    );
    await user.click(screen.getByRole("button", { name: "Ask Lloyd" }));
    await screen.findByText("Sources found");
    expect(screen.getByRole("button", { name: "3D map" })).toBeDisabled();
    await user.click(
      screen.getByRole("button", {
        name: "Open source: Annex inspection, page 2",
      }),
    );
    const drawer = screen.getByRole("region", { name: "Selected source" });
    expect(
      within(drawer).getByText("Annex inspection · Page 2"),
    ).toBeInTheDocument();
    expect(within(drawer).getByText(source.excerpt)).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Pin for comparison" }),
    );
    expect(screen.getByText("Pinned comparison")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use in question" }));
    expect(screen.getByLabelText("Ask an underwriting question")).toHaveValue(
      " [source: ev-inspection]",
    );
    await user.selectOptions(
      screen.getByLabelText("Source filter"),
      "inspection",
    );
    expect(
      screen.getByRole("list", { name: "Ranked sources" }).children,
    ).toHaveLength(1);
    await user.click(
      screen.getByRole("button", {
        name: "Delete conversation and saved answers",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Sources found")).not.toBeInTheDocument(),
    );
  });
  it("reports stream failure without manufacturing an answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/sessions")
          ? Response.json({ sessionId: "s" })
          : new Response(
              'event: error\ndata: {"message":"Retrieval unavailable"}\n\n',
            ),
      ),
    );
    const user = userEvent.setup();
    render(<AskWorkspace caseId="case-demo" />);
    await user.type(
      screen.getByLabelText("Ask an underwriting question"),
      "Find evidence",
    );
    await user.click(screen.getByRole("button", { name: "Ask Lloyd" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Retrieval unavailable",
    );
    expect(screen.queryByText("Sources found")).not.toBeInTheDocument();
  });
});

it("presents readable source metadata and keeps raw provenance collapsed", async () => {
  const { SourceCard, friendlyClaim } =
    await import("../components/ask-lloyd/AnswerCards");
  render(
    <SourceCard
      source={source}
      detail={{ internalId: "audit-only" }}
      onClose={() => {}}
      onUse={() => {}}
    />,
  );
  expect(screen.getByText("Conflicting evidence")).toBeInTheDocument();
  expect(screen.getByText("Sep 20, 2026")).toBeInTheDocument();
  expect(screen.getByText("90 / 100")).toBeInTheDocument();
  expect(
    screen.getByText("Source provenance · JSON").closest("details"),
  ).not.toHaveAttribute("open");
  expect(
    friendlyClaim(
      "premium: 176000; NOT_ACCEPTABLE. premium: NOT_ACCEPTABLE. Sources: federato",
    ),
  ).toBe("Premium: $176,000. Not acceptable. Recorded by Federato.");
});
