import { Readable } from "node:stream";
import { createApp } from "../../../../apps/api/src/app";

// Explicitly credential-free. A warm function reuses its synthetic workspace;
// a cold start creates a fresh one. Never hydrate configuration from local env.
let ready: ReturnType<typeof start> | undefined;
async function start() {
  const app = createApp();
  await app.ready();
  const seeded = await app.inject({ method: "POST", url: "/api/ask/demo" });
  if (seeded.statusCode !== 200) throw new Error("Synthetic demo setup failed");
  return app;
}

export async function hostedDemo(request: Request, url: string): Promise<Response> {
  const app = await (ready ??= start().catch((error) => {
    ready = undefined;
    throw error;
  }));
  const response = await app.inject({
    method: request.method as "GET" | "POST" | "PUT" | "DELETE",
    url,
    headers: {
      accept: request.headers.get("accept") ?? "application/json",
      ...(request.headers.get("content-type")
        ? { "content-type": request.headers.get("content-type")! }
        : {}),
    },
    payload: ["GET", "HEAD"].includes(request.method) ? undefined : await request.text(),
    payloadAsStream: true,
    signal: request.signal,
  });
  const noBody = [204, 304].includes(response.statusCode);
  return new Response(noBody ? null : Readable.toWeb(response.stream()) as ReadableStream<Uint8Array>, {
    status: response.statusCode,
    headers: {
      "content-type": String(response.headers["content-type"] ?? "application/json"),
      "cache-control": "no-store",
    },
  });
}
