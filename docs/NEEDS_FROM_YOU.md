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
   - name the final pilot access-review owner and review cadence for pilot users
   - see [PILOT_SECURITY_GATE.md](PILOT_SECURITY_GATE.md) for the exact PHI-facing approval gate that is still external to the repo

3. Staging proof credentials and environment inputs
   - confirm staging API and frontend hostnames remain final
   - current status on April 20, 2026:
     - the repo now supports a durable proof-header verification path using `AUTH_PROOF_HEADER_SECRET`
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
   - incident escalation contacts (runbook in [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md); owner to populate on-call rotation)
   - pilot master data payload for facilities, clinics, providers, reasons, and templates
   - named owner for pilot go/no-go signoff
   - backup / restore and incident runbook approver (procedures in [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) and [ROLLBACK_PROCEDURE.md](ROLLBACK_PROCEDURE.md); owner to approve)
   - named owner for PHI_ENCRYPTION_KEY custody and rotation per [SECRET_ROTATION.md](SECRET_ROTATION.md)
   - confirm the final approvers for the items listed in [PILOT_SECURITY_GATE.md](PILOT_SECURITY_GATE.md)

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
- If you want local authenticated frontend-live checks to run instead of being skipped, set either proof auth (`VITE_PROOF_USER_ID` + `VITE_PROOF_SECRET`), dev-header auth, or bearer auth in the shell before running `pnpm frontend:verify-live`.
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
