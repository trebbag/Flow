# Needs From You

These are the remaining owner or tenant-admin inputs required before pilot activation.

## Required Before Pilot

1. Final production or pilot PostgreSQL target
   - confirm final `POSTGRES_DATABASE_URL`
   - confirm Azure region and data residency requirements
   - confirm where production secrets will be stored

2. Final Entra security posture
   - choose the pilot MFA enforcement path:
     - preferred: Conditional Access
     - fallback: Security Defaults or per-user MFA
   - confirm tenant-member-only access for pilot users
   - confirm the final pilot user group membership

3. Staging proof credentials and environment inputs
   - keep `STAGING_FRONTEND_BEARER_TOKEN` fresh or replace it with a more durable proof path
   - provide role-specific staging JWTs if you want fully automated role-by-role proof
   - confirm staging API and frontend hostnames remain final

4. AthenaOne staging connector inputs, if that integration is in pilot scope
   - base URL
   - practice ID
   - authentication method and credentials
   - department scope

5. Governance and go-live inputs
   - retention and audit expectations
   - incident escalation contacts
   - pilot master data payload for facilities, clinics, providers, reasons, and templates

## Operational Follow-Ups

- Assign at least one real pilot user the `OfficeManager` role before the final role-by-role staging proof.
- Keep using `pnpm staging:auth:refresh` from a signed-in Azure CLI session before authenticated staging verification runs if you stay on the current short-lived bearer-token workflow.
- Confirm the scheduled Entra directory sync behaves as expected after future pilot-user provisioning changes.
- If you want local authenticated frontend-live checks to run instead of being skipped, set either `VITE_DEV_USER_ID` / `FRONTEND_DEV_USER_ID` or `VITE_BEARER_TOKEN` / `FRONTEND_BEARER_TOKEN` in the shell before running `pnpm frontend:verify-live`.
- Before real staging proof of the revenue cockpit, configure the AthenaOne connector with the real revenue-monitoring endpoint in `revenuePath` and valid connector credentials for the pilot facility so the new preview/import path can exercise real downstream Athena data.

## Repository Hygiene Follow-Up

Local `.env` files and bearer-proof token artifacts were removed from source control, but those values previously existed in git history.

Rotate any secrets or reusable credentials that may have been stored in:

- root `.env`
- `docs/Flow Frontend/.env`
- `docs/verification/bearer-proof-env.sh`
- `docs/verification/bearer-proof-env.json`

Keep using checked-in `.env.example` files as templates for future setup.

## Post History Rewrite Follow-Up

The public git history was rewritten to remove previously committed secret-bearing paths.

If you have other local clones or other machines with this repository checked out:

- re-clone the repository, or
- run `git fetch --all --prune` and reset local branches to the rewritten `origin/main`

If any external automation cached the old history, refresh that checkout before making more changes.
