# Archived Label Audit

- Date: 2026-03-06
- Scope: analytics, report, history, incoming, encounter-facing, and revenue-facing display paths

## Verified Backend Label Sources

1. `src/lib/display-names.ts` applies `(Archived)` consistently for clinic, room, provider, user, reason, and template labels.
2. `src/routes/encounters.ts` maps encounter DTOs through those formatters for clinic/provider/reason/room/assigned MA.
3. `src/routes/incoming.ts` maps incoming schedule DTOs through those formatters for clinic/provider/reason.
4. `src/lib/office-manager-rollups.ts` uses formatted provider names in history rollups.

## Verified Frontend Label Sources

1. `docs/Flow Frontend/src/app/components/display-names.ts` preserves `(Archived)` on clinic/provider/user/reason/template labels.
2. Revenue Cycle uses labeled clinic names and archived-aware compact clinic badges.
3. Office Manager uses archived-aware clinic/room/user labels from the shared helpers.
4. Admin archived sections explicitly render archived rows as `(Archived)`.

## Result

- No new archived-label gaps were found in the currently wired analytics/report/export-facing code paths inspected in this pass.
- Existing archived-label logic remains coherent between backend DTO shaping and frontend presentation helpers.

## Residual Risk

- Final pilot confidence still requires staging screenshots/evidence of the same archived-label behavior under real pilot-like data, not only code and local verification.
