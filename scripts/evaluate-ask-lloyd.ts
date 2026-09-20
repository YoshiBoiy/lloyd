import { CaseStore, EvidenceStore } from "../packages/integrations/src/data.js";
import {
  seedAskDemo,
  demoQuestions,
  DEMO_CASE,
} from "../packages/ask/src/fixtures.js";
import { AskService } from "../packages/ask/src/service.js";
import { AskRequest } from "../packages/ask/src/contracts.js";
const cases = new CaseStore(),
  evidence = new EvidenceStore();
await seedAskDemo(cases, evidence);
const service = new AskService(cases, evidence);
const rows = [];
for (const [question, intent, expected] of demoQuestions) {
  const global = intent === "PORTFOLIO_FILTER";
  const result = await service.ask(
    AskRequest.parse({ question, filters: global ? { state: "PA" } : {} }),
    {
      tenantId: "carrier-demo",
      userId: "evaluation",
      caseIds: ["*"],
      caseId: global ? undefined : DEMO_CASE,
      portfolioAccess: true,
      precedentAccess: true,
    },
  );
  const ids = result.packet.evidence.map((s) => s.evidenceId);
  const ranks = expected.map((id) => ids.indexOf(id) + 1);
  rows.push({
    question,
    intentCorrect: result.trace.intent === intent,
    recall: expected.length
      ? ranks.filter((r) => r > 0 && r <= 10).length / expected.length
      : null,
    mrr: expected.length
      ? 1 / (Math.min(...ranks.filter((r) => r > 0)) || Infinity)
      : null,
    coverage: result.answer.claims.length
      ? result.answer.claims.filter((c) => c.evidenceIds.length > 0).length /
        result.answer.claims.length
      : 1,
    precision: result.answer.claims.every((c) =>
      result.packet.evidence.some(
        (s) =>
          c.evidenceIds.includes(s.evidenceId) && s.excerpt.includes(c.claim),
      ),
    ),
    status: result.answer.status,
    firstResultMs: result.trace.firstResultMs,
    completedMs: result.trace.completedMs,
  });
}
const average = (v: number[]) => v.reduce((a, b) => a + b, 0) / (v.length || 1);
const median = (v: number[]) =>
  v.sort((a, b) => a - b)[Math.floor(v.length / 2)];
console.log(
  JSON.stringify(
    {
      mode: "deterministic-fixtures",
      questions: rows.length,
      intentAccuracy: average(rows.map((r) => Number(r.intentCorrect))),
      recallAt10: average(
        rows.flatMap((r) => (r.recall === null ? [] : [r.recall])),
      ),
      mrr: average(rows.flatMap((r) => (r.mrr === null ? [] : [r.mrr]))),
      citationPrecision: average(rows.map((r) => Number(r.precision))),
      claimCoverage: average(rows.map((r) => r.coverage)),
      insufficiencyCorrect: rows[1]!.status === "NOT_ENOUGH_EVIDENCE",
      medianFirstResultMs: median(rows.map((r) => r.firstResultMs)),
      medianCompletedMs: median(rows.map((r) => r.completedMs)),
      rows,
    },
    null,
    2,
  ),
);
if (
  rows.some(
    (r) =>
      !r.intentCorrect || !r.precision || (r.recall !== null && r.recall < 1),
  ) ||
  rows[1]!.status !== "NOT_ENOUGH_EVIDENCE"
)
  process.exitCode = 1;
