import { existsSync, readFileSync } from "node:fs";
import { createApp } from "./app.js";
if (existsSync(".env")) process.loadEnvFile(".env");
const e = process.env;
if (Boolean(e.FEDERATO_CLIENT_ID) !== Boolean(e.FEDERATO_CLIENT_SECRET))
  throw new Error("Both Federato credentials are required");
if (
  e.AUTHENTICITY_REVIEW_THRESHOLD &&
  (!Number.isFinite(Number(e.AUTHENTICITY_REVIEW_THRESHOLD)) ||
    Number(e.AUTHENTICITY_REVIEW_THRESHOLD) < 0 ||
    Number(e.AUTHENTICITY_REVIEW_THRESHOLD) > 1)
)
  throw new Error("Invalid authenticity threshold");
/**
 * v2 device/reviewer bindings. Either a policy file (EDGE_V2_POLICY_FILE, JSON with `devices` and
 * `reviewers` maps) or the single-device shorthand (EDGE_TENANT_ID, EDGE_SIGNING_KEY_ID,
 * EDGE_DEVICE_ID, EDGE_SIGNING_KEY, EDGE_REVIEWER_ID, EDGE_REVIEWER_SIGNING_KEY). Absent → v2 disabled.
 */
function loadV2Policy() {
  if (e.EDGE_V2_POLICY_FILE) {
    const policy = JSON.parse(readFileSync(e.EDGE_V2_POLICY_FILE, "utf8"));
    if (
      !policy ||
      typeof policy !== "object" ||
      !policy.devices ||
      !policy.reviewers
    )
      throw new Error("EDGE_V2_POLICY_FILE must contain devices and reviewers");
    return policy as {
      devices: Record<string, never>;
      reviewers: Record<string, never>;
    };
  }
  if (
    e.EDGE_SIGNING_KEY &&
    e.EDGE_TENANT_ID &&
    e.EDGE_DEVICE_ID &&
    e.EDGE_SIGNING_KEY_ID
  ) {
    if (!e.EDGE_REVIEWER_ID || !e.EDGE_REVIEWER_SIGNING_KEY)
      throw new Error(
        "EDGE_REVIEWER_ID and EDGE_REVIEWER_SIGNING_KEY are required with a device binding",
      );
    return {
      devices: {
        [e.EDGE_SIGNING_KEY_ID]: {
          tenantId: e.EDGE_TENANT_ID,
          deviceId: e.EDGE_DEVICE_ID,
          key: e.EDGE_SIGNING_KEY,
        },
      },
      reviewers: {
        [e.EDGE_REVIEWER_ID]: {
          tenantId: e.EDGE_TENANT_ID,
          key: e.EDGE_REVIEWER_SIGNING_KEY,
          caseIds: (e.EDGE_REVIEWER_CASE_IDS ?? "*")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        },
      },
    };
  }
  return undefined;
}
const app = createApp({
  apiToken: e.API_TOKEN,
  approvalKey: e.RELEASE_APPROVAL_KEY,
  federato:
    e.FEDERATO_CLIENT_ID && e.FEDERATO_CLIENT_SECRET
      ? { id: e.FEDERATO_CLIENT_ID, secret: e.FEDERATO_CLIENT_SECRET }
      : undefined,
  mapping: e.FEDERATO_MAPPING_FILE
    ? JSON.parse(readFileSync(e.FEDERATO_MAPPING_FILE, "utf8"))
    : undefined,
  mongoUri: e.MONGODB_URI,
  elasticUrl: e.ELASTICSEARCH_URL,
  elasticKey: e.ELASTICSEARCH_API_KEY,
  tigerUrl: e.TIGER_DATABASE_URL,
  telemetryKey: e.TELEMETRY_HMAC_KEY,
  openaiKey: e.OPENAI_API_KEY,
  openaiModel: e.OPENAI_MODEL,
  foundryProjectEndpoint: e.FOUNDRY_PROJECT_ENDPOINT,
  foundryAgentId: e.FOUNDRY_AGENT_ID,
  foundryApiKey: e.FOUNDRY_API_KEY,
  foundryModel: e.FOUNDRY_MODEL,
  plannerProvider: e.PLANNER_PROVIDER,
  v2Policy: loadV2Policy(),
  geminiKey: e.GEMINI_API_KEY,
  geminiModel: e.GEMINI_MODEL,
  gptzeroKey: e.GPTZERO_API_KEY,
  gptzeroUrl: e.GPTZERO_URL,
  claimSupportUrl: e.GPTZERO_CLAIM_SUPPORT_URL,
  authenticityPolicy:
    e.AUTHENTICITY_POLICY_VERSION && e.AUTHENTICITY_REVIEW_THRESHOLD
      ? {
          version: e.AUTHENTICITY_POLICY_VERSION,
          reviewThreshold: Number(e.AUTHENTICITY_REVIEW_THRESHOLD),
        }
      : undefined,
});
const host = e.HOST ?? "127.0.0.1";
if (host !== "127.0.0.1" && host !== "localhost" && !e.API_TOKEN)
  throw new Error("API_TOKEN is required for non-loopback binding");
await app.listen({ port: Number(e.PORT ?? 3001), host });
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
