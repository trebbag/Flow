import { Client } from "pg";

const REQUIRED_TABLES = [
  "Facility",
  "Clinic",
  "User",
  "UserRole",
  "Provider",
  "TemporaryClinicAssignmentOverride",
  "ReasonForVisit",
  "Template",
  "IncomingSchedule",
  "Encounter",
  "Task",
  "RoomOperationalState",
  "RoomOperationalEvent",
  "RoomIssue",
  "RoomChecklistRun",
  "SafetyEvent",
  "OfficeManagerDailyRollup",
  "RoomDailyRollup",
  "AuditLog",
  "EventOutbox"
] as const;

async function main() {
  const postgresUrl = process.env.POSTGRES_DATABASE_URL;
  if (!postgresUrl) {
    throw new Error("POSTGRES_DATABASE_URL is required");
  }

  const client = new Client({ connectionString: postgresUrl });
  await client.connect();

  try {
    const versionRow = await client.query<{ version: string }>("select version()");
    console.info(`Connected to: ${versionRow.rows[0]?.version || "unknown"}`);

    const tables = await client.query<{ table_name: string }>(
      `
      select table_name
      from information_schema.tables
      where table_schema = 'public'
      `
    );

    const existing = new Set(tables.rows.map((row) => row.table_name));
    const missing = REQUIRED_TABLES.filter((name) => !existing.has(name));

    if (missing.length > 0) {
      throw new Error(
        `Connected successfully, but the PostgreSQL schema is not initialized yet. ` +
          `Missing required tables in public schema: ${missing.join(", ")}. ` +
          `Next step: run "POSTGRES_DATABASE_URL='postgresql://<user>:<password>@<host>:5432/flow?sslmode=verify-full' ` +
          `npx prisma db push --schema prisma/schema.postgres.prisma" and then rerun this preflight.`
      );
    }

    console.info("PostgreSQL preflight passed: required tables are present.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
