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

async function main() {
  await runPrismaDbPush();
  await installEncounterVersionTrigger();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
