import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { getRevenueSyncWorkerStatus } from "../lib/revenue-sync-queue.js";

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health", async () => {
    return { status: "ok" };
  });

  app.get("/ready", async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      const revenueSyncWorker = await getRevenueSyncWorkerStatus(prisma);
      const degraded = revenueSyncWorker.lastError !== null;
      const payload = {
        status: degraded ? "degraded" : "ready",
        database: { status: "ok" },
        revenueSyncWorker,
      };
      reply.code(degraded ? 503 : 200);
      return payload;
    } catch (error) {
      reply.code(503);
      return {
        status: "not_ready",
        database: {
          status: "error",
          message: error instanceof Error ? error.message : "Database readiness check failed",
        },
        revenueSyncWorker: {
          running: false,
          pendingCount: 0,
          lastSuccessfulDrainAt: null,
          lastFailedDrainAt: null,
          lastError: null,
        },
      };
    }
  });
}
