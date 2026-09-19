import { z } from "zod";
import { DomainError } from "../../contracts/src/index.js";
import { SchemaGraph, readPath, type Query, type Schema } from "./schema.js";

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
      return await requestJson(
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
          : await this.call({ action: "schema" }),
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
    const q = graph.validate(input);
    if (this.mode === "live") {
      // Internal expand is an ordered path list; wire expand is the documented object form.
      const raw = await this.call({
        action: "query",
        payload: {
          ...q,
          expand: Object.fromEntries(q.expand.map((p) => [p, true])),
        },
      });
      const parsed = z
        .object({
          records: z.array(z.record(z.unknown())),
          total: z.number().int().nonnegative(),
        })
        .parse(raw);
      return { ...parsed, schemaHash: graph.hash, mode: this.mode };
    }
    return {
      ...fixtureQuery(this.fixtureRows, q),
      schemaHash: graph.hash,
      mode: this.mode,
    };
  }
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
