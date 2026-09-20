import { createHmac, randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import pg from "pg";
import { z } from "zod";
import {
  Preference,
  TelemetryEvent,
  assertSanitizedText,
  sha256,
  verifyIntake,
  type SanitizedIntake,
} from "../../contracts/src/index.js";
import type { VerifiedV2 } from "../../contracts/src/intake-v2.js";
import type { Decision, Facts } from "../../engine/src/index.js";
import { requestJson, type Transport } from "./federato.js";
export interface CaseRecord {
  tenantId?: string;
  humanApproved?: boolean;
  approvedRationale?: Array<{ evidenceId: string; text: string }>;
  documentIntegrity?: {
    policy: string;
    status: "AUTHENTICITY_REVIEW" | "CLEAR" | "UNAVAILABLE";
    documentId: string;
  };
  id: string;
  version: number;
  schemaHash: string;
  mode: "fixture" | "live";
  facts: Facts;
  decision: Decision;
  updatedAt: string;
  sourceHash: string;
}
export class CaseStore {
  private rows = new Map<string, CaseRecord>();
  private history = new Map<string, CaseRecord[]>();
  private extras = new Map<string, unknown>();
  private client?: MongoClient;
  readonly mode: "memory" | "live";
  constructor(uri?: string) {
    this.mode = uri ? "live" : "memory";
    if (uri)
      this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  }
  async init() {
    if (this.client) {
      await this.client.connect();
      await this.client
        .db("riskgraph")
        .collection("cases")
        .createIndex({ id: 1 }, { unique: true });
      await this.client
        .db("riskgraph")
        .collection("case_versions")
        .createIndex({ id: 1, version: 1 }, { unique: true });
    }
  }
  async close() {
    await this.client?.close();
  }
  async get(id: string): Promise<CaseRecord | undefined> {
    return this.client
      ? ((await this.client
          .db("riskgraph")
          .collection<CaseRecord>("cases")
          .findOne({ id }, { projection: { _id: 0 } })) ?? undefined)
      : structuredClone(this.rows.get(id));
  }
  async list(): Promise<CaseRecord[]> {
    return this.client
      ? this.client
          .db("riskgraph")
          .collection<CaseRecord>("cases")
          .find({}, { projection: { _id: 0 } })
          .toArray()
      : structuredClone([...this.rows.values()]);
  }
  async put(value: CaseRecord) {
    if (this.client) {
      const db = this.client.db("riskgraph");
      await db
        .collection("case_versions")
        .updateOne(
          { id: value.id, version: value.version },
          { $setOnInsert: value },
          { upsert: true },
        );
      await db
        .collection<CaseRecord>("cases")
        .replaceOne({ id: value.id }, value, { upsert: true });
    } else {
      this.rows.set(value.id, structuredClone(value));
      const h = this.history.get(value.id) ?? [];
      if (!h.some((v) => v.version === value.version))
        h.push(structuredClone(value));
      this.history.set(value.id, h);
    }
  }
  async saveExtra(kind: string, id: string, value: object) {
    const expiresAt =
      "expiresAt" in value && typeof value.expiresAt === "string"
        ? new Date(value.expiresAt)
        : undefined;
    if (
      this.client &&
      ["ask_sessions", "ask_answers", "ask_traces"].includes(kind)
    )
      await this.client
        .db("riskgraph")
        .collection(kind)
        .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    if (this.client)
      await this.client
        .db("riskgraph")
        .collection(kind)
        .replaceOne(
          { key: id },
          { key: id, value, ...(expiresAt ? { expiresAt } : {}) },
          { upsert: true },
        );
    else this.extras.set(`${kind}:${id}`, structuredClone(value));
  }
  async getExtra<T>(kind: string, id: string): Promise<T | undefined> {
    if (this.client)
      return (
        await this.client.db("riskgraph").collection(kind).findOne({ key: id })
      )?.value as T | undefined;
    return structuredClone(this.extras.get(`${kind}:${id}`)) as T | undefined;
  }
  async pruneAskHistory(now = Date.now()) {
    const kinds = ["ask_sessions", "ask_answers", "ask_traces"];
    if (this.client) {
      for (const kind of kinds)
        await this.client
          .db("riskgraph")
          .collection(kind)
          .deleteMany({ expiresAt: { $lte: new Date(now) } });
    } else {
      for (const [key, value] of this.extras) {
        if (!kinds.some((kind) => key.startsWith(`${kind}:`))) continue;
        const expiry = (value as { expiresAt?: string }).expiresAt;
        if (expiry && Date.parse(expiry) <= now) this.extras.delete(key);
      }
    }
  }
  async deleteExtra(kind: string, id: string) {
    if (this.client)
      await this.client.db("riskgraph").collection(kind).deleteOne({ key: id });
    else this.extras.delete(`${kind}:${id}`);
  }
  async scopedCases(tenantId: string, caseIds: string[]) {
    if (this.client)
      return this.client
        .db("riskgraph")
        .collection<CaseRecord>("cases")
        .find(
          {
            tenantId,
            ...(caseIds.includes("*") ? {} : { id: { $in: caseIds } }),
          },
          { projection: { _id: 0 } },
        )
        .limit(1000)
        .toArray();
    return (await this.list())
      .filter(
        (c) =>
          (c.tenantId ??
            (c.mode === "fixture" ? "carrier-demo" : undefined)) === tenantId &&
          (caseIds.includes("*") || caseIds.includes(c.id)),
      )
      .slice(0, 1000);
  }
  async riskPrecedents(
    tenantId: string,
    caseIds: string[],
    current: CaseRecord,
  ) {
    const { riskProfile } = await import("../../ask/src/risk.js");
    if (!this.client) return this.scopedCases(tenantId, caseIds);
    return this.client
      .db("riskgraph")
      .collection<CaseRecord>("cases")
      .aggregate<CaseRecord>([
        {
          $vectorSearch: {
            index: "ask-risk-v1",
            path: "riskProfile8",
            queryVector: riskProfile(current).vector,
            numCandidates: 200,
            limit: 50,
            filter: {
              tenantId,
              id: {
                $ne: current.id,
                ...(caseIds.includes("*") ? {} : { $in: caseIds }),
              },
            },
          },
        },
        { $project: { _id: 0 } },
      ])
      .toArray();
  }
  async precedents(current: CaseRecord) {
    const vector = caseVector(current);
    try {
      const rows = this.client
        ? await this.client
            .db("riskgraph")
            .collection<CaseRecord>("cases")
            .aggregate<CaseRecord & { score: number }>([
              {
                $vectorSearch: {
                  index: "case-vector",
                  path: "caseEmbedding",
                  queryVector: vector,
                  numCandidates: 50,
                  limit: 6,
                  filter: { id: { $ne: current.id } },
                },
              },
              {
                $project: {
                  _id: 0,
                  id: 1,
                  facts: 1,
                  decision: 1,
                  score: { $meta: "vectorSearchScore" },
                },
              },
            ])
            .toArray()
        : (await this.list())
            .filter((c) => c.id !== current.id)
            .map((c) => ({ ...c, score: cosine(vector, caseVector(c)) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 5);
      return {
        status: "AVAILABLE",
        mode: this.mode,
        matches: rows.map((c) => ({
          id: c.id,
          score: c.score,
          decision: c.decision.class,
          humanApproved: false,
          sharedFactors: current.decision.criteria
            .filter((f) =>
              c.decision.criteria.some(
                (o) => o.key === f.key && o.observed === f.observed,
              ),
            )
            .map((f) => f.key),
          materialDifferences: current.decision.criteria
            .filter((f) =>
              c.decision.criteria.some(
                (o) => o.key === f.key && o.observed !== f.observed,
              ),
            )
            .map((f) => f.key),
        })),
      };
    } catch {
      return { status: "UNAVAILABLE", mode: this.mode, matches: [] };
    }
  }
  async saveVector(record: CaseRecord) {
    if (this.client)
      await this.client
        .db("riskgraph")
        .collection("cases")
        .updateOne(
          { id: record.id },
          {
            $set: {
              caseEmbedding: caseVector(record),
              riskProfile8: (await import("../../ask/src/risk.js")).riskProfile(
                record,
              ).vector,
              riskProfileVersion: "risk-v1",
              embeddingModel: "deterministic-risk-features-v1",
            },
          },
        );
  }
}
function caseVector(c: CaseRecord) {
  return c.decision.criteria.map((f) => f.points / f.weight);
}
function cosine(a: number[], b: number[]) {
  const norm = Math.hypot(...a) * Math.hypot(...b);
  return norm ? a.reduce((n, v, i) => n + v * (b[i] ?? 0), 0) / norm : 0;
}
export const Chunk = z
  .object({
    evidenceId: z.string(),
    documentId: z.string().max(250).optional(),
    title: z.string().max(300).optional(),
    sourceType: z.string().max(80).optional(),
    verificationStatus: z.string().max(60).optional(),
    reliability: z.number().min(0).max(1).optional(),
    importance: z.number().positive().max(10).optional(),
    boundingBox: z.array(z.number().min(0).max(1)).length(4).optional(),
    caseId: z.string(),
    text: z.string().max(20_000),
    sourceUri: z.string().min(1),
    sourceField: z.string(),
    observedAt: z.string().datetime(),
    contentHash: z.string(),
    vector: z.array(z.number().finite()).length(32),
    state: z.string().optional(),
    tenantId: z.string().min(1).max(100).optional(),
    page: z.number().int().positive().optional(),
    blockId: z.string().max(64).optional(),
  })
  .strict();
export type Chunk = z.infer<typeof Chunk>;
// Local semantic vocabulary for offline mode; vectors remain purpose-limited and reproducible.
export function embed(text: string): number[] {
  const synonyms: Record<string, string> = {
    masonry: "construction",
    steel: "construction",
    building: "construction",
    structure: "construction",
    fire: "hazard",
    blaze: "hazard",
    loss: "claim",
    losses: "claim",
    damage: "claim",
    premium: "price",
    cost: "price",
  };
  const v = Array<number>(32).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const normalized = synonyms[word] ?? word;
    const i = parseInt(sha256(normalized).slice(0, 4), 16) % 32;
    v[i] = (v[i] ?? 0) + 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
export class EvidenceStore {
  private chunks = new Map<string, Chunk>();
  readonly mode: "memory" | "live";
  constructor(
    private url?: string,
    private apiKey?: string,
    private transport: Transport = fetch,
  ) {
    this.mode = url ? "live" : "memory";
  }
  private call(path: string, body: unknown, method = "POST") {
    return requestJson(
      `${this.url}/risk-evidence-v1${path}`,
      {
        method,
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `ApiKey ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      },
      this.transport,
    );
  }
  async init() {
    if (this.url) {
      const mapping = {
        properties: {
          documentId: { type: "keyword" },
          title: { type: "text" },
          sourceType: { type: "keyword" },
          sourceUri: { type: "keyword" },
          verificationStatus: { type: "keyword" },
          caseId: { type: "keyword" },
          tenantId: { type: "keyword" },
          evidenceId: { type: "keyword" },
          blockId: { type: "keyword" },
          page: { type: "integer" },
          state: { type: "keyword" },
          observedAt: { type: "date" },
          text: { type: "text" },
          vector: {
            type: "dense_vector",
            dims: 32,
            index: true,
            similarity: "cosine",
          },
        },
      };
      const response = await this.transport(`${this.url}/risk-evidence-v1`, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
        headers: this.apiKey ? { authorization: `ApiKey ${this.apiKey}` } : {},
      });
      if (response.status === 404)
        await this.call("", { mappings: mapping }, "PUT");
      else if (response.ok) await this.call("/_mapping", mapping, "PUT");
      else throw new Error("Evidence index unavailable");
    }
  }
  async ingest(intake: SanitizedIntake, approved: boolean, tenantId?: string) {
    const data = verifyIntake(
      intake,
      ["lloyd-api", "gemini", "openai", "gptzero", "elasticsearch"],
      "elasticsearch",
      approved,
    );
    return this.add({
      tenantId,
      documentId: data.manifest.documentId,
      evidenceId: data.manifest.documentId,
      caseId: data.manifest.caseId,
      text: data.artifact.text,
      sourceUri: `sanitized://${data.manifest.documentId}`,
      sourceField: "artifact.text",
      observedAt: data.manifest.createdAt,
      contentHash: data.manifest.sanitizedSha256,
      vector: embed(data.artifact.text),
    });
  }
  /**
   * Index a verified v2 release one chunk per sanitized block. Chunks are scoped to the tenant and the
   * case chosen at association time; the released text is never re-derived from anything but the
   * verified artifacts.
   */
  async ingestV2(verified: VerifiedV2, caseId: string) {
    const { manifest, artifacts } = verified.data;
    let indexed = 0;
    for (const artifact of artifacts) {
      const descriptor = manifest.artifacts.find((d) => d.id === artifact.id);
      if (!descriptor || !artifact.text.trim()) continue;
      await this.add({
        evidenceId: `${manifest.intakeId}:${artifact.id}`,
        caseId,
        tenantId: manifest.tenantId,
        documentId: manifest.intakeId,
        text: artifact.text,
        sourceUri: `intake-v2://${encodeURIComponent(manifest.intakeId)}/${encodeURIComponent(artifact.id)}`,
        sourceField: `artifacts.${artifact.id}`,
        observedAt: manifest.createdAt,
        contentHash: descriptor.sha256,
        vector: embed(artifact.text),
        page: descriptor.page,
        blockId: descriptor.blockId,
      });
      indexed++;
    }
    return { indexed };
  }
  async add(input: Chunk) {
    const c = Chunk.parse(input);
    if (sha256(c.text) !== c.contentHash)
      throw new Error("Evidence hash mismatch");
    assertSanitizedText(JSON.stringify(c));
    const id = sha256(c.contentHash + c.sourceUri + c.sourceField);
    if (this.url) await this.call(`/_doc/${id}`, c, "PUT");
    else this.chunks.set(id, c);
  }
  async corpus(
    tenantId: string,
    caseIds: string[],
    limit = 1000,
  ): Promise<Chunk[]> {
    if (this.url) {
      const filter: unknown[] = [{ term: { tenantId } }];
      if (!caseIds.includes("*")) filter.push({ terms: { caseId: caseIds } });
      const raw = await this.call("/_search", {
        size: Math.min(limit, 1000),
        query: { bool: { filter } },
      });
      return z
        .object({
          hits: z.object({ hits: z.array(z.object({ _source: Chunk })) }),
        })
        .parse(raw)
        .hits.hits.map((h) => h._source);
    }
    return [...this.chunks.values()]
      .filter(
        (c) =>
          c.tenantId === tenantId &&
          (caseIds.includes("*") || caseIds.includes(c.caseId)),
      )
      .slice(0, limit);
  }
  async search(
    caseId: string | string[],
    query: string,
    filters: {
      state?: string;
      after?: string;
      before?: string;
      tenantId?: string;
      sourceTypes?: string[];
      limit?: number;
    } = {},
  ) {
    try {
      let lexical: Chunk[], dense: Chunk[];
      if (this.url) {
        const filter: unknown[] = [
          Array.isArray(caseId) ? { terms: { caseId } } : { term: { caseId } },
        ];
        if (filters.tenantId)
          filter.push({ term: { tenantId: filters.tenantId } });
        if (filters.sourceTypes)
          filter.push({ terms: { sourceType: filters.sourceTypes } });
        if (filters.state) filter.push({ term: { state: filters.state } });
        if (filters.after || filters.before)
          filter.push({
            range: {
              observedAt: {
                ...(filters.after ? { gte: filters.after } : {}),
                ...(filters.before ? { lte: filters.before } : {}),
              },
            },
          });
        const parse = (v: unknown) =>
          z
            .object({
              hits: z.object({ hits: z.array(z.object({ _source: Chunk })) }),
            })
            .parse(v)
            .hits.hits.map((h) => h._source);
        const results = await Promise.all([
          this.call("/_search", {
            size: 20,
            query: {
              bool: {
                must: [
                  {
                    multi_match: {
                      query,
                      fields: ["title^2", "text", "evidenceId^3"],
                    },
                  },
                ],
                filter,
              },
            },
          }),
          this.call("/_search", {
            size: 20,
            knn: {
              field: "vector",
              query_vector: embed(query),
              k: 20,
              num_candidates: 100,
              filter: { bool: { filter } },
            },
          }),
        ]);
        lexical = parse(results[0]);
        dense = parse(results[1]);
      } else {
        const rows = [...this.chunks.values()].filter(
          (c) =>
            (Array.isArray(caseId)
              ? caseId.includes(c.caseId)
              : c.caseId === caseId) &&
            (!filters.tenantId || c.tenantId === filters.tenantId) &&
            (!filters.sourceTypes ||
              filters.sourceTypes.includes(c.sourceType ?? "document")) &&
            (!filters.state || c.state === filters.state) &&
            (!filters.after || c.observedAt >= filters.after) &&
            (!filters.before || c.observedAt <= filters.before),
        );
        const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
        const score = (c: Chunk) =>
          terms.reduce(
            (n, t) => n + (c.text.toLowerCase().includes(t) ? 1 : 0),
            0,
          );
        lexical = rows
          .filter((c) => score(c) > 0)
          .sort((a, b) => score(b) - score(a))
          .slice(0, 20);
        dense = rows
          .sort(
            (a, b) =>
              cosine(embed(query), b.vector) - cosine(embed(query), a.vector),
          )
          .slice(0, 20);
      }
      const fused = new Map<string, { chunk: Chunk; score: number }>();
      for (const list of [lexical, dense])
        list.forEach((chunk, i) =>
          fused.set(chunk.evidenceId, {
            chunk,
            score: (fused.get(chunk.evidenceId)?.score ?? 0) + 1 / (60 + i + 1),
          }),
        );
      return {
        status: "AVAILABLE",
        mode: this.mode,
        results: [...fused.values()]
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.min(20, filters.limit ?? 10)),
      };
    } catch {
      return { status: "UNAVAILABLE", mode: this.mode, results: [] };
    }
  }
}
export class Telemetry {
  private pool?: pg.Pool;
  private events: z.infer<typeof TelemetryEvent>[] = [];
  constructor(
    url?: string,
    private secret: string = randomUUID(),
  ) {
    if (url) {
      // Tiger services commonly use a certificate chain accepted by libpq but
      // rejected by pg's newer strict interpretation of sslmode=require.
      const connection = new URL(url);
      if (connection.searchParams.get("sslmode") === "require")
        connection.searchParams.set("uselibpqcompat", "true");
      this.pool = new pg.Pool({
        connectionString: connection.toString(),
        connectionTimeoutMillis: 3000,
        statement_timeout: 3000,
      });
    }
  }
  async emit(
    caseId: string,
    event: z.infer<typeof TelemetryEvent>["event"],
    outcome: z.infer<typeof TelemetryEvent>["outcome"],
    durationMs: number,
  ) {
    const e = TelemetryEvent.parse({
      eventId: randomUUID(),
      casePseudonym: createHmac("sha256", this.secret)
        .update(caseId)
        .digest("hex"),
      event,
      outcome,
      durationMs,
      at: new Date().toISOString(),
    });
    return this.write(e);
  }
  async write(input: unknown) {
    const e = TelemetryEvent.parse(input);
    try {
      if (this.pool)
        await this.pool.query(
          "INSERT INTO investigation_events (event_id, occurred_at, pseudonymous_case_id, event_type, duration_ms, status) VALUES ($1,$2,$3,$4,$5,$6)",
          [e.eventId, e.at, e.casePseudonym, e.event, e.durationMs, e.outcome],
        );
      else this.events.push(e);
      return { status: "RECORDED" };
    } catch {
      return { status: "UNAVAILABLE" };
    }
  }
  async summary() {
    try {
      if (this.pool)
        return {
          status: "AVAILABLE",
          mode: "live",
          hourly: (
            await this.pool.query(
              "SELECT * FROM investigation_hourly ORDER BY hour DESC LIMIT 24",
            )
          ).rows,
        };
      return {
        status: "AVAILABLE",
        mode: "memory",
        total: this.events.length,
        failures: this.events.filter((e) => e.outcome !== "success").length,
        averageDurationMs:
          this.events.reduce((n, e) => n + e.durationMs, 0) /
          (this.events.length || 1),
      };
    } catch {
      return { status: "UNAVAILABLE", mode: "live" };
    }
  }
  async close() {
    await this.pool?.end();
  }
}
export class Backboard {
  private preferences: z.infer<typeof Preference>[] = [];
  constructor(
    private config?: { url: string; key: string; assistantId: string },
    private transport: Transport = fetch,
  ) {}
  async remember(input: unknown) {
    const preference = Preference.parse(input);
    try {
      if (this.config)
        await requestJson(
          `${this.config.url}/assistants/${encodeURIComponent(this.config.assistantId)}/memories`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "X-API-Key": this.config.key,
            },
            body: JSON.stringify({ content: JSON.stringify(preference) }),
          },
          this.transport,
        );
      else this.preferences.push(preference);
      return { status: "STORED", mode: this.config ? "live" : "memory" };
    } catch {
      return { status: "UNAVAILABLE", mode: "live" };
    }
  }
}
