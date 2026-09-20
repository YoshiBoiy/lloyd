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
  Orchestrator,
  resolvePlanner,
  type Planner,
  type PlannerDescriptor,
} from "../../../packages/integrations/src/agent.js";
import {
  IntakeInbox,
  type IntakeRecord,
} from "../../../packages/integrations/src/intakes.js";
import {
  V2_LIMITS,
  canonicalV2,
  reviewerMayAccess,
  verifyV2,
  type DeviceBinding,
  type ReviewerBinding,
  type VerifiedV2,
} from "../../../packages/contracts/src/intake-v2.js";
import { type Query } from "../../../packages/integrations/src/schema.js";

const BuildingConstruction = z.enum([
  "joisted_masonry",
  "noncombustible",
  "steel",
  "masonry_noncombustible",
  "frame",
  "other",
]);
// `paths` covers concepts reachable as a single scalar (possibly through one
// hydrated reference hop, e.g. `insured.name`). Several appetite concepts
// cannot be a single path at all: they require expanding a one-to-many
// reference chain and aggregating client-side (TIV summed across buildings,
// construction weighted by TIV, controlling building year, five-year loss
// value derived from claims). `propertyExposure` and `claims` describe the
// raw nested structure to fetch for those concepts by field name, so the
// aggregation itself (packages/engine) stays schema-agnostic while this
// mapping stays fully swappable if the live schema's field names change.
const PropertyExposureMapping = z
  .object({
    // Dotted path from the resource to the one-to-many property exposure
    // reference (e.g. "exposure_units").
    path: z.string(),
    // Field on each exposure unit holding the one-to-one location reference.
    locationField: z.string(),
    // Field on the location holding its state code.
    stateField: z.string(),
    // Field on the location holding the one-to-many buildings reference.
    buildingsField: z.string(),
    tivField: z.string(),
    yearBuiltField: z.string(),
    constructionField: z.string(),
    // Raw construction_type string -> app's normalized construction bucket.
    // Anything absent maps to "other" (excluded from acceptable-construction
    // weighting, same as "frame").
    constructionMap: z.record(BuildingConstruction),
  })
  .strict();
const ClaimsMapping = z
  .object({
    // Dotted path from the resource to the one-to-many claims reference.
    path: z.string(),
    dateField: z.string(),
    // Loss amount is the sum of every listed numeric field per claim
    // (e.g. paid + reserve, indemnity + expense).
    amountFields: z.array(z.string()).min(1),
  })
  .strict();
const Mapping = z
  .object({
    schemaHash: z.string(),
    resource: z.string(),
    idPath: z.string(),
    paths: z.record(z.string()),
    // Raw source value -> normalized concept value, applied to `paths`
    // concepts after fetch (e.g. Federato's `business_type: "new"` becomes
    // the engine's `submissionType: "new_business"`).
    valueMaps: z.record(z.record(z.string())).optional(),
    propertyExposure: PropertyExposureMapping.optional(),
    claims: ClaimsMapping.optional(),
    confirmed: z.literal(true),
  })
  .strict();
// Synthetic select aliases carrying raw, un-aggregated nested substructures
// (never Facts concepts themselves) so normalize() can derive primaryState,
// buildingYear, construction, and tiv (via the existing construction-derived
// fallback below) client-side.
const PROPERTY_EXPOSURE_ALIAS = "__propertyExposure";
const CLAIMS_ALIAS = "__claims";
type PropertyExposureMappingT = NonNullable<
  z.infer<typeof Mapping>["propertyExposure"]
>;
type ClaimsMappingT = NonNullable<z.infer<typeof Mapping>["claims"]>;
function extractBuildings(
  raw: unknown,
  cfg: PropertyExposureMappingT,
): { tiv: number; construction: string; year: number | null }[] {
  const buildings: {
    tiv: number;
    construction: string;
    year: number | null;
  }[] = [];
  for (const unit of Array.isArray(raw) ? raw : []) {
    const location =
      unit && typeof unit === "object"
        ? (unit as Record<string, unknown>)[cfg.locationField]
        : undefined;
    const list =
      location && typeof location === "object"
        ? (location as Record<string, unknown>)[cfg.buildingsField]
        : undefined;
    for (const b of Array.isArray(list) ? list : []) {
      if (!b || typeof b !== "object") continue;
      const record = b as Record<string, unknown>;
      const tiv = record[cfg.tivField];
      if (typeof tiv !== "number" || !Number.isFinite(tiv) || tiv < 0) continue;
      const rawType = record[cfg.constructionField];
      const construction =
        typeof rawType === "string"
          ? (cfg.constructionMap[rawType] ?? "other")
          : "other";
      const rawYear = record[cfg.yearBuiltField];
      const year =
        typeof rawYear === "number" && Number.isInteger(rawYear)
          ? rawYear
          : null;
      buildings.push({ tiv, construction, year });
    }
  }
  return buildings;
}
// Primary state is not a verified single field on this dataset: a policy can
// insure locations across many states. Absent a documented rule, this
// attributes the primary state to whichever location carries the greatest
// aggregate building TIV (mirrors "construction weighted by TIV, not count"
// from the appetite assumptions), breaking ties by first-seen order.
function extractPrimaryState(
  raw: unknown,
  cfg: PropertyExposureMappingT,
): string | undefined {
  const totals = new Map<string, number>();
  for (const unit of Array.isArray(raw) ? raw : []) {
    const location =
      unit && typeof unit === "object"
        ? (unit as Record<string, unknown>)[cfg.locationField]
        : undefined;
    if (!location || typeof location !== "object") continue;
    const state = (location as Record<string, unknown>)[cfg.stateField];
    if (typeof state !== "string" || !state) continue;
    const list = (location as Record<string, unknown>)[cfg.buildingsField];
    const tiv = (Array.isArray(list) ? list : []).reduce((n: number, b) => {
      const v =
        b && typeof b === "object"
          ? (b as Record<string, unknown>)[cfg.tivField]
          : undefined;
      return n + (typeof v === "number" && Number.isFinite(v) ? v : 0);
    }, 0);
    if (!totals.has(state)) totals.set(state, 0);
    totals.set(state, totals.get(state)! + tiv);
  }
  let best: string | undefined,
    bestTiv = -1;
  for (const [state, tiv] of totals)
    if (tiv > bestTiv) {
      best = state;
      bestTiv = tiv;
    }
  return best;
}
function extractLosses(
  raw: unknown,
  cfg: ClaimsMappingT,
): { complete: true; items: { date: string; amount: number }[] } {
  const items: { date: string; amount: number }[] = [];
  for (const claim of Array.isArray(raw) ? raw : []) {
    if (!claim || typeof claim !== "object") continue;
    const record = claim as Record<string, unknown>;
    const date = record[cfg.dateField];
    if (typeof date !== "string") continue;
    const amount = cfg.amountFields.reduce((n, field) => {
      const v = record[field];
      return n + (typeof v === "number" && Number.isFinite(v) ? v : 0);
    }, 0);
    items.push({ date, amount });
  }
  return { complete: true, items };
}
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
  foundryProjectEndpoint?: string;
  foundryAgentId?: string;
  foundryApiKey?: string;
  foundryModel?: string;
  /** "openai" | "foundry" | "scripted"; unset resolves from credentials and labels the result. */
  plannerProvider?: string;
  /** Device and reviewer bindings for v2 releases. Absent means v2 intake is disabled. */
  v2Policy?: {
    devices: Record<string, DeviceBinding>;
    reviewers: Record<string, ReviewerBinding>;
  };
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
  const resolved = resolvePlanner(config);
  const plannerDescriptor: PlannerDescriptor = overrides.planner
    ? {
        provider: "scripted",
        status: "scripted",
        model: null,
        reason: "TEST_OVERRIDE",
      }
    : resolved.descriptor;
  const agent = new Orchestrator(
    federato,
    store,
    evidence,
    models,
    overrides.planner ?? resolved.planner,
  );
  const inbox = new IntakeInbox(store);
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
        // A path that reads through a hydrated reference (e.g. "insured.name")
        // is only legal once that reference is in the expand list; compute it
        // from the schema graph rather than requiring it in the mapping file.
        graph.path(
          mapping.resource,
          path,
          graph.requiredExpansions(mapping.resource, path),
        );
      }
      if (mapping.propertyExposure) {
        const pe = mapping.propertyExposure;
        const exposure = graph.path(mapping.resource, pe.path);
        if (exposure.type !== "reference" || !exposure.targetResource)
          throw new DomainError(
            "INVALID_MAPPING",
            "propertyExposure.path must be a reference",
          );
        const exposureFields =
          graph.schema.resources[exposure.targetResource]?.fields ?? {};
        const location = exposureFields[pe.locationField];
        if (
          !location ||
          location.type !== "reference" ||
          !location.targetResource
        )
          throw new DomainError(
            "INVALID_MAPPING",
            "propertyExposure.locationField must be a reference",
          );
        const locationFields =
          graph.schema.resources[location.targetResource]?.fields ?? {};
        if (locationFields[pe.stateField]?.type !== "string")
          throw new DomainError(
            "INVALID_MAPPING",
            "propertyExposure.stateField must be a string field",
          );
        const buildings = locationFields[pe.buildingsField];
        if (
          !buildings ||
          buildings.type !== "reference" ||
          !buildings.targetResource
        )
          throw new DomainError(
            "INVALID_MAPPING",
            "propertyExposure.buildingsField must be a reference",
          );
        const buildingFields =
          graph.schema.resources[buildings.targetResource]?.fields ?? {};
        for (const field of [
          pe.tivField,
          pe.yearBuiltField,
          pe.constructionField,
        ])
          if (!Object.hasOwn(buildingFields, field))
            throw new DomainError(
              "INVALID_MAPPING",
              `Unknown building field ${field}`,
            );
      }
      if (mapping.claims) {
        const cl = mapping.claims;
        const claims = graph.path(mapping.resource, cl.path);
        if (claims.type !== "reference" || !claims.targetResource)
          throw new DomainError(
            "INVALID_MAPPING",
            "claims.path must be a reference",
          );
        const claimFields =
          graph.schema.resources[claims.targetResource]?.fields ?? {};
        for (const field of [cl.dateField, ...cl.amountFields])
          if (!Object.hasOwn(claimFields, field))
            throw new DomainError(
              "INVALID_MAPPING",
              `Unknown claim field ${field}`,
            );
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
        planner: plannerDescriptor.status,
        plannerDetail: plannerDescriptor,
        intakeV2: config.v2Policy ? "ENABLED" : "DISABLED",
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
    const select: Record<string, string> = { id: m.idPath, ...m.paths };
    if (m.propertyExposure)
      select[PROPERTY_EXPOSURE_ALIAS] = m.propertyExposure.path;
    if (m.claims) select[CLAIMS_ALIAS] = m.claims.path;
    return {
      resource: m.resource,
      select,
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
    const evidence = (key: string, path: string) => [
      {
        id: `${id}:${key}`,
        source: (federato.mode === "fixture" ? "fixture" : "federato") as
          "fixture" | "federato",
        path,
        observedAt: now,
        verified: true,
      },
    ];
    for (const key of Object.keys(Facts.shape))
      if (Object.hasOwn(row, key)) {
        const path = mapping?.paths[key] ?? key;
        let value = row[key];
        const translated =
          typeof value === "string"
            ? mapping?.valueMaps?.[key]?.[value]
            : undefined;
        if (translated !== undefined) value = translated;
        result[key] = {
          value,
          contradicted: false,
          evidence: evidence(key, path),
        };
      }
    // Buildings/state/loss facts require expanding and aggregating a
    // one-to-many chain (buildings across property exposures, claims within
    // a loss window); see mapping.propertyExposure / mapping.claims.
    if (
      mapping?.propertyExposure &&
      Object.hasOwn(row, PROPERTY_EXPOSURE_ALIAS)
    ) {
      const pe = mapping.propertyExposure;
      const buildings = extractBuildings(row[PROPERTY_EXPOSURE_ALIAS], pe);
      const buildingsPath = `${pe.path}.${pe.locationField}.${pe.buildingsField}`;
      if (!result.construction && buildings.length)
        result.construction = {
          value: buildings.map((b) => ({
            tiv: b.tiv,
            construction: b.construction,
          })),
          contradicted: false,
          evidence: evidence(
            "construction",
            `${buildingsPath}.${pe.constructionField}`,
          ),
        };
      if (!result.buildingYear) {
        // Controlling building year is the oldest known year; a missing
        // year on any building makes the controlling year unknown.
        const years = buildings.map((b) => b.year);
        if (years.length && years.every((y): y is number => y !== null))
          result.buildingYear = {
            value: Math.min(...years),
            contradicted: false,
            evidence: evidence(
              "buildingYear",
              `${buildingsPath}.${pe.yearBuiltField}`,
            ),
          };
      }
      if (!result.primaryState) {
        const state = extractPrimaryState(row[PROPERTY_EXPOSURE_ALIAS], pe);
        if (state)
          result.primaryState = {
            value: state,
            contradicted: false,
            evidence: evidence(
              "primaryState",
              `${pe.path}.${pe.locationField}.${pe.stateField}`,
            ),
          };
      }
    }
    if (mapping?.claims && Object.hasOwn(row, CLAIMS_ALIAS) && !result.losses)
      result.losses = {
        value: extractLosses(row[CLAIMS_ALIAS], mapping.claims),
        contradicted: false,
        evidence: evidence(
          "losses",
          `${mapping.claims.path}.${mapping.claims.dateField}`,
        ),
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
          const id = z.coerce.string().min(1).max(100).parse(row.id),
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
        updatedAt: c.updatedAt,
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
    // A case can hold more than one scanned document; the bounded list travels with the case
    // so the workspace does not need a second round trip per case (workspace TDD §8.3).
    return {
      case: c,
      pathToYes: pathToYes(c.decision),
      documents: await inbox.documents(c.id),
    };
  });
  /**
   * Documents attached to a case, authorized identically to the case itself. Reviewers only
   * see documents on cases they may access.
   */
  app.get<{ Params: { id: string } }>(
    "/api/cases/:id/documents",
    async (req) => {
      const c = await getCase(req.params.id);
      if (config.v2Policy) {
        const reviewer = reviewerFrom(req);
        if (!reviewerMayAccess(reviewer.binding, c.id))
          throw new DomainError(
            "FORBIDDEN",
            "Reviewer is not authorized for this case",
            403,
          );
      }
      const documents = await inbox.documents(c.id);
      return { caseId: c.id, documents, total: documents.length };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/cases/:id/precedents",
    async (req) => {
      const c = await getCase(req.params.id);
      const result = await store.precedents(c);
      const names = Object.fromEntries(
        (await store.list()).map((row) => [
          row.id,
          String(row.facts.accountName?.value ?? row.id),
        ]),
      );
      return {
        status: result.status,
        matches: result.matches.map((match) => ({
          ...match,
          accountName: names[match.id] ?? match.id,
        })),
      };
    },
  );
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
  // --- Intake v2 (TDD §6, §7) -------------------------------------------------------------
  function v2Policy() {
    if (!config.v2Policy)
      throw new DomainError(
        "V2_NOT_CONFIGURED",
        "Release contract v2 is not enabled on this backend",
        503,
      );
    return { ...config.v2Policy, destinations: allowed };
  }
  function reviewerFrom(req: { headers: Record<string, unknown> }) {
    const policy = v2Policy();
    const id = req.headers["x-reviewer-id"];
    const binding = typeof id === "string" ? policy.reviewers[id] : undefined;
    if (!binding || typeof id !== "string")
      throw new DomainError(
        "REVIEWER_REQUIRED",
        "A known reviewer identity is required",
        403,
      );
    return { id, binding };
  }
  const caseExists = async (id: string) => !!(await store.get(id));
  async function processV2(
    record: IntakeRecord,
  ): Promise<Record<string, unknown>> {
    const caseId = record.association!.caseId;
    const verified: VerifiedV2 = {
      data: {
        manifest: record.manifest,
        artifacts: record.artifacts,
        authentication: record.authentication,
      },
      digest: record.digest,
      identity: record.identity,
    };
    const processing: Record<string, unknown> = {};
    const destinations = record.manifest.destinations;
    if (destinations.includes("elasticsearch"))
      try {
        processing.elasticsearch = {
          status: "INDEXED",
          ...(await evidence.ingestV2(verified, caseId)),
        };
      } catch {
        processing.elasticsearch = { status: "UNAVAILABLE" };
      }
    if (destinations.includes("gemini"))
      processing.gemini = await models.extractV2(verified);
    if (destinations.includes("gptzero")) {
      const text = record.artifacts.map((a) => a.text).join("\n");
      const finding = await models.authorshipText(
        text,
        { documentId: record.documentId, contentHash: record.digest },
        config.authenticityPolicy,
      );
      processing.gptzero = finding;
      if (
        config.authenticityPolicy &&
        finding.outcome === "AUTHENTICITY_REVIEW"
      ) {
        const current = await getCase(caseId);
        await store.put({
          ...current,
          version: current.version + 1,
          updatedAt: new Date().toISOString(),
          documentIntegrity: {
            policy: config.authenticityPolicy.version,
            status: "AUTHENTICITY_REVIEW",
            documentId: record.documentId,
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
    await telemetry.emit(caseId, "released", "success", 0);
    return processing;
  }
  const publicIntake = (r: IntakeRecord) => ({
    intakeId: r.intakeId,
    documentId: r.documentId,
    tenantId: r.tenantId,
    deviceId: r.deviceId,
    revision: r.revision,
    digest: r.digest,
    receivedAt: r.receivedAt,
    status: r.status,
    association: r.association,
    classification: r.manifest.classification,
    matchHints: r.manifest.matchHints,
    quality: r.manifest.quality,
    approval: r.manifest.approval,
    destinations: r.manifest.destinations,
    fields: r.manifest.fields,
    artifacts: r.artifacts,
    processing: r.processing,
    audit: r.audit,
    supersedes: r.supersedes ?? null,
  });
  const BoundedId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
  /**
   * Identity a refused envelope claims for itself. Nothing here is trusted: when the failure
   * is a signature or device rejection these are the attacker's own values, which is why the
   * persisted record marks them unverified. Only bounded metadata is read, never content.
   */
  function claimedIdentity(body: unknown) {
    const parsed = z
      .object({
        manifest: z
          .object({
            tenantId: BoundedId,
            deviceId: BoundedId,
            intakeId: BoundedId,
            revision: z.number().int().min(1).max(1_000_000),
          })
          .partial(),
      })
      .partial()
      .safeParse(body);
    const m = parsed.success ? (parsed.data.manifest ?? {}) : {};
    return {
      tenantId: m.tenantId,
      deviceId: m.deviceId ?? "unknown",
      intakeId: m.intakeId ?? "unknown",
      revision: m.revision ?? 0,
    };
  }
  /**
   * Persist one bounded rejection record so `Failed` has a cloud-side source of truth
   * (workspace TDD §7.1). A request that never identified a tenant is not persisted: there is
   * no tenant to show it to, and the code is already returned to the caller.
   */
  async function recordRejection(
    body: unknown,
    code: string,
    verified: VerifiedV2 | null,
  ) {
    const m = verified?.data.manifest;
    const claimed = m
      ? {
          tenantId: m.tenantId,
          deviceId: m.deviceId,
          intakeId: m.intakeId,
          revision: m.revision,
        }
      : claimedIdentity(body);
    if (!claimed.tenantId) return;
    await inbox.recordRejection({
      at: new Date().toISOString(),
      tenantId: claimed.tenantId,
      deviceId: claimed.deviceId,
      intakeId: claimed.intakeId,
      revision: claimed.revision,
      identity:
        verified?.identity ??
        sha256(
          canonicalV2([
            claimed.tenantId,
            claimed.deviceId,
            claimed.intakeId,
            claimed.revision,
          ]),
        ),
      code,
      verified: verified !== null,
    });
  }
  app.post(
    "/api/intake/v2",
    { bodyLimit: V2_LIMITS.envelopeBytes + 65_536 },
    (req, reply) =>
      exclusive(async () => {
        const policy = v2Policy();
        let verified: VerifiedV2 | null = null;
        try {
          verified = verifyV2(req.body, policy);
          const { record, duplicate } = await inbox.accept(
            verified,
            caseExists,
            processV2,
          );
          reply.code(duplicate ? 200 : 202);
          return {
            status: duplicate ? "DUPLICATE" : "ACCEPTED",
            intakeId: record.intakeId,
            revision: record.revision,
            digest: record.digest,
            receivedAt: record.receivedAt,
            association: record.association,
            processingStatus: record.status,
          };
        } catch (error) {
          const code =
            error instanceof DomainError
              ? error.code
              : error instanceof z.ZodError
                ? "SCHEMA_INVALID"
                : null;
          if (code) await recordRejection(req.body, code, verified);
          throw error;
        }
      }),
  );
  app.get("/api/intakes", async (req) => {
    const q = z
      .object({
        status: z
          .enum([
            "AWAITING_ASSOCIATION",
            "PROCESSING",
            "PROCESSED",
            "PROCESSED_WITH_WARNINGS",
          ])
          .optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict()
      .parse(req.query);
    const reviewer = reviewerFrom(req);
    const rows = (await inbox.list(reviewer.binding.tenantId)).filter(
      (r) => !q.status || r.status === q.status,
    );
    return {
      items: rows.slice(0, q.limit).map(publicIntake),
      total: rows.length,
    };
  });
  // Static route registered before the parametric one so "rejections" is never read as an id.
  app.get("/api/intakes/rejections", async (req) => {
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
      .strict()
      .parse(req.query);
    const reviewer = reviewerFrom(req);
    const rows = await inbox.rejections(reviewer.binding.tenantId);
    return { items: rows.slice(0, q.limit), total: rows.length };
  });
  app.get<{ Params: { id: string } }>("/api/intakes/:id", async (req) => {
    const reviewer = reviewerFrom(req);
    const record = await inbox.require(req.params.id);
    if (record.tenantId !== reviewer.binding.tenantId)
      throw new DomainError("FORBIDDEN", "Reviewer is not in this tenant", 403);
    return { intake: publicIntake(record) };
  });
  app.get<{ Params: { id: string } }>(
    "/api/intakes/:id/candidates",
    async (req) => {
      const reviewer = reviewerFrom(req);
      return inbox.candidates(
        req.params.id,
        await store.list(),
        reviewer.binding,
      );
    },
  );
  app.post<{ Params: { id: string } }>("/api/intakes/:id/association", (req) =>
    exclusive(async () => {
      const reviewer = reviewerFrom(req);
      const record = await inbox.associate(
        req.params.id,
        req.body,
        reviewer,
        caseExists,
        processV2,
      );
      return { intake: publicIntake(record) };
    }),
  );
  /**
   * Re-run cloud processing for an accepted release whose providers were unavailable. The
   * stored manifest, digest and approval are reused untouched; nothing is re-signed, and a
   * retry cannot create a second intake.
   */
  app.post<{ Params: { id: string } }>("/api/intakes/:id/retry", (req) =>
    exclusive(async () => {
      const reviewer = reviewerFrom(req);
      const record = await inbox.retryProcessing(
        req.params.id,
        reviewer,
        processV2,
      );
      return { intake: publicIntake(record) };
    }),
  );
  app.get<{ Params: { id: string } }>(
    "/api/intakes/:id/processing",
    async (req) => {
      const reviewer = reviewerFrom(req);
      const record = await inbox.require(req.params.id);
      if (record.tenantId !== reviewer.binding.tenantId)
        throw new DomainError(
          "FORBIDDEN",
          "Reviewer is not in this tenant",
          403,
        );
      return {
        intakeId: record.intakeId,
        revision: record.revision,
        status: record.status,
        association: record.association,
        processing: record.processing,
      };
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
