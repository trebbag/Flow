# Staging RCM Live Proof - 2026-04-18

## Scope
- Environment: staging
- Frontend: `https://orange-beach-0851cdc0f.6.azurestaticapps.net`
- API: `https://flow-staging-api-esgxesfjhnenabg7.centralus-01.azurewebsites.net`
- Auth mode: real Microsoft Entra bearer token for the current staging Admin user
- Objective: validate the deployed RCM boundary slice with authenticated frontend checks, live encounter flow proof, and room-release behavior

## Deployment State Verified
- Frontend staging deploy succeeded for commit `8fb9fdf1a`
- Backend staging deploy succeeded for commit `8fb9fdf1a`
- Staging backend health: `{"status":"ok"}`
- Staging frontend host responded with HTTP `200`

## Runtime Repair Performed During Proof
The first authenticated staging proof attempt failed because the deployed backend was ahead of the staging PostgreSQL schema.

Repair performed:
- synced staging PostgreSQL with the current Prisma schema using `pnpm db:push:postgres` against the staging `POSTGRES_DATABASE_URL` sourced from Azure App Service settings

Result after repair:
- `/dashboard/revenue-cycle` and the broader authenticated proof path recovered without additional code changes

## Authenticated Frontend Proof Result
Executed `pnpm frontend:verify-live` with:
- `FRONTEND_API_BASE_URL = staging API`
- `FRONTEND_BASE_URL = staging frontend`
- `FRONTEND_BEARER_TOKEN = live Entra bearer token`

Passed:
- contract checks
- visual artifact checks
- live API-backed encounter flow
- browser role-board regression checks against the deployed staging frontend host
- bundle budget checks

This closes the previous "skipped local-auth mode" gap for staging admin proof.

## Live Encounter / RCM Flow Result
The live API-backed encounter flow completed successfully in staging.

Evidence:
- proof encounter: `f990ef13-9bed-4dd6-9852-bbf18eae4db4`
- patient id: `PT-E2E-1776527156395`
- clinic: `Team J`
- final status: `Optimized`

Validated in the flow:
- check-in
- room assignment
- rooming
- ready-for-provider
- optimizing
- checkout
- checkout complete
- downstream dashboard visibility

## Room Release Validation
Room-release behavior was validated successfully on the clinic used for the live proof.

Validated room state:
- clinic: `Team J`
- room used in proof: `Room 5`
- after checkout completion: room transitioned to `NeedsTurnover` with no `currentEncounter`
- after mark-ready: room returned to `Ready`

Current live room snapshot after proof:
- `Room 4 = NeedsTurnover`
- `Room 5 = Ready`

## Post-Proof Staging Cleanup
The synthetic proof residue identified during the original live run was cleaned up after evidence capture.

Cleanup completed:
- deleted the synthetic `PT-E2E-*` and `ZZ-STAGE-DOC-*` encounters and related revenue rows
- cleared `Team A / Room 2` and `Team A / Room 3`
- removed the temporary `Proof Room`

Current interpretation:
- room release works in the validated happy path on `Team J`
- the earlier `Team A` stale-proof-room residue is no longer a blocker
- broader room-operations proof in `Team A` still needs to happen with real role-by-role staging usage, not synthetic cleanup residue

## Checkout Reliability Regression
The local checkout-screen crash was traced to missing frontend component imports in the expanded checkout card.

Status:
- fixed in code
- browser regression coverage added so checkout encounter expansion must not produce the route error screen
- authenticated browser proof against the deployed staging frontend now passes

## Role-by-Role Proof Status
Generated current role-proof artifacts:
- `docs/verification/staging-facility-switch-roles-20260418-114745.md`
- `docs/verification/staging-threshold-evidence-20260418-114852.md`

Current state:
- Admin bearer proof passed for facility switching and threshold alert presence
- broader role proof is now blocked only by missing role-specific staging bearer tokens or live Entra sessions for:
  - `FrontDeskCheckIn`
  - `MA`
  - `Clinician`
  - `FrontDeskCheckOut`
  - `OfficeManager`
  - `RevenueCycle`

## Bottom Line
Pass:
- deployed staging frontend/backend are live
- authenticated staging frontend proof is green with real auth
- time-of-service RCM flow is operational in staging without Athena dependency
- room release is validated on a live happy-path clinic/room
- role-proof prep artifacts are current and explicit

Still outstanding before broad pilot proof:
- provide role-specific staging tokens or complete real user sign-ins for role-by-role proof
- complete broader room-operations validation in `Team A` now that the stale proof residue is gone
- finalize remaining PHI-facing governance inputs and pilot data/config inputs
