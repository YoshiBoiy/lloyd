import { createHash } from "node:crypto";
import { NOTICE, type ExploreGraph } from "./contracts.js";
export interface Projection {
  version: string;
  dimension: number;
  mean: number[];
  components: number[][];
  explainedVariance: number[];
  sampleCount: number;
  createdAt: string;
}
export function normalize(v: number[]) {
  const n = Math.hypot(...v);
  return v.map((x) => (n ? x / n : 0));
}
export function cosine(a: number[], b: number[]) {
  if (a.length !== b.length) throw new Error("Vector spaces differ");
  const n = Math.hypot(...a) * Math.hypot(...b);
  return n ? a.reduce((s, x, i) => s + x * b[i]!, 0) / n : 0;
}
export function centroid(vectors: number[][], weights = vectors.map(() => 1)) {
  if (!vectors.length) return Array<number>(32).fill(0);
  const d = vectors[0]!.length;
  if (
    vectors.some((v) => v.length !== d || v.some((x) => !Number.isFinite(x))) ||
    weights.length !== vectors.length ||
    weights.some((w) => w <= 0)
  )
    throw new Error("Invalid centroid");
  return normalize(
    Array.from({ length: d }, (_, j) =>
      vectors.reduce((s, v, i) => s + v[j]! * weights[i]!, 0),
    ),
  );
}
/** Deterministic power iteration with deflation, fixed start vectors and sign convention. */
export function fitProjection(
  vectors: number[][],
  dimension: number,
  prefix: string,
): Projection {
  if (
    ![8, 32].includes(dimension) ||
    vectors.some(
      (v) => v.length !== dimension || v.some((x) => !Number.isFinite(x)),
    )
  )
    throw new Error("Invalid vector");
  const rows = [...vectors].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
  const mean = Array.from(
    { length: dimension },
    (_, j) => rows.reduce((s, v) => s + v[j]!, 0) / (rows.length || 1),
  );
  const covariance = Array.from({ length: dimension }, (_, i) =>
    Array.from(
      { length: dimension },
      (_, j) =>
        rows.reduce((s, v) => s + (v[i]! - mean[i]!) * (v[j]! - mean[j]!), 0) /
        Math.max(1, rows.length - 1),
    ),
  );
  const total = covariance.reduce((s, r, i) => s + r[i]!, 0),
    components: number[][] = [],
    explainedVariance: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    let v = normalize(
      Array.from({ length: dimension }, (_, i) =>
        Math.sin((i + 1) * (axis + 1)),
      ),
    );
    for (let iteration = 0; iteration < 100; iteration++) {
      let next = covariance.map((row) =>
        row.reduce((s, x, j) => s + x * v[j]!, 0),
      );
      for (const c of components) {
        const dot = next.reduce((s, x, j) => s + x * c[j]!, 0);
        next = next.map((x, j) => x - dot * c[j]!);
      }
      if (Math.hypot(...next) < 1e-12) {
        v = Array<number>(dimension).fill(0);
        break;
      }
      v = normalize(next);
    }
    const pivot = v.find((x) => Math.abs(x) > 1e-8);
    if (pivot && pivot < 0) v = v.map((x) => -x);
    const eigen = v.reduce(
      (s, x, i) => s + x * covariance[i]!.reduce((n, c, j) => n + c * v[j]!, 0),
      0,
    );
    components.push(v);
    explainedVariance.push(total ? Math.max(0, eigen / total) : 0);
  }
  const hash = createHash("sha256")
    .update(JSON.stringify({ mean, components }))
    .digest("hex")
    .slice(0, 12);
  return {
    version: `${prefix}-pca-v1-${hash}`,
    dimension,
    mean,
    components,
    explainedVariance,
    sampleCount: rows.length,
    createdAt: new Date().toISOString(),
  };
}
export function transform(p: Projection, v: number[]) {
  if (v.length !== p.dimension || v.some((x) => !Number.isFinite(x)))
    throw new Error("Projection dimension mismatch");
  const xyz = p.components.map((c) =>
    c.reduce((s, x, i) => s + x * (v[i]! - p.mean[i]!), 0),
  );
  return { x: xyz[0]!, y: xyz[1]!, z: xyz[2]! };
}
export function needsRebuild(
  p: Projection,
  vectors: number[][],
  growth = 0.25,
  drift = 0.35,
) {
  return (
    vectors.length >
      Math.max(p.sampleCount + 5, p.sampleCount * (1 + growth)) ||
    (vectors.length > 0 &&
      Math.hypot(
        ...p.mean.map(
          (x, j) => vectors.reduce((s, v) => s + v[j]!, 0) / vectors.length - x,
        ),
      ) > drift)
  );
}
export function graph(
  mode: ExploreGraph["mode"],
  p: Projection,
  items: Array<{
    id: string;
    label: string;
    type: string;
    vector: number[];
    relevance: number;
    cited: boolean;
    metadataPreview: Record<string, string | number | boolean>;
  }>,
  anchor?: { id: string; vector: number[] },
  threshold = 0.65,
): ExploreGraph {
  const visible = items.slice(0, anchor ? 149 : 150);
  const nodes = visible.map(({ vector, ...item }) => ({
    ...item,
    ...transform(p, vector),
  }));
  const candidates: Array<{ source: string; target: string; score: number }> =
    [];
  for (let i = 0; i < visible.length; i++)
    for (let j = i + 1; j < visible.length; j++) {
      const score = cosine(visible[i]!.vector, visible[j]!.vector);
      if (score >= threshold)
        candidates.push({
          source: visible[i]!.id,
          target: visible[j]!.id,
          score,
        });
    }
  const degree = new Map<string, number>();
  const edges: ExploreGraph["edges"] = [];
  for (const e of candidates.sort((a, b) => b.score - a.score)) {
    if ((degree.get(e.source) ?? 0) >= 3 || (degree.get(e.target) ?? 0) >= 3)
      continue;
    edges.push({ ...e, relationship: "SIMILARITY" });
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  if (anchor && !nodes.some((n) => n.id === anchor.id)) {
    nodes.push({
      id: anchor.id,
      label: mode === "evidence" ? "Question" : "Selected case",
      type: "anchor",
      relevance: 1,
      cited: false,
      metadataPreview: {},
      ...transform(p, anchor.vector),
    });
    for (const n of visible.slice(0, 10))
      edges.push({
        source: anchor.id,
        target: n.id,
        relationship: "QUERY_MATCH",
        score: cosine(anchor.vector, n.vector),
      });
  }
  return {
    mode,
    projectionVersion: p.version,
    nodes: nodes.slice(0, 150),
    edges: edges
      .filter(
        (e) =>
          nodes.slice(0, 150).some((n) => n.id === e.source) &&
          nodes.slice(0, 150).some((n) => n.id === e.target),
      )
      .slice(0, 300),
    notice: NOTICE,
  };
}
