import { buildApp } from "./app.js";
import { env } from "./lib/env.js";
import { backfillCanonicalPatients } from "./lib/patients.js";
import { prisma } from "./lib/prisma.js";
import { startRevenueSyncWorker, stopRevenueSyncWorker } from "./lib/revenue-sync-queue.js";
import { assertStartupInvariants } from "./lib/startup-invariants.js";

assertStartupInvariants();

const app = buildApp();

async function startBackgroundTasks() {
  try {
    startRevenueSyncWorker({
      db: prisma,
      logger: {
        error: (error, message) => app.log.error(error as Error, message),
      },
    });
  } catch (error) {
    app.log.error(error, "Revenue sync worker failed to start after startup");
  }

  if (process.env.FLOW_RUN_STARTUP_PATIENT_BACKFILL === "1") {
    try {
      await backfillCanonicalPatients(prisma);
    } catch (error) {
      app.log.error(error, "Canonical patient backfill failed after startup");
    }
  }
}

async function start() {
  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    void startBackgroundTasks();
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

start();

process.on("SIGTERM", async () => {
  await stopRevenueSyncWorker();
  await prisma.$disconnect();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await stopRevenueSyncWorker();
  await prisma.$disconnect();
  process.exit(0);
});
