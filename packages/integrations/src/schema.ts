import { z } from "zod";
import { DomainError, sha256 } from "../../contracts/src/index.js";

export interface Field {
  type: "string" | "number" | "boolean" | "object" | "array" | "reference";
  fields?: Record<string, Field>;
  items?: Field;
  targetResource?: string;
  cardinality?: "one" | "many";
}
export interface Schema {
  resources: Record<string, { fields: Record<string, Field> }>;
}
const fieldSchema: z.ZodType<Field> = z.lazy(() =>
  z
    .object({
      type: z.enum([
        "string",
        "number",
        "boolean",
        "object",
        "array",
        "reference",
      ]),
      fields: z.record(fieldSchema).optional(),
      items: fieldSchema.optional(),
      targetResource: z.string().optional(),
      cardinality: z.enum(["one", "many"]).optional(),
    })
    .strict(),
);
export const SchemaContract: z.ZodType<Schema> = z
  .object({
    resources: z.record(z.object({ fields: z.record(fieldSchema) }).strict()),
  })
  .strict();
export const QueryContract = z
  .object({
    resource: z.string(),
    where: z.record(z.unknown()).optional(),
    expand: z.array(z.string()).default([]),
    unwind: z.array(z.string()).default([]),
    filter: z.record(z.unknown()).optional(),
    over: z
      .record(
        z
          .object({
            operator: z.enum([
              "$sum",
              "$avg",
              "$min",
              "$max",
              "$count",
              "$countDistinct",
            ]),
            path: z.string(),
          })
          .strict(),
      )
      .optional(),
    select: z
      .record(z.string())
      .refine((v) => Object.keys(v).length > 0, "Projection required"),
    sort: z.record(z.enum(["asc", "desc"])).optional(),
    pagination: z
      .object({
        limit: z.number().int().min(1).max(100),
        offset: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type Query = z.infer<typeof QueryContract>;
function fail(message: string): never {
  throw new DomainError("QUERY_VALIDATION", message);
}
export class SchemaGraph {
  readonly schema: Schema;
  readonly hash: string;
  constructor(input: unknown) {
    this.schema = SchemaContract.parse(input);
    this.hash = sha256(JSON.stringify(this.schema));
  }
  path(
    resource: string,
    path: string,
    expand: string[] = [],
    traversable: string[] = [],
    raw = false,
  ): Field {
    let fields: Record<string, Field> | undefined = this.schema.resources[resource]?.fields;
    if (!fields) return fail(`Unknown resource: ${resource}`);
    const parts = path.split(".");
    let result: Field | undefined;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (["__proto__", "constructor", "prototype"].includes(part))
        return fail("Forbidden path");
      result = fields?.[part];
      if (!result) return fail(`Unknown path: ${path}`);
      const prefix = parts.slice(0, i + 1).join(".");
      if (i < parts.length - 1) {
        if (result.type === "reference") {
          if (raw || !expand.includes(prefix))
            return fail(`Expand ${prefix} before reference traversal`);
          if (result.cardinality === "many" && !traversable.includes(prefix))
            return fail(`Use $elemMatch or unwind at ${prefix}`);
          fields = this.schema.resources[result.targetResource ?? ""]?.fields;
        } else if (result.type === "array") {
          if (!traversable.includes(prefix))
            return fail(`Use $elemMatch or unwind at ${prefix}`);
          fields = result.items?.fields;
        } else fields = result.fields;
      }
    }
    return result!;
  }
  legalPaths(resource: string): string[] {
    const paths: string[] = [];
    const visit = (fields: Record<string, Field>, prefix = "", depth = 0) => {
      if (depth > 8) return;
      for (const [name, field] of Object.entries(fields)) {
        const p = prefix + name;
        paths.push(p);
        const children = field.fields ?? field.items?.fields;
        if (children) visit(children, p + ".", depth + 1);
      }
    };
    const fields = this.schema.resources[resource]?.fields;
    if (fields) visit(fields);
    return paths;
  }
  boundaries(
    resource: string,
    path: string,
  ): { arrays: string[]; references: string[] } {
    let fields: Record<string, Field> | undefined = this.schema.resources[resource]?.fields;
    if (!fields) fail(`Unknown resource: ${resource}`);
    const arrays: string[] = [],
      references: string[] = [],
      parts = path.split(".");
    for (let i = 0; i < parts.length; i++) {
      const f: Field | undefined = fields?.[parts[i]!];
      if (!f) fail(`Unknown path: ${path}`);
      const prefix = parts.slice(0, i + 1).join(".");
      if (f.type === "reference") {
        references.push(prefix);
        if (f.cardinality === "many") arrays.push(prefix);
        fields = this.schema.resources[f.targetResource ?? ""]?.fields;
      } else if (f.type === "array") {
        arrays.push(prefix);
        fields = f.items?.fields;
      } else fields = f.fields;
    }
    return { arrays, references };
  }
  arrayBoundaries(resource: string, path: string) {
    return this.boundaries(resource, path).arrays;
  }
  referenceChain(resource: string, path: string) {
    return this.boundaries(resource, path).references;
  }
  requiredExpansions(resource: string, path: string) {
    return this.referenceChain(resource, path).filter((p) => p !== path);
  }
  repair(input: unknown): Query {
    const q = QueryContract.parse(input);
    for (const stage of ["where", "filter"] as const) {
      const conditions = q[stage];
      if (!conditions) continue;
      for (const [path, predicate] of Object.entries(conditions)) {
        if (path.startsWith("$")) continue;
        const bounds = this.boundaries(q.resource, path);
        if (stage === "filter")
          q.expand = [
            ...new Set([
              ...q.expand,
              ...bounds.references.filter((p) => p !== path),
            ]),
          ];
        // Raw references cannot be repaired by silently moving a where predicate after expansion.
        if (stage === "where" && bounds.references.some((p) => p !== path))
          continue;
        const arrays = bounds.arrays.filter(
          (p) => p !== path && !(stage === "filter" && q.unwind.includes(p)),
        );
        if (arrays.length) {
          let rewritten: unknown = predicate;
          let tail = path;
          for (const boundary of [...arrays].reverse()) {
            rewritten = {
              $elemMatch: { [tail.slice(boundary.length + 1)]: rewritten },
            };
            tail = boundary;
          }
          delete conditions[path];
          // Preserve an existing constraint on the same array by conjoining both predicates.
          if (Object.hasOwn(conditions, tail))
            q[stage] = { $and: [conditions, { [tail]: rewritten }] };
          else conditions[tail] = rewritten;
        }
      }
    }
    for (const path of Object.values(q.select))
      if (!q.over?.[path])
        q.expand = [
          ...new Set([
            ...q.expand,
            ...this.requiredExpansions(q.resource, path),
          ]),
        ];
    return this.validate(q);
  }
  candidatePaths(concept: string) {
    const words = concept
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[ _]+/);
    return Object.keys(this.schema.resources).flatMap((resource) =>
      this.legalPaths(resource)
        .filter((path) => words.some((w) => path.toLowerCase().includes(w)))
        .map((path) => ({ resource, path, confidence: 0.5, confirmed: false })),
    );
  }
  validate(input: unknown): Query {
    const q = QueryContract.parse(input);
    if (!this.schema.resources[q.resource])
      fail(`Unknown resource: ${q.resource}`);
    for (const e of q.expand) {
      const f = this.path(q.resource, e, q.expand, q.expand);
      if (
        f.type !== "reference" ||
        !f.targetResource ||
        !this.schema.resources[f.targetResource] ||
        !f.cardinality
      )
        fail(`Invalid reference expansion: ${e}`);
    }
    for (const u of q.unwind) {
      const f = this.path(q.resource, u, q.expand, q.unwind);
      if (
        f.type !== "array" &&
        !(f.type === "reference" && f.cardinality === "many")
      )
        fail(`Cannot unwind ${u}`);
    }
    const checkFilter = (
      condition: Record<string, unknown>,
      raw: boolean,
      prefix = "",
      arrays: string[] = [],
      depth = 0,
    ) => {
      if (depth > 12) fail("Filter nesting limit");
      for (const [key, expression] of Object.entries(condition)) {
        if (["$and", "$or"].includes(key)) {
          if (!Array.isArray(expression) || !expression.length)
            fail("Logical operator requires nonempty array");
          for (const v of expression)
            checkFilter(
              z.record(z.unknown()).parse(v),
              raw,
              prefix,
              arrays,
              depth + 1,
            );
          continue;
        }
        if (key === "$not") {
          checkFilter(
            z.record(z.unknown()).parse(expression),
            raw,
            prefix,
            arrays,
            depth + 1,
          );
          continue;
        }
        if (key.startsWith("$")) fail(`Unsupported operator ${key}`);
        const p = prefix + key,
          field = this.path(
            q.resource,
            p,
            q.expand,
            [...arrays, ...(raw ? [] : q.unwind)],
            raw,
          );
        const ops =
          expression !== null &&
          typeof expression === "object" &&
          !Array.isArray(expression)
            ? (expression as Record<string, unknown>)
            : { $eq: expression };
        for (const [op, value] of Object.entries(ops)) {
          if (
            ![
              "$eq",
              "$ne",
              "$exists",
              "$gt",
              "$gte",
              "$lt",
              "$lte",
              "$in",
              "$nin",
              "$contains",
              "$elemMatch",
            ].includes(op)
          )
            fail(`Unsupported operator ${op}`);
          if (op === "$elemMatch") {
            if (
              field.type !== "array" &&
              !(
                field.type === "reference" &&
                field.cardinality === "many" &&
                !raw
              )
            )
              fail("$elemMatch requires array");
            checkFilter(
              z.record(z.unknown()).parse(value),
              raw,
              p + ".",
              [...arrays, p],
              depth + 1,
            );
          } else if (op === "$exists") {
            if (typeof value !== "boolean") fail("$exists requires boolean");
          } else if (["$in", "$nin"].includes(op)) {
            if (
              !Array.isArray(value) ||
              !value.every((v) => typeof v === field.type)
            )
              fail(`${op} requires typed array`);
          } else if (op === "$contains") {
            if (field.type !== "string" || typeof value !== "string")
              fail("$contains requires string");
          } else if (["$gt", "$gte", "$lt", "$lte"].includes(op)) {
            if (
              !["number", "string"].includes(field.type) ||
              typeof value !== field.type
            )
              fail("Invalid ordered comparison");
          } else if (value !== null && typeof value !== field.type)
            fail("Comparison type mismatch");
        }
      }
    };
    if (q.where) checkFilter(q.where, true);
    if (q.filter) checkFilter(q.filter, false);
    for (const reduction of Object.values(q.over ?? {})) {
      const f = this.path(q.resource, reduction.path, q.expand, q.unwind);
      if (
        ["$sum", "$avg", "$min", "$max"].includes(reduction.operator) &&
        f.type !== "number"
      )
        fail("Numeric reduction requires number");
    }
    for (const [alias, path] of Object.entries(q.select)) {
      if (
        alias.startsWith("$") ||
        alias.includes(".") ||
        ["__proto__", "constructor", "prototype"].includes(alias)
      )
        fail("Invalid projection alias");
      if (!q.over?.[path]) this.path(q.resource, path, q.expand, q.unwind);
    }
    for (const path of Object.keys(q.sort ?? {}))
      if (!Object.hasOwn(q.select, path))
        fail(`Sort occurs after select; unknown alias ${path}`);
    return q;
  }
}

export function readPath(record: unknown, path: string): unknown {
  let current: unknown = record;
  for (const p of path.split(".")) {
    if (
      !current ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.hasOwn(current, p)
    )
      return undefined;
    current = (current as Record<string, unknown>)[p];
  }
  return current;
}
