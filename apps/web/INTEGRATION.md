# Lloyd web integration notes

This app is independently runnable from `apps/web` against typed fixtures. It must not import unfinished packages from `packages/**` until the integration pass.

## Run locally

```bash
cd apps/web
npm install
npm run dev
```

Default mode is mock. No Federato, Gemini, OpenAI, GPTZero, Elasticsearch, Atlas, Tiger Data, or RDK credentials are required.

## Client switch

| Env var | Purpose |
|---|---|
| `NEXT_PUBLIC_LLOYD_API_MODE=mock\|http` | Factory in `lib/api/index.ts` |
| `NEXT_PUBLIC_LLOYD_API_URL` | Backend origin for `HttpLloydApi` |
| `NEXT_PUBLIC_INTAKE_CONTRACT=v1\|v2` | Which intake UI `/intake` renders (`components/intake/IntakeEntry.tsx`); default `v2` in `http` mode, `v1` in mock |
| `NEXT_PUBLIC_EDGE_GATEWAY_URL` | Direct pairing origin of the RDK X5 gateway for v2 (browser → board on the LAN). Unset ⇒ same-origin proxy, which cannot preview or approve |
| `NEXT_PUBLIC_LLOYD_REVIEWER_ID` | `x-reviewer-id` sent to the backend inbox routes |
| `NEXT_PUBLIC_INTAKE_SOURCE=camera\|fixture\|upload` | v1 secure-intake capture source in `http` mode (default `camera`) |
| `EDGE_GATEWAY_URL` *(server-only)* | Where `app/api/edge/[...path]/route.ts` actually reaches the RDK X5 gateway |
| `EDGE_LOCAL_TOKEN`, `EDGE_HUMAN_APPROVAL_TOKEN` *(server-only)* | Gateway pairing/approval tokens, injected by the proxy — never sent to the browser |

`MockLloydApi` (`lib/api/mock.ts`) is the demo brain. `HttpLloydApi` (`lib/api/http.ts`) is a thin fetch adapter for the TDD API surface. See `.env.example`.

## Temporary type duplication

Frontend contracts live in `lib/api/types.ts`. They duplicate the TDD application API and privacy-manifest shapes so this branch does not import `@lloyd/contracts`.

Replace during integration:

- `lib/api/types.ts` → `@lloyd/contracts` / generated OpenAPI types
- `lib/appetite.ts` → `@lloyd/engine` (keep UI formatting only)
- Fixture IDs in `lib/fixtures/*` → real case IDs from `POST /api/ingest`

## Backend routes the HTTP client already targets

From `Federato_RiskGraph_TDD.md` §15, `HttpLloydApi` expects:

- `POST /api/bootstrap`
- `GET  /api/cases`
- `GET  /api/cases/:id`
- `POST /api/cases/:id/investigate`
- `GET  /api/cases/:id/investigations/:investigationId`
- `POST /api/cases/:id/simulate`
- `POST /api/cases/:id/actions/draft-information-request`
- `GET  /api/analytics/summary`

Frontend-only endpoints used by the mock today; wire or alias these on the API:

- `POST /api/cases/:id/override`
- `POST /api/cases/:id/notes`
- `POST /api/cases/:id/authenticity`
- `GET  /api/guidelines`
- `GET  /api/activity`

Intake talks to the edge-gateway mock inside `MockLloydApi` by default. In `http` mode, `HttpLloydApi` drives the real RDK X5 wire contract (per-document IDs, not `current`) through the same-origin proxy:

- `POST /api/edge/capture` — `{caseId, source: "camera"|"fixture"|"upload"}`; falls back to `fixture` if the camera capture errors (no board/`/dev/video*` reachable)
- `POST /api/edge/documents/:id/ocr`
- `POST /api/edge/documents/:id/redact` — `{destinations}`
- `GET  /api/edge/documents/:id/preview`
- `POST /api/edge/documents/:id/release` — `{approve, approvedBy}`

Two real-contract gaps the UI adapts to rather than papering over: the gateway never returns raw pixels or unredacted OCR text (so `IntakeDocument.originalText` holds the *sanitized* text in live mode, and the "Original" panel shows capture metadata instead of pixels), and its `PrivacyField` manifest entries are path-labeled with no character offsets (so live redactions render read-only via `manifestFields`, not as the mock's toggleable `spans`). Per-field toggling and manual redaction add are mock-only; `HttpLloydApi` rejects them with a clear error rather than silently no-op-ing.

Sanitized cloud handoff remains `POST /api/intake/sanitized` plus `GET /api/intake/:documentId/manifest` on the API. The UI never sends token maps, originals, or `LOCAL_ONLY` values.

### Release contract v2 (`Lloyd_Edge_Cloud_TDD_v2.md`)

`components/intake/IntakeV2View.tsx` drives the gateway's `/v2/intakes/*` routes through `lib/api/edge-v2.ts`. Two transports:

- **Direct pairing** (`NEXT_PUBLIC_EDGE_GATEWAY_URL` set): the browser talks to the board on the LAN; the operator enters the pairing token and reviewer token in the UI (sessionStorage only). This is the only transport that can stream `/preview/stream`, read `/review` (sanitized blocks, fields, page thumbnails), add redactions, and `approve`. The gateway must list the app origin in `EDGE_ALLOWED_ORIGINS`.
- **Proxy** (`/api/edge/*`): capture/analyze/status/release relay; `review`, `preview`, `preview/stream` return `403 DIRECT_PAIRING_REQUIRED`, and every forwarded request carries `Via` so the gateway refuses privileged routes even if the proxy were misconfigured. The view explains this rather than showing an approve button that cannot work.

The view renders bounded state (`stage`, `revision`, quality status + reasons, closed-enum classification with model identity/digest, match hints, per-capability health), never raw pixels or unredacted OCR. Every edit bumps `revision`; approve and release always name the revision the reviewer saw. `DELETE /originals` is offered after `ACCEPTED`.

### Intake workspace (`Lloyd_Intake_Workspace_TDD.md`)

The operator queue (`/intake/inbox`, `components/intake/IntakeWorkspaceView.tsx` with `IntakeDetailPanel.tsx`) merges two trust domains in the browser, because only the browser legitimately sees both: `GET /api/edge/v2/intakes` (device stages, bounded metadata) and `GET /api/intakes` plus `GET /api/intakes/rejections` (cloud statuses and refused releases). `lib/api/intake-work.ts` projects the fourteen device stages and four backend statuses onto six queues — Ready to Scan, Processing, Needs Privacy Review, Unmatched, Attached, Failed — so every item appears exactly once, chosen by who must act next. A domain that does not answer yields `null` counts rendered as unknown, never zero.

Per-queue actions: `getIntakeCandidates / associateIntake` for Unmatched (ranked from privacy-safe hints with reasons, recorded with the rank the reviewer chose from), `retryIntakeProcessing` for an attached document whose provider was unavailable, and `retryIntakeRelease` for a transport failure only — a digest conflict needs a new intake, since a released revision is immutable. Review data itself never crosses the proxy, so `Needs Privacy Review` links into the device session at `/intake?intake=<id>`, which is also how a reloaded browser recovers in-flight work.

The proxy allowlist lives in `lib/edge-proxy.ts` (`RELAYABLE_ROUTES`): the enumeration route is relayed because it carries no document content, `review` / `preview` / `preview/stream` stay direct-pairing-only, and an unknown route is refused rather than forwarded. Cases hold several documents: `CaseDetail.documents` (also `GET /api/cases/:id/documents`) lists type, pages, revision, digest and attribution per scan, and attaching one never promotes a fact on its own. `MockLloydApi` seeds device rows, one accepted release and one rejection so all six tabs, including Failed, work offline; `setDeviceReachable(false)` demonstrates unknown counts.

Intake is case-scoped at capture time, which is the only place the choice exists: the gateway releases to one fixed destination (`EDGE_BACKEND_URL`) and the API validates `manifest.caseId` against a real case. `/cases/:id/intake` scans into that case; `/intake` is the unscoped entry for documents that arrive before anyone has picked one, and currently stands in the seeded demo case. `getIntake(caseId)` restarts an idle document whenever the requested case differs from the one in flight, so a reviewer moving between cases never releases case A's scan into case B.

## Seeded demo that must keep working after the switch

1. Scan the synthetic Harbor Mill inspection on `/intake` (or from the case itself via `/cases/case:harbor-mill/intake`).
2. Enable the signature redaction (or explicitly approve low confidence).
3. Release to Gemini / OpenAI / GPTZero.
4. Open `case:harbor-mill`.
5. Run investigation (OpenAI, Federato, Gemini, Elasticsearch, Atlas, GPTZero).
6. Case moves to `INVESTIGATE`.
7. Simulate broker response and recalculate to `ACCEPT_WITH_CONDITIONS`.
8. Queue and `/analytics` update from the same in-memory (later server) store.

Minimum release confidence is `0.95`, matching the contracts package `MIN_RELEASE_CONFIDENCE`.
