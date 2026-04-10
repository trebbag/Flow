# Flow Backend (ClinOps-Aligned)

This repository implements backend functionality for the Flow Figma project while preserving the core ClinOps data relationships:

- Imported schedule rows (`IncomingSchedule`) -> encounter check-in/disposition
- Encounter card lifecycle (`Lobby` -> `Rooming` -> `ReadyForProvider` -> `Optimizing` -> `CheckOut` -> `Optimized`)
- Role and scope relationships (users, user roles, clinics, facilities)
- Visit reasons and templates (clinic-specific + global definitions)

The API surface is aligned to the Figma `api-client.ts` contract so the frontend can be wired without changing design/UI markup.

## Stack

- Fastify + TypeScript
- Prisma ORM
- SQLite (local default)
- Zod validation
- Vitest integration tests

## Commands

- Install: `pnpm install`
- Generate Prisma client: `pnpm db:generate`
- Initialize schema: `pnpm db:push`
- Push PostgreSQL schema from `POSTGRES_DATABASE_URL`: `pnpm db:push:postgres`
- Seed sample data: `pnpm db:seed`
- Recompute persisted office-manager history rollups: `pnpm rollup:daily --date=YYYY-MM-DD` (or `--from=YYYY-MM-DD --to=YYYY-MM-DD`)
- Export SQLite snapshot: `pnpm db:export:snapshot`
- PostgreSQL preflight: `pnpm db:preflight:postgres` (requires `POSTGRES_DATABASE_URL`)
- Import snapshot to PostgreSQL: `pnpm db:import:postgres artifacts/sqlite-snapshot.json`
- Pilot preflight: `pnpm pilot:preflight`
- Frontend live verification hook: `pnpm frontend:verify-live`
- Dev server: `pnpm dev`
- Dev backend + frontend together: `pnpm dev:all`
- Quick launch alias for the same combined startup: `pnpm start:all`
- Build: `pnpm build`
- Start compiled server: `pnpm start`
- Lint: `pnpm lint`
- Typecheck: `pnpm typecheck`
- Tests: `pnpm test`

## Quick Start

1. Copy env file:
   - `cp .env.example .env`
2. Install dependencies:
   - `pnpm install`
3. Prepare DB + seed:
   - `pnpm db:push`
   - `pnpm db:seed`
4. Run API:
   - `pnpm dev`

Default API URL: `http://localhost:4000`

## Auth in Development

Default `AUTH_MODE` is `hybrid` in development/test:

- JWT Bearer tokens are accepted.
- Dev headers are accepted when `AUTH_ALLOW_DEV_HEADERS=true`.

Dev header format:

- `x-dev-user-id: <user-uuid>`
- `x-dev-role: Admin|FrontDeskCheckIn|MA|Clinician|FrontDeskCheckOut|RevenueCycle`

The seed script prints usable user IDs.

## Auth for Pilot/Production

Set:

- `AUTH_MODE=jwt`
- `AUTH_ALLOW_DEV_HEADERS=false`
- `AUTH_ALLOW_IMPLICIT_ADMIN=false`
- `JWT_SECRET` (HS256) **or** `JWT_JWKS_URI` (RS256/JWKS)
- `JWT_ISSUER`
- `JWT_AUDIENCE`
- `JWT_SUBJECT_CLAIMS` (defaults to `sub,oid,objectidentifier`)

Token subjects map to users by `User.id`, `User.cognitoSub`, or email claim (`email`, `upn`, `preferred_username`). Roles are resolved from DB-scoped `UserRole` assignments.

### Microsoft Entra ID

Flow can use Microsoft Entra ID as the identity provider for real pilot logins.

Backend:

- `AUTH_MODE=jwt`
- `JWT_JWKS_URI=https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys`
- `JWT_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0`
- `JWT_AUDIENCE=api://<backend-api-app-id>` (or your exposed API audience)
- `JWT_SUBJECT_CLAIMS=sub,oid,objectidentifier`

Frontend (`docs/Flow Frontend/.env`):

- `VITE_ENTRA_TENANT_ID=<tenant-id>` or `VITE_ENTRA_AUTHORITY=<full-authority-url>`
- `VITE_ENTRA_CLIENT_ID=<spa-app-registration-client-id>`
- `VITE_ENTRA_API_SCOPE=api://<backend-api-app-id>/<scope-name>`
- `VITE_DEFAULT_AUTH_MODE=microsoft`

User mapping can be done either by matching Entra `email`/`upn` to the Flow user email, or by storing the Entra object ID in `User.cognitoSub`.

## API Security Controls

- Global rate limiting via `@fastify/rate-limit`:
  - `RATE_LIMIT_MAX`
  - `RATE_LIMIT_WINDOW`
- Strict CORS allowlist from `CORS_ORIGINS` (or `CORS_ORIGIN` fallback)
- Correlation ID propagation:
  - accepts `x-correlation-id` inbound header
  - returns `x-correlation-id` on responses

## Core Endpoint Groups

- `GET /auth/context`
- `POST /auth/context/facility`
- `GET|POST /admin/*` (facilities, clinics, reasons, rooms, templates, users, assignments)
- `GET|POST /incoming/*` (import, update, disposition, intake)
- `GET|POST|PATCH /encounters/*` (check-in, status transitions, assign, visits, checkout, cancel)
- `GET|POST /safety/*`
- `GET|POST|PATCH|DELETE /tasks/*`

Deprecated admin endpoints removed:

- `/admin/providers`
- `/admin/ma-mappings`
- `/admin/ma-clinic-mappings`

Use `/admin/assignments` instead.

## Verification

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

All four commands were used as the project verification gate.

## Relationship Notes

See:

- `docs/CLINOPS_REFERENCE_ANALYSIS.md`
- `docs/MVP_STATUS.md`
- `docs/NEEDS_FROM_YOU.md`
- `docs/POSTGRES_MIGRATION.md`
- `docs/DEPLOYMENT_RUNBOOK.md`
- `docs/PILOT_DATA_GOVERNANCE.md`
- `docs/FRONTEND_LIVE_WIRING.md`
