# Needs From You

These are the remaining owner or tenant-admin inputs required before pilot activation.

## Required Before Pilot

1. Final production or pilot PostgreSQL target
   - confirm final migration/admin `POSTGRES_DATABASE_URL`
   - confirm final non-owner runtime `POSTGRES_RUNTIME_DATABASE_URL`
   - confirm Azure region and data residency requirements
   - confirm where production secrets will be stored
   - create or confirm a non-owner runtime database role for the API and set `POSTGRES_APP_ROLE` for rollout verification
   - provide the matching runtime database connection secret separately from the migration/admin connection secret
   - `pnpm db:push:postgres` now fails closed if append-only protections cannot be installed for a runtime role distinct from the migration/admin role
   - staging now has `POSTGRES_APP_ROLE=flow_app_user`; repeat this same role separation for production before production rollout

2. Final Entra security posture
   - Conditional Access is unavailable in the current Entra edition
   - enable and validate one MFA fallback before PHI go-live:
     - preferred fallback: Security Defaults
     - acceptable fallback: per-user MFA for every pilot user
   - confirm tenant-member-only access for pilot users if external/guest accounts would otherwise be eligible
   - confirm the final pilot user group membership
   - pilot access-review owner: Gregory Gabbert
   - pilot user add/remove approver: Gregory Gabbert
   - review cadence: monthly
   - see [PILOT_SECURITY_GATE.md](PILOT_SECURITY_GATE.md) for the exact PHI-facing approval gate that is still external to the repo

3. Staging proof credentials and environment inputs
   - confirm staging API and frontend hostnames remain final
   - current status on April 20, 2026:
     - the repo now supports a durable proof-header verification path using `AUTH_PROOF_HEADER_SECRET` plus `AUTH_PROOF_HMAC_SECRET`
     - the remaining external dependency is simply keeping the staging proof identity user active in Flow with Admin scope

4. AthenaOne staging connector inputs, if that integration is in pilot scope
   - base URL
   - practice ID
   - authentication method and credentials
   - department scope
   - main-facility staging connector is still unconfigured as of April 18, 2026:
     - `enabled = false`
     - empty `baseUrl`
     - empty `practiceId`
     - empty `previewPath`
     - empty `revenuePath`
   - until those values are configured, Athena connector test validation and revenue-monitoring preview/import cannot be proven in staging

5. Governance and go-live inputs
   - retention and audit expectations (baseline documented in [PILOT_DATA_GOVERNANCE.md](PILOT_DATA_GOVERNANCE.md); owner to confirm)
   - incident escalation contacts:
     - technical owner: Gregory Gabbert
     - business owner: Allison Gabbert
     - privacy/compliance owner: Gregory Gabbert
   - pilot master data payload for facilities, clinics, providers, reasons, and templates
   - final go/no-go owner: Gregory Gabbert
   - go/no-go approval requirement: technical and business approval
   - backup / restore approval:
     - production PostgreSQL PITR retention approved
     - quarterly restore drill approved
     - restore owner and approver: Gregory Gabbert
   - incident runbook owner/approver: Gregory Gabbert
   - named owner for PHI_ENCRYPTION_KEY custody and rotation per [SECRET_ROTATION.md](SECRET_ROTATION.md)
   - BAA is not yet in place and must be executed before PHI-facing go-live
   - approved Azure region: Central US
   - approved backup region: Central US / same-region backup posture

6. Time-of-service RCM pilot content
   - finalize the facility-level service catalog that MAs should capture in Flow
   - finalize the facility-level charge schedule used for expected gross-charge estimation in Flow
   - finalize the facility-level payer / financial-class reimbursement rules used for expected net-reimbursement projection in Flow
   - confirm any clinic-specific services or CPT mappings that should differ from the seeded defaults
   - confirm any clinic-specific payer-name or financial-class taxonomy differences that should differ from the seeded defaults
   - confirm whether any pilot clinics need custom missed-collection reasons beyond the seeded taxonomy

## Operational Follow-Ups

- Assign at least one real pilot user the `OfficeManager` role before the final role-by-role staging proof.
- If the durable proof path is unavailable in a future environment, `pnpm staging:auth:refresh` remains the fallback for short-lived bearer verification.
- Confirm the scheduled Entra directory sync behaves as expected after future pilot-user provisioning changes.
- If you want local authenticated frontend-live checks to run instead of being skipped, set either proof auth (`VITE_PROOF_USER_ID` + `VITE_PROOF_SECRET` + `VITE_PROOF_HMAC_SECRET` when backend HMAC signing is enabled), dev-header auth, or bearer auth in the shell before running `pnpm frontend:verify-live`.
- Before PHI-facing pilot activation, close the external owner approvals listed in [PILOT_SECURITY_GATE.md](PILOT_SECURITY_GATE.md).
- Before real staging proof of the revenue cockpit, configure the AthenaOne connector with the real revenue-monitoring endpoint in `revenuePath` and valid connector credentials for the pilot facility so the new preview/import path can exercise real downstream Athena data.
- Before real staging proof of the time-of-service RCM workflow, review and confirm the seeded MA service catalog and charge schedule in `Admin -> Revenue Operations Settings` so expected-money totals reflect your pilot operating model rather than demo defaults.
- Before clinician-role staging proof of the new optimizing flow, confirm whether the seeded bundled ICD-10/CPT lookup list is sufficient for pilot use or whether you want a larger reference dataset loaded for broader code coverage.
- Staging proof on April 18, 2026 now shows:
  - room release was validated successfully on `Team J` / `Room 5` through `NeedsTurnover -> Ready`
  - the earlier stale proof-room residue in `Team A` has been cleaned up
- Additional staging proof on April 19, 2026 now shows:
  - `Team A` room operations validated successfully through the live happy path
  - see [staging-room-ops-team-a-20260419.md](verification/staging-room-ops-team-a-20260419.md)
  - the remaining room-validation work is broader multi-role usage coverage, not unresolved `Team A` room integrity

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
