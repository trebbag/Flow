# Disaster Recovery Plan

## Recovery objectives
- **RTO (Recovery Time Objective):** 4 hours for API; 8 hours for full pilot surface (frontend + integrations).
- **RPO (Recovery Point Objective):** 1 hour for PHI (PostgreSQL point-in-time recovery window); 15 minutes for audit/event logs once streaming enabled.

## Protected assets
| Asset | Store | Backup mechanism | Backup retention |
|---|---|---|---|
| PostgreSQL (Flexible Server) | Azure | Automated backups + PITR | 35 days |
| Object storage (future: archived PHI) | Azure Blob (ZRS) | Soft-delete + versioning | 90 days |
| Configuration (App Service settings) | Azure | ARM/Bicep template in repo | repo history |
| Application source | GitHub | Main branch protected, signed commits | repo history |
| Secrets | Azure Key Vault | Soft-delete + purge protection | 90 days |
| Container/webapp images | Azure built artifacts | kept for 10 deploys | see `az webapp deployment list` |
| SBOM artifacts | GitHub Actions | per-CI-run artifacts | 90 days |

## Scenarios

### 1. Azure region-wide outage (production region)
1. Confirm outage on Azure Status page.
2. If primary region is down >30 min and SEV-1 declared:
   - Provision Flow stack in paired region using Bicep template (see repo `infra/` — to be added in a later milestone).
   - Restore PostgreSQL from geo-redundant backup: `az postgres flexible-server geo-restore`.
   - Seed configuration from Key Vault (Key Vault must be geo-replicated).
   - Update DNS at Azure Front Door to point to new backend.
3. RTO target: 4 hours.

### 2. PostgreSQL primary database loss or corruption
1. Stop writes: scale App Service to 0 or route to maintenance page.
2. Choose recovery target:
   - For corruption, PITR to 5 min before first symptom.
   - For loss, PITR to the most recent available point (within 35-day retention).
3. `az postgres flexible-server restore --restore-time <ISO-8601>`.
4. Swap connection string to the restored server.
5. Run `pnpm db:push:postgres` on the restored instance to verify schema.
6. Resume writes.
7. File a post-mortem including whether RPO was met.

### 3. Mass data deletion (accidental or malicious)
1. Freeze further writes as above.
2. If a single table or tenant scope was affected, restore to an isolated server via PITR, export the affected rows as SQL INSERTs, import into prod.
3. If broad: full restore as in scenario 2.
4. For malicious cases, also rotate all secrets via Key Vault, revoke all Entra sessions, trigger a security review.

### 4. Azure App Service loss
1. Redeploy using the last successful `production-deploy` workflow run against the same Postgres.
2. Re-populate App Service settings from Key Vault via Bicep.
3. No data restore needed (stateless app).

### 5. Compromised secrets
See `docs/SECRET_ROTATION.md` (created alongside this runbook).

## Quarterly DR drill
- Execute scenario 2 (PITR) against a non-prod server using a disposable
  restore target and verify app boots against the restored DB.
- Document results in `docs/verification/DR_DRILL_<date>.md`.
- Retire drill artifacts within 24 h.

## Backup verification
- Weekly: verify PostgreSQL automated backups are present via
  `az postgres flexible-server backup list --name <pg> --resource-group <rg>`.
- Monthly: restore the most recent backup into a disposable server, boot
  the app against it, run smoke tests, tear down.
