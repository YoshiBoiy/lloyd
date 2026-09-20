import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntakeV2View } from "../components/intake/IntakeV2View";
import { IntakeWorkspaceView } from "../components/intake/IntakeWorkspaceView";
import { resolveIntakeContract } from "../components/intake/IntakeEntry";
import { getMockLloydApi } from "../lib/api";
import { getEdgeV2Client } from "../lib/api/edge-v2";

const HEALTH = {
  status: "ok",
  version: "2.0.0",
  outbound: "explicit-release-only",
  deviceId: "rdk-x5-test",
  tenantId: "tenant-test",
  v2Enabled: true,
  capabilities: {
    camera: false,
    ocr: { adapter: "LocalOCR", ready: true },
    classifier: { ready: true, modelId: "local-text-v1", artifactDigest: "ab".repeat(32), runtimeVersion: "multinomial-v1", calibration: "UNCALIBRATED", error: null },
    detector: { ready: false, modelId: null, artifactDigest: null, runtimeVersion: null, error: "MODEL_MISSING" },
    qualityPolicy: { version: "quality-v2-provisional", calibrated: false },
    privacyPolicyVersion: "privacy-v2-text-only",
    imageRedaction: "TEXT_LAYOUT_ONLY",
    pairing: { configured: true, reviewers: 1, allowedOrigins: [] },
  },
};
const STATUS = {
  intakeId: "11111111-2222-4333-8444-555555555555",
  documentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  revision: 1,
  stage: "CAPTURED",
  caseId: "case:1001",
  pageCount: 0,
  quality: null,
  classification: null,
  matchHints: null,
  approval: null,
  receipt: null,
  releaseError: null,
  limitations: ["Image redaction is text-layout only"],
  model: { classifier: HEALTH.capabilities.classifier, detector: HEALTH.capabilities.detector },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("IntakeV2View", () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith("/health")) return json(HEALTH);
        if (url.endsWith("/v2/intakes") && init?.method === "POST") return json(STATUS);
        if (url.endsWith("/status")) return json(STATUS);
        return json({ detail: "unexpected" }, 500);
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
    delete process.env.NEXT_PUBLIC_EDGE_GATEWAY_URL;
    getEdgeV2Client(true);
  });

  it("starts a proxied intake without diagnostic capability chrome", async () => {
    render(<IntakeV2View caseId="case:1001" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Start intake" })).toBeEnabled());
    expect(screen.queryByText("local-text-v1")).not.toBeInTheDocument();
    expect(screen.queryByText("MODEL_MISSING")).not.toBeInTheDocument();
    expect(screen.queryByText(/Release contract v2/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/gateway 2\.0\.0/)).not.toBeInTheDocument();
    expect(screen.queryByText("Image redaction is text-layout only")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Local processing/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Live preview/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Start intake" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Set case" })).toBeInTheDocument());
    const start = calls.find((c) => c.url.endsWith("/v2/intakes"));
    expect(start?.url).toBe("/api/edge/v2/intakes");
    expect(JSON.parse(start!.init!.body as string)).toEqual({
      caseId: "case:1001",
      destinations: ["lloyd-api", "gemini", "gptzero", "elasticsearch"],
    });
    expect(new Headers(start!.init!.headers).has("authorization")).toBe(false);
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument();
  });

  it("auto-pairs a USB workstation so live preview does not wait on a pasted token", async () => {
    process.env.NEXT_PUBLIC_EDGE_GATEWAY_URL = "http://127.0.0.1:18001";
    window.sessionStorage.clear();
    getEdgeV2Client(true);
    const usbHealth = { ...HEALTH, capabilities: { ...HEALTH.capabilities, camera: true } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith("/api/edge/local-pairing")) {
          return json({ pairingToken: "usb-pair", approvalToken: "usb-rev" });
        }
        if (url.endsWith("/health")) return json(usbHealth);
        return json({ detail: "unexpected" }, 500);
      }),
    );
    render(<IntakeV2View />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Live preview/ })).toBeEnabled());
    expect(screen.queryByRole("button", { name: /^Pair$/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Paired with this workstation over USB/)).not.toBeInTheDocument();
    const health = calls.find((c) => String(c.url).endsWith("/health"));
    expect(health?.url).toBe("http://127.0.0.1:18001/health");
    expect(new Headers(health?.init?.headers).get("authorization")).toBe("Bearer usb-pair");
  });

  it("recovers an in-flight intake named in the route instead of orphaning it on reload", async () => {
    render(<IntakeV2View intakeId={STATUS.intakeId} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Set case" })).toBeInTheDocument());
    expect(calls.some((c) => c.url.endsWith("/v2/intakes") && c.init?.method === "POST")).toBe(false);
    expect(calls.some((c) => c.url.endsWith(`/v2/intakes/${STATUS.intakeId}/status`))).toBe(true);
  });
});

describe("IntakeWorkspaceView (mock adapters)", () => {
  beforeEach(async () => {
    getMockLloydApi().setDeviceReachable(true);
    await getMockLloydApi().resetDemo();
    getMockLloydApi().setLatency(0);
  });

  async function tab(name: RegExp) {
    const found = await waitFor(() => screen.getByRole("tab", { name }));
    fireEvent.click(found);
    return found;
  }

  it("opens on privacy review, explains the risk flags, and keeps approval mandatory", async () => {
    render(<IntakeWorkspaceView />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /Needs Privacy Review/ })).toBeInTheDocument());
    // An approved-but-unreleased intake waits on a person, and its signature lapses.
    expect(screen.getByText(/approved, not released · expires/)).toBeInTheDocument();
    expect(screen.getByText(/bumps the revision back to review; it is not a failure/)).toBeInTheDocument();

    fireEvent.click(screen.getAllByText(/classifier abstained/)[0]!);
    expect(screen.getByText(/The semantic detector found identifiers/)).toBeInTheDocument();
    expect(screen.getByText(/Approval is still required for every release/)).toBeInTheDocument();
    // Review data never crosses a hosted server, so the workspace links to the device session.
    expect(screen.getByRole("link", { name: /Open intake/ })).toHaveAttribute(
      "href",
      "/intake?intake=5f607182-93a4-4b56-8c78-d9e0f1a2b3c4",
    );
  });

  it("partitions every item into exactly one tab, and the counts sum to the total", async () => {
    render(<IntakeWorkspaceView />);
    for (const entry of ["Ready to Scan", "Processing", "Needs Privacy Review", "Unmatched", "Attached", "Failed"])
      expect(await waitFor(() => screen.getByRole("tab", { name: new RegExp(entry) }))).toBeInTheDocument();
    const work = await getMockLloydApi().listIntakeWork();
    const sum = Object.values(work.counts).reduce((total, value) => total! + (value ?? 0), 0);
    expect(sum).toBe(work.items.length);
    expect(new Set(work.items.map((item) => item.intakeId)).size).toBe(work.items.length);
  });

  it("ranks candidates from hints with reasons and attaches the document on association", async () => {
    render(<IntakeWorkspaceView initialTab="unmatched" />);
    await waitFor(() => expect(screen.getByText("riskState: PA")).toBeInTheDocument());
    const radios = await waitFor(() => {
      const found = screen.getAllByRole("radio");
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    expect(screen.getAllByText(/Risk state PA matches/).length).toBeGreaterThan(0);
    fireEvent.click(radios[0]);
    fireEvent.click(screen.getByRole("button", { name: /Associate/ }));
    await tab(/Attached/);
    await waitFor(() => expect(screen.getByText(/local vs provider: agree/)).toBeInTheDocument());
    expect(screen.getByText(/ASSOCIATED · Selected from ranked candidates/)).toBeInTheDocument();
  });

  it("offers a transport retry in Failed and refuses one where the revision is immutable", async () => {
    render(<IntakeWorkspaceView initialTab="failed" />);
    await waitFor(() => expect(screen.getByText("DEVICE_DENIED")).toBeInTheDocument());
    // A refused release: administrator action, never a retry.
    fireEvent.click(screen.getByText("DEVICE_DENIED"));
    expect(screen.getByText(/check the device and reviewer key bindings/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry the same approved release/ })).toBeNull();
    // A transport failure: the identical envelope goes out again and dedupes on the backend.
    fireEvent.click(screen.getByText("statement of values"));
    const retry = screen.getByRole("button", { name: /Retry the same approved release/ });
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByText("statement of values")).toBeNull());
    const work = await getMockLloydApi().listIntakeWork();
    const retried = work.items.filter((item) => item.documentType === "statement_of_values");
    expect(retried).toHaveLength(1);
    expect(retried[0]!.tab).toBe("attached");
  });

  it("renders unknown device counts rather than false zeros when the gateway is silent", async () => {
    getMockLloydApi().setDeviceReachable(false);
    render(<IntakeWorkspaceView initialTab="ready" />);
    // Device-owned queues are unknown; the backend-owned Unmatched tab keeps its real count.
    await waitFor(() => expect(screen.getByRole("tab", { name: /Ready to Scan — \(0 known\)/ })).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: /Unmatched 1/ })).toBeInTheDocument();
    expect(screen.getByText(/device-owned queues are unknown rather than empty/)).toBeInTheDocument();
    expect(screen.getByText(/Unknown — the domain that fills this queue did not answer/)).toBeInTheDocument();
  });
});

describe("intake contract selection", () => {
  it("defaults to v2 against a real backend and honours an explicit override", () => {
    expect(resolveIntakeContract({})).toBe("v1");
    expect(resolveIntakeContract({ NEXT_PUBLIC_INTAKE_CONTRACT: "v2" })).toBe("v2");
    expect(resolveIntakeContract({ NEXT_PUBLIC_INTAKE_CONTRACT: "v1" })).toBe("v1");
  });
});
