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
   - For the repo-managed Azure App Service backend deploy workflow, provide in GitHub:
     - `AZURE_WEBAPP_NAME` variable using the Azure Web App resource `Name` field, not the hostname
     - `AZURE_CLIENT_ID` variable for the staging Azure identity used by GitHub OIDC
     - `AZURE_TENANT_ID` variable
     - `AZURE_SUBSCRIPTION_ID` variable
2. Final auth issuer details:
   - `JWT_ISSUER`
   - `JWT_AUDIENCE`
   - `JWT_JWKS_URI` or secret management path for `JWT_SECRET`.
   - Microsoft Entra local pilot values were provided on April 9, 2026 and wired into local env.
   - Remaining Entra-specific pilot inputs:
     - live browser sign-in with the actual Entra accounts for local and staging proof
     - final Conditional Access / MFA expectation for pilot users, because Flow now assumes Microsoft Entra is the front-door control for those protections
     - Recommended pilot baseline policy:
       - target a dedicated Flow pilot Entra group
       - include the Flow SPA app registration and Flow API app registration
       - require MFA for all pilot users
       - block legacy authentication
       - keep access tenant-member-only; do not allow guest/B2B access for pilot
       - if PHI is introduced before full production hardening, also require either compliant device or trusted network conditions
   - Completed on April 12, 2026:
     - staging redirect URI pattern updated to dedicated `/auth/callback`
     - backend App Service system-assigned managed identity enabled
     - Microsoft Graph application permission `User.Read.All` granted to the backend managed identity for:
       - `/admin/directory-users`
       - `/admin/users/provision`
       - `/admin/users/:id/resync`
       - `pnpm auth:sync:directory`
     - Microsoft Graph application permission `User.Read.All` granted to the GitHub OIDC staging identity used by the scheduled directory sync workflow
     - dedicated Entra pilot security group created:
       - `Flow Pilot Users`
       - group id: `ce55a692-ea89-4edc-b5a0-902650452ace`
   - Blocker discovered on April 12, 2026:
     - creating tenant-wide Conditional Access policies through Microsoft Graph failed with `AccessDenied` because the current tenant is not licensed for Conditional Access.
   - Required next steps from tenant administration:
     - add all pilot users to the `Flow Pilot Users` Entra group
     - choose one of these enforcement paths before any PHI-facing pilot:
       - preferred: upgrade tenant licensing so Conditional Access is available, then create:
         - `Flow Pilot - Require MFA`
         - `Flow Pilot - Block Legacy Auth`
       - fallback if licensing cannot be upgraded yet: enable Microsoft Security Defaults or per-user MFA for every Flow pilot user and document that exception as temporary
     - once licensing is available, target:
       - users: `Flow Pilot Users`
       - cloud apps: `Flow Web` and `Flow API`
       - grant control: require multifactor authentication
       - client apps condition: block legacy authentication
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
   - Before the role-by-role staging pass, confirm the pilot Entra users still have the intended `UserRole` rows and facility scope in staging after any admin provisioning updates.
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
  - HIPAA / BAA readiness guardrails for PHI go-live:
    - Azure data residency confirmation
    - production secret-management plan for PostgreSQL and Graph access
    - final Entra Conditional Access / MFA enforcement plan
6. Pilot master data payload (real facilities/clinics/providers/reasons/templates) for cutover seeding.
7. Local verification prerequisites when running frontend contract/live scripts:
   - Start backend API on `http://localhost:4000` before frontend checks in `docs/Flow Frontend`.
   - Set a dev user header (`VITE_DEV_USER_ID`) or bearer token before `pnpm test:contract` to avoid 401 contract failures.
   - Set `VITE_DEV_USER_ID` or `FRONTEND_DEV_USER_ID` before `pnpm test:e2e-live`.
   - Set a dev user header (`VITE_DEV_USER_ID`) or bearer token before `pnpm test:e2e-browser` to avoid auth-skip mode.

## Latest Blocker Snapshot

- Local Entra pilot mapping, local bearer verification, browser redirect proof, and local threshold-alert evidence were re-run on **April 9, 2026**.
- Azure PostgreSQL staging target is now known as of **April 10, 2026**, and both schema push and preflight have succeeded.
- The remaining Azure database blocker is no longer connectivity, schema creation, runtime code support, or snapshot import; it is:
  - redeploying the backend against the PostgreSQL runtime environment
  - confirming staging traffic is reading the PostgreSQL-backed dataset cleanly
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

## Current Live Follow-Ups (2026-04-12)
- Complete the role-by-role staging proof with the real Entra pilot accounts after the latest auth and provisioning fixes are deployed.
- Review the first scheduled `Entra Directory Sync` workflow run in GitHub Actions and confirm it completes without suspending any active pilot user unexpectedly.
- Confirm and enforce the pilot Conditional Access policy above before any PHI-facing rollout.
- Add all pilot users to the `Flow Pilot Users` Entra group.
- Decide whether to upgrade tenant licensing for Conditional Access or to use Microsoft Security Defaults / per-user MFA as the temporary pilot fallback.
- If you stay on the Security Defaults / per-user MFA path, verify it directly in the Entra portal. The current Azure CLI session does not have enough Microsoft Graph policy-read scope to confirm tenant-wide Security Defaults state programmatically.
