# SQLite to PostgreSQL Migration Path

This project now ships a repeatable pilot cutover path from local SQLite to PostgreSQL.

## Prerequisites

1. Set `POSTGRES_DATABASE_URL` in environment.
2. Ensure a PostgreSQL database exists and is reachable.
3. Keep `DATABASE_URL` pointed to SQLite while exporting snapshot data.

Current Azure staging target:

```text
postgresql://flowadmin:<REDACTED>@flow-staging-pg.postgres.database.azure.com:5432/flow?sslmode=verify-full
```

Use the real password only in your local shell, Azure app settings, or another secret store. Do not commit it into docs or checked-in env files.

Current checkpoint as of April 10, 2026:

1. Azure PostgreSQL connectivity: confirmed
2. `pnpm db:push:postgres`: succeeded
3. `pnpm db:preflight:postgres`: succeeded after schema push
4. Backend runtime PostgreSQL switch: implemented
5. Next step: `pnpm db:import:postgres artifacts/sqlite-snapshot.json`

Note on SSL:

- Azure PostgreSQL supports hostname-validated TLS, so `sslmode=verify-full` is the right explicit setting here.
- If you use `sslmode=require`, the current Node/Postgres stack will connect, but it emits a warning because future versions will treat that mode differently.

## 1. Prepare PostgreSQL Schema

Generate postgres Prisma client metadata:

```bash
pnpm db:generate:postgres
```

Create schema in PostgreSQL (one-time):

```bash
POSTGRES_DATABASE_URL='postgresql://flowadmin:<REDACTED>@flow-staging-pg.postgres.database.azure.com:5432/flow?sslmode=verify-full' pnpm db:push:postgres
```

Why this uses a repo script:

- Prisma 7 now expects datasource URLs to come from `prisma.config.ts`, not from `url = env(...)` in the schema file.
- This repo’s Prisma config uses `DATABASE_URL`, so `pnpm db:push:postgres` safely maps `POSTGRES_DATABASE_URL` into `DATABASE_URL` for the PostgreSQL schema push.

## 2. Export SQLite Snapshot

```bash
pnpm db:export:snapshot
```

Default output: `artifacts/sqlite-snapshot.json`.

## 3. Validate PostgreSQL Target

```bash
POSTGRES_DATABASE_URL='postgresql://flowadmin:<REDACTED>@flow-staging-pg.postgres.database.azure.com:5432/flow?sslmode=verify-full' pnpm db:preflight:postgres
```

This checks connectivity and required tables.

If this command reports missing tables, that means the connection is good but the schema has not been pushed yet. Run the `prisma db push` command above first, then rerun preflight.

## 4. Import into PostgreSQL

```bash
POSTGRES_DATABASE_URL='postgresql://flowadmin:<REDACTED>@flow-staging-pg.postgres.database.azure.com:5432/flow?sslmode=verify-full' pnpm db:import:postgres artifacts/sqlite-snapshot.json
```

The import script truncates target tables in dependency-safe order, then inserts snapshot rows.

For the current Azure staging database, this is now the next required command in the cutover sequence.

## 5. Verify Pilot Readiness

Run API verification against PostgreSQL environment:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

For pilot cutover:

1. keep local development on SQLite by leaving `POSTGRES_DATABASE_URL` unset
2. set `POSTGRES_DATABASE_URL` in staging/pilot runtime settings after import validation succeeds
3. redeploy the backend so the packaged PostgreSQL Prisma client is available in the running app
