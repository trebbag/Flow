# ClinOps Reference Analysis

Source reviewed: `https://github.com/trebbag/ClinOps`

## 1. Canonical Data Structure

Primary relational entities and intended ownership:

- `Facility` -> has many `Clinic`
- `Clinic` -> has many `Provider`, `ClinicRoom`, `ReasonForVisit`, `Template`, `Encounter`, `IncomingSchedule`
- `User` -> has many scoped `UserRole` rows
- `Provider` -> belongs to exactly one clinic
- `ReasonForVisit` -> can be clinic-scoped or facility/global
- `Template` -> belongs to `ReasonForVisit` and optionally to a clinic (clinic override or global definition)
- `Encounter` -> core patient flow object with status, timing stamps, and form payloads (`intakeData`, `roomingData`, `clinicianData`, `checkoutData`)
- `IncomingSchedule` -> imported pre-visit schedule row, linked to provider/reason and later to check-in/disposition outcomes

## 2. Imported Data Relationships

Imported rows flow through:

1. CSV/EHR/FHIR row -> normalized + validated -> `IncomingSchedule`
2. Row validity requires: patient ID, appointment time parse, provider mapping, reason mapping
3. Dedupe identity: patient + day + appointment time
4. Check-in creates `Encounter` in `Lobby`, and marks sibling incoming rows as checked in
5. Disposition path creates or references same-day encounter and resolves row to `Optimized`

## 3. Encounter / Patient / Card Flow

Canonical state machine from reference backend:

- `Incoming` -> `Lobby` -> `Rooming` -> `ReadyForProvider` -> `Optimizing` -> `CheckOut` -> `Optimized`

Important behavior:

- Optimistic concurrency via `version`
- Skip transitions only allowed for Admin with `reasonCode`
- Blocking tasks prevent checkout completion
- Template-required fields are enforced before stage exits:
  - `rooming` template before `ReadyForProvider`
  - `clinician` template before `CheckOut`
  - `checkout` template before `Optimized`

## 4. User Roles, Clinics, Facilities

Role model in reference is scoped and relational:

- Roles: `FrontDeskCheckIn`, `MA`, `Clinician`, `FrontDeskCheckOut`, `Admin`, `RevenueCycle`
- `UserRole` rows bind user to role and optional clinic/facility scope
- `MA` assignment logic:
  - non-MA-run clinic: MA selected via `MaProviderMap` (provider + clinic + MA)
  - MA-run clinic: MA selected via `MaClinicMap` (clinic + MA)

## 5. Templates and Visit Reasons

- Reasons are clinic-specific or global/facility-level
- Templates key by `reasonForVisitId + type + clinicId?`
- Clinic templates override global templates
- `requiredFields` from template drive progression guardrails

## 6. Figma Compatibility Implications

The Figma Make project currently uses view-model fields (`status`, provider/reason names) while ClinOps canonical model uses IDs + `currentStatus`. This backend keeps canonical relationships intact and exposes ClinOps-aligned endpoints so a UI adapter can map IDs to display fields without changing visual design.
