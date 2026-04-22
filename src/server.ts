import { buildApp } from "./app.js";
import { env } from "./lib/env.js";
import { backfillCanonicalPatients } from "./lib/patients.js";
import { prisma } from "./lib/prisma.js";
import { startRevenueSyncWorker, stopRevenueSyncWorker } from "./lib/revenue-sync-queue.js";
import { assertStartupInvariants } from "./lib/startup-invariants.js";

assertStartupInvariants();

const app = buildApp();

async function start() {
  try {
    await backfillCanonicalPatients(prisma);
    startRevenueSyncWorker({
      db: prisma,
      logger: {
        error: (error, message) => app.log.error(error as Error, message),
      },
    });
    await app.listen({ port: env.PORT, host: env.HOST });
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
