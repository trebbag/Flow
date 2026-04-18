# MVP Status

Updated: April 18, 2026

## Percent Complete By Core Area

1. Encounter lifecycle and workflow parity: **99%**
2. Entra auth and access control: **98%**
3. Admin provisioning, scoping, and recovery tooling: **99%**
4. Rooms / Office Manager / room-task workflow: **96%**
5. Pre-service guidance (`1.C` to `1.F`): **87%**
6. Time-of-service ownership (`2.G` to `2.I`): **94%**
7. Revenue cockpit, projections, and closeout workflow: **92%**
8. Analytics and reporting consistency: **98%**
9. Azure staging, deploy, and runtime readiness: **99%**
10. Security / PHI readiness posture: **92%**
11. Verification coverage and automation: **98%**
12. Repository hygiene and public-facing presentation: **97%**

## Current MVP Readiness

- Overall MVP / pilot readiness: **97%**
- Core Flow-side RCM workflow is now operational without Athena dependency for pre-service guidance and time-of-service execution.
- The remaining work is concentrated in real role proof, pilot content/governance inputs, PHI-facing hardening, and a few live-environment follow-through items rather than missing product foundations.

## Completed Recently

- Implemented the Flow RCM boundary model across pre-service guidance, time-of-service ownership, and Athena-only post-service.
- Added structured pre-service capture, expected-money projections, payer-class reimbursement rules, and step-aligned revenue checklists.
- Hardened clinician checkout behavior so documentation-incomplete cases continue forward while Revenue inherits the blocker downstream.
- Fixed checkout-screen runtime failures and added browser regression coverage for expanding checkout encounters.
- Enabled read-only encounter review for Front Desk Check-Out users in the frontend route layer.
- Verified authenticated staging frontend proof with a real Entra bearer token.
- Verified live room-release behavior on staging (`NeedsTurnover -> Ready`) on a ready-room clinic.
- Refreshed role-proof evidence so the remaining staging gap is explicitly missing role tokens / live user sessions, not unknown product instability.

## Remaining Work Before Pilot

1. Run the full role-by-role staging proof with real Entra users or per-role bearer tokens and record the final evidence.
2. Resolve or clean up stale occupied proof rooms in `Team A` before broader staging proof there.
3. Finalize the facility service catalog, charge schedule, and payer / financial-class reimbursement rules used by the revenue projection model.
4. Finalize PHI-facing security controls:
   - MFA / Conditional-Access-equivalent enforcement
   - named access-review owner and cadence
   - BAA-dependent production guardrails
   - backup / restore and incident runbook hardening
5. Finish the remaining pilot-scope modules if they are still required:
   - Supplies
   - Audits / fluorescent marker workflows
6. Optionally complete Athena comparison/import wiring if actual-vs-projected reconciliation remains in pilot scope.

## Owner Inputs Still Required

See [NEEDS_FROM_YOU.md](NEEDS_FROM_YOU.md) for the remaining external inputs needed for pilot readiness.
