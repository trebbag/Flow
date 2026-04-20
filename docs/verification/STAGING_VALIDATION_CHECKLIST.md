# Staging Validation Checklist

Run this before pilot go/no-go:

1. Export staging auth/env inputs:
   - `STAGING_FRONTEND_API_BASE_URL`
   - preferred durable proof path:
     - `STAGING_PROOF_USER_ID`
     - `STAGING_PROOF_SECRET`
     - optional `STAGING_PROOF_ROLE` (defaults to `Admin`)
   - legacy fallback only:
     - `STAGING_FRONTEND_BEARER_TOKEN`
     - or `STAGING_VITE_DEV_USER_ID`
   - AthenaOne staging connector inputs from [ATHENAONE_STAGING_RUNBOOK.md](../ATHENAONE_STAGING_RUNBOOK.md)
2. Run `pnpm pilot:validate:staging` from repo root.
   - to force the live encounter/room proof through a specific clinic during targeted validation, set `FRONTEND_TEST_CLINIC_ID` or `FRONTEND_TEST_CLINIC_NAME` before the run
3. Confirm a new report exists in `docs/verification/` named `staging-validation-*.md`.
4. Verify the latest evidence matches the current expectation:
   - `Pilot Preflight` should pass when staging infra is healthy
   - `Frontend Live Verification` should pass with durable proof auth or real auth
   - `Role-by-Role Facility Switch Proof` should pass with the durable proof path because it provisions scoped probe users and authenticates them through proof headers
   - `Threshold Trigger Evidence Across Roles` should pass with the durable proof path because it provisions scoped probe users and validates alert visibility role by role
5. Attach that report to pilot readiness evidence.

Role proof auth options:
- Preferred for staging proof: use the durable proof-header path with:
  - `STAGING_PROOF_USER_ID`
  - `STAGING_PROOF_SECRET`
  - optional `STAGING_PROOF_ROLE`
- Legacy fallback for JWT-only proof: provide per-role tokens using
  - `STAGING_ROLE_TOKEN_FRONTDESKCHECKIN`
  - `STAGING_ROLE_TOKEN_MA`
  - `STAGING_ROLE_TOKEN_CLINICIAN`
  - `STAGING_ROLE_TOKEN_FRONTDESKCHECKOUT`
  - `STAGING_ROLE_TOKEN_OFFICEMANAGER`
  - `STAGING_ROLE_TOKEN_REVENUECYCLE`
- Dev-header fallback (non-production environments only): provide `STAGING_VITE_DEV_USER_ID`.

Notes:
- The command exits non-zero on missing required inputs or failed validation steps.
- AthenaOne live credentials are required for end-to-end connector validation (see `docs/NEEDS_FROM_YOU.md` and `docs/ATHENAONE_STAGING_RUNBOOK.md`).
