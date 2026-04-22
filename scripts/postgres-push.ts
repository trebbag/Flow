import { spawn } from "node:child_process";
import pg from "pg";

const postgresUrl = (process.env.POSTGRES_DATABASE_URL || "").trim();

if (!postgresUrl) {
  console.error("POSTGRES_DATABASE_URL is required");
  process.exit(1);
}

const ENCOUNTER_VERSION_TRIGGER_SQL = `
CREATE OR REPLACE FUNCTION flow_require_encounter_version_bump()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.version <= OLD.version
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

async function installEncounterVersionTrigger() {
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  try {
    await client.query(ENCOUNTER_VERSION_TRIGGER_SQL);
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

async function installClinicRoomPartialUnique() {
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  try {
    await client.query(CLINIC_ROOM_PARTIAL_UNIQUE_SQL);
  } finally {
    await client.end();
  }
}

async function main() {
  await runPrismaDbPush();
  await installEncounterVersionTrigger();
  await installDataIntegrityChecks();
  await installClinicRoomPartialUnique();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
