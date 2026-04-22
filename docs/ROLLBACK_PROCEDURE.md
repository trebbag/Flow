# Rollback Procedure

Flow production uses an Azure App Service deployment slot strategy: deploys
land in a `staging` slot, pass health checks, then swap into `production`.
This design enables three levels of rollback.

## Decision tree
```
Did the current deploy include a schema migration?
├── No  → Fastest path: slot swap back (Level 1).
└── Yes → Is the migration backward-compatible (additive columns/indexes only)?
         ├── Yes → Slot swap back (Level 1). Leave new columns in place.
         └── No  → Full rollback: redeploy previous release + migration-reverse script (Level 3).
```

## Level 1 — Slot swap back (fastest, < 2 min)
Use when: post-swap production is unhealthy and the deploy was code-only (no migration, or only additive migration).

```bash
az webapp deployment slot swap \
  --name "$PROD_AZURE_WEBAPP_NAME" \
  --resource-group "$PROD_AZURE_RESOURCE_GROUP" \
  --slot production \
  --target-slot staging
```

The `production-deploy` workflow runs this automatically if the post-swap
health check fails. For manual invocation, run it from a trusted admin
workstation using an Azure CLI login with `Website Contributor` role.

After swap:
1. Verify `/health` returns 200.
2. Verify `/ready` returns 200.
3. Verify the `/metrics` counters aren't rising (no schema drift, no auth failures).
4. Notify the on-call channel with the restored commit SHA.

## Level 2 — Previous-release deploy (5–20 min)
Use when: slot swap back restored old code but the failure is still present (e.g. external dependency change, data corruption).

1. Find the previous green release tag: `git tag --sort=-creatordate | head -5`.
2. Re-run `production-deploy` workflow with `release_tag` set to the previous tag.
3. Wait for `build-verify` + `deploy` jobs.
4. Verify health checks as in Level 1.

## Level 3 — Code + schema rollback (30 min–2 h)
Use when: the deploy included a non-backward-compatible migration and the new release must be removed entirely.

**WARNING:** this is a destructive operation for newly-written rows whose shape is incompatible with the prior schema. Only execute with a compliance liaison's approval for any PHI involvement.

1. Declare SEV-2 minimum.
2. Take App Service offline (`az webapp stop`).
3. PITR the database to a timestamp just before the migration was applied
   (check deploy workflow timestamps):
   ```bash
   az postgres flexible-server restore \
     --name "${PROD_PG_NAME}-rollback-$(date +%Y%m%d%H%M)" \
     --source-server "$PROD_PG_NAME" \
     --resource-group "$PROD_AZURE_RESOURCE_GROUP" \
     --restore-time "<ISO-8601 before migration>"
   ```
4. Update webapp `POSTGRES_DATABASE_URL` to the restored server.
5. Re-run `production-deploy` with the prior release tag.
6. Bring App Service online (`az webapp start`).
7. Post-incident: reconcile any writes that occurred between the migration
   and rollback (PITR target) by exporting the diff from the broken server
   and hand-replaying the safe subset.

## Rollback rehearsal
- Rehearse Level 1 monthly in staging.
- Rehearse Level 2 quarterly in staging.
- Rehearse Level 3 annually on a non-production database copy.
- Record results in `docs/verification/ROLLBACK_REHEARSAL_<date>.md`.
