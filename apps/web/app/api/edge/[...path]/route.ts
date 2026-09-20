import { NextRequest, NextResponse } from "next/server";
import {
  DIRECT_PAIRING_REQUIRED,
  FORWARDED_VIA,
  ROUTE_NOT_RELAYED,
  isPrivileged,
  isRelayable,
  wantsApproval,
} from "@/lib/edge-proxy";

/**
 * Same-origin proxy to the RDK X5 privacy gateway.
 *
 * The gateway requires a local pairing bearer token (`EDGE_LOCAL_TOKEN`) and,
 * for low-confidence releases, a separate human-approval header
 * (`EDGE_HUMAN_APPROVAL_TOKEN`). Both are server-only secrets read here from
 * `process.env`, never `NEXT_PUBLIC_*` — the browser never sees them, matching
 * how the rest of this app keeps provider credentials off the client.
 * `EDGE_GATEWAY_URL` points at wherever the gateway is actually reachable
 * from this Next.js process (e.g. an SSH-forwarded local port when the real
 * RDK X5 board sits on a private network: `http://127.0.0.1:18001`).
 */
const GATEWAY_URL = (process.env.EDGE_GATEWAY_URL ?? "http://127.0.0.1:8001").replace(/\/+$/, "");
const LOCAL_TOKEN = process.env.EDGE_LOCAL_TOKEN ?? "";
const HUMAN_APPROVAL_TOKEN = process.env.EDGE_HUMAN_APPROVAL_TOKEN ?? "";

// Only allowlisted, content-free gateway routes are relayed (see lib/edge-proxy.ts); raw
// preview and local review never are, and every relayed request carries a Via header so the
// gateway can enforce that boundary itself.
async function forward(request: NextRequest, segments: string[]): Promise<NextResponse> {
  if (isPrivileged(segments)) {
    return NextResponse.json(DIRECT_PAIRING_REQUIRED, { status: 403, headers: { "cache-control": "no-store" } });
  }
  if (!isRelayable(segments)) {
    return NextResponse.json(ROUTE_NOT_RELAYED, { status: 403, headers: { "cache-control": "no-store" } });
  }
  const path = segments.map(encodeURIComponent).join("/");
  const search = request.nextUrl.search;
  const target = `${GATEWAY_URL}/${path}${search}`;

  const headers = new Headers({ "content-type": "application/json", via: FORWARDED_VIA });
  if (LOCAL_TOKEN) headers.set("authorization", `Bearer ${LOCAL_TOKEN}`);
  // v1 consults x-human-approval at release; v2 at approve. Sending it to the
  // other route is harmless (the gateway ignores unknown headers there).
  if (HUMAN_APPROVAL_TOKEN && wantsApproval(segments)) {
    headers.set("x-human-approval", HUMAN_APPROVAL_TOKEN);
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.method !== "DELETE";
  const body = hasBody ? await request.text() : undefined;

  let response: Response;
  try {
    response = await fetch(target, {
      method: request.method,
      headers,
      body: body && body.length > 0 ? body : undefined,
      redirect: "manual",
      cache: "no-store",
      signal: request.signal,
    });
  } catch {
    return NextResponse.json(
      { error: { code: "EDGE_UNAVAILABLE", message: "The local privacy gateway is unreachable." } },
      { status: 502 },
    );
  }

  const responseText = await response.text();
  return new NextResponse(responseText, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}

type RouteParams = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  return forward(request, (await params).path);
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  return forward(request, (await params).path);
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  return forward(request, (await params).path);
}
