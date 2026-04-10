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
