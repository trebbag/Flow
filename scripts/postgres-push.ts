import { spawn } from "node:child_process";
import pg from "pg";

const postgresUrl = (process.env.POSTGRES_DATABASE_URL || "").trim();

if (!postgresUrl) {
  console.error("POSTGRES_DATABASE_URL is required");
  process.exit(1);
}

const RLS_TABLES = [
  "Clinic",
  "ClinicRoom",
  "Provider",
  "ReasonForVisit",
  "Template",
  "Patient",
  "PatientAlias",
  "PatientIdentityReview",
  "PatientConsent",
  "Encounter",
  "StatusChangeEvent",
  "AlertState",
  "SafetyEvent",
  "IncomingImportBatch",
  "IncomingImportIssue",
  "IncomingSchedule",
  "Task",
  "RoomIssue",
  "RoomOperationalState",
  "RoomOperationalEvent",
  "RoomChecklistRun",
  "RevenueCase",
  "FinancialReadiness",
  "CheckoutCollectionTracking",
  "ChargeCaptureRecord",
  "ProviderClarification",
  "RevenueChecklistItem",
  "RevenueCaseEvent",
  "RevenueCloseoutRun",
  "RevenueCloseoutItem",
  "RevenueCycleSettings",
  "AlertThreshold",
  "NotificationPolicy",
  "UserAlertInbox",
  "AuditLog",
  "EntityEvent",
];

const VERSION_TRIGGER_SQL = `
CREATE OR REPLACE FUNCTION flow_require_encounter_version_bump()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.version <> OLD.version + 1
    AND (
      NEW."currentStatus" IS DISTINCT FROM OLD."currentStatus" OR
      NEW."providerId" IS DISTINCT FROM OLD."providerId" OR
      NEW."reasonForVisitId" IS DISTINCT FROM OLD."reasonForVisitId" OR
      NEW."assignedMaUserId" IS DISTINCT FROM OLD."assignedMaUserId" OR
      NEW."roomId" IS DISTINCT FROM OLD."roomId" OR
      NEW."checkInAt" IS DISTINCT FROM OLD."checkInAt" OR
      NEW."dateOfService" IS DISTINCT FROM OLD."dateOfService" OR
      NEW."roomingStartAt" IS DISTINCT FROM OLD."roomingStartAt" OR
      NEW."roomingCompleteAt" IS DISTINCT FROM OLD."roomingCompleteAt" OR
      NEW."providerStartAt" IS DISTINCT FROM OLD."providerStartAt" OR
      NEW."providerEndAt" IS DISTINCT FROM OLD."providerEndAt" OR
      NEW."checkoutCompleteAt" IS DISTINCT FROM OLD."checkoutCompleteAt" OR
      NEW."closedAt" IS DISTINCT FROM OLD."closedAt" OR
      NEW."walkIn" IS DISTINCT FROM OLD."walkIn" OR
      NEW."insuranceVerified" IS DISTINCT FROM OLD."insuranceVerified" OR
      NEW."arrivalNotes" IS DISTINCT FROM OLD."arrivalNotes" OR
      NEW."closureType" IS DISTINCT FROM OLD."closureType" OR
      NEW."closureNotes" IS DISTINCT FROM OLD."closureNotes" OR
      NEW."roomingData" IS DISTINCT FROM OLD."roomingData" OR
      NEW."clinicianData" IS DISTINCT FROM OLD."clinicianData" OR
      NEW."checkoutData" IS DISTINCT FROM OLD."checkoutData" OR
      NEW."intakeData" IS DISTINCT FROM OLD."intakeData"
    )
  THEN
    RAISE EXCEPTION 'ENCOUNTER_VERSION_REQUIRED';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "Encounter_require_version_bump_on_business_update" ON "Encounter";
CREATE TRIGGER "Encounter_require_version_bump_on_business_update"
BEFORE UPDATE ON "Encounter"
FOR EACH ROW
EXECUTE FUNCTION flow_require_encounter_version_bump();

CREATE OR REPLACE FUNCTION flow_require_task_version_bump()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.version <> OLD.version + 1
    AND (
      NEW."assignedToRole" IS DISTINCT FROM OLD."assignedToRole" OR
      NEW."assignedToUserId" IS DISTINCT FROM OLD."assignedToUserId" OR
      NEW."status" IS DISTINCT FROM OLD."status" OR
      NEW."priority" IS DISTINCT FROM OLD."priority" OR
      NEW."blocking" IS DISTINCT FROM OLD."blocking" OR
      NEW."dueAt" IS DISTINCT FROM OLD."dueAt" OR
      NEW."acknowledgedAt" IS DISTINCT FROM OLD."acknowledgedAt" OR
      NEW."acknowledgedBy" IS DISTINCT FROM OLD."acknowledgedBy" OR
      NEW."completedAt" IS DISTINCT FROM OLD."completedAt" OR
      NEW."completedBy" IS DISTINCT FROM OLD."completedBy" OR
      NEW."archivedAt" IS DISTINCT FROM OLD."archivedAt" OR
      NEW."archivedBy" IS DISTINCT FROM OLD."archivedBy" OR
      NEW."notes" IS DISTINCT FROM OLD."notes"
    )
  THEN
    RAISE EXCEPTION 'TASK_VERSION_REQUIRED';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "Task_require_version_bump_on_business_update" ON "Task";
CREATE TRIGGER "Task_require_version_bump_on_business_update"
BEFORE UPDATE ON "Task"
FOR EACH ROW
EXECUTE FUNCTION flow_require_task_version_bump();

CREATE OR REPLACE FUNCTION flow_require_room_issue_version_bump()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.version <> OLD.version + 1
    AND (
      NEW."status" IS DISTINCT FROM OLD."status" OR
      NEW."severity" IS DISTINCT FROM OLD."severity" OR
      NEW."title" IS DISTINCT FROM OLD."title" OR
      NEW."description" IS DISTINCT FROM OLD."description" OR
      NEW."placesRoomOnHold" IS DISTINCT FROM OLD."placesRoomOnHold" OR
      NEW."taskId" IS DISTINCT FROM OLD."taskId" OR
      NEW."sourceModule" IS DISTINCT FROM OLD."sourceModule" OR
      NEW."metadataJson" IS DISTINCT FROM OLD."metadataJson" OR
      NEW."resolvedAt" IS DISTINCT FROM OLD."resolvedAt" OR
      NEW."resolvedByUserId" IS DISTINCT FROM OLD."resolvedByUserId" OR
      NEW."resolutionNote" IS DISTINCT FROM OLD."resolutionNote"
    )
  THEN
    RAISE EXCEPTION 'ROOM_ISSUE_VERSION_REQUIRED';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "RoomIssue_require_version_bump_on_business_update" ON "RoomIssue";
CREATE TRIGGER "RoomIssue_require_version_bump_on_business_update"
BEFORE UPDATE ON "RoomIssue"
FOR EACH ROW
EXECUTE FUNCTION flow_require_room_issue_version_bump();

CREATE OR REPLACE FUNCTION flow_require_revenue_case_version_bump()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.version <> OLD.version + 1
    AND (
      NEW."patientRecordId" IS DISTINCT FROM OLD."patientRecordId" OR
      NEW."providerId" IS DISTINCT FROM OLD."providerId" OR
      NEW."currentRevenueStatus" IS DISTINCT FROM OLD."currentRevenueStatus" OR
      NEW."currentWorkQueue" IS DISTINCT FROM OLD."currentWorkQueue" OR
      NEW."currentDayBucket" IS DISTINCT FROM OLD."currentDayBucket" OR
      NEW."priority" IS DISTINCT FROM OLD."priority" OR
      NEW."assignedToUserId" IS DISTINCT FROM OLD."assignedToUserId" OR
      NEW."assignedToRole" IS DISTINCT FROM OLD."assignedToRole" OR
      NEW."currentBlockerCategory" IS DISTINCT FROM OLD."currentBlockerCategory" OR
      NEW."currentBlockerText" IS DISTINCT FROM OLD."currentBlockerText" OR
      NEW."dueAt" IS DISTINCT FROM OLD."dueAt" OR
      NEW."rolledFromDateKey" IS DISTINCT FROM OLD."rolledFromDateKey" OR
      NEW."rollReason" IS DISTINCT FROM OLD."rollReason" OR
      NEW."readyForAthenaAt" IS DISTINCT FROM OLD."readyForAthenaAt" OR
      NEW."athenaHandoffOwnerUserId" IS DISTINCT FROM OLD."athenaHandoffOwnerUserId" OR
      NEW."athenaHandoffStartedAt" IS DISTINCT FROM OLD."athenaHandoffStartedAt" OR
      NEW."athenaHandoffConfirmedAt" IS DISTINCT FROM OLD."athenaHandoffConfirmedAt" OR
      NEW."athenaHandoffConfirmedByUserId" IS DISTINCT FROM OLD."athenaHandoffConfirmedByUserId" OR
      NEW."athenaHandoffNote" IS DISTINCT FROM OLD."athenaHandoffNote" OR
      NEW."athenaChargeEnteredAt" IS DISTINCT FROM OLD."athenaChargeEnteredAt" OR
      NEW."athenaClaimSubmittedAt" IS DISTINCT FROM OLD."athenaClaimSubmittedAt" OR
      NEW."athenaDaysToSubmit" IS DISTINCT FROM OLD."athenaDaysToSubmit" OR
      NEW."athenaDaysInAR" IS DISTINCT FROM OLD."athenaDaysInAR" OR
      NEW."athenaClaimStatus" IS DISTINCT FROM OLD."athenaClaimStatus" OR
      NEW."athenaPatientBalanceCents" IS DISTINCT FROM OLD."athenaPatientBalanceCents" OR
      NEW."athenaLastSyncAt" IS DISTINCT FROM OLD."athenaLastSyncAt" OR
      NEW."closeoutState" IS DISTINCT FROM OLD."closeoutState" OR
      NEW."closedAt" IS DISTINCT FROM OLD."closedAt" OR
      NEW."archivedAt" IS DISTINCT FROM OLD."archivedAt" OR
      NEW."archivedByUserId" IS DISTINCT FROM OLD."archivedByUserId" OR
      NEW."archivedReason" IS DISTINCT FROM OLD."archivedReason"
    )
  THEN
    RAISE EXCEPTION 'REVENUE_CASE_VERSION_REQUIRED';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "RevenueCase_require_version_bump_on_business_update" ON "RevenueCase";
CREATE TRIGGER "RevenueCase_require_version_bump_on_business_update"
BEFORE UPDATE ON "RevenueCase"
FOR EACH ROW
EXECUTE FUNCTION flow_require_revenue_case_version_bump();
`;

const RLS_SQL = `
CREATE OR REPLACE FUNCTION flow_current_facility_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_facility_id', true), '')::text
$$;

CREATE OR REPLACE FUNCTION flow_clinic_in_scope(clinic_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "Clinic" c
    WHERE c.id = clinic_id
      AND c."facilityId" = flow_current_facility_id()
  )
$$;

CREATE OR REPLACE FUNCTION flow_room_in_scope(room_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "ClinicRoom" r
    WHERE r.id = room_id
      AND r."facilityId" = flow_current_facility_id()
  )
$$;

CREATE OR REPLACE FUNCTION flow_encounter_in_scope(encounter_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "Encounter" e
    JOIN "Clinic" c ON c.id = e."clinicId"
    WHERE e.id = encounter_id
      AND c."facilityId" = flow_current_facility_id()
  )
$$;

CREATE OR REPLACE FUNCTION flow_revenue_case_in_scope(revenue_case_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "RevenueCase" rc
    WHERE rc.id = revenue_case_id
      AND rc."facilityId" = flow_current_facility_id()
  )
$$;

CREATE OR REPLACE FUNCTION flow_apply_rls(table_name text, policy_name text, using_expr text, with_check_expr text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', table_name);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', table_name);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %s', policy_name, table_name);
  EXECUTE format(
    'CREATE POLICY %I ON %s USING (%s)%s',
    policy_name,
    table_name,
    using_expr,
    CASE
      WHEN with_check_expr IS NULL THEN ''
      ELSE format(' WITH CHECK (%s)', with_check_expr)
    END
  );
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flow_admin') THEN
    CREATE ROLE flow_admin NOLOGIN BYPASSRLS;
  END IF;
END
$$;

SELECT flow_apply_rls('"Clinic"', 'clinic_facility_scope', '"facilityId" = flow_current_facility_id()', '"facilityId" = flow_current_facility_id()');
SELECT flow_apply_rls('"ClinicRoom"', 'clinic_room_facility_scope', '"facilityId" = flow_current_facility_id()', '"facilityId" = flow_current_facility_id()');
SELECT flow_apply_rls('"Provider"', 'provider_facility_scope', 'flow_clinic_in_scope("clinicId")', 'flow_clinic_in_scope("clinicId")');
SELECT flow_apply_rls('"ReasonForVisit"', 'reason_facility_scope', '("facilityId" = flow_current_facility_id()) OR ("facilityId" IS NULL AND "clinicId" IS NOT NULL AND flow_clinic_in_scope("clinicId"))', '("facilityId" = flow_current_facility_id()) OR ("facilityId" IS NULL AND "clinicId" IS NOT NULL AND flow_clinic_in_scope("clinicId"))');
SELECT flow_apply_rls('"Template"', 'template_facility_scope', '"facilityId" = flow_current_facility_id()', '"facilityId" = flow_current_facility_id()');
SELECT flow_apply_rls('"Patient"', 'patient_facility_scope', '"facilityId" = flow_current_facility_id()', '"facilityId" = flow_current_facility_id()');
SELECT flow_apply_rls('"PatientAlias"', 'patient_alias_facility_scope', '"facilityId" = flow_current_facility_id()', '"facilityId" = flow_current_facility_id()');
SELECT flow_apply_rls('"PatientIdentityReview"', 'patient_identity_review_facility_scope', '"facilityId" = flow_current_facility_id()', '"facilityId" = flow_current_facility_id()');
SELECT flow_apply_rls('"PatientConsent"', 'patient_consent_facility_scope', '"facilityId" = flow_current_facility_id()', '"facilityId" = flow_current_facility_id()');
SELECT flow_apply_rls('"Encounter"', 'encounter_facility_scope', 'flow_clinic_in_scope("clinicId")', 'flow_clinic_in_scope("clinicId")');
SELECT flow_apply_rls('"StatusChangeEvent"', 'status_change_event_scope', 'flow_encounter_in_scope("encounterId")', 'flow_encounter_in_scope("encounterId")');
SELECT flow_apply_rls('"AlertState"', 'alert_state_scope', 'flow_encounter_in_scope("encounterId")', 'flow_encounter_in_scope("encounterId")');
SELECT flow_apply_rls('"SafetyEvent"', 'safety_event_scope', 'flow_encounter_in_scope("encounterId")', 'flow_encounter_in_scope("encounterId")');
SELECT flow_apply_rls('"IncomingImportBatch"', 'incoming_import_batch_scope', '"facilityId" = flow_current_facility_id()', '"facilityId" = flow_current_facility_id()');
SELECT flow_apply_rls('"IncomingImportIssue"', 'incoming_import_issue_scope', '"facilityId" = flow_current_facility_id()', '"facilityId" = flow_current_facility_id()');
SELECT flow_apply_rls('"IncomingSchedule"', 'incoming_schedule_scope', 'flow_clinic_in_scope("clinicId")', 'flow_clinic_in_scope("clinicId")');
SELECT flow_apply_rls('"Task"', 'task_facility_scope', '"facilityId" = flow_current_facility_id()', '"facilityId" = flow_current_facility_id()');
SELECT flow_apply_rls('"RoomIssue"', 'room_issue_facility_scope', '"facilityId" = flow_current_facility_id()', '"facilityId" = flow_current_facility_id()');
SELECT flow_apply_rls('"RoomOperationalState"', 'room_operational_state_scope', 'flow_room_in_scope("roomId")', 'flow_room_in_scope("roomId")');
SELECT flow_apply_rls('"RoomOperationalEvent"', 'room_operational_event_scope', '"facilityId" = flow_current_facility_id()', '"facilityId" = flow_current_facility_id()');
SELECT flow_apply_rls('"RoomChecklistRun"', 'room_checklist_run_scope', '"facilityId" = flow_current_facility_id()', '"facilityId" = flow_current_facility_id()');
SELECT flow_apply_rls('"RevenueCase"', 'revenue_case_facility_scope', '"facilityId" = flow_current_facility_id()', '"facilityId" = flow_current_facility_id()');
SELECT flow_apply_rls('"FinancialReadiness"', 'financial_readiness_scope', 'flow_revenue_case_in_scope("revenueCaseId")', 'flow_revenue_case_in_scope("revenueCaseId")');
SELECT flow_apply_rls('"CheckoutCollectionTracking"', 'checkout_collection_scope', 'flow_revenue_case_in_scope("revenueCaseId")', 'flow_revenue_case_in_scope("revenueCaseId")');
SELECT flow_apply_rls('"ChargeCaptureRecord"', 'charge_capture_scope', 'flow_revenue_case_in_scope("revenueCaseId")', 'flow_revenue_case_in_scope("revenueCaseId")');
SELECT flow_apply_rls('"ProviderClarification"', 'provider_clarification_scope', 'flow_revenue_case_in_scope("revenueCaseId")', 'flow_revenue_case_in_scope("revenueCaseId")');
SELECT flow_apply_rls('"RevenueChecklistItem"', 'revenue_checklist_item_scope', 'flow_revenue_case_in_scope("revenueCaseId")', 'flow_revenue_case_in_scope("revenueCaseId")');
SELECT flow_apply_rls('"RevenueCaseEvent"', 'revenue_case_event_scope', 'flow_revenue_case_in_scope("revenueCaseId")', 'flow_revenue_case_in_scope("revenueCaseId")');
SELECT flow_apply_rls('"RevenueCloseoutRun"', 'revenue_closeout_run_scope', '"facilityId" = flow_current_facility_id()', '"facilityId" = flow_current_facility_id()');
SELECT flow_apply_rls('"RevenueCloseoutItem"', 'revenue_closeout_item_scope', 'flow_revenue_case_in_scope("revenueCaseId")', 'flow_revenue_case_in_scope("revenueCaseId")');
SELECT flow_apply_rls('"RevenueCycleSettings"', 'revenue_cycle_settings_scope', '"facilityId" = flow_current_facility_id()', '"facilityId" = flow_current_facility_id()');
SELECT flow_apply_rls('"AlertThreshold"', 'alert_threshold_scope', '"facilityId" = flow_current_facility_id()', '"facilityId" = flow_current_facility_id()');
SELECT flow_apply_rls('"NotificationPolicy"', 'notification_policy_scope', 'flow_clinic_in_scope("clinicId")', 'flow_clinic_in_scope("clinicId")');
SELECT flow_apply_rls('"UserAlertInbox"', 'user_alert_inbox_scope', '"facilityId" = flow_current_facility_id() OR ("facilityId" IS NULL AND "clinicId" IS NOT NULL AND flow_clinic_in_scope("clinicId"))', '"facilityId" = flow_current_facility_id() OR ("facilityId" IS NULL AND "clinicId" IS NOT NULL AND flow_clinic_in_scope("clinicId"))');
SELECT flow_apply_rls('"AuditLog"', 'audit_log_scope', '"facilityId" = flow_current_facility_id()', '"facilityId" = flow_current_facility_id()');
SELECT flow_apply_rls('"EntityEvent"', 'entity_event_scope', '"facilityId" = flow_current_facility_id()', '"facilityId" = flow_current_facility_id()');
`;

const TENANT_SCOPE_BACKFILL_SQL = `
DO $$
DECLARE
  unresolved jsonb;
BEGIN
  IF to_regclass('public."Clinic"') IS NOT NULL THEN
    WITH candidates AS (
      SELECT ur."clinicId", ur."facilityId" FROM "UserRole" ur WHERE ur."clinicId" IS NOT NULL AND ur."facilityId" IS NOT NULL
      UNION ALL
      SELECT at."clinicId", at."facilityId" FROM "AlertThreshold" at WHERE at."clinicId" IS NOT NULL AND at."facilityId" IS NOT NULL
      UNION ALL
      SELECT iib."clinicId", iib."facilityId" FROM "IncomingImportBatch" iib WHERE iib."clinicId" IS NOT NULL AND iib."facilityId" IS NOT NULL
      UNION ALL
      SELECT iii."clinicId", iii."facilityId" FROM "IncomingImportIssue" iii WHERE iii."clinicId" IS NOT NULL AND iii."facilityId" IS NOT NULL
      UNION ALL
      SELECT rc."clinicId", rc."facilityId" FROM "RevenueCase" rc WHERE rc."clinicId" IS NOT NULL AND rc."facilityId" IS NOT NULL
      UNION ALL
      SELECT rcr."clinicId", rcr."facilityId" FROM "RevenueCloseoutRun" rcr WHERE rcr."clinicId" IS NOT NULL AND rcr."facilityId" IS NOT NULL
      UNION ALL
      SELECT rdr."clinicId", rdr."facilityId" FROM "RoomDailyRollup" rdr WHERE rdr."clinicId" IS NOT NULL AND rdr."facilityId" IS NOT NULL
    ),
    resolved AS (
      SELECT "clinicId", min("facilityId") AS "facilityId"
      FROM candidates
      GROUP BY "clinicId"
      HAVING count(DISTINCT "facilityId") = 1
    )
    UPDATE "Clinic" c
    SET "facilityId" = r."facilityId"
    FROM resolved r
    WHERE c.id = r."clinicId"
      AND c."facilityId" IS NULL;
  END IF;

  IF to_regclass('public."Task"') IS NOT NULL THEN
    WITH active_room_clinic AS (
      SELECT cra."roomId", min(cra."clinicId") AS "clinicId"
      FROM "ClinicRoomAssignment" cra
      WHERE cra.active = true
      GROUP BY cra."roomId"
      HAVING count(DISTINCT cra."clinicId") = 1
    ),
    candidates AS (
      SELECT t.id, e."clinicId", c."facilityId"
      FROM "Task" t
      JOIN "Encounter" e ON e.id = t."encounterId"
      JOIN "Clinic" c ON c.id = e."clinicId"
      WHERE t."encounterId" IS NOT NULL
      UNION ALL
      SELECT t.id, rc."clinicId", rc."facilityId"
      FROM "Task" t
      JOIN "RevenueCase" rc ON rc.id = t."revenueCaseId"
      WHERE t."revenueCaseId" IS NOT NULL
      UNION ALL
      SELECT t.id, arc."clinicId", cr."facilityId"
      FROM "Task" t
      JOIN "ClinicRoom" cr ON cr.id = t."roomId"
      JOIN active_room_clinic arc ON arc."roomId" = t."roomId"
      WHERE t."roomId" IS NOT NULL
      UNION ALL
      SELECT existing_task.id, existing_task."clinicId", existing_task."facilityId"
      FROM "Task" existing_task
      WHERE existing_task."clinicId" IS NOT NULL AND existing_task."facilityId" IS NOT NULL
    ),
    resolved AS (
      SELECT id, min("clinicId") AS "clinicId", min("facilityId") AS "facilityId"
      FROM candidates
      GROUP BY id
      HAVING count(DISTINCT "clinicId") = 1
         AND count(DISTINCT "facilityId") = 1
    )
    UPDATE "Task" t
    SET
      "clinicId" = COALESCE(t."clinicId", r."clinicId"),
      "facilityId" = COALESCE(t."facilityId", r."facilityId")
    FROM resolved r
    WHERE t.id = r.id
      AND (t."clinicId" IS NULL OR t."facilityId" IS NULL);
  END IF;

  IF to_regclass('public."Clinic"') IS NULL OR to_regclass('public."Task"') IS NULL THEN
    RETURN;
  END IF;

  SELECT jsonb_build_object(
    'Clinic.facilityId', COALESCE((SELECT count(*) FROM "Clinic" WHERE "facilityId" IS NULL), 0),
    'Task.facilityId', COALESCE((SELECT count(*) FROM "Task" WHERE "facilityId" IS NULL), 0),
    'Task.clinicId', COALESCE((SELECT count(*) FROM "Task" WHERE "clinicId" IS NULL), 0)
  ) INTO unresolved;

  IF (unresolved->>'Clinic.facilityId')::int > 0
    OR (unresolved->>'Task.facilityId')::int > 0
    OR (unresolved->>'Task.clinicId')::int > 0
  THEN
    RAISE EXCEPTION 'TENANT_SCOPE_REPAIR_REQUIRED %', unresolved;
  END IF;
END
$$;
`;

function runPrismaDbPush() {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["prisma", "db", "push", "--schema", "prisma/schema.postgres.prisma"],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          DATABASE_URL: postgresUrl,
        },
      },
    );

    child.on("exit", (code) => {
      if ((code ?? 1) === 0) {
        resolve();
        return;
      }
      reject(new Error(`prisma db push exited with code ${code ?? 1}`));
    });

    child.on("error", reject);
  });
}

async function suspendRowLevelSecurityForSchemaPush() {
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  try {
    const role = await client.query<{ current_user: string; rolbypassrls: boolean }>(
      `
      SELECT current_user, COALESCE(r.rolbypassrls, false) AS rolbypassrls
      FROM pg_roles r
      WHERE r.rolname = current_user
      `,
    );
    if (role.rows[0]?.rolbypassrls) {
      return false;
    }

    let suspended = false;
    for (const table of RLS_TABLES) {
      const exists = await client.query<{ exists: boolean }>("SELECT to_regclass($1) IS NOT NULL AS exists", [
        `public."${table}"`,
      ]);
      if (!exists.rows[0]?.exists) {
        continue;
      }

      const qualified = pg.escapeIdentifier(table);
      await client.query(`ALTER TABLE ${qualified} NO FORCE ROW LEVEL SECURITY`);
      await client.query(`ALTER TABLE ${qualified} DISABLE ROW LEVEL SECURITY`);
      suspended = true;
    }

    if (suspended) {
      console.warn(
        "Temporarily suspended row-level security for Prisma schema push because the migration role does not have BYPASSRLS; policies will be reinstalled before exit.",
      );
    }

    return suspended;
  } finally {
    await client.end();
  }
}

async function runPrePushStepsWithRlsSuspension() {
  const rlsSuspended = await suspendRowLevelSecurityForSchemaPush();
  try {
    await migrateTaskStatusEnum();
    await backfillTenantScopeBeforePush();
    await runPrismaDbPush();
  } finally {
    if (rlsSuspended) {
      await installRowLevelSecurity();
    }
  }
}

async function installVersionTriggers() {
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  try {
    await client.query(VERSION_TRIGGER_SQL);
  } finally {
    await client.end();
  }
}

async function backfillTenantScopeBeforePush() {
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  try {
    await client.query(TENANT_SCOPE_BACKFILL_SQL);
  } finally {
    await client.end();
  }
}

const CLINIC_ROOM_PARTIAL_UNIQUE_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS "ClinicRoom_facilityId_roomNumber_live_unique"
  ON "ClinicRoom" ("facilityId", "roomNumber")
  WHERE "status" IN ('active', 'inactive');
`;

const CHECK_CONSTRAINTS_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Encounter_provider_times_ordered'
  ) THEN
    ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_provider_times_ordered"
      CHECK ("providerStartAt" IS NULL OR "providerEndAt" IS NULL OR "providerStartAt" <= "providerEndAt");
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Encounter_closureNotes_nonempty'
  ) THEN
    ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_closureNotes_nonempty"
      CHECK ("closureNotes" IS NULL OR length(trim("closureNotes")) > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Task_description_nonempty'
  ) THEN
    ALTER TABLE "Task" ADD CONSTRAINT "Task_description_nonempty"
      CHECK (length(trim("description")) > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'RoomIssue_title_nonempty'
  ) THEN
    ALTER TABLE "RoomIssue" ADD CONSTRAINT "RoomIssue_title_nonempty"
      CHECK (length(trim("title")) > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AlertThreshold_red_ge_yellow'
  ) THEN
    ALTER TABLE "AlertThreshold" ADD CONSTRAINT "AlertThreshold_red_ge_yellow"
      CHECK ("redAtMin" >= "yellowAtMin");
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AlertThreshold_escalation_ge_red'
  ) THEN
    ALTER TABLE "AlertThreshold" ADD CONSTRAINT "AlertThreshold_escalation_ge_red"
      CHECK ("escalation2Min" IS NULL OR "escalation2Min" >= "redAtMin");
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CheckoutCollectionTracking_amountDue_nonneg'
  ) THEN
    ALTER TABLE "CheckoutCollectionTracking" ADD CONSTRAINT "CheckoutCollectionTracking_amountDue_nonneg"
      CHECK ("amountDueCents" >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CheckoutCollectionTracking_amountCollected_nonneg'
  ) THEN
    ALTER TABLE "CheckoutCollectionTracking" ADD CONSTRAINT "CheckoutCollectionTracking_amountCollected_nonneg"
      CHECK ("amountCollectedCents" >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CheckoutCollectionTracking_collected_le_due'
  ) THEN
    ALTER TABLE "CheckoutCollectionTracking" ADD CONSTRAINT "CheckoutCollectionTracking_collected_le_due"
      CHECK ("amountCollectedCents" <= "amountDueCents");
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Patient_cipher_pairing'
  ) THEN
    ALTER TABLE "Patient" ADD CONSTRAINT "Patient_cipher_pairing"
      CHECK (
        ("displayName" IS NULL OR "displayNameCipher" IS NOT NULL OR "cipherKeyId" IS NULL)
        AND ("dateOfBirth" IS NULL OR "dateOfBirthCipher" IS NOT NULL OR "cipherKeyId" IS NULL)
      );
  END IF;
END
$$;
`;

const TASK_STATUS_ENUM_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'TaskStatus'
  ) THEN
    CREATE TYPE "TaskStatus" AS ENUM ('open', 'completed', 'archived');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Task'
      AND column_name = 'status'
      AND udt_name <> 'TaskStatus'
  ) THEN
    ALTER TABLE "Task" ALTER COLUMN "status" DROP DEFAULT;

    UPDATE "Task"
    SET "status" = CASE
      WHEN "status" IS NULL THEN 'open'
      WHEN lower(trim("status")) IN ('open', 'completed', 'archived') THEN lower(trim("status"))
      WHEN "archivedAt" IS NOT NULL THEN 'archived'
      WHEN "completedAt" IS NOT NULL THEN 'completed'
      ELSE 'open'
    END
    WHERE "status" IS NULL
      OR lower(trim("status")) NOT IN ('open', 'completed', 'archived')
      OR "status" <> lower(trim("status"));

    ALTER TABLE "Task"
      ALTER COLUMN "status" TYPE "TaskStatus"
      USING (
        CASE
          WHEN "status" IS NULL THEN 'open'
          WHEN lower(trim("status")) IN ('open', 'completed', 'archived') THEN lower(trim("status"))
          WHEN "archivedAt" IS NOT NULL THEN 'archived'
          WHEN "completedAt" IS NOT NULL THEN 'completed'
          ELSE 'open'
        END
      )::"TaskStatus";

    ALTER TABLE "Task" ALTER COLUMN "status" SET DEFAULT 'open';
  END IF;
END
$$;
`;

async function installDataIntegrityChecks() {
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  try {
    await client.query(CHECK_CONSTRAINTS_SQL);
  } finally {
    await client.end();
  }
}

async function migrateTaskStatusEnum() {
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  try {
    await client.query(TASK_STATUS_ENUM_SQL);
  } finally {
    await client.end();
  }
}

async function installClinicRoomPartialUnique() {
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  try {
    await client.query(CLINIC_ROOM_PARTIAL_UNIQUE_SQL);
  } finally {
    await client.end();
  }
}

async function installRowLevelSecurity() {
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  try {
    await client.query(RLS_SQL);
  } finally {
    await client.end();
  }
}

const APPEND_ONLY_TABLES = [
  "EntityEvent",
  "StatusChangeEvent",
  "AuditLog",
  "RevenueCaseEvent",
  "RoomOperationalEvent",
];

async function installAppendOnlyProtections() {
  const appRole = (process.env.POSTGRES_APP_ROLE || "").trim();
  if (!appRole) {
    throw new Error(
      "POSTGRES_APP_ROLE is required to install append-only table protections. Configure a non-owner runtime DB role distinct from the migration/admin role.",
    );
  }

  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  try {
    const currentUser = (await client.query<{ current_user: string }>("SELECT current_user")).rows[0]?.current_user;
    if (currentUser === appRole) {
      throw new Error("POSTGRES_APP_ROLE must differ from the migration/admin role used for db:push:postgres.");
    }

    const roleExists = await client.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)", [
      appRole,
    ]);
    if (!roleExists.rows[0]?.exists) {
      throw new Error(`POSTGRES_APP_ROLE '${appRole}' does not exist. Create the runtime role before running db:push:postgres.`);
    }

    for (const table of APPEND_ONLY_TABLES) {
      const qualified = `"${table}"`;
      await client.query(`GRANT SELECT, INSERT ON TABLE ${qualified} TO ${pg.escapeIdentifier(appRole)}`);
      await client.query(`REVOKE UPDATE, DELETE ON TABLE ${qualified} FROM ${pg.escapeIdentifier(appRole)}`);
      const privilegeCheck = await client.query<{ can_update: boolean; can_delete: boolean }>(
        "SELECT has_table_privilege($1, $2, 'UPDATE') AS can_update, has_table_privilege($1, $2, 'DELETE') AS can_delete",
        [appRole, qualified],
      );
      const row = privilegeCheck.rows[0];
      if (row?.can_update || row?.can_delete) {
        throw new Error(
          `Append-only protection did not take effect for ${table}; verify ${appRole} is not the table owner or a privileged role.`,
        );
      }
    }
  } finally {
    await client.end();
  }
}

async function main() {
  await runPrePushStepsWithRlsSuspension();
  await installVersionTriggers();
  await installDataIntegrityChecks();
  await installClinicRoomPartialUnique();
  await installRowLevelSecurity();
  await installAppendOnlyProtections();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
