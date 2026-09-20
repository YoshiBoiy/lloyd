import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

/**
 * Same-origin proxy to the Lloyd API. Browser callers never see API_TOKEN;
 * this route injects it from server env (or the repo `.env` used by the API).
 */
function hydrateEnv() {
  const files = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), "../.env"),
    path.resolve(process.cwd(), "../.env.local"),
  ];
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq);
      let value = trimmed.slice(eq + 1);
      if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined || process.env[key] === "") process.env[key] = value;
    }
  }
}

hydrateEnv();

const API_URL = (process.env.LLOYD_API_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, "");
const API_TOKEN = process.env.API_TOKEN ?? "";

async function forward(request: NextRequest, segments: string[]): Promise<NextResponse> {
  const pathName = segments.map(encodeURIComponent).join("/");
  const target = `${API_URL}/api/${pathName}${request.nextUrl.search}`;
  const headers = new Headers({ accept: request.headers.get("accept") ?? "application/json" });
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  if (API_TOKEN) headers.set("authorization", `Bearer ${API_TOKEN}`);
  const reviewer = request.headers.get("x-reviewer-id");
  if (reviewer) headers.set("x-reviewer-id", reviewer);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
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
      { error: { code: "API_UNAVAILABLE", message: "The Lloyd API is unreachable." } },
      { status: 502, headers: { "cache-control": "no-store" } },
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

export async function PUT(request: NextRequest, { params }: RouteParams) {
  return forward(request, (await params).path);
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  return forward(request, (await params).path);
}
