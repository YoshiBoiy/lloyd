import { HttpLloydApi } from "./http";
import { MockLloydApi } from "./mock";
import type { LloydApi } from "./types";

export type ApiMode = "mock" | "http";

let singleton: LloydApi | null = null;
let mockSingleton: MockLloydApi | null = null;

export function getApiMode(): ApiMode {
  if (typeof process !== "undefined" && process.env.NEXT_PUBLIC_LLOYD_API_MODE === "http") {
    return "http";
  }
  return "mock";
}

export function getLloydApi(): LloydApi {
  if (!singleton) {
    if (getApiMode() === "http") {
      singleton = new HttpLloydApi(
        process.env.NEXT_PUBLIC_LLOYD_API_URL ?? "http://localhost:8080",
        process.env.NEXT_PUBLIC_LLOYD_EDGE_URL ?? "http://localhost:8787",
      );
    } else {
      mockSingleton = new MockLloydApi({ latencyMs: 140 });
      singleton = mockSingleton;
    }
  }
  return singleton;
}

export function getMockLloydApi(): MockLloydApi {
  const api = getLloydApi();
  if (api instanceof MockLloydApi) return api;
  throw new Error("Mock API is not active.");
}

export function subscribeLloydApi(listener: () => void): () => void {
  const api = getLloydApi();
  if (api instanceof MockLloydApi) return api.subscribe(listener);
  return () => undefined;
}
