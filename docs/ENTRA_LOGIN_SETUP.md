# Microsoft Entra Login Setup

This app now supports a proper browser-based Microsoft Entra login in the frontend and JWT validation against Entra on the backend.

## What You Need To Provide

1. Entra tenant ID
2. Frontend SPA app registration client ID
3. Backend/API app registration Application ID URI or audience
4. Exposed API scope name for the SPA to request
5. Redirect URI approval for the SPA app registration:
   - local: `http://localhost:5173/login`
   - preview/test if used: `http://localhost:4173/login`
   - staging URL login callback once that hostname is known
6. Post-logout redirect URI approval:
   - local: `http://localhost:5173/login`
   - preview/test if used: `http://localhost:4173/login`
7. Decide how Flow users will map to Entra identities:
   - preferred: existing Flow user email matches Entra `email` or `upn`
   - alternate: provide each user's Entra Object ID and store it in `User.cognitoSub`
8. Optional, if you want token-based role hints from Entra:
   - Entra app roles or group claims that match Flow role names
   - otherwise Flow will continue using DB-managed role assignments only

## Backend Settings

Set in the root `.env` for Entra-backed JWT validation:

```env
AUTH_MODE=jwt
AUTH_ALLOW_DEV_HEADERS=false
AUTH_ALLOW_IMPLICIT_ADMIN=false
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
VITE_ENTRA_REDIRECT_PATH=/login
VITE_ENTRA_POST_LOGOUT_REDIRECT_PATH=/login
```

If you prefer, you can use `VITE_ENTRA_AUTHORITY` instead of `VITE_ENTRA_TENANT_ID`.

## Recommended Entra Shape

- One SPA app registration for the frontend
- One API app registration for the Flow backend
- SPA requests the API's exposed scope
- Backend validates the API access token via JWKS

## Current App Behavior

- Microsoft login appears automatically when the `VITE_ENTRA_*` values are configured.
- The frontend acquires and refreshes API access tokens silently.
- The backend accepts Entra JWTs and can resolve users by:
  - `User.id`
  - `User.cognitoSub` (good target for Entra Object ID)
  - `email` / `upn` / `preferred_username`
- Flow still enforces clinic/facility/role access from its own database.

## Pilot Checklist

1. Configure SPA redirect URIs in Entra.
2. Configure the backend API audience/scope in Entra.
3. Add the Entra values to local/staging env files.
4. Make sure pilot users exist in Flow and map by email or `cognitoSub`.
5. Run local auth verification.
6. Run staging role-proof verification with real Entra accounts.

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
   - their Flow email matches Entra `email` / `upn` / `preferred_username`, or
   - their Entra Object ID is stored in `User.cognitoSub`
4. In Azure `Log stream`, look for Flow auth warnings:
   - `jwt_verify_failed`
   - `jwt_subject_missing`
   - `jwt_user_not_mapped`

Those warnings now include the configured issuer/audience and the token issuer/audience so you can tell whether the failure is claim mismatch or user mapping.

## If Login Says "timed_out"

That MSAL error means the browser never fully completed the redirect handoff to Microsoft. In Flow, the frontend now tries popup-based sign-in first and only falls back to redirect if the popup path cannot start, so a fresh deploy should usually clear this.

If you still see it after deploying the latest frontend:

1. Confirm you are signing in from the registered SPA host:
   - staging: `https://orange-beach-0851cdc0f.6.azurestaticapps.net/login`
   - local: `http://localhost:5173/login`
2. In the Entra SPA app registration, verify the exact redirect URI exists for the host you are using.
3. Disable popup blockers or allow popups for the Flow site, because the fallback path uses `loginPopup`.
4. Clear the browser site data for the Flow staging host and retry in a fresh tab.
5. If the error only happens in one browser profile, retry in an incognito/private window to rule out an extension blocking the redirect.

Flow now uses an extended Microsoft auth timeout window in the frontend so account picker + password + MFA can finish without MSAL aborting too early. If the app is still showing `timed_out`, make sure you are testing a freshly deployed frontend bundle in a new tab rather than a stale tab that still has the older JavaScript loaded.

## Local Commands

After the env values are present, run:

```bash
pnpm auth:sync:entra
pnpm auth:verify:entra-local
```

- `auth:sync:entra` maps the local Flow users to the Entra Object IDs and creates a missing `FrontDeskCheckOut` user if needed.
- `auth:sync:entra` also assigns the first two local facilities to each pilot role when two facilities exist, so role-by-role facility switching can be verified locally.
- `auth:verify:entra-local` mints local verification JWTs with `oid` claims and confirms all six pilot roles authenticate through `/auth/context`.
