import { readFileSync, existsSync } from "node:fs";
import { CaseStore, EvidenceStore } from "../packages/integrations/src/data.js";
import { AskPolicy } from "../apps/api/src/routes/ask.js";
import { AskService, collapse } from "../packages/ask/src/service.js";
import { riskProfile } from "../packages/ask/src/risk.js";
import { needsRebuild } from "../packages/ask/src/projection.js";
if (existsSync(".env")) process.loadEnvFile(".env");
const mode = process.argv[2];
if (mode !== "evidence" && mode !== "precedents")
  throw new Error(
    "Usage: tsx scripts/rebuild-ask-projection.ts evidence|precedents [caseId] [--force]",
  );
if (!process.env.ASK_POLICY_FILE)
  throw new Error("ASK_POLICY_FILE is required");
const policy = AskPolicy.parse(
  JSON.parse(readFileSync(process.env.ASK_POLICY_FILE, "utf8")),
);
const scope = {
  ...policy,
  caseId: process.argv[3]?.startsWith("--") ? undefined : process.argv[3],
};
const cases = new CaseStore(process.env.MONGODB_URI),
  evidence = new EvidenceStore(
    process.env.ELASTICSEARCH_URL,
    process.env.ELASTICSEARCH_API_KEY,
  ),
  service = new AskService(cases, evidence);
try {
  await cases.init();
  await evidence.init();
  if (scope.caseId) await service.current(scope);
  const authorizedCases =
    mode === "precedents" ? await service.authorizedCases(scope) : [];
  if (mode === "precedents")
    for (const record of authorizedCases) await cases.saveVector(record);
  const vectors =
    mode === "evidence"
      ? collapse(
          (
            await evidence.corpus(
              scope.tenantId,
              scope.caseId ? [scope.caseId] : scope.caseIds,
            )
          ).map((chunk) => ({ chunk, score: 0 })),
          Date.now(),
          1000,
        ).map((d) => d.vector)
      : authorizedCases.map((c) => riskProfile(c).vector);
  const old = await service.projection(scope, mode, vectors);
  const rebuild =
    process.argv.includes("--force") || needsRebuild(old, vectors);
  const next = rebuild
    ? await service.projection(scope, mode, vectors, true)
    : old;
  console.log(
    JSON.stringify(
      {
        mode,
        rebuilt: rebuild,
        projectionVersion: next.version,
        sampleCount: next.sampleCount,
        explainedVariance: next.explainedVariance,
      },
      null,
      2,
    ),
  );
} finally {
  await cases.close();
}
