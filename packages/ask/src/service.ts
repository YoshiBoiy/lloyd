import { fiveYearLoss } from "../../engine/src/index.js";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { DomainError, assertSanitizedText } from "../../contracts/src/index.js";
import {
  CaseStore,
  EvidenceStore,
  embed,
  type Chunk,
  type CaseRecord,
} from "../../integrations/src/data.js";
import {
  type Scope,
  type AskRequest,
  type Plan,
  type Document,
  type Source,
  type Precedent,
  type AnswerEvidencePacket,
  type AskLloydResponse,
  type Trace,
  type Claim,
  type ExploreGraph,
} from "./contracts.js";
import {
  compilePlan,
  routeQuestion,
  authorizeCase,
  type AskModels,
} from "./planner.js";
import {
  centroid,
  cosine,
  fitProjection,
  graph,
  needsRebuild,
  type Projection,
} from "./projection.js";
import { matchesFilters, riskProfile } from "./risk.js";
export function documentId(c: Chunk) {
  return c.documentId ?? c.sourceUri;
}
export function collapse(
  rows: Array<{ chunk: Chunk; score: number }>,
  now = Date.now(),
  limit = 10,
): Document[] {
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const id = documentId(row.chunk);
    grouped.set(id, [...(grouped.get(id) ?? []), row]);
  }
  return [...grouped.entries()]
    .map(([id, rs]) => {
      rs.sort((a, b) => b.score - a.score);
      const c = rs[0]!.chunk,
        reliability = c.reliability ?? 0.5;
      const freshness = Math.max(
        0,
        1 - (now - Date.parse(c.observedAt)) / (365 * 86400000),
      );
      const passages = rs.slice(0, 3).map(({ chunk: x }): Source => ({
        evidenceId: x.evidenceId,
        documentId: id,
        caseId: x.caseId,
        label: x.title ?? x.sourceField,
        page: x.page,
        boundingBox: x.boundingBox,
        sourceUri: x.sourceUri,
        sourceField: x.sourceField,
        excerpt: x.text.slice(0, 1000),
        sourceType: x.sourceType ?? "document",
        verificationStatus: x.verificationStatus ?? "UNVERIFIED",
        reliability: x.reliability ?? 0.5,
        observedAt: x.observedAt,
      }));
      return {
        id,
        caseId: c.caseId,
        title: c.title ?? c.sourceField,
        sourceType: c.sourceType ?? "document",
        score:
          rs[0]!.score +
          0.15 * Math.min(1, rs.length / 3) +
          0.1 * reliability +
          0.05 * freshness,
        vector: centroid(
          rs.map((r) => r.chunk.vector),
          rs.map((r) => r.chunk.importance ?? 1),
        ),
        passages,
        verificationStatus: c.verificationStatus ?? "UNVERIFIED",
        reliability,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
/** Conservative semantic gate: exact source statements only; keyword overlap is never support. */
export function citationGate(raw: unknown, sources: Source[]) {
  const parsed = z
    .object({
      claims: z
        .array(
          z
            .object({
              claim: z.string().min(1).max(1200),
              evidenceIds: z.array(z.string()).min(1).max(8),
            })
            .strict(),
        )
        .max(20),
    })
    .strict()
    .safeParse(raw);
  if (!parsed.success) return { claims: [] as Claim[], rejected: true };
  const claims = parsed.data.claims.filter(
    (c) =>
      c.evidenceIds.every((id) => sources.some((s) => s.evidenceId === id)) &&
      c.evidenceIds.every((id) =>
        sources.some((s) => s.evidenceId === id && s.excerpt.includes(c.claim)),
      ),
  );
  return { claims, rejected: claims.length !== parsed.data.claims.length };
}
export type EventSink = (event: string, data: unknown) => void;
export interface AskResult {
  answer: AskLloydResponse;
  trace: Trace;
  graphs: { evidence: ExploreGraph; precedents: ExploreGraph };
  packet: AnswerEvidencePacket;
  documents: Document[];
}
export class AskService {
  constructor(
    readonly cases: CaseStore,
    readonly evidence: EvidenceStore,
    readonly models?: AskModels,
    readonly timeoutMs = 8000,
  ) {}
  private scopeKey(scope: Scope, mode: string) {
    return createHash("sha256")
      .update(
        JSON.stringify([
          scope.tenantId,
          [...scope.caseIds].sort(),
          scope.caseId ?? "",
          mode,
        ]),
      )
      .digest("hex");
  }
  async authorizedCases(scope: Scope) {
    return this.cases.scopedCases(scope.tenantId, scope.caseIds);
  }
  async current(scope: Scope) {
    if (!scope.caseId) return undefined;
    authorizeCase(scope, scope.caseId);
    const c = await this.cases.get(scope.caseId);
    if (!c) throw new DomainError("NOT_FOUND", "Case not found", 404);
    if (
      (c.tenantId ?? (c.mode === "fixture" ? "carrier-demo" : undefined)) !==
      scope.tenantId
    )
      throw new DomainError(
        "FORBIDDEN",
        "Case is outside the authorized tenant",
        403,
      );
    return c;
  }
  async projection(
    scope: Scope,
    mode: "evidence" | "precedents",
    vectors: number[][],
    rebuild = false,
  ) {
    const key = this.scopeKey(scope, mode);
    let p = await this.cases.getExtra<Projection>("ask_projections", key);
    if (!p || rebuild) {
      p = fitProjection(vectors, mode === "evidence" ? 32 : 8, mode);
      await this.cases.saveExtra("ask_projections", key, p);
      await this.cases.saveExtra(
        "ask_projection_versions",
        `${key}:${p.version}`,
        p,
      );
    } else if (needsRebuild(p, vectors))
      await this.cases.saveExtra("ask_projection_rebuilds", key, {
        scope,
        mode,
        requestedAt: new Date().toISOString(),
      });
    return p;
  }
  async getProjection(scope: Scope, mode: string, version: string) {
    return this.cases.getExtra<Projection>(
      "ask_projection_versions",
      `${this.scopeKey(scope, mode)}:${version}`,
    );
  }
  async ask(
    request: AskRequest,
    scope: Scope,
    emit: EventSink = () => {},
  ): Promise<AskResult> {
    assertSanitizedText(request.question);
    if (
      /latency|throughput|operational metrics|average duration/i.test(
        request.question,
      )
    )
      throw new DomainError(
        "USE_ANALYTICS",
        "Operational metrics are available on the Investigation Analytics screen.",
        400,
      );
    if (scope.caseId) authorizeCase(scope, scope.caseId);
    if (!scope.caseId && !Object.keys(request.filters).length)
      throw new DomainError(
        "NARROW_SCOPE",
        "Choose a case or explicit portfolio filters",
        400,
      );
    const started = Date.now(),
      controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("TIMEOUT"));
      }, this.timeoutMs);
    });
    // Every asynchronous optional dependency is bounded by the same question deadline.
    const bounded = <T>(p: Promise<T>) => Promise.race([p, deadline]);
    const warnings: string[] = [],
      sources: Source[] = [],
      facts: AnswerEvidencePacket["caseFacts"] = [],
      precedents: Precedent[] = [],
      documents: Document[] = [];
    const retrieved: Array<{ chunk: Chunk; score: number }> = [];
    let current: CaseRecord | undefined,
      firstResult = 0;
    const trace: Trace = {
      id: randomUUID(),
      intent: "",
      effectiveScope: { tenantId: scope.tenantId, caseId: scope.caseId },
      planner: "deterministic-v1",
      steps: [],
      warnings,
      firstResultMs: 0,
      completedMs: 0,
      modelVersion: this.models?.version ?? "extractive-v1",
      promptVersion: "ask-grounded-v1",
      retrievalIds: [],
    };
    let plan: Plan;
    try {
      plan = routeQuestion(request, scope);
      if (this.models?.plan) {
        try {
          const raw = await bounded(
            this.models.plan(request, scope, controller.signal),
          );
          plan = compilePlan(raw, scope);
          trace.planner = this.models.version;
        } catch (e) {
          if (e instanceof DomainError && e.status === 403) throw e;
          warnings.push(
            "PLANNER_UNAVAILABLE_OR_INVALID: deterministic routing",
          );
        }
      }
      trace.intent = plan.intent;
      emit("intent", {
        intent: plan.intent,
        effectiveScope: trace.effectiveScope,
        planner: trace.planner,
      });
      const addCase = (c: CaseRecord) => {
        for (const criterion of c.decision.criteria) {
          const fact = c.facts[criterion.key];
          const factId = `case:${c.id}:v${c.version}:${criterion.key}`;
          const excerpt = `${criterion.key}: ${JSON.stringify(criterion.observed)}; ${criterion.status}. ${criterion.explanation}. Sources: ${[...new Set(fact?.evidence.map((e) => e.source) ?? [])].join(", ") || "not recorded"}`;
          assertSanitizedText(excerpt);
          sources.push({
            evidenceId: factId,
            caseId: c.id,
            label: `${criterion.key} · case v${c.version}`,
            excerpt,
            sourceType: "canonical_fact",
            verificationStatus: criterion.status,
            reliability: 1,
            observedAt: c.updatedAt,
          });
          facts.push({
            factId,
            name: criterion.key,
            value: criterion.observed,
            status: criterion.status,
            evidenceIds: [factId, ...(fact?.evidence.map((e) => e.id) ?? [])],
          });
        }
        const excerpt = `Recorded decision: ${c.decision.class}. Completeness: ${c.decision.completenessScore}. Confidence: ${c.decision.confidence}.`;
        sources.push({
          evidenceId: `case:${c.id}:v${c.version}:decision`,
          caseId: c.id,
          label: "Recorded decision",
          excerpt,
          sourceType: "canonical_case",
          verificationStatus: "RECORDED",
          reliability: 1,
          observedAt: c.updatedAt,
        });
      };
      for (const step of plan.steps) {
        const at = Date.now();
        emit("retrieval_started", {
          operation: step.operation,
          filters: step.filters,
        });
        let count = 0,
          status = "AVAILABLE";
        try {
          if (
            ["GET_CASE", "FIND_PRECEDENTS", "COMPARE_CASES"].includes(
              step.operation,
            )
          )
            current ??= await bounded(this.current(scope));
          if (step.operation === "GET_CASE" && current) {
            addCase(current);
            count = facts.length;
          }
          if (
            [
              "SEARCH_EVIDENCE",
              "SEARCH_GUIDELINES",
              "GET_DECISION_EVIDENCE",
            ].includes(step.operation)
          ) {
            const ids = scope.caseId
              ? [scope.caseId]
              : (await bounded(this.authorizedCases(scope)))
                  .filter((c) => matchesFilters(c, request.filters))
                  .map((c) => c.id)
                  .slice(0, 20);
            const results = [
              await bounded(
                this.evidence.search(ids, step.query ?? request.question, {
                  tenantId: scope.tenantId,
                  after: step.filters.after,
                  before: step.filters.before,
                  sourceTypes:
                    step.operation === "SEARCH_GUIDELINES"
                      ? ["guideline"]
                      : step.filters.sourceTypes,
                  limit: step.limit,
                }),
              ),
            ];
            if (results.some((r) => r.status === "UNAVAILABLE")) {
              status = "UNAVAILABLE";
              warnings.push("ELASTICSEARCH_UNAVAILABLE");
            }
            let rows = results
              .flatMap((r) => r.results)
              .sort((a, b) => b.score - a.score)
              .slice(0, step.limit);
            const references = [
              ...request.question.matchAll(/\[source: ([^\]]+)\]/g),
            ].map((m) => m[1]!);
            if (references.length || request.pinnedNodeIds.length) {
              const selected = (
                await bounded(this.evidence.corpus(scope.tenantId, ids))
              )
                .filter(
                  (c) =>
                    references.includes(c.evidenceId) ||
                    request.pinnedNodeIds.includes(documentId(c)),
                )
                .map((chunk) => ({ chunk, score: 1 }));
              rows = [
                ...new Map(
                  [...selected, ...rows].map((r) => [r.chunk.evidenceId, r]),
                ).values(),
              ].slice(0, step.limit);
            }
            const safe = rows.filter(
              (r) =>
                r.chunk.tenantId === scope.tenantId &&
                ids.includes(r.chunk.caseId),
            );
            if (safe.length !== rows.length) {
              warnings.push("SECURITY_RESULT_DROPPED");
              status = "PARTIAL";
            }
            for (const r of safe) assertSanitizedText(JSON.stringify(r.chunk));
            const meaningful =
              (step.query ?? request.question)
                .toLowerCase()
                .match(/[a-z0-9]+/g)
                ?.filter(
                  (t) =>
                    t.length > 2 &&
                    !new Set([
                      "what",
                      "which",
                      "where",
                      "when",
                      "why",
                      "how",
                      "the",
                      "this",
                      "that",
                      "these",
                      "those",
                      "for",
                      "and",
                      "are",
                      "was",
                      "has",
                      "have",
                      "with",
                      "from",
                      "can",
                      "you",
                      "show",
                      "find",
                      "evidence",
                      "documents",
                      "document",
                      "supporting",
                      "case",
                      "does",
                      "still",
                      "under",
                      "investigation",
                    ]).has(t),
                ) ?? [];
            const relevant = safe.filter(
              (r) =>
                step.operation === "GET_DECISION_EVIDENCE" ||
                references.includes(r.chunk.evidenceId) ||
                request.pinnedNodeIds.includes(documentId(r.chunk)) ||
                meaningful.some((t) =>
                  new RegExp(`\\b${t}\\b`, "i").test(
                    `${r.chunk.title ?? ""} ${r.chunk.text}`,
                  ),
                ) ||
                cosine(embed(meaningful.join(" ")), r.chunk.vector) > 0.65,
            );
            retrieved.push(...relevant);
            const docs = collapse([
              ...new Map(
                retrieved.map((r) => [r.chunk.evidenceId, r]),
              ).values(),
            ]);
            documents.splice(0, documents.length, ...docs);
            for (let i = sources.length - 1; i >= 0; i--)
              if (sources[i]!.documentId) sources.splice(i, 1);
            sources.push(...docs.flatMap((d) => d.passages));
            count = relevant.length;
          }
          if (step.operation === "FILTER_CASES") {
            const cases = (await bounded(this.authorizedCases(scope)))
              .filter((c) => matchesFilters(c, step.filters))
              .slice(0, step.limit);
            for (const c of cases) addCase(c);
            count = cases.length;
          }
          if (
            ["FIND_PRECEDENTS", "COMPARE_CASES"].includes(step.operation) &&
            current
          ) {
            const risk = riskProfile(current);
            if (risk.missingDimensions.length === 8)
              throw new Error("Risk profile unavailable");
            const rows = await bounded(
              this.cases.riskPrecedents(scope.tenantId, scope.caseIds, current),
            );
            const latest = new Map<string, CaseRecord>();
            for (const c of rows) {
              if (c.id === current.id) continue;
              authorizeCase(scope, c.id);
              if (
                (c.tenantId ??
                  (c.mode === "fixture" ? "carrier-demo" : undefined)) !==
                scope.tenantId
              ) {
                warnings.push("SECURITY_RESULT_DROPPED");
                continue;
              }
              if (!latest.has(c.id) || latest.get(c.id)!.version < c.version)
                latest.set(c.id, c);
            }
            const ranked = [...latest.values()]
              .filter(
                (c) =>
                  matchesFilters(c, step.filters) &&
                  (!/acceptable construction/i.test(step.query ?? "") ||
                    c.decision.criteria.some(
                      (x) =>
                        x.key === "construction" &&
                        ["TARGET", "ACCEPTABLE"].includes(x.status),
                    )) &&
                  (!/lower losses/i.test(step.query ?? "") ||
                    (fiveYearLoss(
                      c.facts.losses?.value,
                      c.facts.effectiveDate?.value,
                    ) ?? Infinity) <
                      (fiveYearLoss(
                        current!.facts.losses?.value,
                        current!.facts.effectiveDate?.value,
                      ) ?? -Infinity)) &&
                  (!step.caseIds?.length || step.caseIds.includes(c.id)),
              )
              .map((c) => ({ c, r: riskProfile(c) }))
              .sort(
                (a, b) =>
                  cosine(risk.vector, b.r.vector) -
                  cosine(risk.vector, a.r.vector),
              )
              .slice(0, step.limit);
            for (const { c, r } of ranked) {
              const shared = current.decision.criteria
                .filter(
                  (f) =>
                    f.observed != null &&
                    c.decision.criteria.some(
                      (o) =>
                        o.key === f.key &&
                        JSON.stringify(o.observed) ===
                          JSON.stringify(f.observed),
                    ),
                )
                .map((f) => f.key);
              const differences = current.decision.criteria
                .filter((f) => !shared.includes(f.key))
                .map((f) => f.key);
              const evidenceId = `precedent:${c.id}:v${c.version}`;
              const rationale = (
                c.humanApproved && c.approvedRationale?.length
                  ? c.approvedRationale.map((r) => r.text).join(" ")
                  : c.decision.criteria
                      .map((x) => `${x.key}: ${x.explanation}`)
                      .join(" ")
              ).slice(0, 600);
              const excerpt = `Recorded decision: ${c.decision.class}. Shared factors: ${shared.join(", ") || "none established"}. Material differences: ${differences.join(", ") || "none established"}. ${rationale}`;
              assertSanitizedText(excerpt);
              sources.push({
                evidenceId,
                caseId: c.id,
                label: `${c.id} · v${c.version}`,
                excerpt,
                sourceType: "precedent",
                verificationStatus: c.humanApproved
                  ? "HUMAN_APPROVED"
                  : "UNAPPROVED",
                reliability: 1,
                observedAt: c.updatedAt,
              });
              precedents.push({
                caseId: c.id,
                caseVersion: c.version,
                similarity: cosine(risk.vector, r.vector),
                sharedFactors: shared,
                materialDifferences: differences,
                decision: c.decision.class,
                decisionDate: c.updatedAt,
                humanApproved: !!c.humanApproved,
                rationaleEvidenceIds: [evidenceId],
                missingDimensions: r.missingDimensions,
                vector: r.vector,
              });
            }
            count = precedents.length;
          }
        } catch (e) {
          if (e instanceof DomainError && e.status === 403) throw e;
          status = "UNAVAILABLE";
          warnings.push(`${step.operation}_UNAVAILABLE`);
        }
        trace.steps.push({
          operation: step.operation,
          purpose: plan.intent,
          filters: step.filters,
          count,
          durationMs: Date.now() - at,
          status,
        });
        if (count && !firstResult) firstResult = Date.now() - started;
        emit("retrieval_results", {
          operation: step.operation,
          count,
          status,
          documents: documents.map((d) => ({
            id: d.id,
            title: d.title,
            score: d.score,
          })),
          precedents: precedents.map((p) => ({
            caseId: p.caseId,
            similarity: p.similarity,
          })),
        });
      }
      // Connect canonical fact citations to their retrieved source document when provenance resolves.
      for (const source of sources.filter(
        (s) => s.sourceType === "canonical_fact",
      )) {
        const fact = facts.find((f) => f.factId === source.evidenceId);
        const document = documents.find(
          (d) =>
            d.caseId === source.caseId &&
            d.passages.some((p) => fact?.evidenceIds.includes(p.evidenceId)),
        );
        if (document) source.documentId = document.id;
      }
      documents.sort(
        (a, b) =>
          Number(request.pinnedNodeIds.includes(b.id)) -
            Number(request.pinnedNodeIds.includes(a.id)) || b.score - a.score,
      );
      const packet: AnswerEvidencePacket = {
        question: request.question,
        effectiveScope: trace.effectiveScope,
        caseFacts: facts,
        evidence: sources,
        precedents,
      };
      assertSanitizedText(JSON.stringify(packet));
      const requestedFact = /construction|percentage/.test(
        request.question.toLowerCase(),
      )
        ? "construction"
        : /building year/.test(request.question.toLowerCase())
          ? "buildingYear"
          : undefined;
      const missing =
        !!requestedFact &&
        facts.some(
          (f) =>
            f.name === requestedFact &&
            ["UNKNOWN", "CONTRADICTED"].includes(f.status),
        );
      let gate = citationGate(
        {
          claims: sources
            .slice(0, 12)
            .map((s) => ({ claim: s.excerpt, evidenceIds: [s.evidenceId] })),
        },
        sources,
      );
      if (this.models?.answer) {
        try {
          gate = citationGate(
            await bounded(this.models.answer(packet, controller.signal)),
            sources,
          );
          if (gate.rejected)
            gate = citationGate(
              await bounded(
                this.models.answer(packet, controller.signal, {
                  instruction:
                    "Remove unsupported claims. Use only exact source excerpts.",
                }),
              ),
              sources,
            );
        } catch {
          warnings.push("ANSWER_MODEL_UNAVAILABLE: showing ranked sources");
          gate = { claims: [], rejected: false };
        }
      }
      if (gate.rejected)
        warnings.push("CITATION_GATE_REJECTED_UNSUPPORTED_CLAIMS");
      const claims = missing ? [] : gate.claims;
      const citations = sources.filter((s) =>
        claims.some((c) => c.evidenceIds.includes(s.evidenceId)),
      );
      const answer: AskLloydResponse = {
        answerId: randomUUID(),
        status:
          missing || !sources.length
            ? "NOT_ENOUGH_EVIDENCE"
            : warnings.length || gate.rejected || !claims.length
              ? "PARTIAL"
              : "ANSWERED",
        answerMarkdown: missing
          ? "The available evidence does not establish the requested fact. Request a TIV-weighted construction schedule or a verified building record."
          : claims.length
            ? claims.map((c) => c.claim).join("\n\n")
            : sources.length
              ? "Generated prose is unavailable. Review the ranked sources below."
              : "No supporting evidence was found. Narrow the question or provide verified source evidence.",
        claims,
        citations,
        focusNodes: [
          ...new Set(citations.map((c) => c.documentId ?? c.caseId)),
        ],
        suggestedQuestions: [
          "What evidence contradicts sprinkler coverage?",
          "Show similar accepted cases and explain how they resolved sprinkler uncertainty.",
          "What percentage of TIV is acceptable construction?",
        ],
        retrievalTraceId: trace.id,
      };
      const empty = (mode: "evidence" | "precedents"): ExploreGraph => ({
        mode,
        projectionVersion: "unavailable",
        nodes: [],
        edges: [],
        notice: "Projection unavailable. Use the ranked list.",
      });
      const graphs = {
        evidence: empty("evidence"),
        precedents: empty("precedents"),
      };
      try {
        const corpus = await bounded(
          this.evidence.corpus(
            scope.tenantId,
            scope.caseId ? [scope.caseId] : scope.caseIds,
          ),
        );
        const safeCorpus = corpus.filter(
          (c) =>
            c.tenantId === scope.tenantId &&
            (scope.caseId
              ? c.caseId === scope.caseId
              : scope.caseIds.includes("*") ||
                scope.caseIds.includes(c.caseId)),
        );
        const all = collapse(
          safeCorpus.map((chunk) => ({ chunk, score: 0 })),
          Date.now(),
          1000,
        );
        // Centroids use the corpus, never only the question's matching chunks.
        const vectors = new Map(all.map((d) => [d.id, d.vector]));
        for (const d of documents) d.vector = vectors.get(d.id) ?? d.vector;
        const ep = await bounded(
          this.projection(
            scope,
            "evidence",
            all.map((d) => d.vector),
          ),
        );
        graphs.evidence = graph(
          "evidence",
          ep,
          documents.map((d) => ({
            id: d.id,
            label: d.title,
            type: d.sourceType,
            vector: d.vector,
            relevance: d.score,
            cited: answer.focusNodes.includes(d.id),
            metadataPreview: {
              verificationStatus: d.verificationStatus,
              reliability: d.reliability,
            },
          })),
          { id: "query:anchor", vector: embed(request.question) },
        );
      } catch {
        warnings.push("EVIDENCE_PROJECTION_UNAVAILABLE");
      }
      if (scope.precedentAccess && scope.caseId)
        try {
          current ??= await bounded(this.current(scope));
          const rows = await bounded(this.authorizedCases(scope));
          const pp = await bounded(
            this.projection(
              scope,
              "precedents",
              rows.map((c) => riskProfile(c).vector),
            ),
          );
          graphs.precedents = graph(
            "precedents",
            pp,
            precedents.map((p) => ({
              id: p.caseId,
              label: p.caseId,
              type: p.decision,
              vector: p.vector,
              relevance: p.similarity,
              cited: p.humanApproved,
              metadataPreview: {
                humanApproved: p.humanApproved,
                caseVersion: p.caseVersion,
                missingDimensions: p.missingDimensions.join(", "),
              },
            })),
            current
              ? { id: current.id, vector: riskProfile(current).vector }
              : undefined,
          );
        } catch {
          warnings.push("PRECEDENT_PROJECTION_UNAVAILABLE");
        }
      if (warnings.length && answer.status === "ANSWERED")
        answer.status = "PARTIAL";
      trace.firstResultMs = firstResult;
      trace.completedMs = Date.now() - started;
      trace.retrievalIds = sources.map((s) => s.evidenceId);
      emit("answer_delta", { text: answer.answerMarkdown });
      emit("citations", answer.citations);
      emit("map_focus", { focusNodes: answer.focusNodes, graphs });
      const result = { answer, trace, graphs, packet, documents };
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}
