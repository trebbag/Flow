# Azure Staging Setup Guide

This is the recommended Azure-managed staging setup for Flow:

1. Frontend: Azure Static Web Apps
2. Backend API: Azure App Service (Linux, Node.js)
3. Database: Azure Database for PostgreSQL Flexible Server
4. Identity: Microsoft Entra ID

## Current Status As Of April 10, 2026

The Azure PostgreSQL staging target has now advanced past connectivity setup:

1. Azure PostgreSQL connectivity: complete
2. PostgreSQL schema push: complete
3. PostgreSQL preflight: complete
4. Next database step: import the SQLite snapshot into Azure PostgreSQL
5. Remaining backend staging blocker: runtime PostgreSQL support is still not enabled in the app

## Important Current Blocker

Before the backend can truly run against Azure PostgreSQL, one code change is still required in the app:

- The current runtime Prisma setup is hardcoded to SQLite in [src/lib/prisma.ts](/Users/gregorygabbert/Documents/GitHub/Flow/src/lib/prisma.ts).
- The migration scripts and docs already support PostgreSQL import/cutover, but the runtime app does not yet switch to a PostgreSQL adapter in staging/pilot.

You can still create all Azure resources now, wire Entra now, and load PostgreSQL now. The final backend cutover step should happen only after the runtime database selection is updated.

## Recommended Azure Resource Names

Use one Azure region for all staging resources.

Suggested values:

| Resource | Suggested Name |
|---|---|
| Resource group | `flow-staging-rg` |
| Static Web App | `flow-staging-web` |
| App Service Plan | `flow-staging-plan` |
| Backend Web App | `flow-staging-api` |
| PostgreSQL server | `flow-staging-pg` |
| PostgreSQL database | `flow` |

Recommended region:

- Choose the Azure region closest to your pilot users and compatible with your data residency requirements.
- Use the same region for the Web App, PostgreSQL server, and App Service Plan.

## Values You Already Have

Your Entra values already provided for this repo:

- Tenant ID: `b9b1d566-d7ed-44a4-b3cc-cf8786d6a6ed`
- SPA Client ID: `020f7909-e66e-4ec8-810b-cfdf58e70014`
- API App ID: `89658fe4-9844-439a-97b0-ee31ace455da`
- API App ID URI / audience: `api://89658fe4-9844-439a-97b0-ee31ace455da`
- API scope: `api://89658fe4-9844-439a-97b0-ee31ace455da/access_as_user`

Your Azure PostgreSQL staging target is now also known:

- Server host: `flow-staging-pg.postgres.database.azure.com`
- Database name: `flow`
- Admin username: `flowadmin`
- Repo-safe connection string form:

```text
postgresql://flowadmin:<REDACTED>@flow-staging-pg.postgres.database.azure.com:5432/flow?sslmode=verify-full
```

Do not commit the real password into the repo. Keep the full connection string only in:

- Azure App Service environment variables
- local secure `.env` files that stay uncommitted
- password manager / secret manager storage

## Part 1: Create the Resource Group

1. Sign in to the [Azure portal](https://portal.azure.com/).
2. In the top search bar, search for `Resource groups`.
3. Select `Resource groups`.
4. Click `Create`.
5. Choose your Azure subscription.
6. In `Resource group`, enter `flow-staging-rg`.
7. Choose your region.
8. Click `Review + create`.
9. Click `Create`.

## Part 2: Create Azure Database for PostgreSQL Flexible Server

Official reference:

- [Azure Database for PostgreSQL flexible server quickstart](https://learn.microsoft.com/en-us/azure/postgresql/configure-maintain/quickstart-create-server)

### Create the server

1. In the Azure portal, click `Create a resource`.
2. Search for `Azure Database for PostgreSQL flexible server`.
3. Select it.
4. Click `Create`.

### Basics tab

Fill the fields as follows:

1. `Subscription`: your subscription
2. `Resource group`: `flow-staging-rg`
3. `Server name`: `flow-staging-pg` or a globally unique variant
4. `Region`: same region as the resource group
5. `PostgreSQL version`: latest supported stable version
6. `Workload type`: `Development` for staging cost control, or `Production` if you want stronger pilot-like performance
7. `Availability zone`: `No preference`
8. `High availability`: `Disabled` for low-cost staging
9. `Authentication method`: `PostgreSQL authentication only`
10. `Admin username`: choose a non-`pg_` name such as `flowadmin`
11. `Password`: create a strong password and store it in your password manager

### Compute + storage

1. Click `Configure server`.
2. For low-cost staging, choose `Burstable`.
3. Choose a small compute size appropriate for staging.
4. Keep default storage unless you know you need more.
5. Click `Save`.

### Networking

For the simplest staging setup:

1. Choose `Public access (allowed IP addresses)`.
2. Check `Allow public access from any Azure service within Azure to this server`.
3. Click `+ Add current client IP address` so your machine can run import and migration commands.

This is acceptable for staging. Later, you can tighten this by allowing only the App Service outbound IPs.

### Review and create

1. Click `Review + create`.
2. Wait for validation to complete.
3. Click `Create`.

### Create the `flow` database

After deployment:

1. Open the PostgreSQL server resource.
2. In the left menu, select `Databases`.
3. Click `+ Add`.
4. In `Database name`, enter `flow`.
5. Click `Save`.

### Build the connection string

Use this format:

```text
postgresql://<admin-username>:<password>@<server-name>.postgres.database.azure.com:5432/flow?sslmode=verify-full
```

Example shape:

```text
postgresql://flowadmin:<REDACTED>@flow-staging-pg.postgres.database.azure.com:5432/flow?sslmode=verify-full
```

Save this as the future value for:

- `POSTGRES_DATABASE_URL`

## Part 3: Load Staging Data into Azure PostgreSQL

Repo references:

- [POSTGRES_MIGRATION.md](/Users/gregorygabbert/Documents/GitHub/Flow/docs/POSTGRES_MIGRATION.md)
- [DEPLOYMENT_RUNBOOK.md](/Users/gregorygabbert/Documents/GitHub/Flow/docs/DEPLOYMENT_RUNBOOK.md)

Run these from your local terminal in the repo root:

```bash
cd /Users/gregorygabbert/Documents/GitHub/Flow
pnpm db:export:snapshot
POSTGRES_DATABASE_URL='postgresql://...' pnpm db:push:postgres
POSTGRES_DATABASE_URL='postgresql://...' pnpm db:preflight:postgres
POSTGRES_DATABASE_URL='postgresql://...' pnpm db:import:postgres artifacts/sqlite-snapshot.json
```

Important:

- This successfully prepares the Azure PostgreSQL database.
- Do not assume the backend runtime is using PostgreSQL yet until the runtime SQLite/PostgreSQL switch is implemented.
- If `pnpm db:preflight:postgres` says required tables are missing, the connection worked and the next step is to run `pnpm db:push:postgres` before retrying preflight.
- `pnpm db:push:postgres` exists because Prisma 7 reads datasource URLs from `prisma.config.ts`; the helper script maps `POSTGRES_DATABASE_URL` into Prisma’s expected `DATABASE_URL` for the PostgreSQL schema push.
- As of April 10, 2026, `db:push:postgres` and `db:preflight:postgres` have already been confirmed against the Azure staging database. The next live step is `pnpm db:import:postgres`.

## Part 4: Create the Backend API in Azure App Service

Official references:

- [Deploy a Node.js web app in Azure App Service](https://learn.microsoft.com/en-us/azure/app-service/quickstart-nodejs)
- [Configure an App Service app](https://learn.microsoft.com/en-us/azure/app-service/configure-common)

### Create the App Service plan

1. In the Azure portal, search for `App Service plans`.
2. Click `Create`.
3. Set:
   - `Resource group`: `flow-staging-rg`
   - `Name`: `flow-staging-plan`
   - `Operating system`: `Linux`
   - `Region`: same as PostgreSQL
   - `Pricing tier`: choose a small paid plan suitable for staging
4. Click `Review + create`.
5. Click `Create`.

### Create the Web App

1. In the Azure portal, click `Create a resource`.
2. Search for `Web App`.
3. Click `Create`.

### Basics tab

1. `Subscription`: your subscription
2. `Resource group`: `flow-staging-rg`
3. `Name`: `flow-staging-api` or a globally unique variant
4. `Publish`: `Code`
5. `Runtime stack`: choose Node.js LTS
6. `Operating System`: `Linux`
7. `Region`: same as the database
8. `Linux Plan`: `flow-staging-plan`

Application Insights is optional for now; you can leave it enabled if you want better diagnostics.

9. Click `Review + create`
10. Click `Create`

### Connect the repo

After the Web App is created:

1. Open the Web App resource.
2. In the left menu, select `Deployment Center`.
3. Choose `GitHub`.
4. Authorize Azure to access your GitHub account if prompted.
5. Choose:
   - your GitHub organization/user
   - repository: `Flow`
   - branch: your deployment branch
6. Save the deployment configuration.

Azure will create a GitHub Actions workflow for the Web App deployment.

### Configure backend environment variables

1. Open the Web App.
2. In the left menu, select `Settings` -> `Environment variables`.
3. Under `App settings`, add these values:

```text
NODE_ENV=production
HOST=0.0.0.0
PORT=8080
AUTH_MODE=jwt
AUTH_ALLOW_DEV_HEADERS=false
AUTH_ALLOW_IMPLICIT_ADMIN=false
JWT_ISSUER=https://login.microsoftonline.com/b9b1d566-d7ed-44a4-b3cc-cf8786d6a6ed/v2.0
JWT_AUDIENCE=api://89658fe4-9844-439a-97b0-ee31ace455da
JWT_JWKS_URI=https://login.microsoftonline.com/b9b1d566-d7ed-44a4-b3cc-cf8786d6a6ed/discovery/v2.0/keys
JWT_SUBJECT_CLAIMS=sub,oid,objectidentifier
CORS_ORIGINS=https://<your-static-web-app-host>,http://localhost:5173,http://localhost:4173
POSTGRES_DATABASE_URL=postgresql://<admin-username>:<password>@<server>.postgres.database.azure.com:5432/flow?sslmode=verify-full
```

For your current staging target, that value should be the real secret form of:

```text
POSTGRES_DATABASE_URL=postgresql://flowadmin:<REDACTED>@flow-staging-pg.postgres.database.azure.com:5432/flow?sslmode=verify-full
```

4. Click `Apply`.
5. Click `Apply` again to confirm.

### Set the startup command

This repo’s root `start` script is local-oriented and runs the SQLite init step. Do not use it for Azure staging.

Instead:

1. In the Web App, go to `Settings` -> `Configuration` or `Environment variables` depending on portal layout.
2. Open `General settings`.
3. Find `Startup Command`.
4. Set it to:

```text
node dist/server.js
```

5. Save the change.

### Edit the generated GitHub Actions workflow

You no longer need to hand-edit a generated Azure backend workflow for this repo.

A repo-managed backend deployment workflow now exists here:

- [azure-appservice-staging.yml](/Users/gregorygabbert/Documents/GitHub/Flow/.github/workflows/azure-appservice-staging.yml)

What it does:

1. installs backend dependencies with `pnpm`
2. runs `pnpm build`
3. prunes to production dependencies
4. packages `dist`, `node_modules`, `prisma`, `package.json`, and `pnpm-lock.yaml`
5. deploys that package to Azure App Service using `azure/webapps-deploy`

What you need to configure in GitHub before running it:

1. Repository or environment secret:

```text
AZURE_WEBAPP_PUBLISH_PROFILE
```

2. Repository or environment variable:

```text
AZURE_WEBAPP_NAME=flow-staging-api
```

How to get the publish profile:

1. Open your Azure Web App.
2. In the Overview page or top command bar, click `Get publish profile`.
3. Download the publish profile file.
4. Open the file locally.
5. Copy the full XML contents.
6. In GitHub, go to `Settings` -> `Secrets and variables` -> `Actions`.
7. Add a new secret named `AZURE_WEBAPP_PUBLISH_PROFILE`.
8. Paste the full XML contents.

How to run the workflow:

1. Open the GitHub repository.
2. Go to `Actions`.
3. Open `Azure App Service Staging Deploy`.
4. Click `Run workflow`.

This workflow is intentionally manual-only right now so staging deploys do not happen on every push by accident.

## Part 5: Create the Frontend in Azure Static Web Apps

Official references:

- [Azure Static Web Apps overview](https://learn.microsoft.com/en-us/azure/static-web-apps/overview)
- [Azure Static Web Apps build configuration](https://learn.microsoft.com/en-us/azure/static-web-apps/build-configuration)
- [Azure Static Web Apps application settings](https://learn.microsoft.com/en-us/azure/static-web-apps/application-settings)

### Create the Static Web App

1. In the Azure portal, click `Create a resource`.
2. Search for `Static Web App`.
3. Click `Create`.

### Basics tab

1. `Subscription`: your subscription
2. `Resource group`: `flow-staging-rg`
3. `Name`: `flow-staging-web`
4. `Hosting plan`: leave the default staging-appropriate choice unless you know you need Standard
5. `Region`: choose a nearby region
6. `Source`: `GitHub`
7. Sign in to GitHub if prompted
8. Select:
   - organization/user
   - repo: `Flow`
   - branch: your deployment branch

### Build details

This repo’s frontend lives in a subdirectory, so use `Custom` build settings:

1. `Build Presets`: `Custom`
2. `App location`: `docs/Flow Frontend`
3. `API location`: leave blank
4. `Output location`: `dist`

5. Click `Review + create`
6. Click `Create`

Azure may offer to generate a GitHub Actions workflow for the frontend deployment.

### Use the repo-managed Static Web Apps workflow

This repo now includes its own staging workflow at:

- [.github/workflows/azure-static-webapp-staging.yml](/Users/gregorygabbert/Documents/GitHub/Flow/.github/workflows/azure-static-webapp-staging.yml)

Use that workflow instead of relying on Azure’s generated `azure-static-web-apps-*.yml`.

Why:

1. This frontend is in a subfolder: `docs/Flow Frontend`
2. It is a Vite build, so `VITE_*` values must exist during GitHub Actions build time
3. This repo is cleaner if backend and frontend staging deploys are both controlled from checked-in workflows

If Azure creates a generated `azure-static-web-apps-*.yml` file or PR, do not keep it as the active deploy path. Use the repo-managed workflow above.

The repo-managed frontend workflow does this:

1. installs dependencies from `docs/Flow Frontend`
2. builds the Vite app with the required Entra settings
3. deploys the prebuilt `dist` folder to Static Web Apps

Required GitHub configuration before you run it:

1. Secret:

```text
AZURE_STATIC_WEB_APPS_API_TOKEN
```

2. Variable:

```text
STAGING_FRONTEND_API_BASE_URL=https://<your-backend-app>.azurewebsites.net
```

The workflow already injects these known Entra values at build time:

```text
VITE_DEFAULT_AUTH_MODE=microsoft
VITE_ENTRA_TENANT_ID=b9b1d566-d7ed-44a4-b3cc-cf8786d6a6ed
VITE_ENTRA_AUTHORITY=https://login.microsoftonline.com/b9b1d566-d7ed-44a4-b3cc-cf8786d6a6ed
VITE_ENTRA_CLIENT_ID=020f7909-e66e-4ec8-810b-cfdf58e70014
VITE_ENTRA_API_SCOPE=api://89658fe4-9844-439a-97b0-ee31ace455da/access_as_user
VITE_ENTRA_REDIRECT_PATH=/login
VITE_ENTRA_POST_LOGOUT_REDIRECT_PATH=/login
```

The frontend now also includes Azure Static Web Apps SPA routing support at:

- [docs/Flow Frontend/public/staticwebapp.config.json](/Users/gregorygabbert/Documents/GitHub/Flow/docs/Flow%20Frontend/public/staticwebapp.config.json)

That file ensures routes like `/login` correctly rewrite to `index.html` in Azure.

### Get the Static Web Apps deployment token

After the Static Web App resource exists:

1. Open the Static Web App resource in Azure.
2. Look for the deployment token action in the portal.
3. Copy the deployment token.
4. In GitHub, open `Settings` -> `Secrets and variables` -> `Actions`.
5. Add a new repository or environment secret named:

```text
AZURE_STATIC_WEB_APPS_API_TOKEN
```

6. Add the backend base URL as a GitHub variable:

```text
STAGING_FRONTEND_API_BASE_URL=https://<your-backend-app>.azurewebsites.net
```

### Run the frontend staging workflow

1. Open the GitHub repository.
2. Go to `Actions`.
3. Open `Azure Static Web Apps Staging Deploy`.
4. Click `Run workflow`.

After the first successful deployment, Azure will give you a staging frontend URL like:

```text
https://<random-name>.<region>.azurestaticapps.net
```

This becomes your staging app URL.

## Part 6: Add the Staging Redirect URI in Microsoft Entra

Official reference:

- [How to add a redirect URI to your application](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri)

For your SPA app registration (`020f7909-e66e-4ec8-810b-cfdf58e70014`):

1. Go to [Microsoft Entra admin center](https://entra.microsoft.com/).
2. Open `Identity`.
3. Open `Applications`.
4. Open `App registrations`.
5. Open the SPA app.
6. Select `Authentication`.
7. Under `Platform configurations`, open the `Single-page application` platform.
8. Add:

```text
https://<your-static-web-app-host>/login
```

9. Save.

You can keep the existing localhost redirect URIs too:

```text
http://localhost:5173/login
http://localhost:4173/login
```

## Part 7: Finalize Entra API Permissions

For the SPA app:

1. Open the SPA app registration.
2. Select `API permissions`.
3. Confirm the delegated permission exists:

```text
api://89658fe4-9844-439a-97b0-ee31ace455da/access_as_user
```

4. Click `Grant admin consent` if required by your tenant.

For the API app:

1. Open the API app registration.
2. Select `Expose an API`.
3. Confirm the scope `access_as_user` is enabled.
4. Optional but recommended: under `Authorized client applications`, add the SPA client ID:

```text
020f7909-e66e-4ec8-810b-cfdf58e70014
```

## Part 8: Verify the Backend from Azure

After the backend deploy completes:

1. Open the Web App.
2. Click the default hostname link, or browse to:

```text
https://<your-backend-app>.azurewebsites.net/health
```

3. Confirm you get:

```json
{"status":"ok"}
```

If the app fails to start:

1. Open the Web App.
2. Go to `Monitoring` -> `Log stream`.
3. Check the startup logs.
4. Confirm:
   - the deployment built `dist/server.js`
   - the startup command is `node dist/server.js`
   - the required env vars are present

## Part 9: Verify the Frontend from Azure

After the frontend deploy completes:

1. Open the Static Web App.
2. Click the production URL.
3. Go to:

```text
https://<your-static-web-app-host>/login
```

4. Click `Microsoft Entra`.
5. Click `Continue with Microsoft`.
6. Sign in with one of the pilot Entra accounts.

If you return to the login page with an auth error:

1. Double-check the SPA redirect URI in Entra.
2. Double-check the built frontend env values.
3. Confirm the backend `JWT_ISSUER`, `JWT_AUDIENCE`, and `JWT_JWKS_URI` are correct.

## Part 10: Run the Staging Validation Scripts

Once both staging URLs exist, run the repo’s validation from your local machine:

```bash
cd /Users/gregorygabbert/Documents/GitHub/Flow

STAGING_FRONTEND_API_BASE_URL=https://<your-backend-app>.azurewebsites.net \
STAGING_FRONTEND_BEARER_TOKEN=<admin-token> \
STAGING_ROLE_TOKEN_FRONTDESKCHECKIN=<front-desk-check-in-token> \
STAGING_ROLE_TOKEN_MA=<ma-token> \
STAGING_ROLE_TOKEN_CLINICIAN=<clinician-token> \
STAGING_ROLE_TOKEN_FRONTDESKCHECKOUT=<checkout-token> \
STAGING_ROLE_TOKEN_REVENUECYCLE=<revenue-token> \
pnpm pilot:validate:staging
```

Evidence files are written to:

- `docs/verification/`

## Part 11: Tighten Security After the First Successful Staging Run

After you have a working staging environment:

1. Replace broad PostgreSQL Azure-service access with more specific firewall rules.
2. Move sensitive backend settings to Key Vault references if desired.
3. Narrow `CORS_ORIGINS` to only the staging frontend host and local dev hosts you still need.
4. Enable additional monitoring/alerting on the Web App and PostgreSQL server.

## Repo-Specific Notes

1. Do not use the root `pnpm start` script for Azure staging.
   - It runs the local SQLite init flow.
2. For staging/pilot, the backend should run in production mode with:
   - `AUTH_MODE=jwt`
   - `AUTH_ALLOW_DEV_HEADERS=false`
   - `AUTH_ALLOW_IMPLICIT_ADMIN=false`
3. This repo’s official staging/pilot validation flow is:
   - [pilot-preflight.ts](/Users/gregorygabbert/Documents/GitHub/Flow/scripts/pilot-preflight.ts)
   - `pnpm pilot:preflight`
   - `pnpm pilot:validate:staging`

## What Still Needs To Be Implemented Before Azure PostgreSQL Staging Is Truly Live

1. Runtime PostgreSQL support in the backend app.
   - Current blocker: [src/lib/prisma.ts](/Users/gregorygabbert/Documents/GitHub/Flow/src/lib/prisma.ts)
2. A true staging hostname for the frontend.
3. Real staging bearer tokens or live Entra role sign-ins for the validation suite.
4. AthenaOne staging connector inputs and live dry run.

## Official References

1. [Azure Static Web Apps overview](https://learn.microsoft.com/en-us/azure/static-web-apps/overview)
2. [Azure Static Web Apps build configuration](https://learn.microsoft.com/en-us/azure/static-web-apps/build-configuration)
3. [Azure Static Web Apps application settings](https://learn.microsoft.com/en-us/azure/static-web-apps/application-settings)
4. [Deploy a Node.js web app in Azure App Service](https://learn.microsoft.com/en-us/azure/app-service/quickstart-nodejs)
5. [Configure an App Service app](https://learn.microsoft.com/en-us/azure/app-service/configure-common)
6. [Create an Azure Database for PostgreSQL flexible server](https://learn.microsoft.com/en-us/azure/postgresql/configure-maintain/quickstart-create-server)
7. [How to add a redirect URI to your application](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri)
