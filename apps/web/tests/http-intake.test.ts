import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpLloydApi } from "../lib/api/http";

const API_BASE = "http://api.test";

function wireManifest(documentId: string) {
  return {
    sanitizedSha256: `sha-${documentId}`,
    fields: [{ path: "contact.name", classification: "tokenized", confidence: 0.99 }],
    destinations: ["lloyd-api", "gemini", "gptzero", "elasticsearch"],
    confidence: 0.97,
  };
}

/**
 * Stands in for the RDK X5 gateway proxy (`/api/edge/*`) and the backend.
 * Records every request so tests can assert which case id was actually sent.
 */
function stubGateway(options: { knownCases?: string[]; releaseStatus?: number } = {}) {
  const knownCases = options.knownCases ?? [];
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  let documents = 0;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
    const documentId = url.split("/documents/")[1]?.split("/")[0] ?? "";
    if (url.endsWith("/api/edge/capture")) {
      documents += 1;
      return json({
        documentId: `doc-${documents}`,
        quality: { blurVariance: 240, glareFraction: 0.1, confidence: 0.98 },
      });
    }
    if (url.endsWith("/ocr")) return json({ confidence: 0.96, adapter: "local" });
    if (url.endsWith("/redact")) return json({ manifest: wireManifest(documentId), requiresApproval: false });
    if (url.endsWith("/preview")) {
      return json({
        intake: { artifact: { text: `sanitized ${documentId}` }, manifest: wireManifest(documentId) },
        requiresApproval: false,
      });
    }
    if (url.endsWith("/release")) {
      if (options.releaseStatus) return json({ detail: "Release failed" }, options.releaseStatus);
      return json({ documentId, status: "RELEASED" });
    }
    if (url.startsWith(`${API_BASE}/api/cases/`)) {
      const id = decodeURIComponent(url.slice(`${API_BASE}/api/cases/`.length));
      if (!knownCases.includes(id)) return json({ error: "NOT_FOUND" }, 404);
      return json({ id, accountName: `Account ${id}` });
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  return {
    requests,
    captureBodies: () => requests.filter((item) => item.url.endsWith("/capture")).map((item) => item.body),
  };
}

async function runPipeline(client: HttpLloydApi, caseId: string) {
  await client.captureIntake(caseId);
  await client.advanceIntakeProcessing();
  await client.advanceIntakeProcessing();
  await client.advanceIntakeProcessing();
  return client.advanceIntakeProcessing();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HttpLloydApi case-scoped intake", () => {
  it("captures against the requested case instead of a fixed demo id", async () => {
    const gateway = stubGateway({ knownCases: ["demo-020"] });
    const client = new HttpLloydApi(API_BASE);
    const document = await runPipeline(client, "demo-020");
    expect(gateway.captureBodies()).toEqual([{ caseId: "demo-020", source: "camera" }]);
    expect(document.caseId).toBe("demo-020");
    expect(document.manifest?.caseId).toBe("demo-020");
    expect(document.stage).toBe("review");
  });

  it("keeps two cases scanned in sequence isolated from each other", async () => {
    const gateway = stubGateway({ knownCases: ["demo-020", "demo-031"] });
    const client = new HttpLloydApi(API_BASE);

    const first = await runPipeline(client, "demo-020");
    await client.approveAndRelease({ destinations: ["gemini"], approvedBy: "A. Chen", acceptLowConfidence: false });

    // Opening intake for another case must not inherit the released document.
    const opened = await client.getIntake("demo-031");
    expect(opened.caseId).toBe("demo-031");
    expect(opened.stage).toBe("idle");
    expect(opened.documentId).toBe("");
    expect(opened.released).toBe(false);
    expect(opened.manifest).toBeNull();
    expect(opened.redactionConfidence).toBe(0);

    const second = await runPipeline(client, "demo-031");
    expect(second.documentId).not.toBe(first.documentId);
    expect(second.caseId).toBe("demo-031");
    expect(second.manifest?.caseId).toBe("demo-031");
    expect(gateway.captureBodies()).toEqual([
      { caseId: "demo-020", source: "camera" },
      { caseId: "demo-031", source: "camera" },
    ]);
  });

  it("returns the in-flight document when intake is reopened for the same case", async () => {
    stubGateway({ knownCases: ["demo-020"] });
    const client = new HttpLloydApi(API_BASE);
    const captured = await runPipeline(client, "demo-020");
    const reopened = await client.getIntake("demo-020");
    expect(reopened.documentId).toBe(captured.documentId);
    expect(reopened.stage).toBe("review");
  });

  it("names the missing case when release is refused for an unknown case", async () => {
    stubGateway({ knownCases: [], releaseStatus: 502 });
    const client = new HttpLloydApi(API_BASE);
    await runPipeline(client, "case:does-not-exist");
    await expect(
      client.approveAndRelease({ destinations: ["gemini"], approvedBy: "A. Chen", acceptLowConfidence: false }),
    ).rejects.toThrow(/case:does-not-exist was not found/);
  });

  it("requires a case before capturing", async () => {
    stubGateway();
    const client = new HttpLloydApi(API_BASE);
    await expect(client.captureIntake("")).rejects.toThrow(/needs a case/);
  });
});

describe("HttpLloydApi merged intake queue", () => {
  const backendItem = {
    intakeId: "b-1",
    documentId: "doc-b-1",
    deviceId: "rdk-x5-test",
    revision: 1,
    receivedAt: "2026-09-19T15:00:00.000Z",
    status: "AWAITING_ASSOCIATION",
    association: null,
    classification: { documentType: "inspection_report" },
    processing: {},
    audit: [],
  };

  /** Both domains are queried independently; either can fail without hiding the other. */
  function stubDomains(options: { device?: unknown; backend?: unknown }) {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/edge/v2/intakes"))
          return options.device === undefined ? json({ detail: "unreachable" }, 502) : json(options.device);
        if (url.includes("/api/intakes/rejections")) return json({ items: [] });
        if (url.includes("/api/intakes"))
          return options.backend === undefined ? json({ detail: "down" }, 503) : json(options.backend);
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
  }

  it("marks device counts unknown when the gateway is unreachable, keeping backend tabs intact", async () => {
    stubDomains({ backend: { items: [backendItem] } });
    const work = await new HttpLloydApi(API_BASE).listIntakeWork();
    expect(work.deviceReachable).toBe(false);
    expect(work.backendReachable).toBe(true);
    // Unknown says why: an unreachable gateway asks for pairing, a refusal asks for identity.
    expect(work.deviceReason).toBe("did not answer");
    expect(work.backendReason).toBeNull();
    expect(work.counts.privacy_review).toBeNull();
    expect(work.counts.unmatched).toBe(1);
    expect(work.items.map((item) => item.tab)).toEqual(["unmatched"]);
  });

  it("keeps local work visible when the backend is down", async () => {
    stubDomains({
      device: {
        items: [
          {
            intakeId: "d-1",
            documentId: "doc-d-1",
            revision: 1,
            stage: "REVIEW_READY",
            caseId: null,
            pageCount: 2,
            quality: { status: "REVIEW", reasons: ["UNCALIBRATED_POLICY"] },
            classification: { status: "CLASSIFIED", documentType: "loss_run", confidence: 0.9, calibration: "UNCALIBRATED", modelId: "local-text-v1" },
            matchHints: null,
            reviewRisk: { reasons: ["QUALITY_REVIEW"], policyVersion: "review-risk-v1-provisional", provisional: true },
            releaseError: null,
            updatedAt: "2026-09-19T15:05:00.000Z",
            retentionUntil: null,
            originalDeleted: false,
          },
        ],
        total: 1,
      },
    });
    const work = await new HttpLloydApi(API_BASE).listIntakeWork({ tab: "privacy_review" });
    expect(work.backendReachable).toBe(false);
    expect(work.counts.privacy_review).toBe(1);
    expect(work.counts.attached).toBeNull();
    expect(work.items[0]?.reviewRisk).toEqual(["QUALITY_REVIEW"]);
  });
});
