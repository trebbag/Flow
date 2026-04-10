# Deployment Runbook

## Environment Matrix

| Area | Local Dev | Staging | Pilot Production |
|---|---|---|---|
| `NODE_ENV` | `development` | `production` | `production` |
| `AUTH_MODE` | `hybrid` | `jwt` | `jwt` |
| `AUTH_ALLOW_DEV_HEADERS` | `true` | `false` | `false` |
| Primary DB | SQLite (`DATABASE_URL`) | PostgreSQL (`POSTGRES_DATABASE_URL`) | PostgreSQL (`POSTGRES_DATABASE_URL`) |
| CORS | `http://localhost:5173` | Staging app origins | Pilot app origins |
| Rate limits | relaxed | moderate | strict (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW`) |
| Observability | console logs | central logs | central logs + alerting |

## Containerized Startup

```bash
docker compose -f docker-compose.pilot.yml up --build -d
```

## Pilot Preflight

Run before each pilot cutover window:

```bash
pnpm pilot:preflight
```

Optional runtime API check:

```bash
PILOT_API_BASE_URL=https://your-api.example.com pnpm pilot:preflight
```

## PostgreSQL Cutover Sequence

1. Create target schema with `prisma/schema.postgres.prisma`.
2. Export SQLite snapshot:
   - `pnpm db:export:snapshot`
3. Validate target DB:
   - `POSTGRES_DATABASE_URL='postgresql://...' pnpm db:preflight:postgres`
4. Import snapshot:
   - `POSTGRES_DATABASE_URL='postgresql://...' pnpm db:import:postgres artifacts/sqlite-snapshot.json`
5. Set `POSTGRES_DATABASE_URL` in the runtime environment.
6. Deploy or redeploy the backend package generated from the PostgreSQL-aware staging workflow.
7. Restart API and verify `/health` plus authenticated `/auth/context`.

## Verification Gate

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

If any command fails, do not proceed with pilot rollout.
