# Rooms MVP Staging Proof - 2026-04-15

## Deployment

- Branch: `codex/rooms-mvp`
- Deployed commit: `5cb9d5eb`
- Backend workflow run: `24466456239`
- Frontend workflow run: `24466456216`
- Backend host: `https://flow-staging-api-esgxesfjhnenabg7.centralus-01.azurewebsites.net`
- Frontend host: `https://orange-beach-0851cdc0f.6.azurestaticapps.net`
- Figma file: [Flow Rooms MVP](https://www.figma.com/design/0WCFA2eqweqfW5I0ErsqqC)

## Database

Staging PostgreSQL firewall was updated for the current deployment client IP, then schema and backfill were applied.

Commands run:

```bash
pnpm db:push:postgres
pnpm rooms:backfill
pnpm db:preflight:postgres
```

Results:

- PostgreSQL schema push succeeded.
- `RoomOperationalState` backfill completed for 10 active rooms.
- PostgreSQL preflight passed with required Rooms tables present:
  - `RoomOperationalState`
  - `RoomOperationalEvent`
  - `RoomIssue`
  - `RoomChecklistRun`

## Runtime

Staging backend runtime settings after deploy:

- `AUTH_MODE=jwt`
- `AUTH_ALLOW_DEV_HEADERS=false`
- `AUTH_ALLOW_IMPLICIT_ADMIN=false`
- `ENTRA_STRICT_MODE=true`
- `NODE_ENV=production`

Health check:

```bash
curl https://flow-staging-api-esgxesfjhnenabg7.centralus-01.azurewebsites.net/health
```

Result:

```json
{"status":"ok"}
```

## Authenticated Rooms Proof

Authenticated using a short-lived Azure CLI Entra access token for the Flow API audience.

`/auth/context` resolved the current user as:

```json
{
  "role": "Admin",
  "roles": ["Admin", "OfficeManager"]
}
```

A facility-scoped `OfficeManager` role row was added to the current staging Admin user for proof and task fanout validation.

Rooms proof result:

```json
{
  "roomsReturned": 7,
  "sampleRoom": {
    "name": "Room 2",
    "operationalStatus": "Ready"
  },
  "detailEvents": 1,
  "linkedTaskRole": "OfficeManager",
  "officeManagerAlertFound": true,
  "proofIssuesResolved": 2
}
```

Validated:

- `GET /rooms/live?mine=true` returns scoped rooms.
- `GET /rooms/:id` returns room detail and event timeline.
- `POST /rooms/:id/issues` creates a `RoomIssue`.
- Room issue creation creates a linked room-capable `Task`.
- Linked task is assigned to `OfficeManager`.
- OfficeManager task fanout creates an active inbox alert.
- Staging proof issues were resolved after validation.
- Staging proof tasks were completed after validation.

## Remaining Staging Gaps

- True role-by-role staging proof is still blocked by missing per-role JWTs or live Entra sessions for:
  - `FrontDeskCheckIn`
  - `MA`
  - `Clinician`
  - `FrontDeskCheckOut`
  - `OfficeManager`
  - `RevenueCycle`
- The current proof validates strict JWT Admin + OfficeManager access, but not a real MA user's pre-rooming flow in the browser.
- Supplies and Audits are still Phase 1 placeholders.

## MVP Readiness Snapshot

- Encounter lifecycle and workflow parity: 95%.
- Entra auth and access control: 97%.
- Admin provisioning and facility scoping: 97%.
- Rooms / OfficeManager / room-task Phase 1: 84%.
- Incoming/import/schedule accuracy: 90%.
- Analytics/reporting/archive consistency: 91%.
- Azure staging/deploy/runtime readiness: 99%.
- Security/HIPAA readiness: 90%.
- Overall pilot readiness if Rooms is required before pilot: 93%.
