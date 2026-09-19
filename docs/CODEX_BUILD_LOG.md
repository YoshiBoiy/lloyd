# Codex build evidence

Date: 2026-09-19. Workstream: `codex/backend-edge`.

The task began with only README.md in the repository. The user then supplied `Federato_RiskGraph_TDD.md`; it was read completely and preserved. No files under `apps/web` were authored or edited by this workstream.

## Improvement 1: per-field privacy confidence and approval binding

**Problem.** The initial manifest validator checked aggregate confidence. A manifest could claim 0.99 overall while admitting 0.10 confidence for one field. A body-only reviewer identity also cannot establish that a human approved a release. An early signature design bound the artifact but did not bind its case or provider destinations.

**Task.** Review the intake contract for low-confidence release bypasses and add negative tests with sensitive canaries.

**Change.** The shared validator requires authenticated approval if either aggregate or any field confidence is below 0.95. The edge requires a distinct human credential, then signs the document ID, case ID, sanitized hash, confidence, sorted destinations and reviewer/time. The API verifies the signature and exact UTF-8 hash. Unknown fields and token maps fail strict schema validation. Release remains the gateway's sole outbound path.

**Verification.** Vitest tests reject low-field-confidence/high-aggregate manifests, body-only approvals, hash changes, forbidden destinations, local-only fields, token maps, email/government-ID/secret canaries, and unsupported cited claims. Python tests exercise capture through local redaction, block unauthenticated release, assert encrypted disk storage and canary-free outbound content, and test retention. A real HTTP smoke test verifies Python and TypeScript serialization, hash and signature interoperability through successful sanitized Gemini fixture extraction.

**Commit reference.** Implementation commit will be recorded after commit creation below.

## Improvement 2: exact thresholds and safe query repair

**Problem.** Building year 1990, losses exactly $100,000 and exactly 50% acceptable construction must not be rounded into favorable outcomes. Raw array dot paths and post-reference filters also cannot be sent as valid Federato queries.

**Change.** Pure deterministic rules return boundary review at ambiguous endpoints, weight construction by TIV, and calculate dated five-year losses. Schema graph validation enforces stage availability and array/reference semantics; repair wraps array predicates in `$elemMatch` and adds required expansions without weakening the predicate. Case-scoped query IDs are replaced with a placeholder before model planning. Unknown and contradictory evidence remains explicit; conflicting observed values are retained as alternatives.

**Verification.** Every threshold enumerated in the TDD is tested. Additional tests prove hard failures survive high scores, lane ordering dominates score, malformed/unverified data stays unknown, zero/incomplete loss history is not favorable, counterfactuals do not mutate facts, missing evidence can be resolved into a new case version, conflicts remain preserved, repeated tool calls stop at the budget, and SSE completes with the standard response envelope.

## Implemented and verified locally

- Root npm workspace, strict TypeScript, Fastify API and all named application routes.
- Independently runnable FastAPI privacy gateway with fixture capture, encrypted retention, local OCR adapters and explicit release.
- Deterministic engine, schema graph, OAuth refresh/retry, model boundaries, persistence/retrieval/telemetry/preferences adapters, bounded planner.
- 56-case offline demo, idempotent ingestion, draft information requests and saved counterfactuals.
- README: exact frontend contracts, environment variables, setup and explicit live/hardware limitations.

Commands: `npm ci`, `npm run check`, `npm run build`, `npm run format:check`, `npm run lint:edge`, `npm run test:edge`, `npm run test:smoke`, `npm audit`.

No live credentials or RDK hardware were available. Provider transport tests use mocks, and local interoperability uses real HTTP. The live Federato schema/query dialect, nested concept normalization and account-specific GPTZero/Backboard contracts require organizer/account verification. Camera/BPU acceleration, calibrated image-region redaction, direct PDF extraction, geocoding and ES|QL are not represented as verified features. The current release artifact is sanitized text; image preview uses full-page blackout when precise region detection is unavailable. Optional providers report unavailable without inventing a result. The two upstream Starlette/httpx test-client deprecation warnings do not affect test results.
