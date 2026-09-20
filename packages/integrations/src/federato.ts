import { z } from "zod";
import { DomainError } from "../../contracts/src/index.js";
import {
  SchemaGraph,
  readPath,
  type Field,
  type Query,
  type Schema,
} from "./schema.js";

export type Transport = typeof fetch;
export class ProviderError extends DomainError {
  constructor(
    public category: "AUTH" | "VALIDATION" | "ROUTING" | "NETWORK" | "UNKNOWN",
    public retriable: boolean,
  ) {
    super(`PROVIDER_${category}`, `Provider request failed (${category})`, 502);
  }
}
export async function requestJson(
  url: string,
  init: RequestInit,
  transport: Transport = fetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await transport(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ProviderError("NETWORK", true);
  }
  if (!response.ok)
    throw new ProviderError(
      response.status === 401 || response.status === 403
        ? "AUTH"
        : (response.status >= 300 && response.status < 400) ||
            response.status === 404
          ? "ROUTING"
          : response.status === 400 || response.status === 422
            ? "VALIDATION"
            : "UNKNOWN",
      response.status >= 500 || response.status === 429,
    );
  try {
    return await response.json();
  } catch {
    throw new ProviderError("UNKNOWN", false);
  }
}
export class OAuth {
  private token?: { value: string; expires: number };
  private flight?: Promise<string>;
  constructor(
    private id: string,
    private secret: string,
    private transport: Transport = fetch,
    private clock = Date.now,
  ) {}
  invalidate() {
    this.token = undefined;
  }
  async get(): Promise<string> {
    if (this.token && this.clock() < this.token.expires - 300_000)
      return this.token.value;
    if (this.flight) return this.flight;
    this.flight = this.refresh();
    try {
      return await this.flight;
    } finally {
      this.flight = undefined;
    }
  }
  private async refresh(): Promise<string> {
    const raw = await requestJson(
      "https://auth.product.federato.ai/oauth/token",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: this.id,
          client_secret: this.secret,
          audience: "https://product.federato.ai/core-api",
        }),
      },
      this.transport,
    );
    const t = z
      .object({
        access_token: z.string().min(1),
        expires_in: z.number().positive().optional(),
      })
      .parse(raw);
    let expires = this.clock() + Math.min(t.expires_in ?? 14400, 14400) * 1000;
    if (t.access_token.split(".").length === 3) {
      let claims: { iss: string; aud: string | string[]; exp: number };
      try {
        claims = z
          .object({
            iss: z.literal("https://auth.product.federato.ai/"),
            aud: z.union([z.string(), z.array(z.string())]),
            exp: z.number(),
          })
          .parse(
            JSON.parse(
              Buffer.from(
                t.access_token.split(".")[1]!,
                "base64url",
              ).toString(),
            ),
          );
      } catch {
        throw new ProviderError("AUTH", false);
      }
      if (
        ![claims.aud].flat().includes("https://product.federato.ai/core-api") ||
        claims.exp * 1000 <= this.clock()
      )
        throw new ProviderError("AUTH", false);
      // Claim checks are diagnostic, not JWT signature verification. Token comes directly over TLS.
      expires = Math.min(expires, claims.exp * 1000);
    }
    this.token = { value: t.access_token, expires };
    return t.access_token;
  }
}
export interface QueryResult {
  records: Record<string, unknown>[];
  total: number;
  schemaHash: string;
  mode: "fixture" | "live";
}
function fieldsOf(schema: Schema, resource: string): Record<string, Field> {
  return schema.resources[resource]?.fields ?? {};
}
// Live wire select builder. The documented Federato select language has no
// aliasing: keys are real field names/paths and values are `true`, a nested
// select (objects/embedded references already resolvable), or a `$expand`
// leaf that hydrates a reference for output only. Our internal Query.select
// is an alias->dotted-path map, so we translate each path into the
// equivalent nested wire node, merge every alias's node into one select
// tree, send it, then re-derive each alias's value from the (unaliased)
// response via readPath using the same dotted path.
//
// For a path that *terminates* on a reference (one or many) we cannot know
// in advance which nested fields the caller ultimately needs (e.g. mapping
// concepts that read a whole nested substructure such as
// `exposure_units` to aggregate buildings client-side), so we request every
// field of the target resource, recursively, to a bounded depth, refusing
// to re-enter a resource already visited in this chain (breaks cycles such
// as Claim.policy / ExposureUnit.underlying_layer.policy pointing back at
// the root resource).
const FULL_WIDTH_DEPTH = 3;
function fullWidthSelect(
  schema: Schema,
  resource: string,
  visited: ReadonlySet<string>,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fieldsOf(schema, resource)))
    out[name] = fullWidthNode(schema, field, visited, depth);
  return out;
}
function fullWidthNode(
  schema: Schema,
  field: Field,
  visited: ReadonlySet<string>,
  depth: number,
): unknown {
  if (field.type === "reference" && field.targetResource) {
    if (depth <= 0 || visited.has(field.targetResource)) return true;
    return {
      $expand: {
        select: fullWidthSelect(
          schema,
          field.targetResource,
          new Set([...visited, field.targetResource]),
          depth - 1,
        ),
      },
    };
  }
  if (field.type === "object" && field.fields) {
    const out: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(field.fields))
      out[name] = fullWidthNode(schema, child, visited, depth);
    return out;
  }
  return true;
}
function buildNode(
  schema: Schema,
  fields: Record<string, Field>,
  segments: string[],
  idx: number,
  rootVisited: ReadonlySet<string>,
): unknown {
  const field = fields[segments[idx]!];
  if (!field) return true;
  const isLast = idx === segments.length - 1;
  if (field.type === "reference" && field.targetResource) {
    const inner = isLast
      ? fullWidthSelect(
          schema,
          field.targetResource,
          new Set([...rootVisited, field.targetResource]),
          FULL_WIDTH_DEPTH,
        )
      : {
          [segments[idx + 1]!]: buildNode(
            schema,
            fieldsOf(schema, field.targetResource),
            segments,
            idx + 1,
            rootVisited,
          ),
        };
    return { $expand: { select: inner } };
  }
  if (field.type === "object" && field.fields) {
    if (isLast) return true;
    return {
      [segments[idx + 1]!]: buildNode(
        schema,
        field.fields,
        segments,
        idx + 1,
        rootVisited,
      ),
    };
  }
  return true;
}
function mergeSelectNode(a: unknown, b: unknown): unknown {
  if (a === true || b === true) return true;
  if (a == null) return b;
  if (b == null) return a;
  const ao = a as Record<string, unknown>,
    bo = b as Record<string, unknown>;
  if (ao.$expand || bo.$expand) {
    const aSel = ((ao.$expand as { select?: Record<string, unknown> })
      ?.select ?? {}) as Record<string, unknown>;
    const bSel = ((bo.$expand as { select?: Record<string, unknown> })
      ?.select ?? {}) as Record<string, unknown>;
    return { $expand: { select: mergeSelectTree(aSel, bSel) } };
  }
  return mergeSelectTree(ao, bo);
}
function mergeSelectTree(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b))
    out[key] = Object.hasOwn(out, key)
      ? mergeSelectNode(out[key], value)
      : value;
  return out;
}
function buildWireSelect(
  schema: Schema,
  resource: string,
  paths: string[],
): Record<string, unknown> {
  let merged: Record<string, unknown> = {};
  for (const path of paths) {
    const segments = path.split(".");
    const tree = {
      [segments[0]!]: buildNode(
        schema,
        fieldsOf(schema, resource),
        segments,
        0,
        new Set([resource]),
      ),
    };
    merged = mergeSelectTree(merged, tree);
  }
  return merged;
}
// Only top-level scalar `where` values are used by this application (case-id
// lookups); coerce numeric-looking strings against a numeric schema field so
// deep-equality filters against a live numeric primary key still match.
function coerceWhere(
  schema: Schema,
  resource: string,
  where: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!where) return where;
  const fields = fieldsOf(schema, resource);
  return Object.fromEntries(
    Object.entries(where).map(([key, value]) => {
      if (
        fields[key]?.type === "number" &&
        typeof value === "string" &&
        value !== "" &&
        Number.isFinite(Number(value))
      )
        return [key, Number(value)];
      return [key, value];
    }),
  );
}
export class Federato {
  graph?: SchemaGraph;
  readonly mode: "fixture" | "live";
  private oauth?: OAuth;
  constructor(
    private fixtureSchema: Schema,
    private fixtureRows: Record<string, unknown>[],
    credentials?: { id: string; secret: string },
    private transport: Transport = fetch,
  ) {
    this.mode = credentials ? "live" : "fixture";
    if (credentials)
      this.oauth = new OAuth(credentials.id, credentials.secret, transport);
  }
  private async call(body: unknown, retry = true): Promise<unknown> {
    try {
      return unwrapWorkflow(
        await requestJson(
          "https://product.federato.ai/integrations-api/handlers/federato-hack-north?outputOnly=true",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${await this.oauth!.get()}`,
            },
            body: JSON.stringify(body),
          },
          this.transport,
        ),
      );
    } catch (e) {
      if (e instanceof ProviderError && e.category === "AUTH" && retry) {
        this.oauth!.invalidate();
        return this.call(body, false);
      }
      throw e;
    }
  }
  async getSchema(force = false): Promise<SchemaGraph> {
    if (!this.graph || force)
      this.graph = new SchemaGraph(
        this.mode === "fixture"
          ? this.fixtureSchema
          : normalizeLiveSchema(await this.call({ action: "schema" })),
      );
    return this.graph;
  }
  async runQuery(input: unknown, expectedHash?: string): Promise<QueryResult> {
    const graph = await this.getSchema();
    if (expectedHash && expectedHash !== graph.hash)
      throw new DomainError(
        "SCHEMA_CHANGED",
        "Schema changed during investigation",
        409,
      );
    // repair() auto-fills `expand` for reference-hop select paths and then
    // validates; it is a strict superset of validate() for already-valid
    // input. Live wire selects always use `$expand` leaves rather than the
    // expand stage, so this only satisfies internal validation, not the
    // request actually sent over the wire.
    const q = graph.repair(input);
    if (this.mode === "live") {
      // The real query language has no select aliasing (keys are field
      // paths, not caller-chosen names) and expand/reference hydration for
      // select is expressed as nested `$expand` leaves, not our internal
      // flat dotted-path expand list. Build the documented wire shape from
      // our alias->path select, then translate the (unaliased) response
      // back into alias-keyed records. NOTE: this application never needs
      // live-side `filter`/`sort`/`over`/`unwind` for ingestion or fact
      // aggregation (all reduction happens client-side against fetched raw
      // substructures), so those Query stages are intentionally not
      // translated to the wire format here; a caller that sets them in live
      // mode will see them silently ignored.
      const paths = Object.values(q.select);
      const raw = await this.call({
        action: "query",
        payload: {
          resource: q.resource,
          where: coerceWhere(graph.schema, q.resource, q.where),
          select: buildWireSelect(graph.schema, q.resource, paths),
          pagination: q.pagination,
        },
      });
      const parsed = z
        .object({
          results: z.array(z.record(z.unknown())),
          total: z.number().int().nonnegative(),
        })
        .parse(raw);
      const records = parsed.results.map((row) =>
        Object.fromEntries(
          Object.entries(q.select).map(([alias, path]) => [
            alias,
            readPath(row, path),
          ]),
        ),
      );
      return {
        records,
        total: parsed.total,
        schemaHash: graph.hash,
        mode: this.mode,
      };
    }
    return {
      ...fixtureQuery(this.fixtureRows, q),
      schemaHash: graph.hash,
      mode: this.mode,
    };
  }
}

function unwrapWorkflow(input: unknown): unknown {
  const envelope = z
    .object({ output: z.array(z.object({ data: z.unknown() })).min(1) })
    .safeParse(input);
  return envelope.success ? envelope.data.output[0]!.data : input;
}

function normalizeLiveSchema(input: unknown): Schema {
  const resources = z.record(z.unknown()).parse(input);
  const field = (value: unknown): Field => {
    const raw = z
      .object({
        type: z.string(),
        fields: z.record(z.unknown()).optional(),
        itemSchema: z.unknown().optional(),
        itemType: z.string().optional(),
        resource: z.string().optional(),
        cardinality: z.enum(["one", "many"]).optional(),
      })
      .passthrough()
      .parse(value);
    if (raw.type === "reference")
      return {
        type: "reference",
        targetResource: raw.resource,
        cardinality: raw.cardinality,
      };
    if (raw.type === "array")
      return {
        type: "array",
        items: raw.itemSchema
          ? field(raw.itemSchema)
          : {
              type: z
                .enum(["string", "number", "boolean"])
                .parse(raw.itemType ?? "string"),
            },
      };
    if (raw.type === "object")
      return {
        type: "object",
        fields: Object.fromEntries(
          Object.entries(raw.fields ?? {}).map(([name, child]) => [
            name,
            field(child),
          ]),
        ),
      };
    return { type: z.enum(["string", "number", "boolean"]).parse(raw.type) };
  };
  return {
    resources: Object.fromEntries(
      Object.entries(resources).map(([name, value]) => {
        const resource = z
          .object({ fields: z.record(z.unknown()) })
          .passthrough()
          .parse(value);
        return [
          name,
          {
            fields: Object.fromEntries(
              Object.entries(resource.fields).map(([key, child]) => [
                key,
                field(child),
              ]),
            ),
          },
        ];
      }),
    ),
  };
}
function matches(
  record: unknown,
  conditions: Record<string, unknown>,
): boolean {
  return Object.entries(conditions).every(([key, condition]) => {
    if (key === "$and")
      return (condition as Record<string, unknown>[]).every((c) =>
        matches(record, c),
      );
    if (key === "$or")
      return (condition as Record<string, unknown>[]).some((c) =>
        matches(record, c),
      );
    if (key === "$not")
      return !matches(record, condition as Record<string, unknown>);
    const value = readPath(record, key);
    const ops =
      condition && typeof condition === "object" && !Array.isArray(condition)
        ? (condition as Record<string, unknown>)
        : { $eq: condition };
    return Object.entries(ops).every(([op, wanted]) => {
      switch (op) {
        case "$eq":
          return value === wanted;
        case "$ne":
          return value !== wanted;
        case "$exists":
          return (value !== undefined && value !== null) === wanted;
        case "$in":
          return (wanted as unknown[]).includes(value);
        case "$nin":
          return !(wanted as unknown[]).includes(value);
        case "$contains":
          return typeof value === "string" && value.includes(String(wanted));
        case "$gt":
          return (value as number) > (wanted as number);
        case "$gte":
          return (value as number) >= (wanted as number);
        case "$lt":
          return (value as number) < (wanted as number);
        case "$lte":
          return (value as number) <= (wanted as number);
        case "$elemMatch":
          return (
            Array.isArray(value) &&
            value.some((v) => matches(v, wanted as Record<string, unknown>))
          );
        default:
          return false;
      }
    });
  });
}
function fixtureQuery(rows: Record<string, unknown>[], q: Query) {
  if (q.unwind.length || q.over || q.expand.length)
    throw new DomainError(
      "FIXTURE_QUERY_UNSUPPORTED",
      "Fixture executor supports filters, projection, sort and pagination; reference/reduction validation is tested independently",
    );
  let records = rows
    .filter((r) => matches(r, q.where ?? {}) && matches(r, q.filter ?? {}))
    .map((r) =>
      Object.fromEntries(
        Object.entries(q.select).map(([alias, path]) => [
          alias,
          readPath(r, path),
        ]),
      ),
    );
  for (const [key, direction] of Object.entries(q.sort ?? {}).reverse())
    records = records.sort(
      (a, b) =>
        (a[key] === b[key]
          ? 0
          : (a[key] as number) < (b[key] as number)
            ? -1
            : 1) * (direction === "asc" ? 1 : -1),
    );
  return {
    records: records.slice(
      q.pagination.offset,
      q.pagination.offset + q.pagination.limit,
    ),
    total: records.length,
  };
}
