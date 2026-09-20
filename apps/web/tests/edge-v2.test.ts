import { describe, expect, it, vi } from "vitest";
import {
  EdgeV2Client,
  EdgeV2Error,
  bootstrapLocalPairing,
  parseMixedReplace,
  resolveEdgeV2Config,
} from "../lib/api/edge-v2";
import { isPrivileged, isRelayable, wantsApproval } from "../lib/edge-proxy";

function fetchMock(status = 200, body: unknown = {}) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("edge v2 client transports", () => {
  it("resolves direct pairing only when a gateway origin is published to the browser", () => {
    expect(resolveEdgeV2Config({})).toEqual({ transport: "proxy", baseUrl: "/api/edge" });
    expect(resolveEdgeV2Config({ NEXT_PUBLIC_EDGE_GATEWAY_URL: "http://rdk.local:8001/" })).toMatchObject({
      transport: "direct",
      baseUrl: "http://rdk.local:8001",
    });
  });

  it("reads process.env.NEXT_PUBLIC_EDGE_GATEWAY_URL as a static property so Next inlines it in the browser bundle", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const src = await readFile(join(process.cwd(), "lib/api/edge-v2.ts"), "utf8");
    expect(src).toMatch(/process\.env\.NEXT_PUBLIC_EDGE_GATEWAY_URL/);
  });

  it("bootstraps pairing from the loopback workstation endpoint instead of asking the operator to paste a token", async () => {
    const fetch = fetchMock(200, { pairingToken: "pair-usb", approvalToken: "rev-usb" });
    await expect(bootstrapLocalPairing(fetch)).resolves.toEqual({ pairingToken: "pair-usb", approvalToken: "rev-usb" });
    expect(fetch).toHaveBeenCalledWith("/api/edge/local-pairing", { cache: "no-store" });
    await expect(bootstrapLocalPairing(fetchMock(404, { error: { code: "NOT_LOCAL" } }))).resolves.toBeNull();
  });

  it("proxied sessions cannot review, approve or preview — and never send tokens", async () => {
    const fetch = fetchMock();
    const client = new EdgeV2Client({ transport: "proxy", baseUrl: "/api/edge" }, fetch);
    expect(client.canReview).toBe(false);
    await expect(client.review("i")).rejects.toMatchObject({ code: "DIRECT_PAIRING_REQUIRED" });
    await expect(client.approve("i", 1, false)).rejects.toMatchObject({ code: "DIRECT_PAIRING_REQUIRED" });
    await expect(client.streamPreview(() => undefined, new AbortController().signal)).rejects.toMatchObject({
      code: "DIRECT_PAIRING_REQUIRED",
    });
    expect(fetch).not.toHaveBeenCalled();
    await client.status("i");
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("direct sessions send the pairing token and bind approval to the exact revision with the reviewer header", async () => {
    const fetch = fetchMock();
    const client = new EdgeV2Client(
      { transport: "direct", baseUrl: "http://rdk.local:8001", pairingToken: "pair-1", approvalToken: "rev-1" },
      fetch,
    );
    await client.approve("abc", 4, true);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://rdk.local:8001/v2/intakes/abc/approve");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer pair-1");
    expect(headers.get("x-human-approval")).toBe("rev-1");
    expect(JSON.parse(init.body as string)).toEqual({ revision: 4, acknowledgedQuality: true });
    expect(init.cache).toBe("no-store");
  });

  it("refuses to approve without a reviewer token and surfaces gateway detail on errors", async () => {
    const fetch = fetchMock(409, { detail: "Review the exact current revision" });
    const client = new EdgeV2Client({ transport: "direct", baseUrl: "http://rdk.local:8001", pairingToken: "p" }, fetch);
    await expect(client.approve("abc", 1, false)).rejects.toMatchObject({ code: "REVIEWER_TOKEN_REQUIRED" });
    await expect(client.analyze("abc")).rejects.toSatisfy(
      (e: unknown) => e instanceof EdgeV2Error && e.status === 409 && e.message === "Review the exact current revision",
    );
  });

  it("parses the gateway's multipart JPEG stream into discrete frames", async () => {
    const encoder = new TextEncoder();
    const frame = (bytes: number[]) =>
      new Uint8Array([
        ...encoder.encode(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${bytes.length}\r\n\r\n`),
        ...bytes,
        ...encoder.encode("\r\n"),
      ]);
    const chunks = [frame([1, 2, 3]), frame([4, 5])];
    // Split across chunk boundaries to exercise buffering.
    const all = new Uint8Array([...chunks[0], ...chunks[1]]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(all.subarray(0, 20));
        controller.enqueue(all.subarray(20, 61));
        controller.enqueue(all.subarray(61));
        controller.close();
      },
    });
    const frames: number[][] = [];
    for await (const bytes of parseMixedReplace(stream)) frames.push([...bytes]);
    expect(frames).toEqual([[1, 2, 3], [4, 5]]);
  });
});

describe("same-origin proxy boundary", () => {
  it("never relays raw preview or local review, and marks approval routes", () => {
    expect(isPrivileged(["preview", "stream"])).toBe(true);
    expect(isPrivileged(["preview"])).toBe(true);
    expect(isPrivileged(["v2", "intakes", "abc", "review"])).toBe(true);
    expect(isPrivileged(["documents", "abc", "preview"])).toBe(true);
    expect(isPrivileged(["v2", "intakes", "abc", "status"])).toBe(false);
    expect(isPrivileged(["v2", "intakes", "abc", "pages"])).toBe(false);
    expect(isPrivileged(["stream"])).toBe(false);
    expect(wantsApproval(["v2", "intakes", "abc", "approve"])).toBe(true);
    expect(wantsApproval(["documents", "abc", "release"])).toBe(true);
    expect(wantsApproval(["v2", "intakes", "abc", "release"])).toBe(true);
    expect(wantsApproval(["health"])).toBe(false);
  });

  it("relays only allowlisted routes, so a new gateway route is refused until it is reviewed", () => {
    // The enumeration route carries bounded metadata and is deliberately relayed.
    expect(isRelayable(["v2", "intakes"])).toBe(true);
    expect(isRelayable(["v2", "intakes", "abc", "status"])).toBe(true);
    expect(isRelayable(["health"])).toBe(true);
    // Content routes stay direct-pairing-only even though they are otherwise well known.
    expect(isRelayable(["v2", "intakes", "abc", "review"])).toBe(false);
    expect(isRelayable(["v2", "intakes", "abc", "preview"])).toBe(false);
    expect(isRelayable(["v2", "intakes", "abc", "preview", "stream"])).toBe(false);
    // Fail-safe: an unknown route is refused rather than silently forwarded.
    expect(isRelayable(["v2", "intakes", "abc", "artifacts"])).toBe(false);
    expect(isRelayable(["v2", "tokens"])).toBe(false);
    expect(isRelayable(["v2", "intakes", "abc"])).toBe(false);
  });
});
