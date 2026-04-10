# MVP Status (as of April 10, 2026)

## Percent Complete by Core Area

1. Facility tenancy + scope isolation (active facility persistence, scoped visibility): **97%**
2. Admin facilities/rooms/clinics backend model and API behavior: **97%**
3. Encounter lifecycle correctness and card progression logic: **96%**
4. Analytics fidelity (including archived room/clinic history): **97%**
5. Role/scope assignment model (same role across multiple scopes): **94%**
6. Frontend Admin Console parity (Facility/Rooms/Clinics): **95%**
7. Frontend live wiring across all tabs/views: **97%**
8. Security/auth hardening for pilot environments: **96%**
9. Verification coverage (unit/integration/e2e/visual/contract): **99%**
10. Pilot operations readiness (staging, runbooks, cutover prerequisites): **95%**

## Completed in This Phase

1. Facility-scoped room/clinic model and lifecycle states are implemented and active.
2. Auth context now persists and enforces active facility selection.
3. Multi-facility admin facility behavior is enabled.
4. Room APIs support create/edit/inactivate/archive/delete/restore with encounter-aware archive logic.
5. Clinic APIs support room assignment, status lifecycle, archive/delete/restore with encounter-aware archive logic.
6. Encounter and incoming routes now enforce selected-facility and clinic scope on list/read/update/import/disposition paths.
7. Frontend facility context is propagated across encounter-context, check-in, office manager, clinician, revenue cycle, and admin console data fetches.
8. Admin Console room modal now matches required field set (Room Name, Room #, Room Type), with status controls handled in room cards.
9. Legacy frontend assumptions were reduced (live room sourcing in encounter detail, stale duplicate files removed).
10. Archived user display labels now propagate through assignments, encounter aliases, and role boards.
11. User suspend/reactivate flows now return impacted-clinic operational guidance, with UI warnings and assignment-routing.
12. Seed data now creates baseline clinic assignments so operational-path regression tests run against real staffing constraints.
13. Frontend login hardening now supports JWT-first operation while allowing explicit dev-header mode for local/CI verification.
14. Frontend route-level code splitting is implemented, removing the monolithic chunk warning and improving first-load payload.
15. Frontend visual verification was updated for multi-chunk builds while preserving artifact integrity checks.
16. AthenaOne connector onboarding and hardening are implemented (normalized config, secret-preserving updates, redacted reads, timeout/retry/backoff behavior, test and sync-preview hooks).
17. Threshold matrix now drives runtime alert evaluation, including stage-level and overall-visit escalation logic.
18. Incoming import, pending retry, and analytics-facing labels now include archived-aware clinic/provider/reason rendering.
19. Staging validation workflow now has a dedicated orchestration command and evidence artifact generation (`pnpm pilot:validate:staging` + `docs/verification/` output).
20. Cross-role live/browser e2e flows were expanded and stabilized for facility switching, pending-row retry, and template-runtime continuity.
21. Archived-label analytics/reporting audit was completed, including fixes for incoming reason label propagation and revenue clinic archived labeling.
22. CI and staging verification now enforce frontend bundle performance budgets with explicit fail thresholds.
23. Frontend verification orchestration (`pnpm frontend:verify-live`) now includes bundle budget checks.
24. Microsoft Entra local pilot mapping, role-by-role facility switching, threshold fanout proof, and browser redirect proof are now captured in local verification evidence.
25. Azure staging setup now has a dedicated click-by-click runbook covering Static Web Apps, App Service, PostgreSQL Flexible Server, and Entra redirect wiring.
26. Azure PostgreSQL staging schema push and preflight have been completed successfully, narrowing the remaining staging database work to snapshot import plus runtime PostgreSQL support.

## Remaining Work Before Pilot (In Order)

1. Run credentialed staging validation end-to-end with real non-local auth and Athena connector inputs (`pnpm pilot:validate:staging`) and archive the generated evidence file.
2. Import the SQLite snapshot into Azure PostgreSQL and verify the imported staging data set.
3. Implement runtime PostgreSQL support in the backend so Azure staging can run live on PostgreSQL instead of SQLite.
4. Complete external pilot prerequisites in [`docs/NEEDS_FROM_YOU.md`](/Users/gregorygabbert/Documents/GitHub/Flow/docs/NEEDS_FROM_YOU.md): production Postgres target, final auth issuer values, governance sign-off, and real pilot master-data cutover payload.
