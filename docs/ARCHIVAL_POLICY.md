# Flow Archival Policy

This document defines the deletion rule set for Flow as of April 20, 2026.

## Principle

Flow archives entities when historical workflow, audit, financial, safety, room, or operational records may still point at them.

Flow hard-deletes entities only when they are configuration rows with no downstream historical meaning of their own, and when deleting them does not erase required clinical, operational, or financial history.

## Archive-Only Entities

These entities are historically referenced and must archive rather than hard-delete:

- `Clinic`
  - archive when encounters, room operations, rollups, room issues, checklists, safety events, or revenue history already exist
- `ClinicRoom`
  - archive when encounters, room issues, checklists, room events, or occupancy history already exist
- `ReasonForVisit`
  - archive via status change
- `Template`
  - archive via status change
- `User`
  - archive only after suspension; historical ownership and audit references must remain intact
- `Task`
  - archive on delete so workflow and audit references are preserved
- `UserAlertInbox`
  - archive/unarchive instead of deleting delivered operator alerts

## Hard-Delete-Allowed Entities

These are configuration-only rows and may be hard-deleted:

- `AlertThreshold`
  - threshold rows configure future alerting behavior; historical alert evidence lives in alert state, inbox alerts, and audit/outbox records
- `NotificationPolicy`
  - notification policies configure future delivery targets; historical alert delivery evidence lives outside the policy row itself

## Conditional Delete Entities

Some entities can hard-delete only before they become historically referenced:

- `Clinic`
  - may hard-delete only when no historical workflow, room, safety, or rollup references exist
- `ClinicRoom`
  - may hard-delete only when no historical room or encounter references exist

When those references exist, the route must archive instead.

## Implementation Rules

1. Archive is the default for operational entities.
2. Restore is allowed only for archive-capable entities with an explicit restore route or status transition.
3. Hard delete must not be used to bypass audit, workflow, revenue, or room history preservation.
4. UI wording should say `Archive` for archive-capable entities and reserve `Delete` for configuration-only rows.
5. New admin entities should adopt archive semantics unless they are clearly configuration-only and non-historical.

## Operator Guidance

- Use archive when the record participated in real clinic operations.
- Use delete only for configuration cleanup where no historical operational meaning is lost.
- If there is doubt, archive first.
