import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

type Snapshot = {
  metadata?: Record<string, unknown>;
  tables: Record<string, Array<Record<string, unknown>>>;
};

const TABLE_ORDER = [
  "Facility",
  "IntegrationConnector",
  "Clinic",
  "User",
  "UserRole",
  "Provider",
  "MaProviderMap",
  "MaClinicMap",
  "ClinicRoom",
  "ReasonForVisit",
  "Template",
  "IncomingImportBatch",
  "IncomingSchedule",
  "IncomingImportIssue",
  "Encounter",
  "StatusChangeEvent",
  "AlertState",
  "Task",
  "SafetyEvent",
  "AlertThreshold",
  "NotificationPolicy",
  "OfficeManagerDailyRollup",
  "AuditLog",
  "EventOutbox"
] as const;

function sqlId(name: string) {
  return `"${name.replace(/"/g, '""')}"`;
}

async function insertRows(client: Client, table: string, rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return;

  for (const row of rows) {
    const columns = Object.keys(row);
    if (columns.length === 0) continue;

    const values = columns.map((column) => {
      const value = row[column];
      if (value === undefined) return null;
      if (typeof value === "object" && value !== null) {
        return JSON.stringify(value);
      }
      return value;
    });

    const sql = `INSERT INTO ${sqlId(table)} (${columns.map(sqlId).join(", ")}) VALUES (${columns
      .map((_, index) => `$${index + 1}`)
      .join(", ")})`;

    await client.query(sql, values);
  }
}

async function main() {
  const postgresUrl = process.env.POSTGRES_DATABASE_URL;
  if (!postgresUrl) {
    throw new Error("POSTGRES_DATABASE_URL is required");
  }

  const snapshotPathArg = process.argv[2] || "artifacts/sqlite-snapshot.json";
  const snapshotPath = path.resolve(process.cwd(), snapshotPathArg);

  const raw = await fs.readFile(snapshotPath, "utf8");
  const snapshot = JSON.parse(raw) as Snapshot;

  const client = new Client({ connectionString: postgresUrl });
  await client.connect();

  try {
    await client.query("BEGIN");

    const truncateSql = TABLE_ORDER.slice()
      .reverse()
      .map((table) => sqlId(table))
      .join(", ");
    await client.query(`TRUNCATE TABLE ${truncateSql} RESTART IDENTITY CASCADE`);

    for (const table of TABLE_ORDER) {
      const rows = snapshot.tables[table] || [];
      await insertRows(client, table, rows);
      console.info(`Imported ${rows.length} rows into ${table}`);
    }

    await client.query("COMMIT");

    console.info("PostgreSQL snapshot import completed successfully.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
