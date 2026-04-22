# Secret Rotation Runbook

## Inventory
| Secret | Purpose | Rotation cadence | Store |
|---|---|---|---|
| `POSTGRES_DATABASE_URL` | DB connection | 90 days | Azure Key Vault, App Service ref |
| `JWT_SECRET` (dev only) | HMAC for local dev tokens | n/a (not used in prod) | Local `.env` only |
| `JWT_JWKS_URI` | Remote JWKS for Entra | on Entra tenant change | App Service setting |
| `AUTH_PROOF_HEADER_SECRET` | Staging proof gate | 30 days | Key Vault, staging only |
| `AUTH_PROOF_HMAC_SECRET` | Proof HMAC signing | 30 days | Key Vault, staging only |
| `PHI_ENCRYPTION_KEY` (base64 32B) | Column-level PHI encryption | 365 days (or on suspected compromise) | Key Vault, never emitted |
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | SWA deploy | 180 days | GitHub repo secret |
| `STAGING_ENTRA_TENANT_ID` / `CLIENT_ID` / `API_SCOPE` | Frontend build | on Entra app rotation | GitHub repo secret |
| `PROD_AZURE_*` (webapp, RG, client, tenant, subscription) | OIDC deploy | n/a unless Entra SP re-key | GitHub repo variables |
| `PROD_HEALTH_URL` / `PROD_READY_URL` | Health probes | n/a | GitHub repo variables |

## Before you begin
1. Announce the rotation in the ops channel 24 h in advance unless emergency.
2. For PHI encryption key: coordinate with compliance before rotation; see
   "PHI_ENCRYPTION_KEY rotation" below.
3. Ensure the Key Vault soft-delete window is enabled (default 90 d).

## Standard rotation (non-encryption secrets)
1. Generate a new secret value:
   - Random string: `openssl rand -hex 32`.
   - Base64 key: `openssl rand -base64 32`.
2. Store in Key Vault as a new version:
   ```bash
   az keyvault secret set \
     --vault-name "$KEY_VAULT_NAME" \
     --name "$SECRET_NAME" \
     --value "$NEW_VALUE"
   ```
3. Update App Service setting to refer to the new Key Vault version (or rely on
   unversioned references if the deployment uses them).
4. Restart the affected App Service or worker.
5. Verify `/health` and `/ready` after restart.
6. If the secret was embedded in a GitHub workflow, update the repo secret too.
7. Keep the prior version in Key Vault for 24 h as rollback, then revoke.

## PHI_ENCRYPTION_KEY rotation (dual-key window)
The schema uses `PHI_ENCRYPTION_KEY_ID` (default `v1`) to stamp which key
encrypted a given row. To rotate:

1. Generate `v2` key via `openssl rand -base64 32`.
2. Deploy the app with BOTH keys configured: old (for read/decrypt) and new (for encrypt on write). Read paths fall back to the key whose id matches the row's `*_cipherKeyId`.
3. Run the backfill script `pnpm phi:rotate-key --from v1 --to v2` (planned — see `scripts/phi-rotate-key.ts` once implemented).
4. Once backfill completes and no rows reference `v1`, remove `v1` from config.
5. Destroy `v1` in Key Vault after an additional 7-day observation.

Never rotate the encryption key without the dual-key window. Doing so will permanently lose PHI.

## Emergency rotation (suspected compromise)
1. Revoke the old secret in its origin system (Entra → revoke client secret; Postgres → reset password; Key Vault → disable prior version).
2. Immediately rotate via the standard procedure, but skip the 24 h rollback window.
3. Rotate ALL secrets exposed in the same blast radius (if an admin workstation was compromised, rotate everything that workstation could read).
4. Revoke all active user sessions if auth secrets were rotated: Entra tenant "revoke sessions" admin action.
5. Declare SEV-1 if PHI was reachable with the leaked secret.

## Post-rotation checklist
- [ ] New secret is active in production.
- [ ] Old secret is disabled or removed (after rollback window).
- [ ] `/health` and `/ready` are green.
- [ ] No spike in `flow_auth_failure_total` after rotation.
- [ ] Update the inventory table above if cadence or store changed.
