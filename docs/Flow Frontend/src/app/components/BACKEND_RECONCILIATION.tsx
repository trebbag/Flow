// ══════════════════════════════════════════════════════════════════════════
// FLOW — FRONTEND ↔ BACKEND DIFFERENCES AUDIT
// ══════════════════════════════════════════════════════════════════════════
//
// Figma Make prototype:  /src/app/components/  (this codebase)
// Backend repo:          github.com/trebbag/ClinOps @ codex/office-manager
//   Prisma schema:       apps/api/prisma/schema.prisma
//   Shared types:        packages/shared/src/index.ts
//   API controllers:     apps/api/src/{encounters,admin,safety,office-manager}/
//   Next.js frontend:    apps/web/src/
//
// ══════════════════════════════════════════════════════════════════════════
//
//
// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  SECTION A — ENCOUNTER ENTITY                                        ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//
// A1. Field name: "status" vs "currentStatus"
//   Frontend mock-data:  Encounter.status
//   Backend Prisma:      Encounter.currentStatus
//   Shared schema:       EncounterBaseSchema.currentStatus
//   DECISION NEEDED: frontend uses `status`, backend uses `currentStatus`
//
// A2. Field name: "provider" vs "providerId"
//   Frontend:  Encounter.provider = "Dr. Chen" (display name string)
//   Backend:   Encounter.providerId = UUID (FK to Provider)
//   The frontend has no `providerId` — it stores the display name directly.
//   Backend never stores a provider name on the encounter.
//
// A3. Field name: "visitType" vs "reasonForVisitId"
//   Frontend:  Encounter.visitType = "Follow-up" (reason name string)
//   Backend:   Encounter.reasonForVisitId = UUID (FK to ReasonForVisit)
//   The frontend has no `reasonForVisitId`. It uses the display name as a
//   string key to look up check-in templates (keyed by reason ID).
//
// A4. Field name: "assignedMA" vs "assignedMaUserId"
//   Frontend:  Encounter.assignedMA = "Sarah K." (display name)
//   Backend:   Encounter.assignedMaUserId = UUID (FK to User)
//
// A5. Field name: "roomNumber" vs "roomId"
//   Frontend:  Encounter.roomNumber = "Room 3" (display name)
//   Backend:   Encounter.roomId = UUID (FK to ClinicRoom)
//
// A6. Field name: "checkinTime" vs "checkInAt"
//   Frontend:  Encounter.checkinTime = "08:12" (HH:MM string)
//   Backend:   Encounter.checkInAt = ISO 8601 DateTime
//
// A7. Field: "currentStageStart" — not on backend
//   Frontend:  Encounter.currentStageStart = "08:12" (HH:MM string)
//   Backend:   Derived from AlertState.enteredStatusAt (ISO DateTime)
//   or computed from the most recent StatusChangeEvent.changedAt
//
// A8. Field: "minutesInStage" — not on backend
//   Frontend:  Encounter.minutesInStage = 18 (pre-computed number)
//   Backend:   Computed at query time from AlertState.enteredStatusAt
//
// A9. Field: "alertLevel" — not on Encounter model
//   Frontend:  Encounter.alertLevel = "Yellow"
//   Backend:   Stored on separate AlertState.currentAlertLevel (one-to-one)
//   The encounter table itself has no alertLevel column.
//
// A10. Field: "safetyActive" — not on Encounter model
//   Frontend:  Encounter.safetyActive = true/false
//   Backend:   Derived from SafetyEvent where encounterId matches AND
//              resolvedAt IS NULL. No boolean flag on Encounter itself.
//
// A11. Fields on frontend NOT on backend Encounter:
//   - patientInitials    (derived / display only)
//   - clinicName         (joined from Clinic.name)
//   - clinicShortCode    (joined from Clinic.shortCode)
//   - clinicColor        (joined from Clinic.cardColor)
//   - providerInitials   (not stored anywhere in backend; derived from name)
//   - maColor            (not on User model; frontend invented this)
//   - cardTags           (on Clinic model as Json, not on Encounter)
//
// A12. Fields on backend Encounter NOT on frontend:
//   - dateOfService      (DateTime, used for uniqueness constraint)
//   - roomingStartAt     (DateTime)
//   - roomingCompleteAt  (DateTime)
//   - providerStartAt    (DateTime)
//   - providerEndAt      (DateTime)
//   - checkoutCompleteAt (DateTime)
//   - closedAt           (DateTime)
//   - closureNotes       (String)
//   - roomingData        (Json — template captured data)
//   - clinicianData      (Json — template captured data)
//   - checkoutData       (Json — template captured data)
//   - intakeData         (Json — pre-visit intake data)
//   - insuranceVerified  (Boolean — exists on backend, optional on frontend)
//   - arrivalNotes       (String — exists on both ✅)
//
// A13. Encounter.version — same on both ✅
//   Both have `version: number` for optimistic concurrency.
//
// A14. Encounter ID format
//   Frontend mock:  "E-1042" (human-readable sequential)
//   Backend:        UUID v4 (e.g. "550e8400-e29b-41d4-a716-446655440000")
//
// A15. Encounter uniqueness
//   Backend: @@unique([patientId, clinicId, dateOfService])
//   Frontend: no uniqueness enforcement (mock data)
//
//
// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  SECTION B — PROVIDER MODEL                                          ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//
// B1. Provider belongs to single Clinic vs multi-Clinic
//   Backend Prisma:     Provider has clinicId (single FK to Clinic)
//   Frontend admin:     AdminProvider.clinicIds = ["c1", "c2"] (array)
//   Frontend mock data: Dr. Chen appears in encounters for both c1 and c2
//   CONFLICT: Backend model allows only one clinic per provider.
//
// B2. Provider fields present on frontend but missing from backend
//   Frontend AdminProvider has: specialty, npi, clinicIds[], scheduledToday,
//     encounterCount
//   Backend ProviderDto has only: name, clinicId
//   Backend Prisma Provider has only: id, name, active, clinicId
//   MISSING from backend: specialty, npi, initials
//
// B3. Provider display fields
//   Frontend Provider (mock-data): name, initials, specialty,
//     activeEncounters, completedToday, avgCycleTime, utilization, avatarColor
//   Backend: none of these computed stats exist; they'd need to be aggregated
//
//
// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  SECTION C — ROOM MODEL                                              ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//
// C1. Room ownership: Clinic vs Facility
//   Backend Prisma:   ClinicRoom has clinicId → Clinic
//   Frontend types.ts: Room has facilityId → Facility
//   Frontend mock-data Room: has clinicId (matching backend)
//   STATED CONVENTION: "Rooms belong to Facilities, not Clinics"
//   ACTUAL BACKEND: Rooms belong to Clinics
//
// C2. Room model name
//   Backend Prisma:   model is named "ClinicRoom"
//   Frontend:         uses "Room" everywhere
//
// C3. Room fields on frontend NOT on backend
//   Frontend mock Room: clinicName, occupied, encounterId, patientId,
//     status, providerName, assignedMaName, alertLevel, safetyActive
//   Backend ClinicRoom: only id, clinicId, name, active, sortOrder
//   All the "occupied" / "current encounter" fields are view-model enrichment.
//
// C4. Room fields on admin console NOT on backend
//   Frontend admin Room: label, type ("exam"/"procedure"/"storage"), occupied
//   Backend ClinicRoom: no label, no type field
//
//
// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  SECTION D — TEMPLATE SYSTEM                                         ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//
// D1. Template type enum: "intake" vs "checkin"
//   Backend Prisma enum TemplateType: rooming, clinician, checkout, intake
//   Backend shared TemplateType:      rooming, clinician, checkout, intake
//   Frontend types.ts TemplateType:   checkin, rooming, clinician, checkout
//   Frontend checkin-view.tsx: uses "checkin" templates keyed by reason ID
//   CONFLICT: Backend says "intake", frontend says "checkin"
//
// D2. Template storage: JSON schema vs inline fields
//   Backend Template model: { jsonSchema: Json, uiSchema: Json, requiredFields: Json }
//   Frontend checkin-view: hardcoded TemplateField[] arrays per reason ID
//     with { name, type, required, options? } inline definitions
//   Frontend does NOT fetch templates from API — they're all hardcoded.
//
// D3. Template relationship key
//   Backend: Template.reasonForVisitId → ReasonForVisit
//   Frontend admin: Template.reasonId (different field name)
//   Frontend checkin-view: templates keyed by reason ID string (e.g. "rv1")
//
// D4. Template admin fields on frontend NOT on backend
//   Frontend admin Template: version, fieldCount, clinicIds[], lastModified, active
//   Backend Template: no version, no fieldCount, no lastModified, no active flag
//   Backend has clinicId (single, nullable) not clinicIds[] (many-to-many)
//
//
// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  SECTION E — USER / STAFF MODEL                                      ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//
// E1. Role values: "FrontDesk" vs "FrontDeskCheckIn"/"FrontDeskCheckOut"
//   Backend RoleName enum: FrontDeskCheckIn, MA, Clinician, FrontDeskCheckOut,
//     Admin, RevenueCycle
//   Frontend StaffUser.role: "MA" | "FrontDesk" | "Clinician" | "Admin"
//   CONFLICT: Frontend collapses FrontDeskCheckIn + FrontDeskCheckOut
//   into a single "FrontDesk" role. Backend has two distinct roles.
//   Frontend also omits "RevenueCycle" from StaffUser type.
//
// E2. Frontend admin allRoles includes "OfficeManager"
//   admin-console.tsx line 203: allRoles includes "OfficeManager"
//   Backend RoleName enum: no "OfficeManager" role exists
//   CONFLICT: Frontend invented a role that doesn't exist in the backend.
//
// E3. User model fields
//   Backend User: id, email, name, status, cognitoSub, phone, createdAt
//   Frontend StaffUser (mock-data): id, name, initials, role, clinicId, color
//   Frontend AdminUser: id, name, email, status, lastLogin, createdAt, roles[]
//   MISSING from backend User: initials, color, lastLogin
//   Present on backend but not on frontend StaffUser: email, cognitoSub, phone
//
// E4. User-Role relationship
//   Backend: many-to-many via UserRole join model
//     { userId, role, clinicId?, facilityId? }
//     A user can have MULTIPLE roles across different clinics/facilities
//   Frontend AdminUser: roles[] array with { role, clinicId?, facilityId? } — matches ✅
//   Frontend StaffUser: single `role` string — simplified, doesn't match
//
// E5. User color/avatar
//   Frontend: StaffUser.color and Provider.avatarColor exist
//   Backend: User has no color field, Provider has no color field
//   The MA ownership color on encounter cards has no backend source.
//
//
// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  SECTION F — TASK MODEL                                              ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//
// F1. Task type values
//   Backend Task.taskType: free-form String (no enum)
//   Frontend MATask.taskType: "rooming" | "vitals" | "prep" | "followup"
//     | "alert_ack" | "reassignment" (union of string literals)
//   Backend has no constraint; frontend is more specific.
//
// F2. Task status values
//   Backend Task.status: String @default("open") — free-form
//   Frontend MATask.status: "pending" | "in_progress" | "done"
//   Backend presumably uses "open" / "completed" (based on test patterns)
//   CONFLICT: Different status vocabulary.
//
// F3. Task assignment field
//   Backend Task: assignedToRole (RoleName?), assignedToUserId (String?)
//   Frontend MATask: assignedMA (display name string)
//   Frontend has no assignedToRole, no assignedToUserId on MATask.
//
// F4. Task priority
//   Backend Task.priority: Int @default(0) — higher = more important
//   Frontend MATask.priority: 1 | 2 | 3 — 1 = urgent, 3 = low
//   CONFLICT: Priority scale is inverted (0=lowest in backend, 1=highest
//   in frontend)
//
// F5. Task fields on backend NOT on frontend MATask
//   - createdBy (UUID of user who created)
//   - completedAt, completedBy
//   - assignedToRole, assignedToUserId
//   Frontend MATask has: patientId (not on backend Task)
//
// F6. Task in encounter-context.tsx (CreatedTask)
//   The encounter context defines a separate CreatedTask type used for
//   tasks created from the UI. This has: assignedToRole (string),
//   priority (number), blocking (boolean). These are closer to the backend
//   Task model but still differ (no createdBy UUID, etc.)
//
//
// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  SECTION G — ALERT THRESHOLD MODEL                                   ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//
// G1. Field names: yellowMinutes/redMinutes vs yellowAtMin/redAtMin
//   Backend ThresholdDto:  yellowAtMin, redAtMin
//   Backend Prisma:        yellowAtMin, redAtMin
//   Frontend mock-data:    yellowMinutes, redMinutes
//   Frontend admin:        yellowMinutes, redMinutes
//   CONFLICT: Different field names for the same concept.
//
// G2. Threshold clinicId optionality
//   Backend ThresholdDto:  clinicId is REQUIRED (@IsString, no @IsOptional)
//   Backend Prisma:        clinicId is required (String, no ?)
//   Frontend admin:        clinicId can be null (for "global default" thresholds)
//   CONFLICT: Backend requires clinicId, frontend allows null for defaults.
//
// G3. Backend threshold has extra granularity fields
//   Backend Prisma AlertThreshold: reasonForVisitId?, providerId?, escalation2Min?
//   Frontend AlertThreshold: only status, yellowMinutes, redMinutes
//   Frontend admin Threshold type: adds isOverride boolean (not on backend)
//
//
// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  SECTION H — NOTIFICATION POLICY MODEL                               ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//
// H1. Storage format: typed arrays vs Json columns
//   Shared schema NotificationPolicy: recipients: Role[], channels: string[],
//     quietHours: { start, end, timezone } | null
//   Backend Prisma NotificationPolicy: recipientsJson: Json, channelsJson: Json,
//     quietHoursJson: Json?
//   The Prisma model stores these as raw Json; the shared schema has typed arrays.
//   The API service presumably serializes/deserializes.
//
// H2. Frontend adds "enabled" and "lastTriggered"
//   Frontend admin NotificationPolicy: has `enabled: boolean`, `lastTriggered: string | null`
//   Backend Prisma NotificationPolicy: no `enabled` field, no `lastTriggered` field
//   CONFLICT: Frontend has fields the backend doesn't store.
//
// H3. escalationRecipients storage
//   Shared schema: escalationRecipients: Role[] | null
//   Backend Prisma: escalationRecipientsJson: Json?
//   Frontend: not explicitly shown in admin UI but present in types.ts
//
//
// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  SECTION I — SAFETY ASSIST SYSTEM                                    ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//
// I1. Confirmation word source
//   Backend: GET /safety/word → { word: string } (server-generated)
//   Frontend: local array safetyWords = ["ASSIST","HARBOR","SHIELD","GUARDIAN","ANCHOR"]
//     and picks randomly on the client
//   CONFLICT: Frontend doesn't call the backend endpoint.
//
// I2. Safety resolve: requires confirmationWord
//   Backend ResolveSafetyDto: { confirmationWord, resolutionNote? }
//   Frontend safety-assist-modal.tsx: resolve flow sends confirmation word
//   This appears aligned ✅, but the frontend is not actually calling the API.
//
//
// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  SECTION J — CLINIC MODEL                                            ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//
// J1. Clinic "color" field
//   Backend Prisma Clinic: cardColor (String?)
//   Frontend mock clinics: color (String)
//   Frontend admin Clinic: color (String)
//   NAMING DIFFERENCE: "cardColor" vs "color"
//
// J2. Frontend admin Clinic has extra fields NOT on backend
//   Frontend admin Clinic: roomIds[], providerCount, dailyCapacity
//   Backend Prisma Clinic: no roomIds array, no providerCount, no dailyCapacity
//   roomIds would come from the ClinicRoom relation; providerCount/dailyCapacity
//   are computed or don't exist.
//
// J3. Clinic "facilityId" optionality
//   Backend Prisma Clinic: facilityId is optional (String?)
//   Frontend: assumes every clinic belongs to a facility
//
//
// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  SECTION K — FACILITY MODEL                                          ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//
// K1. Frontend admin Facility has extra fields NOT on backend
//   Frontend admin Facility: address, phone, npi, taxId
//   Backend Prisma Facility: only id, name, shortCode, timezone, status, createdAt
//   Backend FacilityDto: only name, shortCode?, timezone?
//   MISSING from backend: address, phone, npi, taxId (critical for real use)
//
//
// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  SECTION L — REASON FOR VISIT MODEL                                  ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//
// L1. Frontend Reason has extra fields NOT on backend
//   Frontend admin Reason: code, durationMinutes, templateCount
//   Backend Prisma ReasonForVisit: id, clinicId?, facilityId?, name, active
//   Backend ReasonDto: clinicId?, facilityId?, name, active?
//   MISSING from backend: code (short code), durationMinutes
//
// L2. Reason scoping
//   Backend: ReasonForVisit can belong to Clinic OR Facility (both optional)
//   Frontend admin: Reason has no explicit clinicId/facilityId shown
//   Frontend checkin-view: visitReasons are a flat hardcoded array with no scoping
//
//
// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  SECTION M — CANCEL / DISPOSITION SYSTEM                             ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//
// M1. Cancel DTO field names
//   Backend CancelEncounterDto: { version, reason (from EncounterCancelReasons), note? }
//   Frontend types.ts CancelEncounterRequest: { version, closureType, closureNotes? }
//   Frontend api-client.ts: sends closureType and closureNotes
//   CONFLICT: Backend uses "reason" + "note", frontend uses "closureType" + "closureNotes"
//
// M2. Cancel reason values
//   Backend EncounterCancelReasons: no_show, left_without_being_seen,
//     arrived_late, telehealth_fail, late_cancel, provider_out, emergency,
//     scheduling_error, administrative_block, other
//   Frontend: no enumerated list — closureType is a free-form string
//
//
// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  SECTION N — ASSIGNMENTS MODEL                                       ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//
// N1. ClinicAssignment is source of truth
//   Backend Prisma ClinicAssignment: { id, clinicId, providerUserId?, maUserId? }
//   Frontend admin Assignments: one MA per clinic and optional provider for MA-run clinics.
//
// N2. Legacy MA mapping model removed
//   Provider-only and MA-mapping admin panels/endpoints are deprecated and should not be used.
//
//
// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  SECTION O — ASSIGN ENCOUNTER DTO                                    ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//
// O1. Assign DTO fields
//   Backend AssignEncounterDto: { assignedMaUserId?, providerId?, version, reasonCode? }
//   Frontend types.ts AssignEncounterRequest: { assignedMaUserId, version }
//   Backend allows reassigning BOTH MA and provider in one call.
//   Frontend only allows reassigning MA (no providerId in request type).
//   Backend's @Roles('Admin') — only Admin can assign. Frontend does not
//   enforce this restriction at the UI level.
//
//
// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  SECTION P — REVENUE CYCLE / WORKBENCH                               ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//
// P1. Revenue cycle as separate entity vs embedded
//   Backend Prisma: EncounterRevenueCycle is a separate model with
//     encounterId as PK (one-to-one with Encounter)
//   Frontend: RevenueCycleRow is a flat view-model with denormalized fields
//   Fields on frontend not on backend: clinicName, clinicColor, providerName,
//     assigneeName, optimizedAt, providerQueryOpenCount
//
// P2. ProviderQuery relationship
//   Backend: ProviderQuery is a separate model linked to Encounter
//     with status enum (sent/acknowledged/resolved)
//   Frontend: only a count (providerQueryOpenCount) is shown in the workbench
//   Frontend has no UI for creating/viewing individual provider queries.
//
//
// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  SECTION Q — INCOMING SCHEDULE (BACKEND ONLY)                        ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//
// Q1. IncomingSchedule model exists ONLY on backend
//   Backend has a full IncomingSchedule model for pre-visit scheduling data
//   imported from CSV/FHIR/EHR sources. Also IncomingImportBatch for batch imports.
//   Frontend shows "Incoming" status encounters but has NO separate incoming
//   schedule concept. The checkin-view creates encounters directly into "Lobby"
//   without going through an incoming schedule.
//
// Q2. Incoming disposition reasons
//   Backend has IncomingDispositionReasons (no_show, left_without_being_seen, etc.)
//   Frontend has no disposition UI for incoming schedules.
//
//
// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  SECTION R — MODELS ON BACKEND WITH NO FRONTEND EQUIVALENT           ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//
// R1. ClinicDay — no frontend equivalent
//   Backend tracks operational days per clinic with Open/Closed status,
//   opened/closed timestamps, and notes. Frontend has no day management UI.
//
// R2. IntegrationConnector — no frontend equivalent
//   Backend stores integration config (schedule/intake type, status, config JSON).
//   Frontend has no integration settings UI.
//
// R3. AuditLog — partially on frontend
//   Backend has full AuditLog model with actor, action, entity, payload.
//   Frontend admin-console has a mockAuditLog but it's display-only mock data
//   with no API wiring.
//
// R4. OutboxEvent — no frontend equivalent
//   Backend event outbox for async processing. Internal to API.
//
// R5. NotificationDelivery — no frontend equivalent
//   Backend tracks individual notification deliveries (sent, acknowledged).
//   Frontend Alert type is simpler: just { type, message, acknowledged }.
//
// R6. OfficeManagerAnnotation — no frontend UI yet
//   Backend has full model and POST endpoint.
//   Frontend has not built the annotation UI (mentioned in user's background).
//
//
// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  SECTION S — FRONTEND CONCEPTS WITH NO BACKEND EQUIVALENT            ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//
// S1. StageMetric / HourlyVolume / overview KPIs
//   Frontend has: StageMetric[], HourlyVolume[], KPI cards
//     (totalActive, avgCycleTime, slaCompliance, activeAlerts)
//   Backend: no endpoint returns pre-aggregated dashboard stats.
//   The /office-manager/reports endpoint may partially cover this
//   but the exact response shape is unknown.
//
// S2. Provider utilization stats
//   Frontend Provider view-model: activeEncounters, completedToday,
//     avgCycleTime, utilization
//   Backend: no provider stats endpoint exists.
//
// S3. "My Dashboard" role-based metrics
//   Frontend overview-page has a demo role switcher showing
//   per-employee metrics. Backend has no equivalent personalized endpoint.
//
// S4. Alert view model
//   Frontend Alert: { id, type, message, encounterId, timestamp, acknowledged, acknowledgedBy }
//   Backend: Alerts are derived from AlertState threshold crossings +
//     NotificationDelivery records. No single "Alert" entity exists.
//
//
// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  SECTION T — ROUTING / ENDPOINT ALIGNMENT                            ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//
// T1. Rooms endpoint query param
//   Backend: GET /admin/rooms?clinicId=...
//   Frontend expects (per types.ts): facilityId param (if rooms move to facility)
//   CURRENTLY: both use clinicId, but convention says facilityId
//
// T2. Templates listing endpoint
//   Backend: GET /admin/templates?clinicId=&reasonForVisitId=&type=&definitionsOnly=
//   Frontend: does not call this endpoint; templates are hardcoded inline
//
// T3. Missing endpoints the frontend needs
//   - GET /dashboard/overview (aggregated KPIs, room status, stage metrics)
//   - GET /admin/annotations (list annotations — only POST exists)
//   - DELETE /admin/annotations/:id (delete annotation)
//   - GET /encounters/:id/history (status change events for timeline)
//
// T4. Endpoint method mismatches
//   Backend: POST /admin/clinics/:id (for update)
//   REST convention: should be PATCH or PUT for updates
//   (Same pattern for facilities/:id, providers/:id, etc.)
//   Frontend api-client.ts: correctly sends POST to match backend.
//
//
// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  SECTION U — SHARED PACKAGE / ZOD SCHEMA DIFFERENCES                 ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//
// U1. EncounterBaseSchema missing fields that exist on Prisma Encounter
//   Prisma has but shared schema omits:
//   - dateOfService
//   - insuranceVerified
//   - arrivalNotes
//   - roomingData, clinicianData, checkoutData (Json fields)
//   These exist in Prisma but are NOT in the Zod EncounterBaseSchema.
//
// U2. EventName enum vs actual events
//   Shared EventName: encounter.created, encounter.status_changed,
//     rooming.updated, visit.started, visit.ended, checkout.completed,
//     alert.threshold_crossed, alert.safety_activated, alert.safety_resolved,
//     incoming.updated, task.created, task.updated
//   Frontend has no event subscription system — all state is mock.
//
// U3. SafetyState enum unused
//   Shared defines SafetyState: "Inactive" | "Active"
//   Backend: never stores this enum; safety state is derived from SafetyEvent
//   Frontend types.ts: exports SafetyState but it's never used in UI code
//
//
// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  SUMMARY TABLE                                                       ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//
// Count of differences by category:
//   Encounter entity:       15 differences (A1–A15)
//   Provider model:          3 differences (B1–B3)
//   Room model:              4 differences (C1–C4)
//   Template system:         4 differences (D1–D4)
//   User/Staff model:        5 differences (E1–E5)
//   Task model:              6 differences (F1–F6)
//   Alert thresholds:        3 differences (G1–G3)
//   Notification policies:   3 differences (H1–H3)
//   Safety system:           2 differences (I1–I2)
//   Clinic model:            3 differences (J1–J3)
//   Facility model:          1 difference  (K1)
//   Reason for visit:        2 differences (L1–L2)
//   Cancel/disposition:      2 differences (M1–M2)
//   MA mappings:             2 differences (N1–N2)
//   Assign encounter:        1 difference  (O1)
//   Revenue cycle:           2 differences (P1–P2)
//   Incoming schedule:       2 differences (Q1–Q2)
//   Backend-only models:     6 models      (R1–R6)
//   Frontend-only concepts:  4 concepts    (S1–S4)
//   Routing/endpoints:       4 differences (T1–T4)
//   Shared package:          3 differences (U1–U3)
//   ─────────────────────────────────────────
//   TOTAL:                  70 identified differences
//
// ══════════════════════════════════════════════════════════════════════════

export {};
