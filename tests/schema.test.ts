import { expect, it } from "vitest";
import {
  SchemaGraph,
  type Query,
  type Schema,
} from "../packages/integrations/src/schema.js";
const schema: Schema = {
  resources: {
    Policy: {
      fields: {
        id: { type: "string" },
        premium: { type: "number" },
        buildings: {
          type: "array",
          items: { type: "object", fields: { year: { type: "number" } } },
        },
        insured: {
          type: "reference",
          targetResource: "Insured",
          cardinality: "one",
        },
        locations: {
          type: "reference",
          targetResource: "Location",
          cardinality: "many",
        },
      },
    },
    Insured: {
      fields: {
        name: { type: "string" },
        address: {
          type: "reference",
          targetResource: "Location",
          cardinality: "one",
        },
      },
    },
    Location: { fields: { state: { type: "string" } } },
  },
};
const graph = new SchemaGraph(schema);
const q = (extra: Partial<Query> = {}): Query => ({
  resource: "Policy",
  select: { id: "id" },
  expand: [],
  unwind: [],
  pagination: { limit: 5, offset: 0 },
  ...extra,
});
it("rejects nonexistent resources and paths", () => {
  expect(() => graph.validate(q({ resource: "fake" }))).toThrow();
  expect(() => graph.validate(q({ select: { x: "fake" } }))).toThrow();
});
it("rejects unsupported operators", () =>
  expect(() =>
    graph.validate(q({ where: { premium: { $grt: 0 } } })),
  ).toThrow());
it("rejects implicit array dot traversal", () =>
  expect(() =>
    graph.validate(q({ where: { "buildings.year": { $gt: 1990 } } })),
  ).toThrow(/elemMatch/));
it("accepts elemMatch at an array boundary", () =>
  expect(
    graph.validate(
      q({ where: { buildings: { $elemMatch: { year: { $gt: 1990 } } } } }),
    ),
  ).toBeTruthy());
it("requires reference expansion", () =>
  expect(() =>
    graph.validate(q({ filter: { "insured.name": "Example" } })),
  ).toThrow(/Expand/));
it("where cannot traverse expanded refs before expansion", () =>
  expect(() =>
    graph.validate(q({ expand: ["insured"], where: { "insured.name": "X" } })),
  ).toThrow());
it("accepts one reference expansion chain", () =>
  expect(
    graph.validate(
      q({
        expand: ["insured", "insured.address"],
        filter: { "insured.address.state": "PA" },
      }),
    ),
  ).toBeTruthy());
it("many reference needs elemMatch or unwind", () => {
  expect(() =>
    graph.validate(
      q({ expand: ["locations"], filter: { "locations.state": "PA" } }),
    ),
  ).toThrow();
  expect(
    graph.validate(
      q({
        expand: ["locations"],
        filter: { locations: { $elemMatch: { state: "PA" } } },
      }),
    ),
  ).toBeTruthy();
  expect(
    graph.validate(
      q({
        expand: ["locations"],
        unwind: ["locations"],
        select: { state: "locations.state" },
      }),
    ),
  ).toBeTruthy();
});
it("sort uses projected aliases", () => {
  expect(
    graph.validate(q({ select: { p: "premium" }, sort: { p: "desc" } })),
  ).toBeTruthy();
  expect(() =>
    graph.validate(q({ select: { p: "premium" }, sort: { premium: "desc" } })),
  ).toThrow();
});
it("rejects incorrect types and pagination", () => {
  expect(() =>
    graph.validate(q({ where: { premium: { $gt: "a" } } })),
  ).toThrow();
  expect(() =>
    graph.validate(q({ pagination: { limit: 1000, offset: 0 } })),
  ).toThrow();
});
it("unwind exposes array paths only downstream", () => {
  expect(
    graph.validate(
      q({ unwind: ["buildings"], filter: { "buildings.year": { $gt: 1990 } } }),
    ),
  ).toBeTruthy();
  expect(() =>
    graph.validate(
      q({ unwind: ["buildings"], where: { "buildings.year": { $gt: 1990 } } }),
    ),
  ).toThrow();
});
it("validates reduction input path and type", () => {
  expect(
    graph.validate(
      q({
        over: { total: { operator: "$sum", path: "premium" } },
        select: { total: "total" },
      }),
    ),
  ).toBeTruthy();
  expect(() =>
    graph.validate(
      q({
        over: { total: { operator: "$sum", path: "id" } },
        select: { total: "total" },
      }),
    ),
  ).toThrow();
});
it("repairs missing expansion without weakening predicate", () => {
  const repaired = graph.repair(q({ filter: { "insured.name": "Example" } }));
  expect(repaired.expand).toContain("insured");
  expect(repaired.filter).toEqual({ "insured.name": "Example" });
});
it("repairs array predicate using elemMatch", () =>
  expect(
    graph.repair(q({ where: { "buildings.year": { $gt: 1990 } } })).where,
  ).toEqual({ buildings: { $elemMatch: { year: { $gt: 1990 } } } }));
it("reports graph array and reference boundaries", () => {
  expect(graph.arrayBoundaries("Policy", "locations.state")).toEqual([
    "locations",
  ]);
  expect(graph.requiredExpansions("Policy", "insured.address.state")).toEqual([
    "insured",
    "insured.address",
  ]);
});
