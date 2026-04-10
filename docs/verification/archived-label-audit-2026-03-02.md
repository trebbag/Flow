# Archived Label Audit (Analytics/Reporting) — March 2, 2026

## Scope Audited

1. Analytics dashboard UI (`analytics-view.tsx`)
2. Office Manager operational analytics (`office-manager-dashboard.tsx`)
3. Revenue Cycle reporting board (`revenue-cycle-view.tsx`)
4. Encounter context live mapping feeding all boards (`encounter-context.tsx`)
5. Backend rollups feeding analytics history (`office-manager-rollups.ts`)
6. Incoming schedule data projection used in reporting (`incoming.ts`)

## Findings and Fixes

1. Fixed: Incoming rows mapped to encounters did not apply archived reason labels in one path.
- File: `docs/Flow Frontend/src/app/components/encounter-context.tsx`
- Change: `mapIncomingRow` now applies `labelReasonName(..., row.reason?.status)`.

2. Fixed: Revenue reporting clinic labels could lose archived suffix because clinic options used raw names.
- File: `docs/Flow Frontend/src/app/components/revenue-cycle-view.tsx`
- Changes:
  - Revenue clinic load now requests `includeInactive: true, includeArchived: true`.
  - Clinic names in lookup + filter options now use `labelClinicName(name, status)`.

3. Verified: Office Manager uses archived-safe label helpers for clinics, rooms, and users.
- File: `docs/Flow Frontend/src/app/components/office-manager-dashboard.tsx`

4. Verified: Backend provider rollups use archived-safe provider display names.
- File: `src/lib/office-manager-rollups.ts`

5. Verified: Incoming projection already returns archived-safe clinic/provider/reason labels.
- File: `src/routes/incoming.ts`

## Result

No remaining archived-label defects were found in current analytics/reporting surfaces for users, clinics, rooms, reasons, and templates in this MVP slice.
