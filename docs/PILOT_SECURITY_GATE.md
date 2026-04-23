# Pilot Security Gate

Updated: April 23, 2026

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
     Task, and RoomIssue at the persistence layer
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
   - confirm whether pilot enforcement is via Conditional Access or an approved fallback
   - name the tenant admin responsible for enabling and validating that policy

2. Access review ownership
   - name the pilot access-review owner
   - confirm the review cadence for pilot users and scoped roles

3. Backup and restore approval
   - confirm backup target, retention, restore testing owner, and approver

4. Incident runbook approval
   - confirm incident escalation contacts, severity path, and approver for the pilot runbook

5. Go / no-go ownership
   - name the final signoff owner for PHI-facing pilot activation

6. Data residency confirmation
   - confirm PostgreSQL region, backup region, and any residency constraints that apply to pilot data

## Gate Status

1. Implemented in code: authentication, scoped authorization, Postgres RLS rollout path, DB-level version guards, audit posture, Athena-independent workflow execution, authenticated live update transport
2. Ready for operator validation: live Postgres facility-isolation proof, staging proof, room operations validation, role-by-role pilot walkthrough
3. Still blocked on named external approvals:
   - MFA enforcement decision and owner
   - access review owner and cadence
   - backup / restore approver
   - incident runbook approver
   - go / no-go owner
   - residency confirmation

## Supporting Evidence

- [PILOT_DATA_GOVERNANCE.md](PILOT_DATA_GOVERNANCE.md)
- [AZURE_STAGING_SETUP.md](AZURE_STAGING_SETUP.md)
- [STAGING_VALIDATION_CHECKLIST.md](verification/STAGING_VALIDATION_CHECKLIST.md)
- [NEEDS_FROM_YOU.md](NEEDS_FROM_YOU.md)
- [MVP_STATUS.md](MVP_STATUS.md)
