# Ask Lloyd and Evidence Constellation

Implemented from `Lloyd_3D_Evidence_and_Chat_TDD.md`. The feature is available at `/explore` and `/cases/:id/ask`, with a link from each case workspace. It never updates underwriting facts or decisions.

## Clean offline demo

From the repository root:

```sh
npm ci
npm --prefix apps/web ci
npm run dev:ask-demo
```

In another terminal:

```sh
cd apps/web
LLOYD_API_URL=http://127.0.0.1:3101 LLOYD_NEXT_DIST_DIR=.next-ask-demo npm run dev -- --port 3100
```

Open `http://127.0.0.1:3100/explore`, select **Load synthetic demo**, then ask:

1. **What evidence contradicts sprinkler coverage?** Both the questionnaire and annex inspection are cited. Open either citation to focus the document and see its page and exact excerpt.
2. **Show similar accepted cases and explain how they resolved sprinkler uncertainty.** Three approved synthetic precedents include normalized risk differences and approved inspection/commissioning rationale. Switch to Precedents and pin two for comparison.
3. **What percentage of TIV is acceptable construction?** Returns `NOT_ENOUGH_EVIDENCE`; masonry wording does not establish a TIV-weighted percentage.

This demo starts in memory, does not read `.env`, does not contact live providers, and seeds only synthetic records through an offline-only endpoint. Repeat questions still execute the visible retrieval pipeline. No opaque prewritten chat responses bypass retrieval. Existing normal API deployments can use the same demo endpoint only when all live storage/Federato connections and custom Ask policy are absent.

## Live authorization and data

### Vercel synthetic demo

The Vercel project uses `apps/web` as its root, with source files outside that directory included. `apps/web/vercel.json` installs both the root and web dependencies. Set `LLOYD_HOSTED_DEMO=true` and `NEXT_PUBLIC_LLOYD_API_MODE=http` for a credential-free hosted demo. The same-origin API runs the existing Fastify app inside the Next.js function, streams its responses, and seeds synthetic evidence on each cold start. No backend URL or live provider credentials are needed. `.vercelignore` excludes local environment files, datasets, and build artifacts.

The banner identifies this as a shared synthetic workspace. Its in-memory cases, answers, and conversations can reset when Vercel starts or replaces an instance; this is not durable production storage or multi-user isolation. Do not enter real submissions. Camera capture still requires the local edge gateway. A live-data deployment must disable `LLOYD_HOSTED_DEMO` and configure an authenticated backend via `LLOYD_API_URL` and `API_TOKEN`, including the authorization requirements below.

Set `ASK_POLICY_FILE` to a JSON file containing the principal bound to the API's server-side bearer token:

```json
{
  "tenantId": "carrier-demo",
  "userId": "underwriter:demo",
  "caseIds": ["case:harrisburg-bindery", "case:approved-precedent"],
  "precedentAccess": true,
  "portfolioAccess": false,
  "retentionDays": 7
}
```

`caseIds: ["*"]` authorizes all cases **within that tenant**, not all tenants. Browser headers or planner text cannot select a different principal. The existing API uses a single server principal; multi-user hosting must bind a separately authenticated principal to each request before sharing this server token. Ask endpoints fail closed when live connections are configured without an Ask policy. The ordinary case workspace remains independent.

- `MONGODB_URI`: canonical `riskgraph.cases`, scoped by `tenantId` and authorized IDs.
- `ELASTICSEARCH_URL` / `ELASTICSEARCH_API_KEY`: sanitized chunks in `risk-evidence-v1`. Evidence queries apply tenant, case, type and timestamp predicates to **both** lexical and dense retrieval before application-side RRF.
- `FOUNDRY_PROJECT_ENDPOINT`, `FOUNDRY_AGENT_ID`, `FOUNDRY_API_KEY`: optional bounded planner and extractive answer generator, using the repository's existing Foundry Responses protocol. No evidence body is supplied to planning. Answer input is a compact, sanitized packet; no model has database tools.

New ingestion attaches tenant metadata and persists `riskProfile8` / `riskProfileVersion`. Existing records without tenant metadata are deliberately inaccessible in live Ask requests. Migrate those records from a trusted tenant assignment; never infer tenancy from a browser request. Install `infra/atlas-ask-vector-index.json` on the `cases` collection. The current-case collection's unique `id` index excludes superseded versions; runtime checks also deduplicate versions and exclude the source case.

`risk-v1` uses explicit categorical encodings and fixed numeric scales in `packages/ask/src/risk.ts`. Missing/contradicted dimensions use `-1` plus named missingness metadata, never a favorable zero. Original-space cosine is used for ranking and edges. This metric is navigation context, not an appetite score.

## Grounding and failure behavior

Every model plan is parsed through strict Zod contracts and compiled against the immutable server scope. Limits: three operations, twenty chunks, ten documents, five precedents, one answer repair, one shared eight-second deadline.

The answer gate is deliberately conservative: each factual claim must be a verbatim statement from an accessible source excerpt, with all cited IDs accessible. Keyword overlap alone never counts as support. The deterministic fallback composes the same verified excerpts. If a configured answer model fails, the UI shows retrieved sources without pretending a generated answer succeeded. Unknown facts return insufficiency; contradicted records remain explicitly labeled. Operational questions are directed to the analytics screen.

Questions and model packets pass the existing sanitized-text gate before use or persistence. Evidence is untrusted data. Maps contain labels, bounded metadata and coordinates, not full document text. Source details are fetched with an answer ID and reauthorize the saved scope. Only approved normalized historical rationale is used for precedent explanation; raw cross-case submissions are not exposed.

If Atlas is unavailable, a circuit breaker keeps new chat history in bounded, expiring process memory and labels it temporary; queued writes retry after recovery. Such temporary history does not survive a server restart. Durable deletion failures are reported rather than silently claiming success.

Each answer stores authorization scope, retrieval IDs, prompt/model versions, trace, and compact source passages. Sessions retain short history excerpts rather than full documents. Retention is configurable from one to ninety days, defaults to seven, uses MongoDB TTL indexes plus a periodic cleanup, and is enforced immediately on reads. `DELETE /api/ask/sessions/:id` removes its answers and traces too. Concurrent writes and deletion during an active question are rejected.

## Projections and rendering

Separate deterministic PCA transforms are persisted in Atlas (or the offline store), scoped by tenant and authorized corpus. Evidence centroids use all available authorized document chunks rather than only matching passages. Query results use the existing transform; new questions do not refit it. Risk and text vectors cannot share a projection. Explained variance, corpus count and transform version are available through projection endpoints.

The projection snapshot is bounded to 1,000 chunks/cases per scope. Growth of 25% (at least five items), or mean drift over 0.35, requests a rebuild. To inspect/rebuild a scope using its stored authorization policy:

```sh
npm run projection:evidence -- case:harrisburg-bindery --force
npm run projection:precedents -- case:harrisburg-bindery --force
```

Without `--force`, scripts rebuild only when thresholds are exceeded. The precedent rebuild also backfills versioned risk vectors on authorized canonical cases. Run these commands on the deployment's maintenance schedule. Prior transform versions remain available for audit. The renderer transitions node positions after graph changes; PCA scores and similarity edges always come from the original space.

The React Three Fiber scene uses instanced node/halo meshes and batched wide-line geometry. It caps nodes at 150 and edges at 300; similarity degree is at most three, and query anchors connect to at most ten returned nodes. Evidence color indicates source type, size indicates relevance, and halos mark citations. Precedent color indicates decision and halos indicate human approval. Edge widths encode original-space similarity. Provenance edges, when supplied, are dashed. Clicking a citation focuses and briefly pulses its node. Shift-click or the accessible Pin button adds a comparison. Reset restores answer filters and camera. Source filters apply the same set to the graph and ranked list.

The list remains available alongside the scene and is the default on small screens, reduced-motion settings, WebGL failures, and missing projections. List controls provide selection, pinning, source references, and comparisons without 3D. Model/provider failures leave ordinary case pages usable.

## Verification

```sh
npm run check
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web test
npm run evaluate:ask
LLOYD_NEXT_DIST_DIR=.next-ask-build npm --prefix apps/web run build
```

`tests/ask.test.ts` covers scope rejection, arbitrary-query rejection, privacy canaries, honest insufficiency, support checking, repair budgets, partial retrieval failures, deadlines, chunk provenance, missingness, version exclusion, deterministic PCA, original-space edges, graph bounds, streaming, source details and deletion. Web tests cover citation-to-page navigation, ranked-list filtering, pinning, source reference insertion and interrupted streams.

The evaluation uses 18 labeled synthetic questions across all eight intents, reporting Recall@10, MRR, citation precision, claim coverage, intent routing, insufficiency correctness and median latencies. These are fixture measurements, not claims about live-corpus accuracy. Provider connectivity and laptop frame-rate targets require validation in the target deployment; they are not inferred from unit tests.
