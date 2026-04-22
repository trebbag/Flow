import { PrismaClient } from "@prisma/client";

const AUDIT_LOG_RETENTION_DAYS = Number(process.env.AUDIT_LOG_RETENTION_DAYS || 90);
const EVENT_OUTBOX_RETENTION_DAYS = Number(process.env.EVENT_OUTBOX_RETENTION_DAYS || 30);
const DRY_RUN = process.env.RETENTION_DRY_RUN === "1";

function daysAgo(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

async function archiveAuditLogs(db: PrismaClient, cutoff: Date) {
  const count = await db.auditLog.count({ where: { occurredAt: { lt: cutoff } } });
  if (count === 0) {
    console.info(`[retention] audit-log: 0 rows older than ${cutoff.toISOString()}`);
    return;
  }
  if (DRY_RUN) {
    console.info(
      `[retention] audit-log: ${count} rows older than ${cutoff.toISOString()} (dry-run, not deleting)`,
    );
    return;
  }
  console.warn(
    `[retention] audit-log: ${count} rows older than ${cutoff.toISOString()} pending archival. ` +
      `This script deletes in-database rows only — upstream archival (S3/Blob) must be configured ` +
      `to read and export before purge. See docs/DISASTER_RECOVERY.md. Set RETENTION_CONFIRM_PURGE=1 to proceed.`,
  );
  if (process.env.RETENTION_CONFIRM_PURGE !== "1") {
    console.info("[retention] audit-log: skipping purge. Set RETENTION_CONFIRM_PURGE=1 to delete.");
    return;
  }
  const result = await db.auditLog.deleteMany({ where: { occurredAt: { lt: cutoff } } });
  console.info(`[retention] audit-log: purged ${result.count} rows`);
}

async function purgeEventOutbox(db: PrismaClient, cutoff: Date) {
  const where = {
    status: { in: ["dispatched", "failed"] },
    dispatchedAt: { lt: cutoff },
  } as const;
  const count = await db.eventOutbox.count({ where });
  if (count === 0) {
    console.info(`[retention] event-outbox: 0 dispatched rows older than ${cutoff.toISOString()}`);
    return;
  }
  if (DRY_RUN) {
    console.info(
      `[retention] event-outbox: ${count} rows older than ${cutoff.toISOString()} (dry-run, not deleting)`,
    );
    return;
  }
  const result = await db.eventOutbox.deleteMany({ where });
  console.info(`[retention] event-outbox: purged ${result.count} rows`);
}

async function main() {
  const db = new PrismaClient();
  const auditCutoff = daysAgo(AUDIT_LOG_RETENTION_DAYS);
  const outboxCutoff = daysAgo(EVENT_OUTBOX_RETENTION_DAYS);
  try {
    console.info(
      `[retention] starting. auditCutoff=${auditCutoff.toISOString()} outboxCutoff=${outboxCutoff.toISOString()} dryRun=${DRY_RUN}`,
    );
    await archiveAuditLogs(db, auditCutoff);
    await purgeEventOutbox(db, outboxCutoff);
    console.info("[retention] done.");
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error("[retention] failed", error);
  process.exit(1);
});
