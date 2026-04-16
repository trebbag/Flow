# Staging Validation Checklist

Run this before pilot go/no-go:

1. Export staging auth/env inputs:
   - `STAGING_FRONTEND_API_BASE_URL`
   - `STAGING_FRONTEND_BEARER_TOKEN` (preferred) or `STAGING_VITE_DEV_USER_ID`
   - AthenaOne staging connector inputs from [ATHENAONE_STAGING_RUNBOOK.md](../ATHENAONE_STAGING_RUNBOOK.md)
2. Run `pnpm pilot:validate:staging` from repo root.
3. Confirm a new report exists in `docs/verification/` named `staging-validation-*.md`.
4. Verify both steps passed in the report:
   - `Pilot Preflight`
   - `Frontend Live Verification`
   - `Role-by-Role Facility Switch Proof`
   - `Threshold Trigger Evidence Across Roles`
5. Attach that report to pilot readiness evidence.

Role proof auth options:
- Preferred for JWT staging: provide per-role tokens using
  - `STAGING_ROLE_TOKEN_FRONTDESKCHECKIN`
  - `STAGING_ROLE_TOKEN_MA`
  - `STAGING_ROLE_TOKEN_CLINICIAN`
  - `STAGING_ROLE_TOKEN_FRONTDESKCHECKOUT`
  - `STAGING_ROLE_TOKEN_REVENUECYCLE`
- Dev-header fallback (non-production environments only): provide `STAGING_VITE_DEV_USER_ID`.

Notes:
- The command exits non-zero on missing required inputs or failed validation steps.
- AthenaOne live credentials are required for end-to-end connector validation (see `docs/NEEDS_FROM_YOU.md` and `docs/ATHENAONE_STAGING_RUNBOOK.md`).
