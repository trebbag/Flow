# Postgres RLS and Append-Only Verification - April 24, 2026

## Scope

Live staging verification for the Postgres app role after the data-destruction hardening rollout.

- Azure resource group: `flow-staging-rg`
- API app: `flow-staging-api`
- Postgres server: `flow-staging-pg`
- Runtime app role: `flow_app_user`
- Migration/admin connection: app-service `POSTGRES_DATABASE_URL`
- Runtime role app setting: `POSTGRES_APP_ROLE=flow_app_user`
- Runtime connection app setting: `POSTGRES_RUNTIME_DATABASE_URL` can point at
  the `flow_app_user` login so the API process runs as the non-owner role while
  rollout scripts keep using the migration/admin URL.

No database passwords or connection strings are recorded in this evidence file.

## Rollout Command

```bash
POSTGRES_DATABASE_URL=<migration-admin-url> \
POSTGRES_APP_ROLE=flow_app_user \
pnpm db:push:postgres
```

Result:

```text
Temporarily suspended row-level security for Prisma schema push because the migration role does not have BYPASSRLS; policies will be reinstalled before exit.
Prisma schema loaded from prisma/schema.postgres.prisma.
Datasource "db": PostgreSQL database "flow", schema "public" at "flow-staging-pg.postgres.database.azure.com:5432"
Your database is now in sync with your Prisma schema.
```

The temporary RLS suspension is limited to the Prisma schema-push window for the owner/admin connection. The rollout command reinstalls forced RLS policies, version triggers, check constraints, and append-only app-role grants before exit.

## Runtime Role Verification

A scratch Facility A / Facility B data set was created, then queried through the non-owner runtime role with `app.current_facility_id` scoped to Facility A and Facility B.

Cross-facility reads under Facility A returned zero rows for Facility B records across:

- `Patient`
- `Encounter`
- `RevenueCase`
- `Task`
- `EntityEvent`
- `StatusChangeEvent`
- `AuditLog`
- `RevenueCaseEvent`
- `RoomOperationalEvent`

In-scope controls under Facility B returned visible rows for `Patient`, `Encounter`, `RevenueCase`, and `Task`.

Append-only mutation attempts under `flow_app_user` were denied for both `UPDATE` and `DELETE` on:

- `EntityEvent`
- `StatusChangeEvent`
- `AuditLog`
- `RevenueCaseEvent`
- `RoomOperationalEvent`

Verification output:

```json
{
  "rlsCrossFacility": "passed",
  "inScopeControl": "passed",
  "appendOnlyDeniedAttempts": 10,
  "appendOnlySqlState": "42501",
  "runtimeRole": "flow_app_user",
  "marker": "codex-rls-1777053827991"
}
```

## Cleanup

All scratch rows used for verification were deleted after the proof completed.

## Result

Passed. The staging runtime app role cannot read representative cross-facility rows and cannot update/delete append-only event/audit tables.
