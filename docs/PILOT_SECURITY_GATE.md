# Pilot Security Gate

Updated: April 24, 2026

This is the PHI-facing gate for pilot activation. It separates what Flow now enforces in code from the tenant-admin and operator approvals that still need to be named explicitly before pilot go-live.

## Implemented In Flow

1. Authentication and scoped authorization
   - Microsoft Entra is the primary pilot-facing auth model.
   - API routes are role-gated and facility-scoped.
   - Facility context switching is explicit and persisted.
   - Postgres runtime facility scoping now sets `app.current_facility_id`
     inside tenant-scoped transactions.

2. Database isolation and integrity backstops
   - Postgres rollout now installs row-level security policies for
     app-facing tenant tables.
   - optimistic concurrency version-bump triggers now protect Encounter,
     Task, RoomIssue, and RevenueCase at the persistence layer with exact
     `+1` version increments
   - append-only event/audit tables are protected by runtime-role privileges
     so the API role cannot update or delete historical records
   - clinic deletion is archive-only in user-facing routes and records
     before/after `EntityEvent` rows for archive/restore
   - authenticated mutating API calls require `Idempotency-Key` and return
     `428 IDEMPOTENCY_KEY_REQUIRED` when omitted
   - callback-form scoped transactions are used where the facility GUC must be
     present for RLS to enforce correctly

3. Minimum-necessary operational data handling
   - audit logs store request metadata rather than full request bodies
   - event payloads are metadata-oriented to reduce PHI duplication
   - dashboards and analytics aggregate counts, durations, and operational states rather than requiring patient-level detail for top-line reporting

4. Athena independence for core workflow execution
   - pre-service guidance and time-of-service workflow run in Flow without Athena access
   - Athena remains optional and observational for later comparison/import work

5. Live-update transport
   - the old unauthenticated browser `EventSource` path is no longer the default behavior
   - the frontend now uses the current session auth context when opening `/events/stream`
   - if the stream is unavailable, Flow falls back to polling without breaking core workflow execution

6. Room and encounter operational protection
   - room assignment, turnover, and mark-ready actions remain backend-enforced
   - encounter step transitions remain backend-enforced and sync revenue state on write
   - write-time JSON validation now rejects malformed structured business JSON
     instead of persisting unreadable rows silently

## External Approvals Still Required Before PHI Pilot

1. MFA enforcement path
   - Conditional Access is not available in the current Entra edition
   - required fallback before PHI go-live: Security Defaults if compatible with the tenant, otherwise per-user MFA for every pilot user
   - owner: Gregory Gabbert
   - status: fallback path still needs to be enabled and validated for pilot users

2. Access review ownership
   - owner: Gregory Gabbert
   - approval scope: Gregory Gabbert approves adding and removing pilot users
   - cadence: monthly pilot-user and scoped-role review

3. Backup and restore approval
   - production PostgreSQL PITR retention is approved
   - restore drill cadence: quarterly
   - restore owner and approver: Gregory Gabbert

4. Incident runbook approval
   - technical owner: Gregory Gabbert
   - business owner: Allison Gabbert
   - privacy/compliance owner: Gregory Gabbert

5. Go / no-go ownership
   - final go/no-go owner: Gregory Gabbert
   - PHI-facing pilot activation requires both technical and business approval

6. Data residency confirmation
   - approved Azure region: Central US
   - approved backup region: Central US / same-region backup posture
   - residency constraints: no additional constraints identified beyond keeping pilot data in the approved Azure region
   - BAA status: not yet in place; must be executed before PHI-facing go-live

## Gate Status

1. Implemented in code: authentication, scoped authorization, Postgres RLS rollout path, DB-level version guards, append-only event protections, strict mutation idempotency, audit posture, Athena-independent workflow execution, authenticated live update transport
2. Ready for operator validation: broader authenticated staging proof, room operations validation, role-by-role pilot walkthrough
3. Still blocked before PHI-facing go-live:
   - enable and validate MFA fallback because Conditional Access is unavailable
   - execute BAA before PHI is entered
   - complete broader authenticated role-by-role staging proof

## Supporting Evidence

- [PILOT_DATA_GOVERNANCE.md](PILOT_DATA_GOVERNANCE.md)
- [AZURE_STAGING_SETUP.md](AZURE_STAGING_SETUP.md)
- [STAGING_VALIDATION_CHECKLIST.md](verification/STAGING_VALIDATION_CHECKLIST.md)
- [postgres-rls-append-only-20260424.md](verification/postgres-rls-append-only-20260424.md)
- [DR_DRILL_2026-04-24.md](verification/DR_DRILL_2026-04-24.md)
- [NEEDS_FROM_YOU.md](NEEDS_FROM_YOU.md)
- [MVP_STATUS.md](MVP_STATUS.md)
