# Microsoft Entra Login Setup

Flow now supports an Entra-only browser login for staging/production, explicit Entra-linked user provisioning, and JWT validation against Entra on the backend.

## What You Need To Provide

1. Entra tenant ID
2. Frontend SPA app registration client ID
3. Backend/API app registration Application ID URI or audience
4. Exposed API scope name for the SPA to request
5. Redirect URI approval for the SPA app registration:
   - local: `http://localhost:5173/auth/callback`
   - preview/test if used: `http://localhost:4173/auth/callback`
   - staging: `https://<static-web-app-host>/auth/callback`
6. Post-logout redirect URI approval:
   - local: `http://localhost:5173/login`
   - preview/test if used: `http://localhost:4173/login`
   - staging: `https://<static-web-app-host>/login`
7. Decide how Flow users will map to Entra identities:
   - Flow now stores explicit Entra identity metadata on `User`:
     - `entraObjectId`
     - `entraTenantId`
     - `entraUserPrincipalName`
     - `identityProvider`
   - transitional compatibility with `User.cognitoSub` remains in place during the backfill period
8. Microsoft Graph access for secure admin provisioning:
   - preferred: App Service managed identity with Graph application permissions
   - required Graph capability: read active tenant member users for search/provision/resync
9. Optional, if you want token-based role hints from Entra:
   - Entra app roles or group claims that match Flow role names
   - otherwise Flow will continue using DB-managed role assignments only

## Backend Settings

Set in the root `.env` for Entra-backed JWT validation:

```env
AUTH_MODE=jwt
AUTH_ALLOW_DEV_HEADERS=false
AUTH_ALLOW_IMPLICIT_ADMIN=false
ENTRA_STRICT_MODE=true
ENTRA_TENANT_ID=<tenant-id>
ENTRA_GRAPH_API_BASE_URL=https://graph.microsoft.com/v1.0
ENTRA_GRAPH_SCOPE=https://graph.microsoft.com/.default
ENTRA_GRAPH_MANAGED_IDENTITY_CLIENT_ID=<optional-user-assigned-managed-identity-client-id>
JWT_JWKS_URI=https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys
JWT_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
JWT_AUDIENCE=api://<backend-api-app-id>
JWT_SUBJECT_CLAIMS=sub,oid,objectidentifier
```

Notes:

- `JWT_AUDIENCE` can stay as the Application ID URI, for example `api://<backend-api-app-id>`.
- Flow now also accepts the bare Entra app/client ID form of that same audience during JWT validation, because Microsoft access tokens may present `aud` that way in some configurations.
- In the Entra API app manifest, set `requestedAccessTokenVersion` to `2`. In the current Microsoft Graph-style manifest this may appear inside the `api` object as `api.requestedAccessTokenVersion`. Some Microsoft docs still refer to the older `accessTokenAcceptedVersion` wording, but the current Entra manifest property is `requestedAccessTokenVersion`. If it stays `null` or `1`, the token issuer will be `https://sts.windows.net/<tenant-id>/` instead of the expected `.../v2.0`, and Flow will reject the token with `401 Unauthorized`.
- Flow also tolerates the legacy `https://sts.windows.net/<tenant-id>/` issuer for the configured tenant as a staging-safe fallback, but the preferred Entra configuration is still `requestedAccessTokenVersion = 2`.

## Frontend Settings

Set in `docs/Flow Frontend/.env`:

```env
VITE_API_BASE_URL=http://localhost:4000
VITE_DEFAULT_AUTH_MODE=microsoft
VITE_ENTRA_TENANT_ID=<tenant-id>
VITE_ENTRA_CLIENT_ID=<spa-client-id>
VITE_ENTRA_API_SCOPE=api://<backend-api-app-id>/<scope-name>
VITE_ENTRA_REDIRECT_PATH=/auth/callback
VITE_ENTRA_POST_LOGOUT_REDIRECT_PATH=/login
```

If you prefer, you can use `VITE_ENTRA_AUTHORITY` instead of `VITE_ENTRA_TENANT_ID`.

## Recommended Entra Shape

- One SPA app registration for the frontend
- One API app registration for the Flow backend
- SPA requests the API's exposed scope
- Backend validates the API access token via JWKS

## Current App Behavior

- Microsoft login is redirect-based and uses a dedicated `/auth/callback` route.
- The frontend acquires and refreshes API access tokens silently after Entra sign-in.
- The backend accepts Entra JWTs and can resolve users by:
  - `User.id`
  - `User.entraObjectId`
  - `User.cognitoSub` (transitional compatibility only)
  - `email` / `upn` / `preferred_username`
- Flow still enforces clinic/facility/role access from its own database.
- In strict Entra environments, Flow rejects:
  - guest/B2B users
  - disabled/deleted directory identities
  - unprovisioned Microsoft accounts
  - local password-reset / local user-creation actions

## Pilot Checklist

1. Configure SPA redirect URIs in Entra.
2. Configure the backend API audience/scope in Entra.
3. Configure Microsoft Graph access for the backend managed identity.
4. Add the Entra values to local/staging env files.
5. Provision pilot users into Flow using Entra-linked provisioning.
6. Run local auth verification.
7. Run staging role-proof verification with real Entra accounts.

## If Staging Says "Unauthorized. Provide a valid Bearer token"

That message means the frontend did send a bearer token, but the backend rejected it during JWT validation or could not map it to an active Flow user.

Check these in order:

1. In the backend Web App app settings, confirm:
   - `AUTH_MODE=jwt`
   - `JWT_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0`
   - `JWT_AUDIENCE=api://<backend-api-app-id>`
   - `JWT_JWKS_URI=https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys`
2. In the Entra API app registration manifest, confirm:
   - `requestedAccessTokenVersion` is `2`
   - in some portal manifests this appears as `api.requestedAccessTokenVersion`
3. In the Flow database, confirm the signed-in user exists and is active, and that either:
   - their `User.entraObjectId` matches the Entra Object ID in the access token, or
   - transitional fallback: their Entra Object ID is still stored in `User.cognitoSub`
4. In Azure `Log stream`, look for Flow auth warnings:
   - `jwt_verify_failed`
   - `jwt_subject_missing`
   - `jwt_user_not_mapped`

Those warnings now include the configured issuer/audience and the token issuer/audience so you can tell whether the failure is claim mismatch or user mapping.

## If Login Says "timed_out" or "no_token_request_cache_error"

Those MSAL errors usually mean the browser redirect state and the page handling the callback are out of sync. Flow now uses a dedicated `/auth/callback` route specifically to avoid that mixed-state problem.

If you still see it after deploying the latest frontend:

1. Confirm you are signing in from the registered SPA host:
   - staging: `https://orange-beach-0851cdc0f.6.azurestaticapps.net/login`
   - local: `http://localhost:5173/login`
2. In the Entra SPA app registration, verify the exact redirect URI exists for the host you are using.
3. Confirm the redirect URI is `/auth/callback`, not `/login`.
4. Clear the browser site data for the Flow staging host and retry in a fresh tab.
5. If the error only happens in one browser profile, retry in an incognito/private window to rule out an extension interfering with the redirect.

## Local Commands

After the env values are present, run:

```bash
pnpm auth:sync:entra
pnpm auth:sync:directory
pnpm auth:verify:entra-local
```

- `auth:sync:entra` maps the local Flow users to the Entra identity fields and creates a missing `FrontDeskCheckOut` user if needed.
- `auth:sync:entra` also assigns the first two local facilities to each pilot role when two facilities exist, so role-by-role facility switching can be verified locally.
- `auth:sync:directory` refreshes all Entra-linked Flow users from Microsoft Graph and suspends access for deleted, disabled, or guest directory identities.
- `auth:verify:entra-local` mints local verification JWTs with `oid` claims and confirms all six pilot roles authenticate through `/auth/context`.
