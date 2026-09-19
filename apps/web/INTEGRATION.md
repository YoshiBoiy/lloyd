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
| `NEXT_PUBLIC_LLOYD_EDGE_URL` | RDK / edge-gateway origin |

`MockLloydApi` (`lib/api/mock.ts`) is the demo brain. `HttpLloydApi` (`lib/api/http.ts`) is a thin fetch adapter for the TDD API surface.

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

Intake currently talks to the edge-gateway mock inside `MockLloydApi`. `HttpLloydApi` maps those calls to:

- `POST /capture`
- `POST /documents/current/ocr`
- `POST /documents/current/redact`
- `POST /documents/current/release`

Sanitized cloud handoff remains `POST /api/intake/sanitized` plus `GET /api/intake/:documentId/manifest` on the API. The UI never sends token maps, originals, or `LOCAL_ONLY` values.

## Seeded demo that must keep working after the switch

1. Scan the synthetic Harbor Mill inspection on `/intake`.
2. Enable the signature redaction (or explicitly approve low confidence).
3. Release to Gemini / OpenAI / GPTZero.
4. Open `case:harbor-mill`.
5. Run investigation (OpenAI, Federato, Gemini, Elasticsearch, Atlas, GPTZero).
6. Case moves to `INVESTIGATE`.
7. Simulate broker response and recalculate to `ACCEPT_WITH_CONDITIONS`.
8. Queue and `/analytics` update from the same in-memory (later server) store.

Minimum release confidence is `0.95`, matching the contracts package `MIN_RELEASE_CONFIDENCE`.
