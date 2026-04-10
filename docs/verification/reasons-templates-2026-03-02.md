# Reasons & Templates Verification Evidence (2026-03-02)

## Scope
- Reasons/Templates API + UI wiring
- Authenticated browser/live regression checks
- Backend regression coverage for reason/template edge cases
- Archived-label analytics checks

## Backend verification
- `pnpm lint` -> pass
- `pnpm typecheck` -> pass
- `pnpm test` -> pass (`38` tests)
- `pnpm build` -> pass

## Frontend verification
- `cd "docs/Flow Frontend" && pnpm build` -> pass
- `cd "docs/Flow Frontend" && pnpm test:contract` with `VITE_DEV_USER_ID`/`VITE_DEV_ROLE` -> pass
- `cd "docs/Flow Frontend" && pnpm test:e2e-live` with `VITE_DEV_USER_ID`/`VITE_DEV_ROLE` -> pass
- `cd "docs/Flow Frontend" && pnpm test:e2e-browser` with `VITE_DEV_USER_ID`/`VITE_DEV_ROLE` -> pass
- `cd "docs/Flow Frontend" && pnpm test:visual` -> pass

## Added regression coverage
- Reason creation/update rejects out-of-facility clinic assignments.
- Active template conflict handling enforces one active template per `(facility, reason, type)`.
- Reasons/Templates list filters verified for:
  - default (active only),
  - `includeInactive=true`,
  - `includeArchived=true`,
  - `includeInactive=true&includeArchived=true`.
- Archived label coverage expanded:
  - encounter-facing reason label includes `(Archived)`.
  - office-manager history provider rollups include `(Archived)` when provider is archived/inactive.
