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

## Local Commands

After the env values are present, run:

```bash
pnpm auth:sync:entra
pnpm auth:verify:entra-local
```

- `auth:sync:entra` maps the local Flow users to the Entra Object IDs and creates a missing `FrontDeskCheckOut` user if needed.
- `auth:sync:entra` also assigns the first two local facilities to each pilot role when two facilities exist, so role-by-role facility switching can be verified locally.
- `auth:verify:entra-local` mints local verification JWTs with `oid` claims and confirms all six pilot roles authenticate through `/auth/context`.
