# MVP Status

Updated: April 23, 2026

## Percent Complete By Core Area

1. Encounter lifecycle and workflow parity: **99%**
2. Entra auth and access control: **98%**
3. Admin provisioning, scoping, and recovery tooling: **99%**
4. Rooms / Office Manager / room-task workflow: **96%**
5. Pre-service guidance (`1.C` to `1.F`): **87%**
6. Time-of-service ownership (`2.G` to `2.I`): **94%**
7. Revenue cockpit, projections, and closeout workflow: **93%**
8. Analytics and reporting consistency: **98%**
9. Azure staging, deploy, and runtime readiness: **99%**
10. Security / PHI readiness posture: **97%**
11. Verification coverage and automation: **99%**
12. Repository hygiene and public-facing presentation: **97%**

## Current MVP Readiness

- Overall MVP / pilot readiness: **97%**
- Core Flow-side RCM workflow is now operational without Athena dependency for pre-service guidance and time-of-service execution.
- The remaining work is concentrated in real role proof, pilot content/governance inputs, live Postgres isolation validation, and a few accessibility/compatibility follow-through items rather than missing product foundations.

## Completed Recently

- Implemented the Flow RCM boundary model across pre-service guidance, time-of-service ownership, and Athena-only post-service.
- Added structured pre-service capture, expected-money projections, payer-class reimbursement rules, and step-aligned revenue checklists.
- Hardened clinician checkout behavior so documentation-incomplete cases continue forward while Revenue inherits the blocker downstream.
- Fixed checkout-screen runtime failures and added browser regression coverage for expanding checkout encounters.
- Enabled read-only encounter review for Front Desk Check-Out users in the frontend route layer.
- Verified authenticated staging frontend proof with a real Entra bearer token.
- Verified live room-release behavior on staging (`NeedsTurnover -> Ready`) on a ready-room clinic.
- Verified the broader `Team A` room-operations happy path in live staging and recorded the evidence in [staging-room-ops-team-a-20260419.md](verification/staging-room-ops-team-a-20260419.md).
- Refreshed role-proof evidence so the remaining staging gap is explicitly missing role tokens / live user sessions, not unknown product instability.
- Replaced the old unauthenticated live-update path with authenticated stream transport backed by the current Flow session.
- Reduced Revenue read-path overhead by avoiding whole-scope revenue-case rebuilds for every dashboard/detail request.
- Centralized versioned update handling for Encounter, Task, and RoomIssue with DB-level version-bump triggers across SQLite bootstrap and Postgres rollout.
- Added facility-scoped Postgres runtime wiring and rollout-time RLS policy installation for tenant-scoped tables.
- Tightened write-side JSON enforcement for structured revenue settings and expanded regression coverage for malformed write rejection and stale-version conflicts.
- Made incoming import batch outcomes explicit with `batchId`, `batchIds`, and `batchStatus` so mixed valid/pending imports are replay-safe and observable.

## Remaining Work Before Pilot

1. Run the full role-by-role staging proof with real Entra users or per-role bearer tokens and record the final evidence.
2. Run live Postgres facility-isolation verification under the active app role so the new RLS path is proven outside local SQLite.
3. Complete broader multi-role staging proof coverage for room operations now that the specific `Team A` room-validation gap is closed.
4. Finalize the facility service catalog, charge schedule, and payer / financial-class reimbursement rules used by the revenue projection model.
5. Finalize PHI-facing security controls:
   - MFA / Conditional-Access-equivalent enforcement
   - named access-review owner and cadence
   - BAA-dependent production guardrails
   - backup / restore and incident runbook hardening
   - close the external approval gate in [PILOT_SECURITY_GATE.md](PILOT_SECURITY_GATE.md)
6. Finish the remaining pilot-scope modules if they are still required:
   - Supplies
   - Audits / fluorescent marker workflows
7. Remove temporary compatibility seams such as `legacyArray=1` once all internal callers and scripts are off them.
8. Finish the last keyboard-only and screen-reader sweep for remaining custom controls and modal/drawer flows.
9. Optionally complete Athena comparison/import wiring if actual-vs-projected reconciliation remains in pilot scope.

## Owner Inputs Still Required

See [NEEDS_FROM_YOU.md](NEEDS_FROM_YOU.md) and [PILOT_SECURITY_GATE.md](PILOT_SECURITY_GATE.md) for the remaining external inputs and PHI-facing approvals needed for pilot readiness.
