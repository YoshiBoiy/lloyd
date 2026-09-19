import Fastify from "fastify";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  DomainError,
  Destination,
  ReleaseManifest,
  approvalMessage,
  sha256,
  verifyIntake,
  type SanitizedIntake,
} from "../../../packages/contracts/src/index.js";
import {
  Facts,
  evaluate,
  compareCases,
  pathToYes,
  simulate,
  type Fact,
} from "../../../packages/engine/src/index.js";
import { Federato } from "../../../packages/integrations/src/federato.js";
import {
  fixtureRows,
  fixtureSchema,
} from "../../../packages/integrations/src/fixtures.js";
import {
  CaseStore,
  EvidenceStore,
  Telemetry,
  type CaseRecord,
} from "../../../packages/integrations/src/data.js";
import { ModelServices } from "../../../packages/integrations/src/models.js";
import {
  OpenAIPlanner,
  Orchestrator,
  type Planner,
} from "../../../packages/integrations/src/agent.js";
import { type Query } from "../../../packages/integrations/src/schema.js";

const Mapping = z
  .object({
    schemaHash: z.string(),
    resource: z.string(),
    idPath: z.string(),
    paths: z.record(z.string()),
    confirmed: z.literal(true),
  })
  .strict();
export interface Config {
  apiToken?: string;
  approvalKey?: string;
  federato?: { id: string; secret: string };
  mapping?: z.infer<typeof Mapping>;
  mongoUri?: string;
  elasticUrl?: string;
  elasticKey?: string;
  tigerUrl?: string;
  telemetryKey?: string;
  openaiKey?: string;
  openaiModel?: string;
  geminiKey?: string;
  geminiModel?: string;
  gptzeroKey?: string;
  gptzeroUrl?: string;
  claimSupportUrl?: string;
  authenticityPolicy?: { version: string; reviewThreshold: number };
  destinations?: z.infer<typeof Destination>[];
}
export function createApp(
  config: Config = {},
  overrides: { federato?: Federato; store?: CaseStore; planner?: Planner } = {},
) {
  const app = Fastify({ logger: false, bodyLimit: 2_500_000 });
  const federato =
    overrides.federato ??
    new Federato(fixtureSchema, fixtureRows, config.federato);
  const store = overrides.store ?? new CaseStore(config.mongoUri),
    evidence = new EvidenceStore(config.elasticUrl, config.elasticKey),
    telemetry = new Telemetry(config.tigerUrl, config.telemetryKey);
  const models = new ModelServices(config);
  const agent = new Orchestrator(
    federato,
    store,
    evidence,
    models,
    overrides.planner ??
      (config.openaiKey && config.openaiModel
        ? new OpenAIPlanner(config.openaiKey, config.openaiModel)
        : undefined),
  );
  const allowed = config.destinations ?? [
    "lloyd-api",
    "gemini",
    "gptzero",
    "elasticsearch",
  ];
  let mapping: z.infer<typeof Mapping> | undefined;
  let bootstrapped = false;
  const documents = new Map<
    string,
    { intake: SanitizedIntake; approved: boolean }
  >();
  // Serialize mutations in this single-process hackathon deployment so versions are monotonic.
  let lock = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = lock.then(fn);
    lock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  app.addHook("onRequest", async (req, reply) => {
    if (
      config.apiToken &&
      req.headers.authorization !== `Bearer ${config.apiToken}`
    )
      return reply.code(401).send({
        error: { code: "UNAUTHORIZED", message: "Authentication required" },
      });
  });
  app.setErrorHandler((error, _request, reply) => {
    const status =
      error instanceof z.ZodError
        ? 400
        : error instanceof DomainError
          ? error.status
          : 500;
    reply.code(status).send({
      error: {
        code:
          error instanceof z.ZodError
            ? "INVALID_REQUEST"
            : error instanceof DomainError
              ? error.code
              : "INTERNAL_ERROR",
        message:
          error instanceof DomainError
            ? error.message
            : status === 400
              ? "Request does not match the contract"
              : "Operation failed; no sensitive details were logged",
      },
    });
  });
  app.addHook("onClose", async () => {
    await store.close();
    await telemetry.close();
  });
  async function bootstrap() {
    const graph = await federato.getSchema(true);
    if (federato.mode === "fixture")
      mapping = {
        schemaHash: graph.hash,
        resource: "DemoSubmission",
        idPath: "id",
        paths: Object.fromEntries(Object.keys(Facts.shape).map((k) => [k, k])),
        confirmed: true,
      };
    else if (config.mapping) {
      mapping = Mapping.parse(config.mapping);
      if (mapping.schemaHash !== graph.hash)
        throw new DomainError(
          "MAPPING_STALE",
          "Confirm mappings against the current schema hash",
          409,
        );
      graph.path(mapping.resource, mapping.idPath);
      for (const [concept, path] of Object.entries(mapping.paths)) {
        if (!Object.hasOwn(Facts.shape, concept))
          throw new DomainError(
            "INVALID_MAPPING",
            "Unknown normalized concept",
          );
        graph.path(mapping.resource, path);
      }
    }
    await store.init();
    let searchStatus = "AVAILABLE";
    try {
      await evidence.init();
    } catch {
      searchStatus = "UNAVAILABLE";
    }
    bootstrapped = true;
    return {
      status: "ready",
      mode: federato.mode,
      schemaHash: graph.hash,
      resources: Object.keys(graph.schema.resources),
      mappings: mapping ?? null,
      unresolvedMappings: mapping ? [] : Object.keys(Facts.shape),
      services: {
        atlas: store.mode,
        elastic: searchStatus,
        planner: config.openaiKey && config.openaiModel ? "live" : "scripted",
      },
    };
  }
  async function ready() {
    if (!bootstrapped) await bootstrap();
    if (!mapping)
      throw new DomainError(
        "MAPPING_REQUIRED",
        "Inspect schema and configure confirmed, schema-hash-bound concept mappings",
        409,
      );
    return mapping;
  }
  async function getCase(id: string) {
    const c = await store.get(id);
    if (!c) throw new DomainError("NOT_FOUND", "Case not found", 404);
    return c;
  }
  function queryFor(
    m: z.infer<typeof Mapping>,
    offset = 0,
    id?: string,
  ): Query {
    return {
      resource: m.resource,
      select: { id: m.idPath, ...m.paths },
      where: id ? { [m.idPath]: id } : undefined,
      expand: [],
      unwind: [],
      pagination: { offset, limit: id ? 1 : 25 },
    };
  }
  function normalize(
    row: Record<string, unknown>,
    id: string,
    now: string,
  ): z.infer<typeof Facts> {
    const result: Record<string, Fact> = {};
    for (const key of Object.keys(Facts.shape))
      if (Object.hasOwn(row, key))
        result[key] = {
          value: row[key],
          contradicted: false,
          evidence: [
            {
              id: `${id}:${key}`,
              source: federato.mode === "fixture" ? "fixture" : "federato",
              path: mapping?.paths[key] ?? key,
              observedAt: now,
              verified: true,
            },
          ],
        };
    if (
      !result.tiv &&
      result.construction &&
      Array.isArray(result.construction.value)
    ) {
      const buildings = result.construction.value as Record<string, unknown>[];
      if (
        buildings.length &&
        buildings.every(
          (b) =>
            typeof b.tiv === "number" && b.tiv >= 0 && Number.isFinite(b.tiv),
        )
      )
        result.tiv = {
          ...result.construction,
          value: buildings.reduce((n, b) => n + (b.tiv as number), 0),
        };
    }
    return Facts.parse(result);
  }
  app.get("/health", async () => ({ status: "ok", mode: federato.mode }));
  app.post("/api/bootstrap", () => exclusive(bootstrap));
  app.get("/api/schema/mappings", async () => {
    const graph = await federato.getSchema();
    return {
      schemaHash: graph.hash,
      schema: graph.schema,
      mappings: mapping ?? null,
      candidates: Object.fromEntries(
        Object.keys(Facts.shape).map((k) => [k, graph.candidatePaths(k)]),
      ),
    };
  });
  app.post("/api/ingest", () =>
    exclusive(async () => {
      const m = await ready();
      let offset = 0,
        total = 0,
        created = 0,
        updated = 0,
        unchanged = 0;
      const warnings: string[] = [];
      do {
        let page;
        try {
          page = await federato.runQuery(queryFor(m, offset), m.schemaHash);
        } catch (e) {
          if (!offset) throw e;
          warnings.push("PARTIAL_PAGINATION_FAILURE");
          break;
        }
        total = page.total;
        if (!page.records.length) {
          if (offset < total) warnings.push("INCOMPLETE_PAGE");
          break;
        }
        for (const row of page.records) {
          const id = z.string().min(1).max(100).parse(row.id),
            sourceHash = sha256(JSON.stringify(row)),
            old = await store.get(id);
          if (old?.sourceHash === sourceHash) {
            unchanged++;
            continue;
          }
          const now = new Date().toISOString(),
            facts = normalize(row, id, now),
            decision = evaluate(facts);
          const record: CaseRecord = {
            id,
            version: (old?.version ?? 0) + 1,
            schemaHash: m.schemaHash,
            mode: federato.mode,
            facts,
            decision,
            updatedAt: now,
            sourceHash,
          };
          await store.put(record);
          try {
            await store.saveVector(record);
          } catch {
            warnings.push("PRECEDENT_INDEX_UNAVAILABLE");
          }
          for (const c of decision.criteria) {
            const text = `${c.key}: ${JSON.stringify(c.observed)}; ${c.status}`;
            try {
              await evidence.add({
                evidenceId: `${id}:${c.key}`,
                caseId: id,
                text,
                sourceUri: `${federato.mode}://${m.resource}/${encodeURIComponent(id)}`,
                sourceField: m.paths[c.key] ?? c.key,
                observedAt: now,
                contentHash: sha256(text),
                vector: (
                  await import("../../../packages/integrations/src/data.js")
                ).embed(text),
              });
            } catch {
              warnings.push("EVIDENCE_INDEX_UNAVAILABLE");
            }
          }
          if (old) updated++;
          else created++;
          await telemetry.emit(id, "ingested", "success", 0);
        }
        offset += page.records.length;
        if (offset > 10000) {
          warnings.push("INGEST_LIMIT");
          break;
        }
      } while (offset < total);
      return {
        status:
          warnings.includes("PARTIAL_PAGINATION_FAILURE") ||
          warnings.includes("INCOMPLETE_PAGE")
            ? "partial"
            : "complete",
        mode: federato.mode,
        total,
        processed: offset,
        created,
        updated,
        unchanged,
        warnings: [...new Set(warnings)],
      };
    }),
  );
  app.get("/api/cases", async (req) => {
    const q = z
      .object({
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        lane: z
          .enum(["IN_APPETITE", "INVESTIGATE", "OUT_OF_APPETITE"])
          .optional(),
      })
      .strict()
      .parse(req.query);
    const rows = (await store.list())
      .sort(compareCases)
      .filter((c) => !q.lane || c.decision.class === q.lane);
    return {
      items: rows.slice(q.offset, q.offset + q.limit).map((c) => ({
        id: c.id,
        version: c.version,
        account: { name: c.facts.accountName?.value ?? null },
        normalizedRisk: {
          primaryState: c.facts.primaryState?.value ?? null,
          tiv: c.facts.tiv?.value ?? null,
          premium: c.facts.premium?.value ?? null,
        },
        decision: c.decision,
        unresolvedQuestions: pathToYes(c.decision),
        mode: c.mode,
      })),
      total: rows.length,
      offset: q.offset,
      limit: q.limit,
    };
  });
  app.get<{ Params: { id: string } }>("/api/cases/:id", async (req) => {
    const c = await getCase(req.params.id);
    return { case: c, pathToYes: pathToYes(c.decision) };
  });
  app.post<{ Params: { id: string } }>(
    "/api/cases/:id/investigate",
    (req, reply) =>
      exclusive(async () => {
        const start = Date.now(),
          c = await getCase(req.params.id),
          m = await ready();
        const stream = req.headers.accept === "text/event-stream";
        if (stream) {
          reply.hijack();
          reply.raw.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
        }
        const emit = (event: string, data: unknown) => {
          if (stream && !reply.raw.destroyed)
            reply.raw.write(
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            );
        };
        try {
          const result = await agent.investigate(
            c,
            queryFor(m, 0, c.id),
            documents,
            (step) => emit("step", step),
          );
          await store.saveExtra("investigations", result.id, result);
          if (JSON.stringify(result.facts) !== JSON.stringify(c.facts))
            await store.put({
              ...c,
              facts: result.facts,
              decision: result.decision,
              version: c.version + 1,
              updatedAt: new Date().toISOString(),
            });
          await telemetry.emit(
            c.id,
            "investigated",
            "success",
            Date.now() - start,
          );
          if (stream) {
            emit("completed", { investigation: result });
            reply.raw.end();
            return;
          }
          return { investigation: result };
        } catch (error) {
          if (stream) {
            emit("error", { code: "INVESTIGATION_FAILED" });
            reply.raw.end();
            return;
          }
          throw error;
        }
      }),
  );
  app.get<{ Params: { id: string; investigationId: string } }>(
    "/api/cases/:id/investigations/:investigationId",
    async (req) => {
      const result = await store.getExtra<{ caseId: string }>(
        "investigations",
        req.params.investigationId,
      );
      if (!result || result.caseId !== req.params.id)
        throw new DomainError("NOT_FOUND", "Investigation not found", 404);
      return { investigation: result };
    },
  );
  app.post<{ Params: { id: string } }>("/api/cases/:id/simulate", (req) =>
    exclusive(async () => {
      const body = z
        .object({
          changes: z
            .record(z.unknown())
            .refine((c) =>
              Object.keys(c).every((k) => Object.hasOwn(Facts.shape, k)),
            ),
          conditions: z.array(z.string().max(200)).max(20).default([]),
        })
        .strict()
        .parse(req.body);
      const c = await getCase(req.params.id),
        result = {
          id: randomUUID(),
          caseId: c.id,
          baseVersion: c.version,
          createdAt: new Date().toISOString(),
          ...simulate(c.facts, body.changes, body.conditions),
        };
      await store.saveExtra("simulations", result.id, result);
      await telemetry.emit(c.id, "simulated", "success", 0);
      return { simulation: result };
    }),
  );
  app.post<{ Params: { id: string } }>(
    "/api/cases/:id/actions/draft-information-request",
    async (req) => {
      const c = await getCase(req.params.id);
      const action = {
        id: randomUUID(),
        caseId: c.id,
        type: "REQUEST_INFORMATION",
        status: "DRAFT",
        questions: pathToYes(c.decision).map((p) => p.description),
        createdAt: new Date().toISOString(),
      };
      await store.saveExtra("actions", action.id, action);
      return { action };
    },
  );
  async function intake(
    input: unknown,
    signature: string | string[] | undefined,
    caseId?: string,
  ) {
    // Approval signature binds document, artifact, confidence and approver. Never trust body approval alone.
    const parsed = z
      .object({ manifest: ReleaseManifest })
      .passthrough()
      .parse(input);
    const signed = approvalMessage(parsed.manifest);
    const expected = config.approvalKey
      ? createHmac("sha256", config.approvalKey).update(signed).digest("hex")
      : "";
    const trusted =
      typeof signature === "string" &&
      !!expected &&
      signature.length === expected.length &&
      timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    const data = verifyIntake(input, allowed, "lloyd-api", trusted);
    if (caseId && data.manifest.caseId !== caseId)
      throw new DomainError(
        "CASE_MISMATCH",
        "Document belongs to another case",
      );
    await getCase(data.manifest.caseId);
    const existing = await store.getExtra<SanitizedIntake["manifest"]>(
      "manifests",
      data.manifest.documentId,
    );
    if (existing && existing.sanitizedSha256 !== data.manifest.sanitizedSha256)
      throw new DomainError(
        "DOCUMENT_CONFLICT",
        "Document ID already has a different artifact",
        409,
      );
    documents.set(data.manifest.documentId, {
      intake: data,
      approved: trusted,
    });
    await store.saveExtra("manifests", data.manifest.documentId, data.manifest);
    const processing: Record<string, unknown> = {};
    if (data.manifest.destinations.includes("elasticsearch")) {
      try {
        await evidence.ingest(data, trusted);
        processing.elasticsearch = { status: "INDEXED" };
      } catch {
        processing.elasticsearch = { status: "UNAVAILABLE" };
      }
    }
    if (data.manifest.destinations.includes("gemini"))
      processing.gemini = await models.extract(data, trusted);
    if (data.manifest.destinations.includes("gptzero")) {
      const finding = await models.authorship(
        data,
        config.authenticityPolicy,
        trusted,
      );
      processing.gptzero = finding;
      if (
        config.authenticityPolicy &&
        finding.outcome === "AUTHENTICITY_REVIEW"
      ) {
        const current = await getCase(data.manifest.caseId);
        await store.put({
          ...current,
          version: current.version + 1,
          updatedAt: new Date().toISOString(),
          documentIntegrity: {
            policy: config.authenticityPolicy.version,
            status: "AUTHENTICITY_REVIEW",
            documentId: data.manifest.documentId,
          },
          decision: {
            ...current.decision,
            class:
              current.decision.class === "OUT_OF_APPETITE"
                ? "OUT_OF_APPETITE"
                : "INVESTIGATE",
          },
        });
      }
    }
    await store.saveExtra(
      "document_extractions",
      data.manifest.documentId,
      processing,
    );
    await telemetry.emit(data.manifest.caseId, "released", "success", 0);
    return {
      documentId: data.manifest.documentId,
      caseId: data.manifest.caseId,
      status: "ACCEPTED",
      sanitizedSha256: data.manifest.sanitizedSha256,
      processing,
    };
  }
  app.post("/api/intake/sanitized", (req) =>
    exclusive(() => intake(req.body, req.headers["x-release-approval"])),
  );
  app.post<{ Params: { id: string } }>("/api/cases/:id/documents", (req) =>
    exclusive(() =>
      intake(req.body, req.headers["x-release-approval"], req.params.id),
    ),
  );
  app.get<{ Params: { documentId: string } }>(
    "/api/intake/:documentId/manifest",
    async (req) => {
      const manifest = await store.getExtra("manifests", req.params.documentId);
      if (!manifest)
        throw new DomainError("NOT_FOUND", "Manifest not found", 404);
      return { manifest };
    },
  );
  app.get("/api/analytics/summary", async () => ({
    analytics: await telemetry.summary(),
  }));
  // Startup schema discovery is mandatory; ready() drives it even before the first request.
  app.addHook("onReady", async () => {
    await bootstrap();
  });
  return app;
}
