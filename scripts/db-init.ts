import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

function resolveSqlitePath(databaseUrl: string) {
  if (!databaseUrl.startsWith("file:")) {
    throw new Error("Only sqlite file: URLs are supported by scripts/db-init.ts");
  }

  const raw = databaseUrl.replace(/^file:/, "");
  if (raw === ":memory:") {
    return ":memory:";
  }

  return path.resolve(process.cwd(), raw);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const dbPath = resolveSqlitePath(databaseUrl);
if (dbPath !== ":memory:") {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

const db = new Database(dbPath);

db.pragma("foreign_keys = ON");

function hasColumn(table: string, column: string) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function hasTable(table: string) {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name?: string } | undefined;
  return Boolean(row?.name);
}

const requiresRebuild =
  hasTable("ClinicRoom") && (!hasColumn("ClinicRoom", "facilityId") || !hasColumn("ClinicRoom", "status")) ||
  hasTable("User") && !hasColumn("User", "activeFacilityId") ||
  hasTable("User") && !hasColumn("User", "entraObjectId") ||
  hasTable("User") && !hasColumn("User", "entraTenantId") ||
  hasTable("User") && !hasColumn("User", "identityProvider") ||
  hasTable("User") && !hasColumn("User", "directoryStatus") ||
  hasTable("Facility") && (!hasColumn("Facility", "address") || !hasColumn("Facility", "phone")) ||
  hasTable("Task") && (!hasColumn("Task", "acknowledgedAt") || !hasColumn("Task", "notes") || !hasColumn("Task", "roomId") || !hasColumn("Task", "sourceType") || !hasColumn("Task", "revenueCaseId") || !hasColumn("Task", "taskCategory") || !hasColumn("Task", "dueAt")) ||
  !hasTable("ClinicRoomAssignment") ||
  !hasTable("RoomOperationalState") ||
  !hasTable("RoomOperationalEvent") ||
  !hasTable("RoomIssue") ||
  !hasTable("RoomChecklistRun") ||
  !hasTable("RoomDailyRollup") ||
  !hasTable("ClinicAssignment") ||
  !hasTable("TemporaryClinicAssignmentOverride") ||
  !hasTable("ReasonClinicAssignment") ||
  !hasTable("TemplateReasonAssignment") ||
  !hasColumn("ReasonForVisit", "appointmentLengthMinutes") ||
  !hasColumn("ReasonForVisit", "status") ||
  !hasColumn("Template", "facilityId") ||
  !hasColumn("Template", "name") ||
  !hasColumn("Template", "status") ||
  !hasColumn("Template", "fieldsJson") ||
  !hasColumn("AlertThreshold", "facilityId") ||
  !hasColumn("AlertThreshold", "metric") ||
  !hasColumn("IncomingImportBatch", "facilityId") ||
  !hasColumn("IncomingImportBatch", "acceptedRowCount") ||
  !hasColumn("IncomingImportBatch", "pendingRowCount") ||
  !hasColumn("IncomingImportBatch", "status") ||
  !hasTable("IncomingImportIssue") ||
  !hasTable("IntegrationConnector") ||
  !hasTable("UserAlertInbox") ||
  !hasTable("RevenueCase") ||
  !hasTable("FinancialReadiness") ||
  !hasTable("CheckoutCollectionTracking") ||
  !hasTable("ChargeCaptureRecord") ||
  !hasTable("ProviderClarification") ||
  !hasTable("RevenueChecklistItem") ||
  !hasTable("RevenueCaseEvent") ||
  !hasTable("RevenueCycleDailyRollup") ||
  !hasTable("RevenueCycleSettings") ||
  !hasTable("RevenueCloseoutRun") ||
  !hasTable("RevenueCloseoutItem") ||
  !hasColumn("RevenueCase", "athenaHandoffOwnerUserId") ||
  !hasColumn("RevenueCase", "athenaHandoffStartedAt") ||
  !hasColumn("RevenueCase", "athenaHandoffConfirmedByUserId") ||
  !hasColumn("RevenueCase", "athenaHandoffNote") ||
  !hasColumn("RevenueCase", "closeoutState") ||
  !hasColumn("ChargeCaptureRecord", "procedureLinesJson") ||
  !hasColumn("ChargeCaptureRecord", "serviceCaptureItemsJson") ||
  !hasColumn("ChargeCaptureRecord", "documentationSummaryJson") ||
  !hasColumn("FinancialReadiness", "registrationVerified") ||
  !hasColumn("FinancialReadiness", "contactInfoVerified") ||
  !hasColumn("FinancialReadiness", "benefitsSummaryText") ||
  !hasColumn("FinancialReadiness", "patientEstimateAmountCents") ||
  !hasColumn("FinancialReadiness", "estimateExplainedToPatient") ||
  !hasColumn("RevenueCycleSettings", "checklistDefaultsJson") ||
  !hasColumn("RevenueCycleSettings", "estimateDefaultsJson") ||
  !hasColumn("RevenueCycleSettings", "reimbursementRulesJson") ||
  !hasColumn("RevenueCycleSettings", "serviceCatalogJson") ||
  !hasColumn("RevenueCycleSettings", "chargeScheduleJson") ||
  !hasColumn("RevenueCycleDailyRollup", "facilityId") ||
  !hasColumn("RevenueCycleDailyRollup", "sameDayCollectionExpectedVisitCount") ||
  !hasColumn("RevenueCycleDailyRollup", "sameDayCollectionVisitRate") ||
  !hasColumn("RevenueCycleDailyRollup", "expectedGrossChargeCents") ||
  !hasColumn("RevenueCycleDailyRollup", "expectedNetReimbursementCents") ||
  !hasColumn("RevenueCycleDailyRollup", "serviceCaptureCompletedVisitCount") ||
  !hasColumn("RevenueCycleDailyRollup", "clinicianCodingEnteredVisitCount") ||
  !hasColumn("RevenueCycleDailyRollup", "chargeCaptureReadyVisitCount");

if (requiresRebuild) {
  db.exec(`
DROP TABLE IF EXISTS IdempotencyRecord;
DROP TABLE IF EXISTS EventOutbox;
DROP TABLE IF EXISTS AuditLog;
DROP TABLE IF EXISTS RoomDailyRollup;
DROP TABLE IF EXISTS OfficeManagerDailyRollup;
DROP TABLE IF EXISTS RevenueCycleDailyRollup;
DROP TABLE IF EXISTS NotificationPolicy;
DROP TABLE IF EXISTS AlertThreshold;
DROP TABLE IF EXISTS UserAlertInbox;
DROP TABLE IF EXISTS SafetyEvent;
DROP TABLE IF EXISTS RoomChecklistRun;
DROP TABLE IF EXISTS RoomIssue;
DROP TABLE IF EXISTS RoomOperationalEvent;
DROP TABLE IF EXISTS RoomOperationalState;
DROP TABLE IF EXISTS Task;
DROP TABLE IF EXISTS RevenueCaseEvent;
DROP TABLE IF EXISTS RevenueChecklistItem;
DROP TABLE IF EXISTS ProviderClarification;
DROP TABLE IF EXISTS ChargeCaptureRecord;
DROP TABLE IF EXISTS CheckoutCollectionTracking;
DROP TABLE IF EXISTS FinancialReadiness;
DROP TABLE IF EXISTS RevenueCloseoutItem;
DROP TABLE IF EXISTS RevenueCloseoutRun;
DROP TABLE IF EXISTS RevenueCycleSettings;
DROP TABLE IF EXISTS RevenueCase;
DROP TABLE IF EXISTS AlertState;
DROP TABLE IF EXISTS StatusChangeEvent;
DROP TABLE IF EXISTS Encounter;
DROP TABLE IF EXISTS IncomingImportIssue;
DROP TABLE IF EXISTS IncomingSchedule;
DROP TABLE IF EXISTS IncomingImportBatch;
DROP TABLE IF EXISTS TemplateReasonAssignment;
DROP TABLE IF EXISTS Template;
DROP TABLE IF EXISTS ReasonClinicAssignment;
DROP TABLE IF EXISTS ReasonForVisit;
DROP TABLE IF EXISTS ClinicRoomAssignment;
DROP TABLE IF EXISTS ClinicRoom;
DROP TABLE IF EXISTS ClinicAssignment;
DROP TABLE IF EXISTS TemporaryClinicAssignmentOverride;
DROP TABLE IF EXISTS MaClinicMap;
DROP TABLE IF EXISTS MaProviderMap;
DROP TABLE IF EXISTS Provider;
DROP TABLE IF EXISTS UserRole;
DROP TABLE IF EXISTS User;
DROP TABLE IF EXISTS PatientIdentityReview;
DROP TABLE IF EXISTS PatientAlias;
DROP TABLE IF EXISTS Patient;
DROP TABLE IF EXISTS Clinic;
DROP TABLE IF EXISTS IntegrationConnector;
DROP TABLE IF EXISTS Facility;
`);
}

db.exec(`
CREATE TABLE IF NOT EXISTS User (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  phone TEXT,
  cognitoSub TEXT UNIQUE,
  entraObjectId TEXT UNIQUE,
  entraTenantId TEXT,
  entraUserPrincipalName TEXT,
  identityProvider TEXT,
  directoryStatus TEXT,
  directoryUserType TEXT,
  directoryAccountEnabled INTEGER,
  lastDirectorySyncAt TEXT,
  activeFacilityId TEXT,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (activeFacilityId) REFERENCES Facility(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS Facility (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  shortCode TEXT,
  address TEXT,
  phone TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  status TEXT NOT NULL DEFAULT 'active',
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS Patient (
  id TEXT PRIMARY KEY NOT NULL,
  facilityId TEXT NOT NULL,
  sourcePatientId TEXT NOT NULL,
  normalizedSourcePatientId TEXT NOT NULL,
  displayName TEXT,
  dateOfBirth TEXT,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (facilityId) REFERENCES Facility(id) ON UPDATE CASCADE ON DELETE CASCADE,
  UNIQUE (facilityId, normalizedSourcePatientId)
);

CREATE TABLE IF NOT EXISTS PatientAlias (
  id TEXT PRIMARY KEY NOT NULL,
  patientId TEXT NOT NULL,
  facilityId TEXT NOT NULL,
  aliasType TEXT NOT NULL,
  aliasValue TEXT NOT NULL,
  normalizedAliasValue TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (patientId) REFERENCES Patient(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (facilityId) REFERENCES Facility(id) ON UPDATE CASCADE ON DELETE CASCADE,
  UNIQUE (patientId, aliasType, normalizedAliasValue)
);

CREATE TABLE IF NOT EXISTS PatientIdentityReview (
  id TEXT PRIMARY KEY NOT NULL,
  facilityId TEXT NOT NULL,
  patientId TEXT,
  sourcePatientId TEXT NOT NULL,
  normalizedSourcePatientId TEXT NOT NULL,
  displayName TEXT,
  normalizedDisplayName TEXT,
  dateOfBirth TEXT,
  reasonCode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  matchedPatientIdsJson TEXT,
  contextJson TEXT,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (facilityId) REFERENCES Facility(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (patientId) REFERENCES Patient(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS Clinic (
  id TEXT PRIMARY KEY NOT NULL,
  facilityId TEXT,
  name TEXT NOT NULL,
  shortCode TEXT,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  maRun INTEGER NOT NULL DEFAULT 0,
  autoCloseEnabled INTEGER NOT NULL DEFAULT 0,
  autoCloseTime TEXT,
  cardColor TEXT,
  cardTags TEXT,
  FOREIGN KEY (facilityId) REFERENCES Facility(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS Provider (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  clinicId TEXT NOT NULL,
  FOREIGN KEY (clinicId) REFERENCES Clinic(id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS UserRole (
  id TEXT PRIMARY KEY NOT NULL,
  userId TEXT NOT NULL,
  role TEXT NOT NULL,
  clinicId TEXT,
  facilityId TEXT,
  FOREIGN KEY (userId) REFERENCES User(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (clinicId) REFERENCES Clinic(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (facilityId) REFERENCES Facility(id) ON UPDATE CASCADE ON DELETE SET NULL,
  UNIQUE (userId, role, clinicId, facilityId)
);

CREATE TABLE IF NOT EXISTS MaProviderMap (
  id TEXT PRIMARY KEY NOT NULL,
  providerId TEXT NOT NULL,
  maUserId TEXT NOT NULL,
  clinicId TEXT NOT NULL,
  FOREIGN KEY (providerId) REFERENCES Provider(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (clinicId) REFERENCES Clinic(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  UNIQUE (providerId, maUserId, clinicId)
);

CREATE TABLE IF NOT EXISTS MaClinicMap (
  id TEXT PRIMARY KEY NOT NULL,
  clinicId TEXT NOT NULL,
  maUserId TEXT NOT NULL,
  FOREIGN KEY (clinicId) REFERENCES Clinic(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  UNIQUE (clinicId, maUserId)
);

CREATE TABLE IF NOT EXISTS ClinicAssignment (
  id TEXT PRIMARY KEY NOT NULL,
  clinicId TEXT NOT NULL UNIQUE,
  providerUserId TEXT,
  providerId TEXT,
  maUserId TEXT,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (clinicId) REFERENCES Clinic(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (providerUserId) REFERENCES User(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (providerId) REFERENCES Provider(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (maUserId) REFERENCES User(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS TemporaryClinicAssignmentOverride (
  id TEXT PRIMARY KEY NOT NULL,
  userId TEXT NOT NULL,
  role TEXT NOT NULL,
  clinicId TEXT NOT NULL,
  facilityId TEXT NOT NULL,
  startsAt TEXT NOT NULL,
  endsAt TEXT NOT NULL,
  reason TEXT NOT NULL,
  createdByUserId TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revokedAt TEXT,
  revokedByUserId TEXT,
  FOREIGN KEY (userId) REFERENCES User(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (clinicId) REFERENCES Clinic(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (facilityId) REFERENCES Facility(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (createdByUserId) REFERENCES User(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (revokedByUserId) REFERENCES User(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ClinicRoom (
  id TEXT PRIMARY KEY NOT NULL,
  facilityId TEXT NOT NULL,
  name TEXT NOT NULL,
  roomNumber INTEGER NOT NULL DEFAULT 0,
  roomType TEXT NOT NULL DEFAULT 'exam',
  status TEXT NOT NULL DEFAULT 'active',
  sortOrder INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (facilityId) REFERENCES Facility(id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS ClinicRoomAssignment (
  id TEXT PRIMARY KEY NOT NULL,
  clinicId TEXT NOT NULL,
  roomId TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (clinicId) REFERENCES Clinic(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (roomId) REFERENCES ClinicRoom(id) ON UPDATE CASCADE ON DELETE CASCADE,
  UNIQUE (clinicId, roomId)
);

CREATE TABLE IF NOT EXISTS ReasonForVisit (
  id TEXT PRIMARY KEY NOT NULL,
  clinicId TEXT,
  facilityId TEXT,
  name TEXT NOT NULL,
  appointmentLengthMinutes INTEGER NOT NULL DEFAULT 20,
  status TEXT NOT NULL DEFAULT 'active',
  active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (clinicId) REFERENCES Clinic(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (facilityId) REFERENCES Facility(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ReasonClinicAssignment (
  id TEXT PRIMARY KEY NOT NULL,
  reasonId TEXT NOT NULL,
  clinicId TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (reasonId) REFERENCES ReasonForVisit(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (clinicId) REFERENCES Clinic(id) ON UPDATE CASCADE ON DELETE CASCADE,
  UNIQUE (reasonId, clinicId)
);

CREATE TABLE IF NOT EXISTS Template (
  id TEXT PRIMARY KEY NOT NULL,
  facilityId TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  active INTEGER NOT NULL DEFAULT 1,
  fieldsJson TEXT NOT NULL DEFAULT '[]',
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  clinicId TEXT,
  reasonForVisitId TEXT,
  type TEXT NOT NULL,
  jsonSchema TEXT NOT NULL,
  uiSchema TEXT NOT NULL,
  requiredFields TEXT NOT NULL,
  FOREIGN KEY (facilityId) REFERENCES Facility(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (clinicId) REFERENCES Clinic(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (reasonForVisitId) REFERENCES ReasonForVisit(id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS TemplateReasonAssignment (
  id TEXT PRIMARY KEY NOT NULL,
  templateId TEXT NOT NULL,
  reasonId TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (templateId) REFERENCES Template(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (reasonId) REFERENCES ReasonForVisit(id) ON UPDATE CASCADE ON DELETE CASCADE,
  UNIQUE (templateId, reasonId)
);

CREATE TABLE IF NOT EXISTS IncomingImportBatch (
  id TEXT PRIMARY KEY NOT NULL,
  facilityId TEXT NOT NULL,
  clinicId TEXT,
  date TEXT NOT NULL,
  source TEXT NOT NULL,
  fileName TEXT,
  rowCount INTEGER NOT NULL DEFAULT 0,
  acceptedRowCount INTEGER NOT NULL DEFAULT 0,
  pendingRowCount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'processed',
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (facilityId) REFERENCES Facility(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (clinicId) REFERENCES Clinic(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS IncomingSchedule (
  id TEXT PRIMARY KEY NOT NULL,
  clinicId TEXT NOT NULL,
  patientRecordId TEXT,
  dateOfService TEXT NOT NULL,
  patientId TEXT NOT NULL,
  appointmentTime TEXT,
  appointmentAt TEXT,
  providerId TEXT,
  providerLastName TEXT,
  reasonForVisitId TEXT,
  reasonText TEXT,
  source TEXT NOT NULL,
  rawPayloadJson TEXT NOT NULL,
  isValid INTEGER NOT NULL DEFAULT 1,
  validationErrors TEXT,
  checkedInAt TEXT,
  checkedInByUserId TEXT,
  checkedInEncounterId TEXT,
  dispositionType TEXT,
  dispositionNote TEXT,
  dispositionAt TEXT,
  dispositionByUserId TEXT,
  dispositionEncounterId TEXT,
  intakeData TEXT,
  importBatchId TEXT,
  FOREIGN KEY (clinicId) REFERENCES Clinic(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (patientRecordId) REFERENCES Patient(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (providerId) REFERENCES Provider(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (reasonForVisitId) REFERENCES ReasonForVisit(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (importBatchId) REFERENCES IncomingImportBatch(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS IncomingImportIssue (
  id TEXT PRIMARY KEY NOT NULL,
  batchId TEXT NOT NULL,
  facilityId TEXT NOT NULL,
  clinicId TEXT,
  dateOfService TEXT NOT NULL,
  rawPayloadJson TEXT NOT NULL,
  normalizedJson TEXT,
  validationErrors TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retryCount INTEGER NOT NULL DEFAULT 0,
  resolvedIncomingId TEXT,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (batchId) REFERENCES IncomingImportBatch(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (facilityId) REFERENCES Facility(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (clinicId) REFERENCES Clinic(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (resolvedIncomingId) REFERENCES IncomingSchedule(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS Encounter (
  id TEXT PRIMARY KEY NOT NULL,
  patientId TEXT NOT NULL,
  patientRecordId TEXT,
  clinicId TEXT NOT NULL,
  providerId TEXT,
  reasonForVisitId TEXT,
  currentStatus TEXT NOT NULL,
  assignedMaUserId TEXT,
  roomId TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  checkInAt TEXT,
  dateOfService TEXT NOT NULL,
  roomingStartAt TEXT,
  roomingCompleteAt TEXT,
  providerStartAt TEXT,
  providerEndAt TEXT,
  checkoutCompleteAt TEXT,
  closedAt TEXT,
  walkIn INTEGER NOT NULL DEFAULT 0,
  insuranceVerified INTEGER NOT NULL DEFAULT 0,
  arrivalNotes TEXT,
  closureType TEXT,
  closureNotes TEXT,
  roomingData TEXT,
  clinicianData TEXT,
  checkoutData TEXT,
  intakeData TEXT,
  FOREIGN KEY (clinicId) REFERENCES Clinic(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (patientRecordId) REFERENCES Patient(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (providerId) REFERENCES Provider(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (reasonForVisitId) REFERENCES ReasonForVisit(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (roomId) REFERENCES ClinicRoom(id) ON UPDATE CASCADE ON DELETE SET NULL,
  UNIQUE (patientId, clinicId, dateOfService)
);

CREATE TABLE IF NOT EXISTS StatusChangeEvent (
  id TEXT PRIMARY KEY NOT NULL,
  encounterId TEXT NOT NULL,
  fromStatus TEXT,
  toStatus TEXT NOT NULL,
  changedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  changedByUserId TEXT NOT NULL,
  reasonCode TEXT,
  FOREIGN KEY (encounterId) REFERENCES Encounter(id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS AlertState (
  encounterId TEXT PRIMARY KEY NOT NULL,
  enteredStatusAt TEXT NOT NULL,
  currentAlertLevel TEXT NOT NULL DEFAULT 'Green',
  yellowTriggeredAt TEXT,
  redTriggeredAt TEXT,
  escalationTriggeredAt TEXT,
  lastAckAt TEXT,
  FOREIGN KEY (encounterId) REFERENCES Encounter(id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS Task (
  id TEXT PRIMARY KEY NOT NULL,
  facilityId TEXT,
  clinicId TEXT,
  encounterId TEXT,
  revenueCaseId TEXT,
  roomId TEXT,
  sourceType TEXT,
  sourceId TEXT,
  taskCategory TEXT,
  taskType TEXT NOT NULL,
  description TEXT NOT NULL,
  assignedToRole TEXT,
  assignedToUserId TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  priority INTEGER NOT NULL DEFAULT 0,
  blocking INTEGER NOT NULL DEFAULT 0,
  dueAt TEXT,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  createdBy TEXT NOT NULL,
  acknowledgedAt TEXT,
  acknowledgedBy TEXT,
  completedAt TEXT,
  completedBy TEXT,
  archivedAt TEXT,
  archivedBy TEXT,
  notes TEXT,
  updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (encounterId) REFERENCES Encounter(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (revenueCaseId) REFERENCES RevenueCase(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (roomId) REFERENCES ClinicRoom(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (createdBy) REFERENCES User(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (acknowledgedBy) REFERENCES User(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (completedBy) REFERENCES User(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS RoomOperationalState (
  roomId TEXT PRIMARY KEY NOT NULL,
  currentStatus TEXT NOT NULL DEFAULT 'Ready',
  statusSinceAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  occupiedEncounterId TEXT,
  activeCleanerUserId TEXT,
  holdReason TEXT,
  holdNote TEXT,
  lastReadyAt TEXT,
  lastOccupiedAt TEXT,
  lastTurnoverAt TEXT,
  updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (roomId) REFERENCES ClinicRoom(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (occupiedEncounterId) REFERENCES Encounter(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS RoomOperationalEvent (
  id TEXT PRIMARY KEY NOT NULL,
  roomId TEXT NOT NULL,
  clinicId TEXT NOT NULL,
  facilityId TEXT NOT NULL,
  encounterId TEXT,
  eventType TEXT NOT NULL,
  fromStatus TEXT,
  toStatus TEXT,
  note TEXT,
  metadataJson TEXT,
  createdByUserId TEXT,
  occurredAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (roomId) REFERENCES ClinicRoom(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (encounterId) REFERENCES Encounter(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS RoomIssue (
  id TEXT PRIMARY KEY NOT NULL,
  roomId TEXT NOT NULL,
  clinicId TEXT NOT NULL,
  facilityId TEXT NOT NULL,
  encounterId TEXT,
  issueType TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open',
  severity INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  description TEXT,
  placesRoomOnHold INTEGER NOT NULL DEFAULT 0,
  taskId TEXT,
  sourceModule TEXT,
  metadataJson TEXT,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  createdByUserId TEXT NOT NULL,
  resolvedAt TEXT,
  resolvedByUserId TEXT,
  resolutionNote TEXT,
  FOREIGN KEY (roomId) REFERENCES ClinicRoom(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (encounterId) REFERENCES Encounter(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (taskId) REFERENCES Task(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS RoomChecklistRun (
  id TEXT PRIMARY KEY NOT NULL,
  roomId TEXT NOT NULL,
  clinicId TEXT NOT NULL,
  facilityId TEXT NOT NULL,
  kind TEXT NOT NULL,
  dateKey TEXT NOT NULL,
  itemsJson TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  startedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completedAt TEXT,
  completedByUserId TEXT,
  note TEXT,
  FOREIGN KEY (roomId) REFERENCES ClinicRoom(id) ON UPDATE CASCADE ON DELETE CASCADE,
  UNIQUE (roomId, kind, dateKey)
);

CREATE TABLE IF NOT EXISTS UserAlertInbox (
  id TEXT PRIMARY KEY NOT NULL,
  userId TEXT NOT NULL,
  facilityId TEXT NOT NULL,
  clinicId TEXT,
  kind TEXT NOT NULL,
  sourceId TEXT NOT NULL,
  sourceVersionKey TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  payloadJson TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  acknowledgedAt TEXT,
  archivedAt TEXT,
  FOREIGN KEY (userId) REFERENCES User(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (facilityId) REFERENCES Facility(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (clinicId) REFERENCES Clinic(id) ON UPDATE CASCADE ON DELETE SET NULL,
  UNIQUE (userId, kind, sourceVersionKey)
);

CREATE TABLE IF NOT EXISTS SafetyEvent (
  id TEXT PRIMARY KEY NOT NULL,
  encounterId TEXT NOT NULL,
  activatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activatedBy TEXT NOT NULL,
  resolvedAt TEXT,
  resolvedBy TEXT,
  resolutionNote TEXT,
  location TEXT,
  FOREIGN KEY (encounterId) REFERENCES Encounter(id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS AlertThreshold (
  id TEXT PRIMARY KEY NOT NULL,
  facilityId TEXT NOT NULL,
  clinicId TEXT,
  metric TEXT NOT NULL DEFAULT 'stage',
  status TEXT,
  reasonForVisitId TEXT,
  providerId TEXT,
  yellowAtMin INTEGER NOT NULL,
  redAtMin INTEGER NOT NULL,
  escalation2Min INTEGER,
  FOREIGN KEY (facilityId) REFERENCES Facility(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (clinicId) REFERENCES Clinic(id) ON UPDATE CASCADE ON DELETE SET NULL,
  UNIQUE (facilityId, clinicId, metric, status)
);

CREATE TABLE IF NOT EXISTS NotificationPolicy (
  id TEXT PRIMARY KEY NOT NULL,
  clinicId TEXT NOT NULL,
  status TEXT NOT NULL,
  severity TEXT NOT NULL,
  recipientsJson TEXT NOT NULL,
  channelsJson TEXT NOT NULL,
  cooldownMinutes INTEGER NOT NULL DEFAULT 10,
  ackRequired INTEGER NOT NULL DEFAULT 0,
  escalationAfterMin INTEGER,
  escalationRecipientsJson TEXT,
  quietHoursJson TEXT
);

CREATE TABLE IF NOT EXISTS RevenueCase (
  id TEXT PRIMARY KEY NOT NULL,
  encounterId TEXT NOT NULL UNIQUE,
  facilityId TEXT NOT NULL,
  clinicId TEXT NOT NULL,
  patientId TEXT NOT NULL,
  patientRecordId TEXT,
  providerId TEXT,
  dateOfService TEXT NOT NULL,
  currentRevenueStatus TEXT NOT NULL,
  currentWorkQueue TEXT NOT NULL,
  currentDayBucket TEXT NOT NULL DEFAULT 'Today',
  priority INTEGER NOT NULL DEFAULT 2,
  assignedToUserId TEXT,
  assignedToRole TEXT,
  currentBlockerCategory TEXT,
  currentBlockerText TEXT,
  dueAt TEXT,
  rolledFromDateKey TEXT,
  rollReason TEXT,
  readyForAthenaAt TEXT,
  athenaHandoffOwnerUserId TEXT,
  athenaHandoffStartedAt TEXT,
  athenaHandoffConfirmedAt TEXT,
  athenaHandoffConfirmedByUserId TEXT,
  athenaHandoffNote TEXT,
  athenaChargeEnteredAt TEXT,
  athenaClaimSubmittedAt TEXT,
  athenaDaysToSubmit REAL,
  athenaDaysInAR REAL,
  athenaClaimStatus TEXT,
  athenaPatientBalanceCents INTEGER,
  athenaLastSyncAt TEXT,
  closeoutState TEXT NOT NULL DEFAULT 'Open',
  closedAt TEXT,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (encounterId) REFERENCES Encounter(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (facilityId) REFERENCES Facility(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (clinicId) REFERENCES Clinic(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (patientRecordId) REFERENCES Patient(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (providerId) REFERENCES Provider(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (assignedToUserId) REFERENCES User(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS FinancialReadiness (
  revenueCaseId TEXT PRIMARY KEY NOT NULL,
  eligibilityStatus TEXT NOT NULL DEFAULT 'NotChecked',
  verifiedAt TEXT,
  verifiedByUserId TEXT,
  registrationVerified INTEGER NOT NULL DEFAULT 0,
  contactInfoVerified INTEGER NOT NULL DEFAULT 0,
  primaryPayerName TEXT,
  primaryPlanName TEXT,
  secondaryPayerName TEXT,
  financialClass TEXT,
  benefitsSummaryText TEXT,
  patientEstimateAmountCents INTEGER NOT NULL DEFAULT 0,
  pointOfServiceAmountDueCents INTEGER NOT NULL DEFAULT 0,
  estimateExplainedToPatient INTEGER NOT NULL DEFAULT 0,
  outstandingPriorBalanceCents INTEGER NOT NULL DEFAULT 0,
  coverageIssueCategory TEXT,
  coverageIssueText TEXT,
  referralRequired INTEGER NOT NULL DEFAULT 0,
  referralStatus TEXT NOT NULL DEFAULT 'NotRequired',
  priorAuthRequired INTEGER NOT NULL DEFAULT 0,
  priorAuthStatus TEXT NOT NULL DEFAULT 'NotRequired',
  priorAuthNumber TEXT,
  notesJson TEXT,
  FOREIGN KEY (revenueCaseId) REFERENCES RevenueCase(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS CheckoutCollectionTracking (
  revenueCaseId TEXT PRIMARY KEY NOT NULL,
  collectionExpected INTEGER NOT NULL DEFAULT 0,
  amountDueCents INTEGER NOT NULL DEFAULT 0,
  amountCollectedCents INTEGER NOT NULL DEFAULT 0,
  collectionOutcome TEXT,
  missedCollectionReason TEXT,
  trackingNote TEXT,
  trackedByUserId TEXT,
  trackedAt TEXT,
  sourceFieldJson TEXT,
  FOREIGN KEY (revenueCaseId) REFERENCES RevenueCase(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ChargeCaptureRecord (
  revenueCaseId TEXT PRIMARY KEY NOT NULL,
  documentationComplete INTEGER NOT NULL DEFAULT 0,
  codingStage TEXT NOT NULL DEFAULT 'NotStarted',
  icd10CodesJson TEXT NOT NULL DEFAULT '[]',
  procedureLinesJson TEXT NOT NULL DEFAULT '[]',
  serviceCaptureItemsJson TEXT NOT NULL DEFAULT '[]',
  documentationSummaryJson TEXT,
  cptCodesJson TEXT NOT NULL DEFAULT '[]',
  modifiersJson TEXT NOT NULL DEFAULT '[]',
  unitsJson TEXT NOT NULL DEFAULT '[]',
  codingNote TEXT,
  reviewedByUserId TEXT,
  reviewedAt TEXT,
  readyForAthenaAt TEXT,
  FOREIGN KEY (revenueCaseId) REFERENCES RevenueCase(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ProviderClarification (
  id TEXT PRIMARY KEY NOT NULL,
  revenueCaseId TEXT NOT NULL,
  encounterId TEXT NOT NULL,
  requestedByUserId TEXT NOT NULL,
  targetUserId TEXT,
  queryType TEXT,
  questionText TEXT NOT NULL,
  responseText TEXT,
  status TEXT NOT NULL DEFAULT 'Open',
  openedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  respondedAt TEXT,
  resolvedAt TEXT,
  FOREIGN KEY (revenueCaseId) REFERENCES RevenueCase(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (encounterId) REFERENCES Encounter(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS RevenueChecklistItem (
  id TEXT PRIMARY KEY NOT NULL,
  revenueCaseId TEXT NOT NULL,
  "group" TEXT NOT NULL,
  label TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  sortOrder INTEGER NOT NULL DEFAULT 0,
  dueAt TEXT,
  completedAt TEXT,
  completedByUserId TEXT,
  evidenceText TEXT,
  payloadJson TEXT,
  FOREIGN KEY (revenueCaseId) REFERENCES RevenueCase(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS RevenueCaseEvent (
  id TEXT PRIMARY KEY NOT NULL,
  revenueCaseId TEXT NOT NULL,
  eventType TEXT NOT NULL,
  fromStatus TEXT,
  toStatus TEXT,
  actorUserId TEXT,
  eventText TEXT,
  payloadJson TEXT,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (revenueCaseId) REFERENCES RevenueCase(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS RevenueCycleSettings (
  facilityId TEXT PRIMARY KEY NOT NULL,
  missedCollectionReasonsJson TEXT NOT NULL DEFAULT '[]',
  queueSlaJson TEXT NOT NULL DEFAULT '{}',
  dayCloseDefaultsJson TEXT NOT NULL DEFAULT '{}',
  providerQueryTemplatesJson TEXT NOT NULL DEFAULT '[]',
  athenaLinkTemplate TEXT,
  athenaChecklistDefaultsJson TEXT NOT NULL DEFAULT '[]',
  checklistDefaultsJson TEXT NOT NULL DEFAULT '{}',
  estimateDefaultsJson TEXT NOT NULL DEFAULT '{}',
  serviceCatalogJson TEXT NOT NULL DEFAULT '[]',
  chargeScheduleJson TEXT NOT NULL DEFAULT '[]',
  reimbursementRulesJson TEXT NOT NULL DEFAULT '[]',
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (facilityId) REFERENCES Facility(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS RevenueCloseoutRun (
  id TEXT PRIMARY KEY NOT NULL,
  facilityId TEXT NOT NULL,
  clinicId TEXT NOT NULL,
  dateKey TEXT NOT NULL,
  closedByUserId TEXT,
  unresolvedCount INTEGER NOT NULL DEFAULT 0,
  rolledCount INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (facilityId) REFERENCES Facility(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (clinicId) REFERENCES Clinic(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS RevenueCloseoutItem (
  id TEXT PRIMARY KEY NOT NULL,
  closeoutRunId TEXT NOT NULL,
  revenueCaseId TEXT NOT NULL,
  queue TEXT NOT NULL,
  snapshotStatus TEXT NOT NULL,
  ownerUserId TEXT,
  ownerRole TEXT,
  reasonNotCompleted TEXT NOT NULL,
  nextAction TEXT,
  dueAt TEXT,
  rollover INTEGER NOT NULL DEFAULT 0,
  patientId TEXT NOT NULL,
  providerId TEXT,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (closeoutRunId) REFERENCES RevenueCloseoutRun(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (revenueCaseId) REFERENCES RevenueCase(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS OfficeManagerDailyRollup (
  id TEXT PRIMARY KEY NOT NULL,
  clinicId TEXT NOT NULL,
  dateKey TEXT NOT NULL,
  queueByStatus TEXT NOT NULL,
  alertsByLevel TEXT NOT NULL,
  encounterCount INTEGER NOT NULL DEFAULT 0,
  lobbyWaitTotalMins INTEGER NOT NULL DEFAULT 0,
  lobbyWaitSamples INTEGER NOT NULL DEFAULT 0,
  roomingWaitTotalMins INTEGER NOT NULL DEFAULT 0,
  roomingWaitSamples INTEGER NOT NULL DEFAULT 0,
  providerVisitTotalMins INTEGER NOT NULL DEFAULT 0,
  providerVisitSamples INTEGER NOT NULL DEFAULT 0,
  stageRollupsJson TEXT NOT NULL,
  providerRollupsJson TEXT NOT NULL,
  computedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (clinicId) REFERENCES Clinic(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  UNIQUE (clinicId, dateKey)
);

CREATE TABLE IF NOT EXISTS RevenueCycleDailyRollup (
  id TEXT PRIMARY KEY NOT NULL,
  facilityId TEXT NOT NULL,
  clinicId TEXT NOT NULL,
  dateKey TEXT NOT NULL,
  sameDayCollectionExpectedVisitCount INTEGER NOT NULL DEFAULT 0,
  sameDayCollectionCapturedVisitCount INTEGER NOT NULL DEFAULT 0,
  sameDayCollectionExpectedCents INTEGER NOT NULL DEFAULT 0,
  sameDayCollectionTrackedCents INTEGER NOT NULL DEFAULT 0,
  sameDayCollectionVisitRate REAL NOT NULL DEFAULT 0,
  sameDayCollectionDollarRate REAL NOT NULL DEFAULT 0,
  expectedGrossChargeCents INTEGER NOT NULL DEFAULT 0,
  expectedNetReimbursementCents INTEGER NOT NULL DEFAULT 0,
  serviceCaptureCompletedVisitCount INTEGER NOT NULL DEFAULT 0,
  clinicianCodingEnteredVisitCount INTEGER NOT NULL DEFAULT 0,
  chargeCaptureReadyVisitCount INTEGER NOT NULL DEFAULT 0,
  financiallyClearedCount INTEGER NOT NULL DEFAULT 0,
  chargeCaptureCompletedCount INTEGER NOT NULL DEFAULT 0,
  athenaHandoffConfirmedCount INTEGER NOT NULL DEFAULT 0,
  rolledCount INTEGER NOT NULL DEFAULT 0,
  avgFlowHandoffHours REAL NOT NULL DEFAULT 0,
  avgAthenaDaysToSubmit REAL,
  avgAthenaDaysInAR REAL,
  queueCountsJson TEXT NOT NULL DEFAULT '{}',
  missedCollectionReasonsJson TEXT NOT NULL DEFAULT '{}',
  rollReasonsJson TEXT NOT NULL DEFAULT '{}',
  queryAgingJson TEXT NOT NULL DEFAULT '{}',
  unfinishedQueueCountsJson TEXT NOT NULL DEFAULT '{}',
  unfinishedOwnerCountsJson TEXT NOT NULL DEFAULT '{}',
  unfinishedProviderCountsJson TEXT NOT NULL DEFAULT '{}',
  computedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (facilityId) REFERENCES Facility(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (clinicId) REFERENCES Clinic(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  UNIQUE (clinicId, dateKey)
);

CREATE TABLE IF NOT EXISTS RoomDailyRollup (
  id TEXT PRIMARY KEY NOT NULL,
  facilityId TEXT NOT NULL,
  clinicId TEXT NOT NULL,
  dateKey TEXT NOT NULL,
  roomCount INTEGER NOT NULL DEFAULT 0,
  dayStartCompletedCount INTEGER NOT NULL DEFAULT 0,
  dayEndCompletedCount INTEGER NOT NULL DEFAULT 0,
  turnoverCount INTEGER NOT NULL DEFAULT 0,
  holdCount INTEGER NOT NULL DEFAULT 0,
  issueCount INTEGER NOT NULL DEFAULT 0,
  resolvedIssueCount INTEGER NOT NULL DEFAULT 0,
  occupiedTotalMins INTEGER NOT NULL DEFAULT 0,
  occupiedSamples INTEGER NOT NULL DEFAULT 0,
  turnoverTotalMins INTEGER NOT NULL DEFAULT 0,
  turnoverSamples INTEGER NOT NULL DEFAULT 0,
  statusMinutesJson TEXT NOT NULL,
  roomRollupsJson TEXT NOT NULL,
  issueRollupsJson TEXT NOT NULL,
  computedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (facilityId) REFERENCES Facility(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (clinicId) REFERENCES Clinic(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  UNIQUE (clinicId, dateKey)
);

CREATE TABLE IF NOT EXISTS AuditLog (
  id TEXT PRIMARY KEY NOT NULL,
  requestId TEXT NOT NULL,
  idempotencyKey TEXT,
  occurredAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actorUserId TEXT,
  actorRole TEXT,
  authSource TEXT,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  statusCode INTEGER NOT NULL,
  clinicId TEXT,
  facilityId TEXT,
  entityType TEXT,
  entityId TEXT,
  payloadJson TEXT
);

CREATE TABLE IF NOT EXISTS IdempotencyRecord (
  id TEXT PRIMARY KEY NOT NULL,
  actorUserId TEXT NOT NULL,
  method TEXT NOT NULL,
  routeKey TEXT NOT NULL,
  idempotencyKey TEXT NOT NULL,
  requestHash TEXT NOT NULL,
  statusCode INTEGER NOT NULL,
  responseJson TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (actorUserId, method, routeKey, idempotencyKey)
);

CREATE TABLE IF NOT EXISTS EventOutbox (
  id TEXT PRIMARY KEY NOT NULL,
  topic TEXT NOT NULL,
  eventType TEXT NOT NULL,
  aggregateType TEXT,
  aggregateId TEXT,
  requestId TEXT,
  payloadJson TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dispatchedAt TEXT,
  lastError TEXT
);

CREATE TABLE IF NOT EXISTS IntegrationConnector (
  id TEXT PRIMARY KEY NOT NULL,
  facilityId TEXT NOT NULL,
  vendor TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  configJson TEXT NOT NULL,
  mappingJson TEXT,
  lastTestStatus TEXT,
  lastTestAt TEXT,
  lastTestMessage TEXT,
  lastSyncStatus TEXT,
  lastSyncAt TEXT,
  lastSyncMessage TEXT,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (facilityId) REFERENCES Facility(id) ON UPDATE CASCADE ON DELETE CASCADE,
  UNIQUE (facilityId, vendor)
);

CREATE INDEX IF NOT EXISTS Clinic_facilityId_idx ON Clinic(facilityId);
CREATE INDEX IF NOT EXISTS Patient_facilityId_createdAt_idx ON Patient(facilityId, createdAt);
CREATE INDEX IF NOT EXISTS Provider_clinicId_active_idx ON Provider(clinicId, active);
CREATE INDEX IF NOT EXISTS UserRole_clinicId_idx ON UserRole(clinicId);
CREATE INDEX IF NOT EXISTS UserRole_facilityId_idx ON UserRole(facilityId);
CREATE INDEX IF NOT EXISTS User_activeFacilityId_idx ON User(activeFacilityId);
CREATE INDEX IF NOT EXISTS User_entraTenantId_idx ON User(entraTenantId);
CREATE INDEX IF NOT EXISTS User_identityProvider_idx ON User(identityProvider);
CREATE INDEX IF NOT EXISTS MaProviderMap_clinicId_idx ON MaProviderMap(clinicId);
CREATE INDEX IF NOT EXISTS MaClinicMap_clinicId_idx ON MaClinicMap(clinicId);
CREATE INDEX IF NOT EXISTS ClinicAssignment_clinicId_idx ON ClinicAssignment(clinicId);
CREATE INDEX IF NOT EXISTS ClinicAssignment_providerUserId_idx ON ClinicAssignment(providerUserId);
CREATE INDEX IF NOT EXISTS ClinicAssignment_providerId_idx ON ClinicAssignment(providerId);
CREATE INDEX IF NOT EXISTS ClinicAssignment_maUserId_idx ON ClinicAssignment(maUserId);
CREATE INDEX IF NOT EXISTS ClinicRoom_facilityId_status_idx ON ClinicRoom(facilityId, status);
CREATE INDEX IF NOT EXISTS ClinicRoom_facilityId_roomNumber_idx ON ClinicRoom(facilityId, roomNumber);
WITH ranked_rooms AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY facilityId
      ORDER BY sortOrder ASC, roomNumber ASC, name ASC, id ASC
    ) AS nextRoomNumber
  FROM ClinicRoom
  WHERE status IN ('active', 'inactive')
)
UPDATE ClinicRoom
SET
  roomNumber = (
    SELECT nextRoomNumber
    FROM ranked_rooms
    WHERE ranked_rooms.id = ClinicRoom.id
  ),
  sortOrder = (
    SELECT nextRoomNumber
    FROM ranked_rooms
    WHERE ranked_rooms.id = ClinicRoom.id
  )
WHERE id IN (SELECT id FROM ranked_rooms);
CREATE UNIQUE INDEX IF NOT EXISTS ClinicRoom_facilityId_roomNumber_live_unique
  ON ClinicRoom(facilityId, roomNumber)
  WHERE status IN ('active', 'inactive');
CREATE INDEX IF NOT EXISTS ClinicRoomAssignment_clinicId_active_idx ON ClinicRoomAssignment(clinicId, active);
CREATE INDEX IF NOT EXISTS ClinicRoomAssignment_roomId_active_idx ON ClinicRoomAssignment(roomId, active);
CREATE INDEX IF NOT EXISTS TemporaryClinicAssignmentOverride_userId_role_startsAt_endsAt_idx ON TemporaryClinicAssignmentOverride(userId, role, startsAt, endsAt);
CREATE INDEX IF NOT EXISTS TemporaryClinicAssignmentOverride_clinicId_startsAt_endsAt_idx ON TemporaryClinicAssignmentOverride(clinicId, startsAt, endsAt);
CREATE INDEX IF NOT EXISTS TemporaryClinicAssignmentOverride_facilityId_startsAt_endsAt_idx ON TemporaryClinicAssignmentOverride(facilityId, startsAt, endsAt);
CREATE INDEX IF NOT EXISTS TemporaryClinicAssignmentOverride_revokedAt_idx ON TemporaryClinicAssignmentOverride(revokedAt);
INSERT OR IGNORE INTO RoomOperationalState (roomId, currentStatus, statusSinceAt, lastReadyAt)
SELECT id, 'Ready', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM ClinicRoom
WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ReasonForVisit_clinicId_active_idx ON ReasonForVisit(clinicId, active);
CREATE INDEX IF NOT EXISTS ReasonForVisit_facilityId_active_idx ON ReasonForVisit(facilityId, active);
CREATE INDEX IF NOT EXISTS Template_clinicId_reasonForVisitId_type_idx ON Template(clinicId, reasonForVisitId, type);
CREATE INDEX IF NOT EXISTS IncomingImportBatch_facilityId_date_status_idx ON IncomingImportBatch(facilityId, date, status);
CREATE INDEX IF NOT EXISTS IncomingImportBatch_clinicId_date_status_idx ON IncomingImportBatch(clinicId, date, status);
CREATE INDEX IF NOT EXISTS IncomingSchedule_clinicId_dateOfService_checkedInAt_idx ON IncomingSchedule(clinicId, dateOfService, checkedInAt);
CREATE INDEX IF NOT EXISTS IncomingSchedule_dateOfService_patientId_appointmentTime_idx ON IncomingSchedule(dateOfService, patientId, appointmentTime);
CREATE INDEX IF NOT EXISTS IncomingImportIssue_batchId_status_idx ON IncomingImportIssue(batchId, status);
CREATE INDEX IF NOT EXISTS IncomingImportIssue_facilityId_date_status_idx ON IncomingImportIssue(facilityId, dateOfService, status);
CREATE INDEX IF NOT EXISTS IncomingImportIssue_clinicId_status_idx ON IncomingImportIssue(clinicId, status);
CREATE INDEX IF NOT EXISTS Encounter_clinicId_currentStatus_idx ON Encounter(clinicId, currentStatus);
CREATE INDEX IF NOT EXISTS Encounter_clinicId_dateOfService_idx ON Encounter(clinicId, dateOfService);
CREATE INDEX IF NOT EXISTS Patient_facilityId_dateOfBirth_idx ON Patient(facilityId, dateOfBirth);
CREATE INDEX IF NOT EXISTS PatientAlias_facilityId_aliasType_normalizedAliasValue_idx ON PatientAlias(facilityId, aliasType, normalizedAliasValue);
CREATE INDEX IF NOT EXISTS PatientAlias_patientId_aliasType_idx ON PatientAlias(patientId, aliasType);
CREATE INDEX IF NOT EXISTS PatientIdentityReview_facilityId_status_createdAt_idx ON PatientIdentityReview(facilityId, status, createdAt);
CREATE INDEX IF NOT EXISTS PatientIdentityReview_facilityId_normalizedSourcePatientId_idx ON PatientIdentityReview(facilityId, normalizedSourcePatientId);
CREATE INDEX IF NOT EXISTS PatientIdentityReview_patientId_status_idx ON PatientIdentityReview(patientId, status);
CREATE INDEX IF NOT EXISTS StatusChangeEvent_encounterId_changedAt_idx ON StatusChangeEvent(encounterId, changedAt);
CREATE INDEX IF NOT EXISTS Task_encounterId_status_idx ON Task(encounterId, status);
CREATE INDEX IF NOT EXISTS Task_clinicId_status_createdAt_idx ON Task(clinicId, status, createdAt);
CREATE INDEX IF NOT EXISTS Task_roomId_status_createdAt_idx ON Task(roomId, status, createdAt);
CREATE INDEX IF NOT EXISTS Task_assignedToRole_status_idx ON Task(assignedToRole, status);
CREATE INDEX IF NOT EXISTS RoomOperationalState_currentStatus_statusSinceAt_idx ON RoomOperationalState(currentStatus, statusSinceAt);
CREATE INDEX IF NOT EXISTS RoomOperationalState_occupiedEncounterId_idx ON RoomOperationalState(occupiedEncounterId);
CREATE INDEX IF NOT EXISTS RoomOperationalEvent_roomId_occurredAt_idx ON RoomOperationalEvent(roomId, occurredAt);
CREATE INDEX IF NOT EXISTS RoomOperationalEvent_clinicId_occurredAt_idx ON RoomOperationalEvent(clinicId, occurredAt);
CREATE INDEX IF NOT EXISTS RoomOperationalEvent_encounterId_idx ON RoomOperationalEvent(encounterId);
CREATE INDEX IF NOT EXISTS RoomIssue_roomId_status_createdAt_idx ON RoomIssue(roomId, status, createdAt);
CREATE INDEX IF NOT EXISTS RoomIssue_clinicId_status_createdAt_idx ON RoomIssue(clinicId, status, createdAt);
CREATE INDEX IF NOT EXISTS RoomIssue_taskId_idx ON RoomIssue(taskId);
CREATE INDEX IF NOT EXISTS RoomChecklistRun_clinicId_kind_dateKey_idx ON RoomChecklistRun(clinicId, kind, dateKey);
CREATE INDEX IF NOT EXISTS UserAlertInbox_userId_status_createdAt_idx ON UserAlertInbox(userId, status, createdAt);
CREATE INDEX IF NOT EXISTS UserAlertInbox_facility_clinic_kind_status_idx ON UserAlertInbox(facilityId, clinicId, kind, status);
CREATE INDEX IF NOT EXISTS SafetyEvent_encounterId_resolvedAt_idx ON SafetyEvent(encounterId, resolvedAt);
CREATE INDEX IF NOT EXISTS RevenueCase_facilityId_currentDayBucket_currentWorkQueue_idx ON RevenueCase(facilityId, currentDayBucket, currentWorkQueue);
CREATE INDEX IF NOT EXISTS RevenueCase_clinicId_currentRevenueStatus_currentDayBucket_idx ON RevenueCase(clinicId, currentRevenueStatus, currentDayBucket);
CREATE INDEX IF NOT EXISTS RevenueCase_assignedToUserId_currentRevenueStatus_idx ON RevenueCase(assignedToUserId, currentRevenueStatus);
CREATE INDEX IF NOT EXISTS RevenueCase_assignedToRole_currentRevenueStatus_idx ON RevenueCase(assignedToRole, currentRevenueStatus);
CREATE INDEX IF NOT EXISTS RevenueCase_closeoutState_currentDayBucket_idx ON RevenueCase(closeoutState, currentDayBucket);
CREATE INDEX IF NOT EXISTS ProviderClarification_revenueCaseId_status_openedAt_idx ON ProviderClarification(revenueCaseId, status, openedAt);
CREATE INDEX IF NOT EXISTS ProviderClarification_encounterId_status_idx ON ProviderClarification(encounterId, status);
CREATE INDEX IF NOT EXISTS ProviderClarification_targetUserId_status_idx ON ProviderClarification(targetUserId, status);
CREATE INDEX IF NOT EXISTS RevenueChecklistItem_revenueCaseId_group_status_idx ON RevenueChecklistItem(revenueCaseId, "group", status);
CREATE INDEX IF NOT EXISTS RevenueCaseEvent_revenueCaseId_createdAt_idx ON RevenueCaseEvent(revenueCaseId, createdAt);
CREATE INDEX IF NOT EXISTS RevenueCloseoutRun_facilityId_dateKey_idx ON RevenueCloseoutRun(facilityId, dateKey);
CREATE INDEX IF NOT EXISTS RevenueCloseoutRun_clinicId_dateKey_idx ON RevenueCloseoutRun(clinicId, dateKey);
CREATE INDEX IF NOT EXISTS RevenueCloseoutItem_closeoutRunId_idx ON RevenueCloseoutItem(closeoutRunId);
CREATE INDEX IF NOT EXISTS RevenueCloseoutItem_revenueCaseId_idx ON RevenueCloseoutItem(revenueCaseId);
CREATE INDEX IF NOT EXISTS RevenueCloseoutItem_queue_rollover_idx ON RevenueCloseoutItem(queue, rollover);
CREATE INDEX IF NOT EXISTS OfficeManagerDailyRollup_dateKey_idx ON OfficeManagerDailyRollup(dateKey);
CREATE INDEX IF NOT EXISTS OfficeManagerDailyRollup_clinicId_dateKey_idx ON OfficeManagerDailyRollup(clinicId, dateKey);
CREATE INDEX IF NOT EXISTS RoomDailyRollup_facilityId_dateKey_idx ON RoomDailyRollup(facilityId, dateKey);
CREATE INDEX IF NOT EXISTS RoomDailyRollup_dateKey_idx ON RoomDailyRollup(dateKey);
CREATE INDEX IF NOT EXISTS RoomDailyRollup_clinicId_dateKey_idx ON RoomDailyRollup(clinicId, dateKey);
CREATE INDEX IF NOT EXISTS AuditLog_occurredAt_idx ON AuditLog(occurredAt);
CREATE INDEX IF NOT EXISTS AuditLog_requestId_idx ON AuditLog(requestId);
CREATE INDEX IF NOT EXISTS AuditLog_route_method_idx ON AuditLog(route, method);
CREATE INDEX IF NOT EXISTS AuditLog_facilityId_occurredAt_idx ON AuditLog(facilityId, occurredAt);
CREATE INDEX IF NOT EXISTS AuditLog_clinicId_occurredAt_idx ON AuditLog(clinicId, occurredAt);
CREATE INDEX IF NOT EXISTS IdempotencyRecord_routeKey_createdAt_idx ON IdempotencyRecord(routeKey, createdAt);
CREATE INDEX IF NOT EXISTS EventOutbox_status_createdAt_idx ON EventOutbox(status, createdAt);
CREATE INDEX IF NOT EXISTS EventOutbox_topic_createdAt_idx ON EventOutbox(topic, createdAt);
CREATE INDEX IF NOT EXISTS EventOutbox_aggregateType_aggregateId_idx ON EventOutbox(aggregateType, aggregateId);
CREATE INDEX IF NOT EXISTS AlertThreshold_facility_clinic_metric_status_idx ON AlertThreshold(facilityId, clinicId, metric, status);
CREATE INDEX IF NOT EXISTS IntegrationConnector_vendor_enabled_idx ON IntegrationConnector(vendor, enabled);
`);

db.exec(`
DROP TRIGGER IF EXISTS Encounter_require_version_bump_on_business_update;
CREATE TRIGGER Encounter_require_version_bump_on_business_update
BEFORE UPDATE ON Encounter
FOR EACH ROW
WHEN (
  NEW.currentStatus IS NOT OLD.currentStatus OR
  NEW.providerId IS NOT OLD.providerId OR
  NEW.reasonForVisitId IS NOT OLD.reasonForVisitId OR
  NEW.assignedMaUserId IS NOT OLD.assignedMaUserId OR
  NEW.roomId IS NOT OLD.roomId OR
  NEW.checkInAt IS NOT OLD.checkInAt OR
  NEW.dateOfService IS NOT OLD.dateOfService OR
  NEW.roomingStartAt IS NOT OLD.roomingStartAt OR
  NEW.roomingCompleteAt IS NOT OLD.roomingCompleteAt OR
  NEW.providerStartAt IS NOT OLD.providerStartAt OR
  NEW.providerEndAt IS NOT OLD.providerEndAt OR
  NEW.checkoutCompleteAt IS NOT OLD.checkoutCompleteAt OR
  NEW.closedAt IS NOT OLD.closedAt OR
  NEW.walkIn IS NOT OLD.walkIn OR
  NEW.insuranceVerified IS NOT OLD.insuranceVerified OR
  NEW.arrivalNotes IS NOT OLD.arrivalNotes OR
  NEW.closureType IS NOT OLD.closureType OR
  NEW.closureNotes IS NOT OLD.closureNotes OR
  NEW.roomingData IS NOT OLD.roomingData OR
  NEW.clinicianData IS NOT OLD.clinicianData OR
  NEW.checkoutData IS NOT OLD.checkoutData OR
  NEW.intakeData IS NOT OLD.intakeData
) AND NEW.version <= OLD.version
BEGIN
  SELECT RAISE(ABORT, 'ENCOUNTER_VERSION_REQUIRED');
END;
`);

if (hasTable("IncomingSchedule") && !hasColumn("IncomingSchedule", "patientRecordId")) {
  db.exec(`ALTER TABLE IncomingSchedule ADD COLUMN patientRecordId TEXT;`);
}

if (hasTable("Encounter") && !hasColumn("Encounter", "patientRecordId")) {
  db.exec(`ALTER TABLE Encounter ADD COLUMN patientRecordId TEXT;`);
}

if (hasTable("RevenueCase") && !hasColumn("RevenueCase", "patientRecordId")) {
  db.exec(`ALTER TABLE RevenueCase ADD COLUMN patientRecordId TEXT;`);
}

if (hasTable("AuditLog") && !hasColumn("AuditLog", "idempotencyKey")) {
  db.exec(`ALTER TABLE AuditLog ADD COLUMN idempotencyKey TEXT;`);
}

if (hasTable("Task") && !hasColumn("Task", "archivedAt")) {
  db.exec(`ALTER TABLE Task ADD COLUMN archivedAt TEXT;`);
}

if (hasTable("Task") && !hasColumn("Task", "archivedBy")) {
  db.exec(`ALTER TABLE Task ADD COLUMN archivedBy TEXT;`);
}

db.exec(`
CREATE INDEX IF NOT EXISTS IncomingSchedule_patientRecordId_idx ON IncomingSchedule(patientRecordId);
CREATE INDEX IF NOT EXISTS Encounter_patientRecordId_idx ON Encounter(patientRecordId);
CREATE INDEX IF NOT EXISTS RevenueCase_patientRecordId_idx ON RevenueCase(patientRecordId);
CREATE INDEX IF NOT EXISTS AuditLog_idempotencyKey_idx ON AuditLog(idempotencyKey);
`);

db.close();

console.info(`SQLite schema initialized at ${dbPath}`);
