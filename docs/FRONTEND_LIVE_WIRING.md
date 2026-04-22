# Frontend Live Wiring + Visual Regression Hooks

The Figma-generated frontend project is now present at:

- `docs/Flow Frontend`

## 1. Current Live Wiring Coverage

Map frontend data modules to backend endpoints:

- auth context: `GET /auth/context`
- clinic/facility boot data: `GET /admin/clinics`, `GET /admin/facility-profile`
- incoming ops: `GET /incoming`, `POST /incoming/import`, `POST /incoming/:id`, `POST /incoming/:id/disposition`
- encounter board + detail: `GET /encounters`, `GET /encounters/:id`, mutation endpoints under `/encounters/*`
- tasks: `GET|POST|PATCH|DELETE /tasks`
- safety: `GET /safety/word`, `POST /safety/:encounterId/activate`, `POST /safety/:encounterId/resolve`
- dashboard aggregates: `GET /dashboard/office-manager`, `GET /dashboard/revenue-cycle`
- dashboard history rollups: `GET /dashboard/office-manager/history`
- realtime updates: `GET /events/stream` (SSE)

Implemented in frontend:

1. `encounter-context` live encounter/incoming/task wiring with SSE + polling fallback.
2. `checkin-view` live check-in flow and incoming reconciliation.
3. `safety-assist-modal` live safety word retrieval + activation.
4. `office-manager-dashboard` live pipeline/KPIs/alerts/rooms/providers from backend data.
5. `revenue-cycle-view` live workbench rows and stats from encounter/task/admin/dashboard endpoints.
6. `admin-console` live hydration for facilities/clinics/users/rooms/reasons/templates/thresholds/notifications/assignments.

## 2. DTO Compatibility Notes

The backend now supports frontend aliases:

- response alias: `status` mirrors `currentStatus` on encounter payloads
- response aliases: `providerName`, `reasonForVisit`, `roomName`, `maName`
- request aliases for cancel action: `closureType`, `closureNotes`

## 3. Run Live Wiring Verification Hook

From this repo root:

```bash
FRONTEND_API_BASE_URL=http://localhost:4000 \
pnpm frontend:verify-live
```

The hook executes these frontend scripts if present:

- `test:contract`
- `test:visual`
- `test:e2e-live`
- `test:e2e-browser`

Recommended for authenticated verification:

```bash
FRONTEND_API_BASE_URL=http://localhost:4000 \
VITE_DEV_USER_ID=<existing-admin-user-id> \
VITE_DEV_ROLE=Admin \
FRONTEND_E2E_PORT=4173 \
pnpm frontend:verify-live
```

JWT mode (pilot/staging) verification:

```bash
FRONTEND_API_BASE_URL=https://<staging-api-host> \
FRONTEND_BEARER_TOKEN=<valid-admin-jwt> \
pnpm frontend:verify-live
```

Durable proof-header mode (preferred for staging verification):

```bash
FRONTEND_API_BASE_URL=https://<staging-api-host> \
FRONTEND_PROOF_USER_ID=<existing-admin-user-id> \
FRONTEND_PROOF_SECRET=<AUTH_PROOF_HEADER_SECRET from the staging web app> \
FRONTEND_PROOF_HMAC_SECRET=<AUTH_PROOF_HMAC_SECRET from the staging web app> \
FRONTEND_PROOF_ROLE=Admin \
pnpm frontend:verify-live
```

Frontend runtime env values (in `docs/Flow Frontend`):

- `VITE_API_BASE_URL` (default `http://localhost:4000`)
- `VITE_PROOF_USER_ID` (optional; durable proof auth for staging verification)
- `VITE_PROOF_ROLE` (optional; defaults to `Admin` for proof auth)
- `VITE_PROOF_SECRET` (optional; shared proof secret configured in backend app settings)
- `VITE_PROOF_HMAC_SECRET` (optional; required when proof-header HMAC signing is enabled in backend app settings)
- `VITE_BEARER_TOKEN` (optional; used by live verification scripts in JWT mode)
- `VITE_ENABLE_DEV_HEADERS` (optional; default `true` in local dev, `false` in production builds)
- `VITE_ENABLE_DEV_HEADER_LOGIN` (optional; default `true` in local dev, `false` in production builds unless `VITE_DEV_USER_ID` is present)
- `VITE_DEFAULT_AUTH_MODE` (optional; `bearer` or `dev_header`)
- `VITE_DEV_USER_ID` (optional; required only for backend dev-header auth)
- `VITE_DEV_ROLE` (optional; required only for backend dev-header auth)
- `FRONTEND_E2E_PORT` (optional; default `4173` for browser preview checks)

## 4. CI + Staging Pipeline Wiring

GitHub Actions workflows:

1. `.github/workflows/ci.yml`
   - Runs backend lint/typecheck/test/build.
   - Seeds local DB, resolves a seeded Admin user ID, starts backend on `:4100`, then runs full `pnpm frontend:verify-live` with authenticated env values.

2. `.github/workflows/staging-live-verify.yml`
   - Manual (`workflow_dispatch`) staging verification against your staging API.
   - Requires:
     - `vars.STAGING_FRONTEND_API_BASE_URL`
     - `secrets.STAGING_VITE_DEV_USER_ID` for the proof identity user id
     - Azure OIDC workflow variables so the job can read `AUTH_PROOF_HEADER_SECRET` and `AUTH_PROOF_HMAC_SECRET` from the staging web app app settings
   - Optional:
     - `vars.STAGING_VITE_DEV_ROLE` (defaults to `Admin`)
     - `vars.STAGING_FRONTEND_E2E_PORT` (defaults to `4173`)

## 5. Visual Regression Requirement

To close MVP item #10, the frontend repo must maintain baseline snapshots of key screens and validate that API rewiring does not alter visual output.

Recommended baseline screens:

1. Incoming Ops list + invalid rows state
2. Encounter board across all statuses
3. Encounter detail panel + rooming/clinician/checkout forms
4. Office manager and revenue cycle dashboards
5. Admin mappings/templates views

## 6. Completion Definition

Item #10 is complete only when the frontend repository reports passing `test:visual` (or equivalent snapshot suite) against live backend data.

## 7. Performance Guardrail Update

- Route-level code splitting is now enabled in `src/app/App.tsx`.
- Bundle output is now validated as multi-chunk in `scripts/test-visual.mjs`.
- Next hardening step: enforce explicit bundle-size budgets in CI as failing thresholds.
