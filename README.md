# Lloyd / RiskGraph backend and privacy gateway

A runnable TypeScript/Fastify underwriting backend and independent Python/FastAPI edge intake service. The authoritative rules are in [Federato_RiskGraph_TDD.md](Federato_RiskGraph_TDD.md). This workstream owns the backend, shared packages, tests and infrastructure; it does not modify `apps/web`.

## Run the offline demo

Requires Node **20.19+** (tested with Node 22.19) and Python **3.11+** (tested with Python 3.14.7). No API credentials, database, camera or OCR installation is needed for the text fixture.

```sh
npm ci
npm run dev
```

The API listens on `127.0.0.1:3001`. It discovers its fixture schema at startup. In another terminal:

```sh
curl -X POST http://127.0.0.1:3001/api/bootstrap
curl -X POST http://127.0.0.1:3001/api/ingest
curl 'http://127.0.0.1:3001/api/cases?limit=100'
curl -X POST http://127.0.0.1:3001/api/cases/demo-001/investigate
curl -X POST http://127.0.0.1:3001/api/cases/demo-001/simulate \
  -H 'Content-Type: application/json' \
  -d '{"changes":{"losses":{"complete":true,"items":[{"date":"2024-01-01","amount":24000}]}},"conditions":["Verify original loss runs"]}'
```

Ingestion creates 56 synthetic cases and is idempotent. `demo-001` initially requires complete loss history. The simulation moves it to `ACCEPT_WITH_CONDITIONS` while leaving its actual facts unchanged. Simulations are saved separately with `baseVersion`; no endpoint silently applies them as verified facts.

The backend workspace intentionally includes `apps/api` and `packages/*`, so it installs and tests with the independently owned web project absent. The frontend can proxy `/api` to port 3001. Requests have no permissive cross-origin policy; use a same-origin development proxy. No browser receives provider credentials.

## Edge gateway

```sh
python3 -m venv apps/edge-gateway/.venv
apps/edge-gateway/.venv/bin/pip install -e 'apps/edge-gateway[test]'
# Export the same pairing key in the API's environment before starting both services.
export RELEASE_APPROVAL_KEY='replace-with-a-random-pairing-key'
export EDGE_HUMAN_APPROVAL_TOKEN='replace-with-a-separate-human-credential'
apps/edge-gateway/.venv/bin/python -m gateway
```

The gateway binds only to `127.0.0.1:8001`. Set `EDGE_LOCAL_TOKEN` to require local Bearer authentication. Its sequence is:

1. `POST /capture` with `{"caseId":"demo-001","source":"fixture"}`.
2. `POST /documents/{documentId}/ocr`.
3. `POST /documents/{documentId}/redact` with `{}` or an explicit destination list.
4. `GET /documents/{documentId}/preview` to review the sanitized derivative and manifest.
5. `POST /documents/{documentId}/release` with `{"approve":true,"approvedBy":"reviewer-id"}` and `x-human-approval: <EDGE_HUMAN_APPROVAL_TOKEN>`.
6. `DELETE /documents/{documentId}/original` to erase the encrypted original, OCR and token map, preserving the sanitized manifest.

`release` is the only module that sends document content over the network. The destination URL is configured locally, never accepted in a request, and redirects are disabled. The gateway signs approval with `RELEASE_APPROVAL_KEY`; the backend verifies that signature before accepting low confidence. The signature binds document ID, case ID, hash, confidence, destinations and reviewer/time.

Fixture and upload capture use the same manifest. Upload accepts base64 `text/plain`, PNG or JPEG with a 10 MB decoded limit. Camera capture uses optional OpenCV. Install `pip install -e 'apps/edge-gateway[vision]'` and the system Tesseract executable for real camera/image OCR. OpenCV performs quadrilateral cropping, perspective correction and blur/glare measurements. Pillow provides a conservative image fallback. PaddleOCR is an optional adapter requiring separately installed, **local** detection and recognition model directories; automatic model acquisition is not part of intake.

Pattern detection covers email, phone, government-ID formats, payment-number patterns, secrets, labeled policy/claim/employee identifiers, names, signatures, addresses, birth dates and configurable extra patterns. Case-scoped HMAC tokens remain stable only inside one case. Additional NER/sensitive-span detectors can only add redactions. Without calibrated region detection, image previews black out the whole page and the outbound artifact is sanitized text. Pattern-only detection is capped at 0.90 confidence, so human approval is mandatory. This is a deliberate working safety boundary, not a claim of complete automated PII recognition. No local LLM is required or enabled.

Local data uses Fernet authenticated encryption, a mode-0600 key, a mode-0700 directory, atomic writes and a default 24-hour retention. Expired originals are purged every 30 seconds while running and on access after restart. The local key resides on the device; this is not hardware-backed key custody. Deletion removes encrypted records' sensitive fields, not guaranteed physical disk erasure.

### Release contract v2 (`Lloyd_Edge_Cloud_TDD_v2.md`)

v2 is the target pipeline; v1 above stays available for existing callers. The board owns capture, perspective/quality assessment, OCR with layout, **local** classification and semantic detection, sanitization, hint generation, and a revision-bound signed approval. The cloud owns acceptance, case association, typed extraction and search. Nothing is released before an authenticated reviewer approves the exact revision they saw.

```
POST   /v2/intakes                       {caseId?, destinations}          -> CAPTURED, revision 1
POST   /v2/intakes/{id}/pages            {source:"camera"} | {source:"upload",contentBase64,mediaType}
POST   /v2/intakes/{id}/case             {revision, caseId}               changing the case is a new revision
POST   /v2/intakes/{id}/analyze                                           OCR -> quality -> classify -> detect -> sanitize -> hints
GET    /v2/intakes/{id}/status                                            bounded status incl. model identity/capabilities
GET    /v2/intakes/{id}/review           local client only                sanitized blocks, fields, pages, proposed manifest
POST   /v2/intakes/{id}/redactions       {revision, blockIds}             operator redaction = new revision
POST   /v2/intakes/{id}/approve          {revision, acknowledgedQuality}  x-human-approval; signs manifest with device + reviewer keys
POST   /v2/intakes/{id}/release                                           revalidates, checks clock skew, sends the identical envelope; retry-safe
DELETE /v2/intakes/{id}/originals                                         erases raw pages/OCR/token map; sanitized audit remains
```

State machine: `CAPTURED → PREPROCESSED → OCR_COMPLETE → ANALYZED → SANITIZED → REVIEW_READY → APPROVED → RELEASE_PENDING → ACCEPTED`, with branches `RECAPTURE_REQUIRED`, `LOCAL_MODEL_UNAVAILABLE`, `BLOCKED`, `RELEASE_FAILED`, `ORIGINAL_EXPIRED`. Any change to inputs or derivatives increments `revision` and discards approval. Quality is a versioned policy (`PASS`/`REVIEW`/`RECAPTURE` with reasons such as `BLUR`, `GLARE_OCCLUSION`, `CLIPPED_PAGE`, `PERSPECTIVE_UNCERTAIN`, `EMPTY_OCR`, `UNCALIBRATED_POLICY`); glare is detected from saturated blobs brighter than the surrounding page, so ordinary white paper is not glare. OCR keeps words, lines, boxes and column order so a safe field next to a sensitive one survives (`Contact: [TOKEN] | Year built: 2016` keeps the year).

Local AI: `gateway/inference.py` loads a digest-pinned classifier artifact (`EDGE_CLASSIFIER_PATH`/`_SHA256`, trained offline with `scripts/train-edge-classifier.py`, seven document classes + abstention) and a digest-pinned spaCy NER detector (`EDGE_DETECTOR_PATH`/`_SHA256`). Model output is sanitized to the closed schema before it can influence anything; a missing or mismatched artifact makes the capability `UNAVAILABLE` and blocks the pipeline — there is no regex fallback masquerading as a model. `/health` reports per-capability readiness with model IDs and artifact digests; the old single `localLLM` flag is gone.

Release envelope: `{manifest, artifacts:[{id,mediaType:"text/plain",text}], authentication:{keyId,algorithm:"HMAC-SHA256",signature,reviewerSignature}}`. The manifest carries tenant/device IDs, revision, closed-enum classification with model identity, privacy-safe match hints (`documentType`, `riskState`, `lineOfBusiness`, `yearRange`, `tivBucket`), quality, per-block artifact descriptors with page/box provenance, destinations and the approval window. Signatures are HMAC over RFC 8785 canonical JSON of the manifest; `packages/contracts/fixtures/intake-v2.golden.json` is generated by Python and verified byte-for-byte by TypeScript (`npm run generate:v2`).

Boundaries: raw preview and `/review` are served only to a directly paired local client. Requests carrying `Via`/`X-Forwarded-*` are refused for those routes, browser origins must be listed in `EDGE_ALLOWED_ORIGINS`, and the gateway compares its clock with the backend `Date` header before releasing. Deployment hardening (systemd sandbox, nftables egress restricted to the backend host, versioned bundles with SHA-256 manifests, rollback) lives in `infra/edge/`; build a bundle with `npm run bundle:edge -- build --version <v> --out dist/edge-bundle --model <classifier.json> --detector <ner-dir>`.

## Modules and decisions

- `packages/engine`: eight TDD rules, provenance, exact boundary classification, scoring, queue order, Path to Yes and isolated simulation.
- `packages/contracts`: strict privacy, approval, preference and telemetry schemas shared by the TypeScript services. `gateway/contracts.py` implements the compatible Python wire contract.
- `packages/integrations/schema.ts`: schema graph, concept candidates, stage/type/operator validation, expansion and array-boundary repair.
- `packages/integrations/federato.ts`: OAuth client credentials, single-flight refresh five minutes early, four-hour cap, issuer/audience claim checks, one 401 retry, no POST redirects, normalized safe errors.
- `packages/integrations/data.ts`: Atlas current/versioned case state and precedent features; Elasticsearch BM25/vector retrieval with application-side reciprocal rank fusion; Tiger telemetry; approved Backboard preferences.
- `packages/integrations/models.ts`: sanitized Gemini candidate extraction, GPTZero authorship and claim support boundaries. Extracted numbers require exact excerpt support and valid units; model output never becomes a verified underwriting fact automatically.
- `packages/integrations/agent.ts`: schema-constrained Responses planner or scripted fallback, deterministic validation, 10-step cap, 6 query cap, 2 repair cap, 2 enrichment cap, 1 precedent lookup, and information-request drafts.
- `apps/api`: route contracts, startup discovery, ingestion, protected release, SSE investigation progress, snapshots and simulation records.
- `infra`: TimescaleDB migration/continuous aggregates and Atlas vector-index definition.

The appetite weights sum to 100. Under the documented status multipliers, an entirely favorable case scores **90**, because submission type, line of business, construction and loss have no target category. This follows the rule table, even though illustrative TDD screenshots show higher scores. A hard failure always remains out of appetite. The exact $100,000 loss and 1990 building-year boundaries require review; exactly 50% construction also requires review. Construction uses insured value, not building count. Losses use `[effective date − five calendar years, effective date)` and require complete history.

The TDD does not fully define opportunity/freshness normalization. This implementation documents linear premium shoulders around the target band and a 90-day freshness decay. Queue lanes take precedence over numerical scores; investigate cases then prioritize premium desirability and fewer blockers. These assumptions are returned with each decision.

## Configuration and live-service boundaries

Copy `.env.example` to `.env` for the Node server. Export variables separately for Python. **No variables are required for offline scoring.** Non-loopback API binding requires `API_TOKEN`. Low-confidence release requires the paired `RELEASE_APPROVAL_KEY` and edge human credential.

| Service | Configuration | Offline behavior | Live implementation / verification limit |
|---|---|---|---|
| Federato | `FEDERATO_CLIENT_ID`, `FEDERATO_CLIENT_SECRET`, `FEDERATO_MAPPING_FILE` | 56 synthetic submissions | Confirmed auth/data URLs from TDD; live HTTP and schema validation. Organizer schema/query wire shapes and encoding still require validation with credentials. No fixture field is promoted to production truth. |
| Atlas | `MONGODB_URI` | Versioned in-memory cases | MongoDB driver, current/versioned snapshots, `$vectorSearch`; apply `infra/atlas-vector-index.json`. Uses explicit eight-dimensional appetite features, not a hosted language embedding. |
| Elasticsearch | `ELASTICSEARCH_URL`, optional `ELASTICSEARCH_API_KEY` | Case-filtered lexical/semantic-vocabulary feature retrieval | Creates index/mapping, BM25 + kNN + RRF, state/time filters, provenance. The deterministic 32-dimensional vocabulary embedding is a demo representation. No external embedding provider is claimed. |
| Tiger Data | `TIGER_DATABASE_URL`, `TELEMETRY_HMAC_KEY` | In-memory allowlisted events | `pg` append-only events and hourly aggregate reads; apply `infra/tiger.sql`. Outage never prevents scoring. |
| Gemini | `GEMINI_API_KEY`, optional `GEMINI_MODEL` | Deterministic `Year built:` extraction, labeled fixture | Structured-output REST extraction from sanitized text. Current wire artifact is text; direct PDF/image extraction is not implemented. |
| OpenAI / Foundry planner | `PLANNER_PROVIDER` (`openai`\|`foundry`\|`scripted`), `OPENAI_API_KEY`, `OPENAI_MODEL`, `FOUNDRY_*` | Scripted bounded planner, labelled `scripted` in bootstrap | Responses API strict function proposal, no storage, only permitted context. Case query ID is replaced by a placeholder before model planning. An explicit provider without credentials is `unavailable` and investigations stop with `planner_unavailable`; the script never impersonates a live planner. |
| GPTZero | `GPTZERO_API_KEY`, optional `GPTZERO_URL` | Explicit `UNAVAILABLE`, never a fabricated detector clearance | Text authorship REST adapter; threshold can trigger review only when a versioned policy is enabled. Live account response compatibility remains unverified. |
| GPTZero claim support | `GPTZERO_CLAIM_SUPPORT_URL` and GPTZero key | Deterministic support gate, `NEEDS_REVIEW` when independent service is absent | Account-specific bridge contract `{claims,evidence,contentHash}` → `{status}`; public endpoint compatibility is **not assumed**. |
| Backboard | Explicit `new Backboard({url,key,assistantId})` | In-memory preferences | Optional REST memory adapter. Not enabled by API startup; only approved fixed-enum cross-case preferences are accepted. Account endpoint compatibility remains unverified. |

Optional authenticity policy: set both `AUTHENTICITY_POLICY_VERSION` and `AUTHENTICITY_REVIEW_THRESHOLD` (0–1). An `AUTHENTICITY_REVIEW` result may move an otherwise eligible case to `INVESTIGATE`; a detector score never creates an appetite rejection. Without the policy, detector results do not change decisions.

Live Federato startup accepts the normalized schema shape `{"resources":{"Resource":{"fields":{"field":{"type":"string|number|boolean|object|array|reference", ...}}}}}`. Object children use `fields`, arrays use `items`, and references use `targetResource` and `cardinality`. Unknown runtime formats fail closed. `/api/schema/mappings` exposes the graph and low-confidence mapping candidates. Supply a reviewed mapping file:

```json
{
  "schemaHash": "<hash returned by bootstrap>",
  "resource": "<runtime-confirmed resource>",
  "idPath": "<confirmed scalar identifier path>",
  "paths": {
    "accountName": "<confirmed path>",
    "premium": "<confirmed path>",
    "tiv": "<confirmed path>"
  },
  "confirmed": true
}
```

Unmapped facts remain unknown. Mapping paths must currently be directly queryable; reference/array query planning is available in the validator but nested live normalization needs the actual organizer sample records. Live normalized enum/loss/building structures must match the engine contract; no guesses are made about organizer codes, currency, premium basis or loss semantics. The internal query uses `expand: string[]`, alias-to-path `select`, and `pagination: {limit,offset}`; the wire adapter emits an expansion object. This dialect must be checked against the supplied organizer query PDF/live schema before calling the live integration verified. Fixture execution supports filtering, projection, sorting and pagination; expansion/unwind/reduction validation is tested separately.

No live provider credentials or physical RDK device were available for verification. Provider adapters have mocked transport/outage tests; the real network smoke test covers local Python-to-Node HTTP. Optional BPU acceleration, calibrated face/signature boxes, PDF intake, geocoding, ES|QL tools and production user/tenant identity are outside this implementation. Memory mode resets on restart; Atlas persists case history, manifests, candidate extraction results, investigations, actions and simulations. Sanitized document bodies remain process-local for model tools; manifests remain retrievable after restart. Run one API process: the mutation queue is not a distributed concurrency mechanism.

## Exact frontend API contract (v1)

All successes are JSON unless `Accept: text/event-stream` is requested for investigation. Failure shape is always `{"error":{"code":"CODE","message":"safe message"}}`; no raw provider bodies, stacks or submitted sensitive values appear in API errors. Typical statuses: 400 validation/hash/destination errors, 401 authentication, 403 missing trusted approval, 404 missing resource, 409 stale mapping/document conflict, 502 provider errors.

Stable envelopes:

| Endpoint | Request | Response envelope |
|---|---|---|
| `POST /api/bootstrap` | empty | `{status:"ready",mode,schemaHash,resources:string[],mappings:Mapping|null,unresolvedMappings:string[],services:{atlas,elastic,planner}}` |
| `POST /api/ingest` | empty | `{status:"complete"|"partial",mode,total,processed,created,updated,unchanged,warnings:string[]}` |
| `GET /api/cases` | `offset=0&limit=50`, optional `lane` | `{items:QueueRow[],total,offset,limit}` |
| `GET /api/cases/:id` | none | `{case:CaseRecord,pathToYes:PathAction[]}` |
| `POST /api/cases/:id/investigate` | empty | `{investigation:Investigation}` |
| `GET /api/cases/:id/investigations/:investigationId` | none | `{investigation:Investigation}` |
| `POST /api/cases/:id/simulate` | `{changes:Record<FactKey,unknown>,conditions?:string[]}` | `{simulation:{id,caseId,baseVersion,createdAt,label:"SIMULATION",changes,conditions,decision,pathToYes,changedCriteria:string[]}}` |
| `POST /api/cases/:id/actions/draft-information-request` | empty | `{action:{id,caseId,type:"REQUEST_INFORMATION",status:"DRAFT",questions:string[],createdAt}}` |
| `POST /api/intake/sanitized` | `SanitizedIntake` below; optional trusted `x-release-approval` | `{documentId,caseId,status:"ACCEPTED",sanitizedSha256,processing:Record<string,ProviderResult>}` |
| `POST /api/cases/:id/documents` | same intake; matching case required | same intake response |
| `GET /api/intake/:documentId/manifest` | none | `{manifest:ReleaseManifest}` |
| `POST /api/intake/v2` | `IntakeV2` envelope (25 MB limit) | `202 {status:"ACCEPTED",intakeId,revision,digest,receivedAt,association,processingStatus}`; identical retry `200 {status:"DUPLICATE",…}`; same identity/different content `409 INTAKE_DIGEST_CONFLICT`; older revision `409 STALE_REVISION`; policy/signature failures `403 <BOUNDED_CODE>`; `503 V2_NOT_CONFIGURED` without a policy |
| `GET /api/intakes` | `x-reviewer-id`; optional `status`, `limit` | `{items:IntakeView[],total}` — sanitized text only, scoped to the reviewer's tenant |
| `GET /api/intakes/:id` | `x-reviewer-id` | `{intake:IntakeView}` |
| `GET /api/intakes/:id/candidates` | `x-reviewer-id` | `{intakeId,revision,sufficientHints,candidates:[{caseId,accountName,score,reasons,decision}]}` — ranked from match hints over cases the reviewer may access; never auto-associates |
| `POST /api/intakes/:id/association` | `x-reviewer-id`; `{caseId,reason}` | `{intake:IntakeView}` — audited (`ASSOCIATED`/`REASSOCIATED`/`ASSOCIATION_CONFIRMED`); processing runs only when the case changes |
| `GET /api/intakes/:id/processing` | `x-reviewer-id` | `{intakeId,revision,status,association,processing:{elasticsearch?,gemini?,gptzero?}}` |
| `GET /api/schema/mappings` | none | `{schemaHash,schema,mappings:Mapping|null,candidates:Record<string,MappingCandidate[]>}` |
| `GET /api/analytics/summary` | none | `{analytics:{status:"AVAILABLE",mode:"memory",total,failures,averageDurationMs}}`, or live `{analytics:{status:"AVAILABLE",mode:"live",hourly:object[]}}`, or `{analytics:{status:"UNAVAILABLE",mode:"live"}}` |

Core object definitions (all timestamps ISO-8601; IDs are strings; money is numeric USD):

```ts
type Status = 'TARGET' | 'ACCEPTABLE' | 'NOT_ACCEPTABLE' |
  'UNKNOWN' | 'CONTRADICTED' | 'BOUNDARY_REVIEW';
type DecisionClass = 'IN_APPETITE' | 'INVESTIGATE' | 'OUT_OF_APPETITE' | 'ACCEPT_WITH_CONDITIONS';
type FactKey = 'accountName' | 'effectiveDate' | 'expirationDate' | 'submissionType' |
  'lineOfBusiness' | 'primaryState' | 'tiv' | 'premium' | 'buildingYear' | 'construction' | 'losses';
type Facts = Partial<Record<FactKey, {
  value: unknown; contradicted: boolean; alternatives?: unknown[];
  evidence: {id:string;source:'federato'|'fixture'|'human'|'gemini';path:string;observedAt:string;verified:boolean}[];
}>>;
interface Decision {
  class: DecisionClass;
  appetiteScore: number; priorityScore: number; completenessScore: number;
  opportunityScore: number; freshnessScore: number; confidence: number;
  criteria: {key:string;status:Status;weight:number;points:number;observed:unknown;
    evidenceIds:string[];clauseId:string;explanation:string}[];
  assumptions: string[];
}
interface CaseRecord {
  id:string;version:number;schemaHash:string;mode:'fixture'|'live';
  facts:Facts;decision:Decision;updatedAt:string;sourceHash:string;
  documentIntegrity?: {policy:string;status:'AUTHENTICITY_REVIEW'|'CLEAR'|'UNAVAILABLE';documentId:string};
}
interface QueueRow {
  id:string;version:number;account:{name:unknown};
  normalizedRisk:{primaryState:unknown;tiv:unknown;premium:unknown};
  decision:Decision;unresolvedQuestions:PathAction[];mode:'fixture'|'live';
}
interface PathAction {
  criterion:string;action:'VERIFY_OR_REFER'|'REQUEST_EVIDENCE';description:string;
  nearestAcceptableValue:number|null;
}
interface Investigation {
  id:string;caseId:string;status:'completed';stopReason:string;createdAt:string;
  steps:{sequence:number;tool:string;reason:string;status:string;resultCount:number;payloadHash:string;at:string}[];
  results:Record<string,unknown>;facts:Facts;decision:Decision;pathToYes:PathAction[];
}
```

Facts use normalized enum values (`new_business`, `renewal`, `property`, state postal codes). Construction is `[{tiv:number,construction:'joisted_masonry'|'noncombustible'|'steel'|'masonry_noncombustible'|'frame'|'other'}]`. Losses are `{complete:true,items:[{date:'YYYY-MM-DD',amount:number}]}`. Missing, malformed, incomplete or unverified facts never become favorable evidence.

Investigation SSE sends `event: step` with a step object, then `event: completed` with the standard investigation envelope; failures after stream opening emit `event: error` with `{code:"INVESTIGATION_FAILED"}`. Use POST `fetch` streaming, not a GET-only EventSource.

The privacy wire format intentionally uses a versioned strict contract rather than the illustrative TDD manifest's field names:

```ts
type Destination = 'lloyd-api'|'gemini'|'openai'|'gptzero'|'elasticsearch';
interface ReleaseManifest {
  version:1;documentId:string;caseId:string;sanitizedSha256:string;
  fields:{path:string;classification:'local_only'|'redacted'|'tokenized'|'generalized'|'cloud_allowed';method?:string;confidence:number}[];
  destinations:Destination[];confidence:number;createdAt:string;
  approval?:{approvedBy:string;approvedAt:string};
}
interface SanitizedIntake {
  manifest:ReleaseManifest;
  artifact:{mediaType:'text/plain';text:string};
}
```

Hash the exact UTF-8 `artifact.text` bytes with SHA-256, lowercase hex, without a `sha256:` prefix. Unknown properties, local-only fields, token maps, unauthorized destinations, sensitive patterns and hash mismatches are rejected. Any aggregate or field confidence below 0.95 requires trusted approval. The default backend document destination allowlist excludes OpenAI; its planner receives bounded normalized context through a separate server-side interface.

Provider results are discriminated by `status` or `outcome`: Gemini returns `{status:"CANDIDATE_UNVERIFIED",mode,documentId,contentHash,extraction:{document_type,candidate_facts:[{field,value,unit,page,supporting_excerpt,confidence}]}}` or `{status:"UNAVAILABLE",documentId}`. GPTZero returns `{documentId,contentHash,applicablePolicy,scannedAt,outcome:"CLEAR"|"AUTHENTICITY_REVIEW"|"UNAVAILABLE",score?,mode?,reason?}`. Elasticsearch ingestion returns `{status:"INDEXED"|"UNAVAILABLE"}`. Render unavailable providers explicitly, never as cleared checks.

### v2 contract and processing

`packages/contracts/src/intake-v2.ts` is authoritative; `apps/edge-gateway/gateway/intake-v2.schema.json` is generated from it so the gateway validates the envelope against the same schema before signing. `verifyV2` re-derives everything the gateway claims: schema and size limits, device/reviewer bindings and tenant, constant-time HMAC over RFC 8785 canonical JSON, approval window and clock tolerance, quality/model gates, destination policy, per-artifact SHA-256 and page/block provenance, then sensitive-pattern scanning per block and across block boundaries. Failures return a bounded code only. Identity is `sha256(tenantId, deviceId, intakeId, revision)`; the canonical digest of the whole envelope makes retries idempotent.

v2 processing per destination: Elasticsearch indexes one chunk per sanitized block with `tenantId`, `page`, `blockId`, and retrieval is filtered by tenant and case. Gemini (`packages/integrations/src/extraction-v2.ts`) returns typed tables — `sovRows`, `lossRunRows`, `inspectionFindings`, `totals` — where every row cites page + block IDs and a verbatim excerpt; numeric and text values must appear literally in that excerpt, placeholders are never read as values (such rows are `REDACTED`), totals are recomputed server-side, and the provider's document type is recorded next to the local classification as `classificationAgreement: AGREE|DISAGREE|LOCAL_UNAVAILABLE`. Results stay `CANDIDATE_UNVERIFIED`; a provenance failure is `REJECTED_PROVENANCE`, never a partial acceptance. GPTZero runs on the joined sanitized text under the same policy as v1.

## Verification

```sh
npm run check             # TypeScript, ESLint, Vitest (incl. cross-language golden + adversarial v2 tests)
npm run build
npm run format:check
npm run lint:edge
npm run test:edge         # gateway: image/layout regressions, local AI, v2 state machine, boundaries
npm run test:smoke        # disposable local Node API; v1 fixture release and full v2 flow over real HTTP
npm run generate:v2       # regenerate intake-v2.schema.json and the Python-signed golden fixture
npm audit
```

Frontend (`apps/web`): `npm run typecheck && npm run lint && npm test`.

Tests cover every listed appetite boundary, malformed/missing/contradicted facts, TIV weighting, loss windows, lane priority, simulation isolation, schema stages, array/reference repair, OAuth expiry/retry/redirects, hash and approval enforcement, canary leakage, strict telemetry/preferences, outages, provenance, retrieval isolation, API idempotency, SSE and edge retention. See [docs/CODEX_BUILD_LOG.md](docs/CODEX_BUILD_LOG.md) for concrete implementation/test improvements and commit evidence.

Provider implementation references: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output), [GPTZero developers](https://gptzero.me/developers). Account-specific contracts still need a live smoke test before deployment.

## Ask Lloyd and Evidence Constellation

Case-scoped cited chat, separate evidence and precedent maps, and an accessible ranked list are available at `/cases/:id/ask` and `/explore`. See [the Ask Lloyd runbook](docs/ask-lloyd.md) for the credential-free demo, authorization policy, live indexes, projection rebuilds, and evaluation commands.
