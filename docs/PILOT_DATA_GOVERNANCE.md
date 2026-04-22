# Pilot Data Governance Workflow

## Scope

This workflow covers pilot handling of scheduling and encounter operations data, including potentially sensitive patient metadata in operational contexts.

## Data Classification

1. Restricted (PHI-adjacent or direct identifiers):
- `Encounter.patientId`
- `IncomingSchedule.patientId`
- intake/rooming/clinician/checkout payload JSON

2. Internal operational metadata:
- status transitions, task metadata, alert states, assignment events

3. Configuration metadata:
- facilities, clinics, providers, roles, templates, notification policies

## Minimum Necessary Handling

1. API audit logs store request metadata only (params/query/body keys) and do not persist full request bodies.
2. Event outbox payloads are metadata-focused and correlation-oriented to avoid PHI duplication.
3. Operational dashboards aggregate by counts/durations; no patient-level data is required for top-line views.

## Access Governance

1. Role model is scoped via `UserRole` and enforced at API pre-handlers.
2. Admin + RevenueCycle are required for event outbox and audit review endpoints.
3. Access review cadence:
- weekly during pilot: review all active users and role scopes
- monthly post-pilot: facility-level certification by operations owner

## Retention Policy (Pilot Baseline)

1. Audit logs: 90 days hot retention, then archive to encrypted storage.
2. Event outbox rows: 30 days after dispatch, then purge.
3. Encounter/incoming operational records: per legal/compliance policy (default 7 years if no stricter policy is provided).
4. Safety events/tasks: retain alongside encounter lifecycle records.

### Automation

The `pnpm retention:enforce` script applies (1) and (2). Schedule it daily:

- Default behaviour is idempotent and safe; purge of audit logs is gated behind
  `RETENTION_CONFIRM_PURGE=1` so the archival side-channel (S3/Blob export) can
  be wired first. Until the archival exporter is live, run with the default
  (no purge) so the operator sees a count of "pending archival" rows.
- Overridable knobs: `AUDIT_LOG_RETENTION_DAYS` (default 90),
  `EVENT_OUTBOX_RETENTION_DAYS` (default 30), `RETENTION_DRY_RUN=1`.
- Suggested schedule: cron / Azure WebJob, once per day 02:00 UTC.

```
0 2 * * *  cd /app && RETENTION_CONFIRM_PURGE=1 pnpm retention:enforce
```

## Consent Capture

`PatientConsent` records the subject's consent posture per patient + consent
type (for example `treatment`, `billing`, `sms-reminders`, `hie-exchange`). A
row carries `grantedAt`, optional `revokedAt`, `source` (staff, portal,
ingestion), and `documentRef` (link to the signed artefact).

- Revocation is expressed by setting `revokedAt` — the row is preserved for
  audit.
- Reads should treat `revokedAt IS NULL` as the current grant.
- Do not delete rows. The `@@unique([patientId, consentType])` constraint keeps
  one row per (patient, type) and it is updated in place.

## Role Recertification

`pnpm recert:report` emits a CSV (or JSON with `RECERT_FORMAT=json`) of every
`UserRole` row with its user and directory status, scoped optionally to a
facility via `RECERT_FACILITY_ID`. Use it weekly during pilot and monthly
post-pilot.

- `RECERT_FAIL_ON_STALE=1` exits non-zero when any row has a non-`active`
  user or directory status — suitable for a scheduled GitHub Actions job
  that pages the access-review owner.
- Suggested cadence: every Monday at 13:00 UTC for pilot.

## Data Subject and Incident Workflow

1. Access request handling:
- open ticket
- identify records by clinic/date/patient identifier
- compliance approval before export

2. Security incident response:
- detect and classify severity
- contain (credential rotation, session invalidation, API lock-down if needed)
- notify pilot stakeholders
- complete post-incident review and corrective actions

## Operational Checklist Before Pilot Start

1. Confirm PHI retention durations with legal/compliance.
2. Confirm data residency for PostgreSQL + backups.
3. Confirm who approves weekly role access recertification.
4. Confirm incident escalation contacts and SLA.
