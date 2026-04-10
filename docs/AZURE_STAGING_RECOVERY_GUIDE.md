# Azure Staging Recovery Guide

Use this guide if the Flow Azure staging setup is partially created but still failing.

Typical symptoms:

1. Static Web App says `Waiting for Deployment`
2. frontend deploy says `No matching Static Web App was found or the api key was invalid`
3. browser login says `Network/CORS request failed`
4. backend deploy says `Site Disabled (CODE: 403)`
5. Azure shows `Error 403 - This web app is stopped`
6. portal navigation lands on a stale path like `/sites/<app>/slots/<suffix>`

## Backend App Name vs Default Domain

Azure uses two different backend identifiers:

1. **Web App Name**
   - used by deployment tooling
   - use this for `AZURE_WEBAPP_NAME`
2. **Default domain**
   - used by the browser and frontend API calls
   - use this for `STAGING_FRONTEND_API_BASE_URL`

Example:

- `Name`: `flow-staging-api`
- `Default domain`: `flow-staging-api-esgxesfjhnenabg7.centralus-01.azurewebsites.net`

Correct GitHub values:

```text
AZURE_WEBAPP_NAME=flow-staging-api
STAGING_FRONTEND_API_BASE_URL=https://flow-staging-api-esgxesfjhnenabg7.centralus-01.azurewebsites.net
```

## Step 1: Verify The Real Backend Web App Resource

1. Open [Azure Portal](https://portal.azure.com/)
2. Open `Resource groups`
3. Open `flow-staging-rg`
4. Find the resource of type `App Service`
5. Open that resource directly
6. On `Overview`, record:
   - `Name`
   - `Default domain`

If Azure opens a stale slot path such as `/sites/flow-staging-api/slots/...`, go back to the resource group and open the `App Service` resource directly.

## Step 2: Fix GitHub Variables And Secrets

Set these in GitHub `Settings` -> `Secrets and variables` -> `Actions`:

```text
AZURE_WEBAPP_NAME=<Azure Web App Name from Overview>
STAGING_FRONTEND_API_BASE_URL=https://<Azure Default domain from Overview>
```

For Static Web Apps:

1. If Azure generated a secret with a random suffix such as:

```text
AZURE_STATIC_WEB_APPS_API_TOKEN_ORANGE_BEACH_0851CDC0F
```

2. copy that same token value into a plain secret named:

```text
AZURE_STATIC_WEB_APPS_API_TOKEN
```

The repo-managed frontend workflow expects the plain secret name above.

## Step 3: Fix Backend App Service State

If the backend shows:

- `Error 403 - This web app is stopped`
- `Site Disabled (CODE: 403)`
- `quota exceeded`

then Azure is refusing traffic before Flow code runs.

Do this:

1. Open the backend Web App
2. Open the linked `App Service plan`
3. If it is `Free` or `Shared`, scale up to `Basic (B1)` or higher
4. Return to the Web App
5. Click `Start`
6. Wait until it shows `Running`

If the site stops again, check:

1. subscription billing/spending state
2. App Service plan quota state
3. `Log stream` for startup errors

## Step 4: Configure Backend App Settings

In the backend Web App, open `Settings` -> `Environment variables` and add or verify:

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
TRUST_PROXY=true
CORS_ORIGINS=https://<your-static-web-app-host>,http://localhost:5173,http://localhost:4173
DATABASE_URL=file:./prisma/dev.db
POSTGRES_DATABASE_URL=postgresql://flowadmin:<REDACTED>@flow-staging-pg.postgres.database.azure.com:5432/flow?sslmode=verify-full
```

No trailing slash in `CORS_ORIGINS`.

## Step 5: Set The Startup Command

In the backend Web App:

1. Open `Settings` -> `General settings`
2. Find `Startup Command`
3. Set:

```text
node dist/server.js
```

Do not use `pnpm start` in Azure staging for this repo.

## Step 6: Verify The App-Level Health Endpoint

This repo already exposes:

- [src/routes/health.ts](/Users/gregorygabbert/Documents/GitHub/Flow/src/routes/health.ts)

Test:

```text
https://<your-backend-default-domain>/health
```

Expected response:

```json
{"status":"ok"}
```

Azure Health Check configuration is optional. The route itself already exists.

## Step 7: Deploy In The Right Order

1. Backend: run `Azure App Service Staging Deploy`
2. Verify backend `https://<backend-default-domain>/health`
3. Frontend: run `Azure Static Web Apps Staging Deploy`
4. Open the Static Web App URL
5. Try Microsoft Entra sign-in

## Step 8: If Entra Login Still Fails With Network/CORS

That usually means one of:

1. backend is not running
2. `/health` is not reachable
3. backend `CORS_ORIGINS` does not include the exact Static Web App host

## Step 9: If Backend Logs Say `Cannot find package 'fastify'`

If `Log stream` shows an error like:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'fastify' imported from /home/site/wwwroot/dist/app.js
```

then the deployed package contains a pnpm-style dependency tree that Azure App Service did not resolve correctly at runtime.

Fix:

1. push the latest repo-managed backend workflow changes
2. rerun `Azure App Service Staging Deploy`
3. verify `/health` again after deploy

The current backend workflow now builds a portable production dependency tree for Azure and then copies the generated Prisma client artifacts into the package.

## Current Repo Limitation

Azure infrastructure can be repaired with this guide, but one code-level staging blocker still remains:

- the backend runtime is still SQLite-based in [src/lib/prisma.ts](/Users/gregorygabbert/Documents/GitHub/Flow/src/lib/prisma.ts)

That means Azure PostgreSQL can be prepared now, but the backend cannot yet use it at runtime until the Prisma adapter selection is updated in code.
