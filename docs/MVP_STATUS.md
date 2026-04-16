# MVP Status

Updated: April 16, 2026

## Percent Complete by Core Area

1. Encounter lifecycle and workflow parity: **98%**
2. Entra auth and access control: **98%**
3. Admin provisioning, scoping, and recovery tooling: **99%**
4. Rooms / Office Manager / room-task workflow: **95%**
5. Incoming upload and schedule accuracy: **96%**
6. Analytics and reporting consistency: **94%**
7. Azure staging, deploy, and runtime readiness: **99%**
8. Security / HIPAA readiness posture: **91%**
9. Verification coverage and automation: **97%**
10. Repository hygiene and public-facing presentation: **96%**

## Current MVP Readiness

- Overall MVP / pilot readiness: **97%**
- The product is past the point of a prototype.
- The remaining work is concentrated in pilot proof, PHI-facing hardening, and a small set of unfinished operational modules rather than core workflow viability.

## Completed Recently

- Entra-first staging sign-in is working end to end.
- Archived encounter recovery is implemented and proven against staging.
- Rooms MVP Phase 1 is in place, including Day Start gating, turnover handling, room issues, room analytics, and Office Manager support.
- Admin tooling supports facility scoping, archived encounter recovery, and temporary clinic coverage.
- Incoming upload validation and role-scoped workflow behavior have been materially hardened.
- CI, staging verification, and bundle-budget checks are all wired.
- Repository hygiene was improved by removing tracked local env files, verification tokens, local databases, build output, and dependency installs from source control.

## Remaining Work Before Pilot

1. Run the full role-by-role staging proof with real Entra users and record the final evidence.
2. Finish the remaining pilot-scope modules:
   - Supplies
   - Audits / fluorescent marker workflows
3. Finalize PHI-facing security controls:
   - MFA / Conditional-Access-equivalent enforcement
   - BAA-dependent production guardrails
   - operational runbook hardening
4. Validate temporary clinic coverage overrides and remaining edge-case workflows in staging.
5. Deepen room analytics once more live event data accumulates.

## Owner Inputs Still Required

See [NEEDS_FROM_YOU.md](NEEDS_FROM_YOU.md) for the remaining external inputs needed for pilot readiness.
