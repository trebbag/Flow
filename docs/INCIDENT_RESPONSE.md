# Incident Response Runbook

## Scope
Covers Flow backend (Fastify/Prisma) + frontend (React/Vite) running on Azure
(App Service + Static Web Apps) with PostgreSQL Flexible Server. PHI is involved,
so every incident must also follow the breach-disclosure flow in `docs/PILOT_DATA_GOVERNANCE.md`.

## Severity definitions
| Severity | Definition | Response time | Resolution target |
|---|---|---|---|
| SEV-1 | PHI exposure, data loss, full outage, auth bypass | 15 min | 4 h |
| SEV-2 | Partial outage, degraded critical workflow (incoming, encounters, revenue), auth failure for a role | 30 min | 24 h |
| SEV-3 | Non-critical degradation, one-tenant or one-clinic scoped issue | 2 h | 5 business days |
| SEV-4 | Cosmetic, slow non-critical job, documentation | Next business day | 10 business days |

## Roles
- **Incident Commander (IC):** coordinates response, posts updates.
- **Subject Matter Expert (SME):** hands-on fix (backend, frontend, DBA as needed).
- **Scribe:** timeline of actions taken, decisions, times (UTC).
- **Comms:** customer-facing updates, external notifications (oncall rotation).
- **Compliance liaison (for PHI):** decides whether breach-reporting thresholds are hit.

One person can hold multiple roles for SEV-3/4.

## Detection channels
- Azure Monitor alerts on `/health` and `/ready` (HTTP 5xx > 1% or 503 detected)
- Prometheus scrape of `/metrics` — alerts on `flow_cross_tenant_denied_total`,
  `flow_schema_drift_total`, `flow_validation_failures_total`, `flow_auth_failure_total`
- User-submitted reports (pilot contact list in `docs/NEEDS_FROM_YOU.md`)
- Dependabot security alerts (escalate immediately for Critical)
- Supply-chain audit failures in CI

## Immediate actions (first 15 minutes)
1. Acknowledge the alert in the oncall channel (state your name + "IC").
2. Declare severity based on table above; err toward higher severity when unclear.
3. Open a timestamped incident doc using `docs/verification/INCIDENT_<date>_<slug>.md`.
4. Start a call bridge for SEV-1/2.
5. Snapshot state:
   - `curl <PROD_HEALTH_URL>` and `curl <PROD_READY_URL>`
   - App Service log tail: `az webapp log tail --name <web> --resource-group <rg>`
   - Recent deploys: `az webapp deployment list --name <web> --resource-group <rg>`
   - Database status: `az postgres flexible-server show --name <pg> --resource-group <rg>`
6. If PHI exposure is suspected, pause any write endpoints (scale to 0 or route off via Front Door) and begin the breach-notification clock (see compliance liaison).

## Rollback
See `docs/ROLLBACK_PROCEDURE.md`. A slot swap is the fastest path; a full redeploy of the previous release is the safe path.

## Common incidents

### A. HTTP 5xx spike, no deploy in the last 2 hours
1. Check `/ready` — if `degraded`, inspect `revenueSyncWorker` section.
2. `az postgres flexible-server show-connection-string` and verify that the primary
   is responsive from the webapp: `az webapp ssh ...` then `psql $POSTGRES_DATABASE_URL -c "select 1"`.
3. If Prisma connection pool is saturated, restart the webapp:
   `az webapp restart --name <web> --resource-group <rg>`.
4. If schema-drift errors (`DATABASE_SCHEMA_OUT_OF_DATE`) appear, follow
   `docs/DEPLOYMENT_RUNBOOK.md` to re-run `pnpm db:push:postgres`.

### B. HTTP 5xx spike immediately after deploy
Initiate rollback (see `docs/ROLLBACK_PROCEDURE.md`) before further investigation.

### C. Cross-tenant data exposure alert
1. `flow_cross_tenant_denied_total` counter rising is a _prevented_ access — investigate the caller but
   do NOT treat as a breach by itself.
2. A data-exposure report (user sees another tenant's data) is SEV-1.
   - Collect correlation IDs from the user's report.
   - Grep logs for those correlation IDs and the user's `facilityId`.
   - Confirm whether the exposure is in the response body (actual leak) or only in error text.
   - If actual: pause the affected endpoint, begin breach-notification flow, then fix.

### D. Auth failure spike
1. Check `flow_auth_failure_total` labels for source. If source=`jwt` and
   reason=`jwt_verify_failed`, the Entra tenant or JWKS endpoint is likely
   unreachable.
2. Verify `JWT_JWKS_URI` returns keys: `curl <JWT_JWKS_URI>`.
3. If Entra outage is upstream, notify pilot users, do not change config.
4. If a secret rotation just occurred, verify environment variables on the
   webapp: `az webapp config appsettings list --name <web> --resource-group <rg>`.

### E. Bulk-import ingestion failures
1. Check `/incoming/import-batches/:id` — batch-level error summary.
2. Check counter `flow_validation_failures_total{route="/incoming/import"}`.
3. If many rows fail the same validation, roll back the import batch
   (`POST /incoming/import-batches/:id/reject`) and share the error summary with the uploader.

## Post-incident
- Within 5 business days, write a post-mortem in `docs/verification/POSTMORTEM_<date>_<slug>.md`
  covering: timeline, root cause, contributing factors, action items, owners, deadlines.
- Action items get tracked in the same project board as feature work.
- SEV-1/2 post-mortems are read aloud in the weekly ops review.
