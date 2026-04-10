# Figma Backend Mapping Notes

This backend preserves ClinOps canonical relationships while matching the Figma project's API contract (`src/app/components/api-client.ts`).

## Canonical vs Display Strategy

- Canonical DB fields use IDs and normalized enums (`currentStatus`, `providerId`, `reasonForVisitId`)
- Figma display fields (provider name, reason name, clinic color, assigned MA name) are served through joined response payloads
- DTO alias support is available for frontend compatibility:
  - encounter responses include `status` alias for `currentStatus`
  - encounter responses include `providerName`, `reasonForVisit`, `roomName`, `maName`
  - cancel flow accepts `closureType`/`closureNotes`
  - accepts canonical `reason`/`note`
  - also accepts Figma-side `closureType`/`closureNotes`

## Relationship Guarantees Kept

- User role scoping remains explicit (`UserRole` rows)
- Provider remains clinic-bound
- MA assignment respects clinic mode:
  - provider mapping for standard clinics
  - clinic mapping for MA-run clinics
- Reason/template linkage remains by `reasonForVisitId`
- Template-required fields gate status progression
- Incoming schedule remains a first-class pipeline before encounters

## Wiring Plan

1. Replace mock encounter context in Figma app with calls to `/encounters`, `/incoming`, `/tasks`, `/admin/*`.
2. Map canonical encounter fields into Figma view-model fields in a thin client adapter.
3. Keep all visual components unchanged; only replace state/data source layer.
