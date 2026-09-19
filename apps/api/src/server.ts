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
