# Needs From You

The backend implementation is now pilot-oriented, but these final inputs are required before live pilot activation:

1. Production `POSTGRES_DATABASE_URL` and confirmation of target region/data residency.
   - Azure staging PostgreSQL URL was provided on April 10, 2026 and is now accounted for in the runbooks using a redacted form:
     - `postgresql://flowadmin:<REDACTED>@flow-staging-pg.postgres.database.azure.com:5432/flow?sslmode=verify-full`
   - Keep the full secret value only in secure local env storage, Azure App Service settings, or a secret manager. It is intentionally not written into this repo.
   - Azure staging PostgreSQL schema push and preflight both succeeded on April 10, 2026.
   - Remaining database steps:
     - run `pnpm db:import:postgres artifacts/sqlite-snapshot.json` against the Azure staging target
     - redeploy the backend after setting `POSTGRES_DATABASE_URL` so Azure staging runs live on that database
   - If using Azure-managed staging/pilot, also choose:
     - Azure subscription
     - Azure region
     - Azure resource group naming
     - staging frontend hostname
     - staging backend hostname
   - For the repo-managed Azure App Service backend deploy workflow, also provide in GitHub:
     - `AZURE_WEBAPP_PUBLISH_PROFILE` secret
     - `AZURE_WEBAPP_NAME` variable using the Azure Web App resource `Name` field, not the hostname
2. Final auth issuer details:
   - `JWT_ISSUER`
   - `JWT_AUDIENCE`
   - `JWT_JWKS_URI` or secret management path for `JWT_SECRET`.
   - Microsoft Entra local pilot values were provided on April 9, 2026 and wired into local env.
   - Remaining Entra-specific pilot inputs:
     - staging hostname / redirect URI once staging is available
     - live browser sign-in with the actual Entra accounts for local and staging proof
3. Frontend live verification credentials for non-local environments:
   - For the repo-managed Azure Static Web Apps staging deploy, also provide in GitHub:
     - `AZURE_STATIC_WEB_APPS_API_TOKEN` secret
     - `STAGING_FRONTEND_API_BASE_URL` variable using the backend Web App `Default domain` with `https://`
   - `vars.STAGING_FRONTEND_API_BASE_URL`
   - Preferred: `secrets.STAGING_FRONTEND_BEARER_TOKEN` (valid Admin JWT)
   - For role-by-role staging evidence in JWT mode, also provide:
     - `secrets.STAGING_ROLE_TOKEN_FRONTDESKCHECKIN`
     - `secrets.STAGING_ROLE_TOKEN_MA`
     - `secrets.STAGING_ROLE_TOKEN_CLINICIAN`
     - `secrets.STAGING_ROLE_TOKEN_FRONTDESKCHECKOUT`
     - `secrets.STAGING_ROLE_TOKEN_REVENUECYCLE`
   - Optional fallback for dev-header environments only: `secrets.STAGING_VITE_DEV_USER_ID`
   - Optional fallback role: `vars.STAGING_VITE_DEV_ROLE` (defaults to `Admin`)
   - Optional `vars.STAGING_FRONTEND_E2E_PORT` if staging runners require a non-default preview port.
   - Run `pnpm pilot:validate:staging` and share the generated evidence file from `docs/verification/`.
4. AthenaOne staging connector inputs for live onboarding:
   - `baseUrl`
   - `practiceId`
   - auth method inputs:
     - API key (`apiKey`, optional `apiKeyHeader`, optional `apiKeyPrefix`) OR
     - Basic auth (`username` + `password`) OR
     - OAuth token/client credentials (`accessToken` and/or `clientId` + `clientSecret`)
   - optional path overrides:
     - `testPath` for connection checks
     - `previewPath` for sync preview hook
   - department scope: `departmentIds` list
   - use [ATHENAONE_STAGING_RUNBOOK.md](/Users/gregorygabbert/Documents/GitHub/Flow/docs/ATHENAONE_STAGING_RUNBOOK.md) for the exact setup/test/preview sequence and evidence expected during staging
5. Governance approvals:
   - retention policy sign-off (audit/outbox retention windows)
   - weekly role access reviewer assignment
   - incident escalation contacts.
6. Pilot master data payload (real facilities/clinics/providers/reasons/templates) for cutover seeding.
7. Local verification prerequisites when running frontend contract/live scripts:
   - Start backend API on `http://localhost:4000` before frontend checks in `docs/Flow Frontend`.
   - Set a dev user header (`VITE_DEV_USER_ID`) or bearer token before `pnpm test:contract` to avoid 401 contract failures.
   - Set `VITE_DEV_USER_ID` or `FRONTEND_DEV_USER_ID` before `pnpm test:e2e-live`.
   - Set a dev user header (`VITE_DEV_USER_ID`) or bearer token before `pnpm test:e2e-browser` to avoid auth-skip mode.

## Latest Blocker Snapshot

- Local Entra pilot mapping, local bearer verification, browser redirect proof, and local threshold-alert evidence were re-run on **April 9, 2026**.
- Azure PostgreSQL staging target is now known as of **April 10, 2026**, and both schema push and preflight have succeeded.
- The remaining Azure database blocker is no longer connectivity, schema creation, or runtime code support; it is:
  - importing the staging snapshot
  - redeploying the backend against the PostgreSQL runtime environment
- New local evidence files:
  - [entra-local-auth-20260409.md](/Users/gregorygabbert/Documents/GitHub/Flow/docs/verification/entra-local-auth-20260409.md)
  - [entra-browser-redirect-20260409.md](/Users/gregorygabbert/Documents/GitHub/Flow/docs/verification/entra-browser-redirect-20260409.md)
  - [staging-threshold-evidence-20260409-122302.md](/Users/gregorygabbert/Documents/GitHub/Flow/docs/verification/staging-threshold-evidence-20260409-122302.md)
- Local facility-switch proof was re-run on **April 9, 2026** and now passes for all six pilot roles:
  - [staging-facility-switch-roles-20260409-122526.md](/Users/gregorygabbert/Documents/GitHub/Flow/docs/verification/staging-facility-switch-roles-20260409-122526.md)
- `pnpm pilot:validate:staging` was re-attempted on **March 6, 2026** and is still blocked before live proof can run.
- `pnpm staging:proof:facility-switch` was re-attempted on **March 6, 2026** and is blocked for the same missing staging auth/base URL inputs.
- `pnpm staging:proof:threshold-alerts` was re-attempted on **March 6, 2026** and is blocked for the same missing staging auth/base URL inputs.
- The run is currently blocked until these staging inputs are provided:
  - `STAGING_FRONTEND_API_BASE_URL` (or `PILOT_API_BASE_URL`)
  - `STAGING_FRONTEND_BEARER_TOKEN` (preferred) or `STAGING_VITE_DEV_USER_ID`
  - For role-by-role proof in JWT mode:
    - `STAGING_ROLE_TOKEN_FRONTDESKCHECKIN`
    - `STAGING_ROLE_TOKEN_MA`
    - `STAGING_ROLE_TOKEN_CLINICIAN`
    - `STAGING_ROLE_TOKEN_FRONTDESKCHECKOUT`
    - `STAGING_ROLE_TOKEN_REVENUECYCLE`
  - AthenaOne staging connector credentials and scope inputs listed above
- Microsoft Entra local configuration is now in place; the remaining auth proof gap is interactive browser sign-in against the real tenant and the future staging redirect URL once staging exists.
