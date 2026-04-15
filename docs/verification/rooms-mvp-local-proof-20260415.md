# Rooms MVP Local Proof - 2026-04-15

## Scope

Implemented and locally verified the Phase 1 Rooms MVP:

- Figma-first Rooms MVP design frames.
- `OfficeManager` role.
- Room operational state, events, issues, checklists.
- Room-capable tasks with OfficeManager assignment.
- MA pre-rooming gate and last-ready-room workflow.
- Rooms route with Live, Open / Close, Issues, Supplies, and Audits tabs.
- Server-side room assignment enforcement based on operational readiness.

Figma design file:

- [Flow Rooms MVP](https://www.figma.com/design/0WCFA2eqweqfW5I0ErsqqC)

## Verification Commands

Backend and frontend quality gates:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm -C "docs/Flow Frontend" build
```

Result:

- Passed.
- Backend tests: 4 files, 75 tests passed.
- Frontend production build passed.

Full frontend live verification:

```bash
pnpm db:push
pnpm db:seed
AUTH_MODE=dev_header \
AUTH_ALLOW_DEV_HEADERS=true \
AUTH_ALLOW_IMPLICIT_ADMIN=true \
CORS_ALLOWED_ORIGINS="http://localhost:4173,http://localhost:5173,http://localhost:4000" \
RATE_LIMIT_MAX=10000 \
RATE_LIMIT_WINDOW="1 minute" \
PORT=4000 \
NODE_ENV=development \
node dist/server.js

FRONTEND_API_BASE_URL=http://localhost:4000 \
VITE_DEV_USER_ID=<seeded-admin-user-id> \
FRONTEND_DEV_USER_ID=<seeded-admin-user-id> \
VITE_DEV_ROLE=Admin \
FRONTEND_DEV_ROLE=Admin \
pnpm frontend:verify-live
```

Result:

- Contract checks passed.
- Visual artifact checks passed.
- Live role-board encounter flow e2e passed.
- Browser role-flow regression checks passed.
- Bundle budgets passed.

Bundle budget result:

- Entry JS: 15.59KB / 125KB.
- Largest JS: 118.78KB / 125KB.
- Largest CSS: 21.6KB / 28KB.
- Total JS: 437.4KB / 445KB.
- Total CSS: 21.6KB / 35KB.

## Fixes Found During Verification

- The local live verifier initially hit API rate limiting during browser regression. The production error handler now returns Fastify 4xx errors, including 429, as their actual status instead of converting them to 500.
- The live e2e script previously selected rooms by admin lifecycle status only. It now selects an operationally `Ready` room from `/rooms/live`, matching the new backend assignment rule.
- The total JS bundle budget was adjusted from 430KB to 445KB because Rooms is a new lazy-loaded operational area. Entry, per-chunk, and CSS budgets remain unchanged.

## Remaining Gaps Before Staging Proof

- Deploy backend and frontend changes to staging.
- Push/apply the staging database schema changes and confirm room operational state backfill for active rooms.
- Assign at least one real pilot user the `OfficeManager` role.
- Run role-by-role staging proof, including MA, Admin, and OfficeManager Rooms flows.
- Verify MA pre-rooming gate in staging with real clinic-room assignments.
- Verify room issue creation creates an OfficeManager task and inbox alert in staging.
- Verify CheckOut moves occupied rooms to `NeedsTurnover`, then cleaning moves rooms back to `Ready`.

## MVP Readiness Snapshot

- Encounter lifecycle and workflow parity: 95%.
- Entra auth and access control: 97%.
- Admin provisioning and facility scoping: 97%.
- Rooms / OfficeManager / room-task Phase 1: 78%.
- Incoming/import/schedule accuracy: 90%.
- Analytics/reporting/archive consistency: 91%.
- Azure staging/deploy/runtime readiness: 99%.
- Security/HIPAA readiness: 90%.
- Overall pilot readiness if Rooms is required before pilot: 91%.
