// ══════════════════════════════════════════════════════════════════════
// Flow — Canonical Frontend Types
// Aligned with packages/shared/src/index.ts  (codex/office-manager)
// ══════════════════════════════════════════════════════════════════════

// ── Enums (mirror @clinops/shared) ───────────────────────────────────

export type EncounterStatus =
  | "Incoming"
  | "Lobby"
  | "Rooming"
  | "ReadyForProvider"
  | "Optimizing"
  | "CheckOut"
  | "Optimized";

export type AlertLevel = "Green" | "Yellow" | "Red";

export type Role =
  | "FrontDeskCheckIn"
  | "MA"
  | "Clinician"
  | "FrontDeskCheckOut"
  | "OfficeManager"
  | "Admin"
  | "RevenueCycle";

export type RevenueCycleStatus =
  | "ChargeCapturePending"
  | "CodingInProgress"
  | "ProviderClarificationNeeded"
  | "ReadyToSubmit"
  | "Submitted"
  | "HoldException";

export type RevenueStatus =
  | "FinancialReadinessNeeded"
  | "FinanciallyCleared"
  | "CheckoutTrackingNeeded"
  | "ChargeCaptureNeeded"
  | "CodingReviewInProgress"
  | "ProviderClarificationNeeded"
  | "ReadyForAthenaHandoff"
  | "AthenaHandoffInProgress"
  | "AthenaHandoffConfirmed"
  | "MonitoringOnly"
  | "Closed";

export type RevenueWorkQueue =
  | "FinancialReadiness"
  | "CheckoutTracking"
  | "ChargeCapture"
  | "ProviderQueries"
  | "AthenaHandoff"
  | "Monitoring";

export type RevenueDayBucket = "Today" | "Yesterday" | "Rolled" | "Monitoring";
export type FinancialEligibilityStatus = "NotChecked" | "Clear" | "Blocked" | "Pending";
export type FinancialRequirementStatus = "NotRequired" | "Pending" | "Approved" | "Expired" | "UnableToObtain";
export type CollectionOutcome =
  | "CollectedInFull"
  | "CollectedPartial"
  | "NotCollected"
  | "NoCollectionExpected"
  | "Waived"
  | "Deferred";
export type CodingStage = "NotStarted" | "InProgress" | "ReadyForReview" | "ReadyForAthena";
export type ProviderClarificationStatus = "Open" | "Responded" | "Resolved";
export type RevenueCloseoutState = "Open" | "ClosedResolved" | "ClosedUnresolved" | "RolledOver";

export type TemplateType = "checkin" | "rooming" | "clinician" | "checkout";
export type TemplateStatus = "active" | "inactive" | "archived";
export type ReasonStatus = "active" | "inactive" | "archived";
export type TemplateFieldType =
  | "text"
  | "textarea"
  | "number"
  | "checkbox"
  | "select"
  | "radio"
  | "date"
  | "time"
  | "bloodPressure"
  | "temperature"
  | "pulse"
  | "respirations"
  | "oxygenSaturation"
  | "height"
  | "weight"
  | "painScore"
  | "yesNo";
export type AlertThresholdMetric = "stage" | "overall_visit";

export type SafetyState = "Inactive" | "Active";

export interface TemplateFieldDefinition {
  id?: string;
  key: string;
  label: string;
  type: TemplateFieldType;
  required?: boolean;
  options?: string[];
  group?: string;
  icon?: string;
  color?: string;
}

// ── Ordered status pipeline (canonical sequence) ─────────────────────

export const STATUS_PIPELINE: EncounterStatus[] = [
  "Incoming",
  "Lobby",
  "Rooming",
  "ReadyForProvider",
  "Optimizing",
  "CheckOut",
  "Optimized",
];

// ── Backend DTOs (what the API sends/receives) ───────────────────────

/** Matches EncounterBaseSchema from packages/shared */
export interface EncounterBase {
  id: string;
  patientId: string;
  clinicId: string;
  providerId: string | null;
  reasonForVisitId: string | null;
  currentStatus: EncounterStatus;
  assignedMaUserId: string | null;
  roomId: string | null;
  version: number;
  checkInAt: string | null;
  roomingStartAt: string | null;
  roomingCompleteAt: string | null;
  providerStartAt: string | null;
  providerEndAt: string | null;
  checkoutCompleteAt: string | null;
  closedAt: string | null;
  walkIn: boolean;
  closureType: string | null;
  closureNotes: string | null;
  intakeData?: Record<string, unknown> | null;
  appointmentTime?: string | null;
}

/** Task from backend */
export interface Task {
  id: string;
  encounterId: string | null;
  revenueCaseId?: string | null;
  taskCategory?: string | null;
  dueAt?: string | null;
  taskType: string;
  description: string;
  assignedToRole: Role | null;
  assignedToUserId: string | null;
  status: string;
  priority: number;
  blocking: boolean;
  createdAt: string;
  createdBy: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  completedAt: string | null;
  completedBy: string | null;
  notes: string | null;
  updatedAt?: string;
}

/** StatusChangeEvent from backend */
export interface StatusChangeEvent {
  id: string;
  encounterId: string;
  fromStatus: EncounterStatus | null;
  toStatus: EncounterStatus;
  changedAt: string;
  changedByUserId: string;
  reasonCode: string | null;
}

/** AlertState from backend */
export interface AlertState {
  encounterId: string;
  enteredStatusAt: string;
  currentAlertLevel: AlertLevel;
  yellowTriggeredAt: string | null;
  redTriggeredAt: string | null;
  escalationTriggeredAt: string | null;
  lastAckAt: string | null;
}

/** SafetyEvent from backend */
export interface SafetyEvent {
  id: string;
  encounterId: string;
  activatedAt: string;
  activatedBy: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  location: string | null;
}

/** NotificationPolicy from backend */
export interface NotificationPolicy {
  id: string;
  clinicId: string;
  status: EncounterStatus;
  severity: AlertLevel;
  recipients: Role[];
  channels: ("in_app" | "sms" | "email")[];
  cooldownMinutes: number;
  ackRequired: boolean;
  escalationAfterMin: number | null;
  escalationRecipients: Role[] | null;
  quietHours: {
    start: string;
    end: string;
    timezone: string;
  } | null;
}

// ── Admin entities ───────────────────────────────────────────────────

export interface Facility {
  id: string;
  name: string;
  shortCode?: string;
  address?: string;
  phone?: string;
  timezone?: string;
  status?: string;
}

export interface Clinic {
  id: string;
  facilityId?: string;
  name: string;
  shortCode?: string;
  timezone?: string;
  maRun?: boolean;
  autoCloseEnabled?: boolean;
  autoCloseTime?: string;
  cardTags?: string[];
  cardColor?: string;
  status?: string;
  roomIds?: string[];
}

export interface Provider {
  id: string;
  name: string;
  initials: string;
  specialty?: string;
  clinicIds?: string[];
  active: boolean;
}

export interface Reason {
  id: string;
  name: string;
  facilityId?: string;
  appointmentLengthMinutes: number;
  status: ReasonStatus;
  clinicIds: string[];
  // legacy compatibility for currently-wired views
  active?: boolean;
  clinicId?: string;
  code?: string;
  durationMinutes?: number;
  templateCount?: number;
}

export interface Room {
  id: string;
  facilityId: string;
  name: string;
  roomNumber: number;
  roomType: string;
  status: "active" | "inactive" | "archived";
  active?: boolean;
  sortOrder?: number;
  encounterCount?: number;
  clinicIds?: string[];
}

export interface StaffUser {
  id: string;
  email: string;
  name: string;
  status?: string;
  phone?: string;
  entraObjectId?: string | null;
  entraTenantId?: string | null;
  entraUserPrincipalName?: string | null;
  identityProvider?: string | null;
  directoryStatus?: string | null;
  directoryUserType?: string | null;
  directoryAccountEnabled?: boolean | null;
  lastDirectorySyncAt?: string | null;
  activeFacilityId?: string | null;
  assignedFacilityIds?: string[];
  roles: UserRole[];
}

export interface DirectoryUser {
  objectId: string;
  displayName: string;
  email: string;
  userPrincipalName: string;
  accountEnabled: boolean;
  userType: string;
  tenantId: string;
  identityProvider: "entra";
  directoryStatus: "active" | "disabled" | "guest" | "deleted";
}

export interface UserRole {
  role: Role;
  clinicId?: string;
  facilityId?: string;
}

export interface Template {
  id: string;
  facilityId: string;
  name: string;
  type: TemplateType;
  status: TemplateStatus;
  reasonIds: string[];
  fields: TemplateFieldDefinition[];
  requiredFields: string[];
  // compatibility fields currently used by existing UI/runtime slices
  active?: boolean;
  clinicId?: string | null;
  reasonForVisitId?: string | null;
  fieldsJson?: TemplateFieldDefinition[];
  jsonSchema: Record<string, unknown>;
  uiSchema: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface AlertThreshold {
  id: string;
  facilityId: string;
  clinicId: string | null;
  metric: AlertThresholdMetric;
  status: EncounterStatus | null;
  yellowAtMin: number;
  redAtMin: number;
  escalation2Min?: number | null;
  // compatibility aliases used by existing UI slices
  yellowMinutes?: number;
  redMinutes?: number;
}

export interface MaProviderMapping {
  id: string;
  maUserId: string;
  providerId: string;
}

export interface MaClinicMapping {
  id: string;
  maUserId: string;
  clinicId: string;
}

export interface ClinicAssignment {
  id: string | null;
  clinicId: string;
  clinicName: string;
  clinicShortCode?: string | null;
  clinicStatus: string;
  maRun: boolean;
  providerUserId: string | null;
  providerUserName: string | null;
  providerUserStatus: string | null;
  maUserId: string | null;
  maUserName: string | null;
  maUserStatus: string | null;
  roomCount: number;
  isOperational: boolean;
}

export interface AdminEncounterRecoveryRow {
  id: string;
  version: number;
  patientId: string;
  clinicId: string;
  clinicName: string;
  dateOfService: string;
  currentStatus: EncounterStatus;
  providerName: string | null;
  reasonForVisit: string | null;
  roomId: string | null;
  roomName: string | null;
  assignedMaUserId: string | null;
  assignedMaName: string | null;
  checkInAt: string | null;
  roomingStartAt: string | null;
  roomingCompleteAt: string | null;
  providerStartAt: string | null;
  providerEndAt: string | null;
  checkoutCompleteAt: string | null;
  closedAt: string | null;
  closureType: string | null;
  archivedForOperations: boolean;
  needsRecovery: boolean;
}

export interface PatientIdentityCandidate {
  id: string;
  sourcePatientId: string;
  displayName: string | null;
  dateOfBirth: string | null;
}

export interface PatientIdentityReview {
  id: string;
  facilityId: string;
  patientId: string | null;
  sourcePatientId: string;
  normalizedSourcePatientId: string;
  displayName: string | null;
  normalizedDisplayName: string | null;
  dateOfBirth: string | null;
  reasonCode: string;
  status: "open" | "resolved" | "ignored";
  matchedPatientIds: string[];
  contextJson?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  patient?: PatientIdentityCandidate | null;
  matchedPatients: PatientIdentityCandidate[];
}

// ── View-model types (enriched for UI display) ───────────────────────

/**
 * Encounter enriched with denormalized display values.
 * This is what the frontend views consume.
 * The API should return enriched encounters (with joined names),
 * or the frontend resolves references via lookup maps.
 */
export interface EncounterView {
  // Core fields from EncounterBase
  id: string;
  patientId: string;
  clinicId: string;
  providerId: string | null;
  reasonForVisitId: string | null;
  currentStatus: EncounterStatus;
  assignedMaUserId: string | null;
  roomId: string | null;
  version: number;
  checkInAt: string | null;
  roomingStartAt: string | null;
  roomingCompleteAt: string | null;
  providerStartAt: string | null;
  providerEndAt: string | null;
  checkoutCompleteAt: string | null;
  closedAt: string | null;
  walkIn: boolean;
  closureType: string | null;
  closureNotes: string | null;
  intakeData?: Record<string, unknown> | null;

  // Denormalized display fields (resolved from references)
  patientInitials: string;
  clinicName: string;
  clinicShortCode: string;
  clinicColor: string;
  maRun?: boolean;
  providerName: string;
  providerInitials: string;
  reasonName: string;
  assignedMaName: string | null;
  maColor: string | null;
  roomName: string | null;

  // Computed / live state
  alertLevel: AlertLevel;
  safetyActive: boolean;
  currentStageStartAt: string;
  minutesInStage: number;
  insuranceVerified?: boolean;
  arrivalNotes?: string;
  cardTags?: string[];
}

/** Room enriched with current occupant info for board views */
export interface RoomView {
  id: string;
  facilityId: string;
  name: string;
  active: boolean;
  sortOrder?: number;
  occupied: boolean;
  encounterId?: string;
  patientId?: string;
  status?: EncounterStatus;
  providerName?: string;
  assignedMaName?: string;
  alertLevel?: AlertLevel;
  safetyActive: boolean;
}

/** Provider with live operational stats */
export interface ProviderView {
  id: string;
  name: string;
  initials: string;
  specialty: string;
  activeEncounters: number;
  completedToday: number;
  avgCycleTime: number;
  utilization: number;
  avatarColor: string;
}

/** Alert as shown in the UI */
export interface AlertView {
  id: string;
  type: "Yellow" | "Red" | "safety";
  message: string;
  encounterId: string;
  timestamp: string;
  acknowledged: boolean;
  acknowledgedBy?: string;
}

/** Revenue cycle row for workbench */
export interface RevenueCycleRow {
  encounterId: string;
  patientId: string;
  clinicName: string;
  clinicColor: string;
  providerName: string;
  status: RevenueCycleStatus;
  assigneeName: string | null;
  dueAt: string | null;
  priority: number;
  notes: string | null;
  holdReason: string | null;
  reviewedAt: string | null;
  optimizedAt: string;
  providerQueryOpenCount: number;
}

export interface RevenueChecklistItem {
  id: string;
  group: string;
  label: string;
  required: boolean;
  status: string;
  sortOrder: number;
  dueAt: string | null;
  completedAt: string | null;
  completedByUserId: string | null;
  evidenceText: string | null;
}

export interface RevenueProviderClarification {
  id: string;
  encounterId: string;
  requestedByUserId: string;
  targetUserId: string | null;
  queryType: string | null;
  questionText: string;
  responseText: string | null;
  status: ProviderClarificationStatus;
  openedAt: string;
  respondedAt: string | null;
  resolvedAt: string | null;
}

export interface RevenueCaseEvent {
  id: string;
  eventType: string;
  fromStatus: RevenueStatus | null;
  toStatus: RevenueStatus | null;
  actorUserId: string | null;
  eventText: string | null;
  createdAt: string;
  payloadJson?: Record<string, unknown> | null;
}

export interface RevenueFinancialReadiness {
  eligibilityStatus: FinancialEligibilityStatus;
  verifiedAt?: string | null;
  verifiedByUserId?: string | null;
  registrationVerified: boolean;
  contactInfoVerified: boolean;
  primaryPayerName?: string | null;
  primaryPlanName?: string | null;
  secondaryPayerName?: string | null;
  financialClass?: string | null;
  benefitsSummaryText?: string | null;
  patientEstimateAmountCents: number;
  pointOfServiceAmountDueCents: number;
  estimateExplainedToPatient: boolean;
  outstandingPriorBalanceCents?: number;
  coverageIssueCategory?: string | null;
  coverageIssueText?: string | null;
  referralRequired: boolean;
  referralStatus?: FinancialRequirementStatus | null;
  priorAuthRequired: boolean;
  priorAuthStatus?: FinancialRequirementStatus | null;
  priorAuthNumber?: string | null;
}

export interface RevenueCheckoutCollectionTracking {
  collectionExpected: boolean;
  amountDueCents: number;
  amountCollectedCents: number;
  collectionOutcome: CollectionOutcome | null;
  missedCollectionReason: string | null;
  trackingNote: string | null;
  trackedByUserId?: string | null;
  trackedAt?: string | null;
}

export interface RevenueChargeCaptureRecord {
  documentationComplete: boolean;
  codingStage: CodingStage;
  icd10CodesJson: string[];
  procedureLinesJson: RevenueProcedureLine[];
  serviceCaptureItemsJson: RevenueServiceCaptureItem[];
  documentationSummaryJson?: RevenueDocumentationSummary | null;
  cptCodesJson: string[];
  modifiersJson: string[];
  unitsJson: string[];
  codingNote: string | null;
  readyForAthenaAt?: string | null;
  reviewedByUserId?: string | null;
  reviewedAt?: string | null;
}

export interface RevenueDocumentationSummary {
  chiefConcernSummary?: string | null;
  assessmentSummary?: string | null;
  planFollowUp?: string | null;
  ordersOrProcedures?: string | null;
}

export interface RevenueProcedureLine {
  lineId: string;
  cptCode: string;
  modifiers: string[];
  units: number;
  diagnosisPointers: number[];
}

export interface RevenueServiceCaptureItem {
  id: string;
  catalogItemId: string | null;
  label: string;
  sourceRole: string;
  sourceTaskId: string | null;
  quantity: number;
  note: string | null;
  performedAt: string | null;
  capturedByUserId: string | null;
  suggestedProcedureCode: string | null;
  expectedChargeCents: number | null;
  detailSchemaKey: string;
  detailJson: Record<string, unknown> | null;
  detailComplete: boolean;
}

export interface RevenueServiceCatalogItem {
  id: string;
  label: string;
  suggestedProcedureCode: string | null;
  expectedChargeCents: number | null;
  detailSchemaKey?: string | null;
  active: boolean;
  allowCustomNote?: boolean;
}

export interface RevenueChargeScheduleItem {
  code: string;
  amountCents: number;
  description: string | null;
  active: boolean;
}

export interface RevenueCaseDetail {
  id: string;
  encounterId: string;
  patientId: string;
  clinicId: string;
  clinicName: string;
  clinicColor: string;
  providerName: string;
  currentRevenueStatus: RevenueStatus;
  currentWorkQueue: RevenueWorkQueue;
  currentDayBucket: RevenueDayBucket;
  priority: number;
  assignedToUserId: string | null;
  assignedToUserName: string | null;
  assignedToRole: Role | null;
  currentBlockerCategory: string | null;
  currentBlockerText: string | null;
  dueAt: string | null;
  rolledFromDateKey: string | null;
  rollReason: string | null;
  closeoutState: RevenueCloseoutState;
  readyForAthenaAt: string | null;
  athenaHandoffOwnerUserId: string | null;
  athenaHandoffStartedAt: string | null;
  athenaHandoffConfirmedAt: string | null;
  athenaHandoffConfirmedByUserId: string | null;
  athenaHandoffNote: string | null;
  athenaChargeEnteredAt: string | null;
  athenaClaimSubmittedAt: string | null;
  athenaDaysToSubmit: number | null;
  athenaDaysInAR: number | null;
  athenaClaimStatus: string | null;
  athenaPatientBalanceCents: number | null;
  athenaLastSyncAt: string | null;
  closedAt: string | null;
  providerQueryOpenCount: number;
  encounter: {
    id: string;
    patientId: string;
    currentStatus: EncounterStatus;
    checkInAt: string | null;
    providerEndAt: string | null;
    checkoutCompleteAt: string | null;
    roomName: string | null;
    reasonForVisit: string | null;
    roomingData?: Record<string, unknown> | null;
    clinicianData?: Record<string, unknown> | null;
    checkoutData?: Record<string, unknown> | null;
  };
  financialReadiness: RevenueFinancialReadiness | null;
  checkoutCollectionTracking: RevenueCheckoutCollectionTracking | null;
  chargeCaptureRecord: RevenueChargeCaptureRecord | null;
  checklistItems: RevenueChecklistItem[];
  providerClarifications: RevenueProviderClarification[];
  events: RevenueCaseEvent[];
}

export interface RevenueDashboardSnapshot {
  scope: {
    clinicId?: string | null;
    from: string;
    to: string;
  };
  kpis: {
    sameDayCollectionExpectedVisitCount: number;
    sameDayCollectionCapturedVisitCount: number;
    sameDayCollectionExpectedCents: number;
    sameDayCollectionCapturedCents: number;
    sameDayCollectionVisitRate: number;
    sameDayCollectionDollarRate: number;
    expectedGrossChargeCents: number;
    expectedNetReimbursementCents: number;
    serviceCaptureCompletedVisitCount: number;
    clinicianCodingEnteredVisitCount: number;
    chargeCaptureReadyVisitCount: number;
    averageFlowHandoffLagHours: number;
    athenaDaysToSubmit: number | null;
    athenaDaysInAR: number | null;
  };
  risks: {
    eligibilityBlockers: number;
    checkoutCollectionMisses: number;
    chargeCaptureNotStarted: number;
    providerQueriesOpen: number;
    readyForAthena: number;
    rolledFromYesterday: number;
  };
  queueCounts: Record<string, number>;
  settings: {
    missedCollectionReasons: string[];
    providerQueryTemplates: string[];
    athenaLinkTemplate: string;
    serviceCatalog: RevenueServiceCatalogItem[];
    chargeSchedule: RevenueChargeScheduleItem[];
    estimateDefaults: RevenueEstimateDefaults;
    reimbursementRules: RevenueReimbursementRuleItem[];
    checklistDefaults: Record<string, Array<{ label: string; sortOrder: number; required?: boolean }>>;
  };
  cases: RevenueCaseDetail[];
}

export interface RevenueDailyHistoryRollup {
  clinicId: string;
  clinicName: string;
  dateKey: string;
  sameDayCollectionExpectedVisitCount: number;
  sameDayCollectionCapturedVisitCount: number;
  sameDayCollectionExpectedCents: number;
  sameDayCollectionTrackedCents: number;
  sameDayCollectionVisitRate: number;
  sameDayCollectionDollarRate: number;
  expectedGrossChargeCents: number;
  expectedNetReimbursementCents: number;
  serviceCaptureCompletedVisitCount: number;
  clinicianCodingEnteredVisitCount: number;
  chargeCaptureReadyVisitCount: number;
  financiallyClearedCount: number;
  chargeCaptureCompletedCount: number;
  athenaHandoffConfirmedCount: number;
  rolledCount: number;
  avgFlowHandoffHours: number;
  avgAthenaDaysToSubmit: number | null;
  avgAthenaDaysInAR: number | null;
  queueCountsJson?: Record<string, number> | null;
  missedCollectionReasonsJson?: Record<string, number> | null;
  rollReasonsJson?: Record<string, number> | null;
  queryAgingJson?: Record<string, number> | null;
  unfinishedQueueCountsJson?: Record<string, number> | null;
  unfinishedOwnerCountsJson?: Record<string, number> | null;
  unfinishedProviderCountsJson?: Record<string, number> | null;
  computedAt: string;
}

export interface RevenueHistorySummaryEntry {
  label: string;
  count: number;
}

export interface RevenueHistorySummary {
  unfinishedQueues: RevenueHistorySummaryEntry[];
  unfinishedReasons: RevenueHistorySummaryEntry[];
  unfinishedOwners: RevenueHistorySummaryEntry[];
  unfinishedProviders: RevenueHistorySummaryEntry[];
  unfinishedClinics: RevenueHistorySummaryEntry[];
  averageFlowHandoffLagHours: number;
  averageAthenaDaysToSubmit: number | null;
  averageAthenaDaysInAR: number | null;
  rolledCount: number;
}

export interface RevenueSettings {
  facilityId: string;
  missedCollectionReasons: string[];
  queueSla: Record<string, number>;
  dayCloseDefaults: {
    defaultDueHours?: number;
    requireNextAction?: boolean;
  };
  estimateDefaults: RevenueEstimateDefaults;
  providerQueryTemplates: string[];
  athenaLinkTemplate: string;
  athenaChecklistDefaults: Array<{ label: string; sortOrder: number }>;
  checklistDefaults: Record<string, Array<{ label: string; sortOrder: number; required?: boolean }>>;
  serviceCatalog: RevenueServiceCatalogItem[];
  chargeSchedule: RevenueChargeScheduleItem[];
  reimbursementRules: RevenueReimbursementRuleItem[];
  defaults?: {
    missedCollectionReasons: string[];
    providerQueryTemplates: string[];
    queueSla: Record<string, number>;
    dayCloseDefaults: Record<string, unknown>;
    estimateDefaults?: RevenueEstimateDefaults;
    checklistDefaults?: Record<string, Array<{ label: string; sortOrder: number; required?: boolean }>>;
    serviceCatalog?: RevenueServiceCatalogItem[];
    chargeSchedule?: RevenueChargeScheduleItem[];
    reimbursementRules?: RevenueReimbursementRuleItem[];
  };
}

export interface RevenueEstimateDefaults {
  defaultPatientEstimateCents: number;
  defaultPosCollectionPercent: number;
  explainEstimateByDefault: boolean;
}

export interface RevenueReimbursementRuleItem {
  id: string;
  payerName?: string | null;
  financialClass?: string | null;
  expectedPercent: number;
  active: boolean;
  note?: string | null;
}

export interface OwnerAnalyticsSnapshot {
  scope: {
    clinicId?: string | null;
    from: string;
    to: string;
  };
  overview: {
    encounterCount: number;
    inProgressCount: number;
    avgCycleTimeMins: number;
    sameDayCollectionExpectedCents: number;
    sameDayCollectionTrackedCents: number;
    sameDayCollectionDollarRate: number;
    expectedGrossChargeCents: number;
    expectedNetReimbursementCents: number;
    unresolvedBlockers: number;
  };
  throughput: {
    stageCounts: Record<string, number>;
    stageDurations: Array<{ status: string; count: number; avgMinutes: number }>;
    daily: Array<{
      dateKey: string;
      encounterCount: number;
      avgCycleTimeMins: number;
      inProgressCount: number;
      rolledCount: number;
    }>;
    hourOfDay: Array<{ label: string; count: number }>;
    leakage: {
      rolledCount: number;
      providerQueriesOpen: number;
    };
  };
  revenue: {
    daily: Array<{
      dateKey: string;
      expectedGrossChargeCents: number;
      expectedNetReimbursementCents: number;
      sameDayCollectionExpectedCents: number;
      sameDayCollectionTrackedCents: number;
      sameDayCollectionVisitRate: number;
      sameDayCollectionDollarRate: number;
    }>;
    queueCounts: Record<string, number>;
    missedCollectionReasons: Array<{ label: string; count: number }>;
    collectionOutcomes: Array<{ label: string; count: number }>;
    mappingGaps: {
      missingChargeMappingCount: number;
      missingReimbursementMappingCount: number;
    };
  };
  providersAndStaff: {
    providers: Array<{
      providerName: string;
      encounterCount: number;
      activeCount: number;
      completedCount: number;
      avgOptimizingMins: number;
    }>;
    staff: Array<{
      label: string;
      role: string;
      encounterCount: number;
    }>;
  };
  roomsAndCapacity: {
    current: {
      roomCount: number;
      avgOccupiedMins: number;
      avgTurnoverMins: number;
      turnoverCount: number;
      holdCount: number;
      issueCount: number;
    };
    daily: Array<{
      dateKey: string;
      roomCount: number;
      avgOccupiedMins: number;
      avgTurnoverMins: number;
      turnoverCount: number;
      holdCount: number;
      issueCount: number;
    }>;
    issueTypes: Array<{ label: string; count: number }>;
  };
  exceptionsAndRisk: {
    documentationIncompleteCount: number;
    providerQueriesOpen: number;
    rolloverReasons: Array<{ label: string; count: number }>;
    staleUnresolvedCount: number;
    activeSafetyCount: number;
    blockingTaskCount: number;
  };
}

/** Day closeout row */
export interface CloseoutRow {
  encounterId: string;
  patientId: string;
  clinicName: string;
  clinicColor: string;
  currentStatus: EncounterStatus;
  version: number;
  providerName: string;
  assignedMaName: string | null;
  roomName: string | null;
  alertLevel: AlertLevel;
  enteredStatusAt: string;
  statusElapsedMs: number;
  safetyActive: boolean;
}

// ── Request DTOs (what the frontend sends to the API) ────────────────

export interface CreateEncounterRequest {
  patientId: string;
  clinicId: string;
  incomingId?: string;
  providerId?: string;
  providerName?: string;
  reasonForVisitId?: string;
  reasonForVisit?: string;
  walkIn?: boolean;
  insuranceVerified?: boolean;
  arrivalNotes?: string;
  intakeData?: Record<string, unknown>;
}

export interface UpdateStatusRequest {
  toStatus: EncounterStatus;
  version: number;
  reasonCode?: string;
}

export interface UpdateRoomingRequest {
  version?: number;
  roomId?: string | null;
  data?: Record<string, unknown>;
}

export interface StartVisitRequest {
  version: number;
}

export interface EndVisitRequest {
  version: number;
  data?: Record<string, unknown>;
}

export interface CompleteCheckoutRequest {
  version: number;
  checkoutData?: Record<string, unknown>;
}

export interface CancelEncounterRequest {
  version: number;
  closureType: string;
  closureNotes?: string;
}

export interface AssignEncounterRequest {
  assignedMaUserId: string;
  version: number;
}

export interface ActivateSafetyRequest {
  confirmationWord: string;
  location?: string;
}

export interface ResolveSafetyRequest {
  confirmationWord: string;
  resolutionNote?: string;
}

// ── Display helpers ──────────────────────────────────────────────────

export const STATUS_LABELS: Record<EncounterStatus, string> = {
  Incoming: "Incoming",
  Lobby: "Lobby",
  Rooming: "Rooming",
  ReadyForProvider: "Ready for Provider",
  Optimizing: "Optimizing",
  CheckOut: "Check Out",
  Optimized: "Optimized",
};

export const STATUS_COLORS: Record<EncounterStatus, string> = {
  Incoming: "#94a3b8",
  Lobby: "#6366f1",
  Rooming: "#8b5cf6",
  ReadyForProvider: "#f59e0b",
  Optimizing: "#a855f7",
  CheckOut: "#10b981",
  Optimized: "#06b6d4",
};

export const REVENUE_CYCLE_LABELS: Record<RevenueCycleStatus, string> = {
  ChargeCapturePending: "Charge Capture Pending",
  CodingInProgress: "Coding In Progress",
  ProviderClarificationNeeded: "Provider Clarification",
  ReadyToSubmit: "Ready to Submit",
  Submitted: "Submitted",
  HoldException: "Hold / Exception",
};

export const REVENUE_CYCLE_COLORS: Record<RevenueCycleStatus, string> = {
  ChargeCapturePending: "#f59e0b",
  CodingInProgress: "#6366f1",
  ProviderClarificationNeeded: "#ef4444",
  ReadyToSubmit: "#10b981",
  Submitted: "#06b6d4",
  HoldException: "#dc2626",
};

export const REVENUE_STATUS_LABELS: Record<RevenueStatus, string> = {
  FinancialReadinessNeeded: "Financial Readiness Needed",
  FinanciallyCleared: "Financially Cleared",
  CheckoutTrackingNeeded: "Checkout Tracking Needed",
  ChargeCaptureNeeded: "Charge Capture Needed",
  CodingReviewInProgress: "Coding Review In Progress",
  ProviderClarificationNeeded: "Provider Clarification Needed",
  ReadyForAthenaHandoff: "Ready for Athena Handoff",
  AthenaHandoffInProgress: "Athena Handoff In Progress",
  AthenaHandoffConfirmed: "Athena Handoff Confirmed",
  MonitoringOnly: "Monitoring Only",
  Closed: "Closed",
};

export const REVENUE_STATUS_COLORS: Record<RevenueStatus, string> = {
  FinancialReadinessNeeded: "#dc2626",
  FinanciallyCleared: "#10b981",
  CheckoutTrackingNeeded: "#f59e0b",
  ChargeCaptureNeeded: "#f97316",
  CodingReviewInProgress: "#6366f1",
  ProviderClarificationNeeded: "#8b5cf6",
  ReadyForAthenaHandoff: "#0891b2",
  AthenaHandoffInProgress: "#2563eb",
  AthenaHandoffConfirmed: "#0f766e",
  MonitoringOnly: "#64748b",
  Closed: "#94a3b8",
};

export const REVENUE_WORK_QUEUE_LABELS: Record<RevenueWorkQueue, string> = {
  FinancialReadiness: "Financial Readiness",
  CheckoutTracking: "Checkout Tracking",
  ChargeCapture: "Charge Capture",
  ProviderQueries: "Provider Queries",
  AthenaHandoff: "Athena Handoff",
  Monitoring: "Monitoring",
};

export const REVENUE_DAY_BUCKET_LABELS: Record<RevenueDayBucket, string> = {
  Today: "Today",
  Yesterday: "Yesterday",
  Rolled: "Rolled",
  Monitoring: "Monitoring",
};

export const ROLE_LABELS: Record<Role, string> = {
  FrontDeskCheckIn: "Front Desk (Check-In)",
  MA: "Medical Assistant",
  Clinician: "Clinician",
  FrontDeskCheckOut: "Front Desk (Check-Out)",
  OfficeManager: "Office Manager",
  Admin: "Admin",
  RevenueCycle: "Revenue Cycle",
};
