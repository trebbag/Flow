import type { PrismaClient, Prisma } from "@prisma/client";
import { DateTime } from "luxon";
import { env } from "./env.js";
import { prisma } from "./prisma.js";
import { syncRevenueCaseForEncounter, syncRevenueCasesForScope } from "./revenue-cycle.js";
import { getRevenueDailyHistoryRollups, listDateKeys } from "./revenue-rollups.js";

type RevenueSyncJob = {
  facilityId: string;
  clinicIds: Set<string>;
  fromDateKey: string;
  toDateKey: string;
};

type RevenueSyncLogger = {
  error?: (error: unknown, message?: string) => void;
};

const DEFAULT_SYNC_INTERVAL_MS = 60_000;
const pendingJobsByFacility = new Map<string, RevenueSyncJob>();
let syncTimer: NodeJS.Timeout | null = null;
let activeDrain: Promise<void> | null = null;
let logger: RevenueSyncLogger | null = null;

function normalizeDateKey(value: string | null | undefined) {
  const trimmed = (value || "").trim();
  if (trimmed) return trimmed;
  return DateTime.now().toISODate() || new Date().toISOString().slice(0, 10);
}

function mergeDateRange(existing: RevenueSyncJob, incoming: RevenueSyncJob) {
  existing.fromDateKey = existing.fromDateKey <= incoming.fromDateKey ? existing.fromDateKey : incoming.fromDateKey;
  existing.toDateKey = existing.toDateKey >= incoming.toDateKey ? existing.toDateKey : incoming.toDateKey;
  incoming.clinicIds.forEach((clinicId) => existing.clinicIds.add(clinicId));
}

function logSyncError(error: unknown, message: string) {
  if (logger?.error) {
    logger.error(error, message);
    return;
  }
  console.error(message, error);
}

async function recomputePersistedRollups(
  db: PrismaClient,
  job: RevenueSyncJob,
) {
  const clinicIds = [...job.clinicIds];
  if (clinicIds.length === 0) return;
  const clinics = await db.clinic.findMany({
    where: { id: { in: clinicIds } },
    select: {
      id: true,
      name: true,
      timezone: true,
      facilityId: true,
    },
  });
  if (clinics.length === 0) return;
  const dateKeys = listDateKeys(job.fromDateKey, job.toDateKey);
  await getRevenueDailyHistoryRollups(db, clinics, dateKeys, {
    persist: true,
    forceRecompute: true,
  });
}

async function processSyncJob(db: PrismaClient, job: RevenueSyncJob) {
  await syncRevenueCasesForScope(db, {
    clinicIds: [...job.clinicIds],
    facilityId: job.facilityId,
    fromDateKey: job.fromDateKey,
    toDateKey: job.toDateKey,
  });
  await recomputePersistedRollups(db, job);
}

export function queueRevenueScopeSync(input: {
  facilityId: string | null | undefined;
  clinicIds: string[];
  fromDateKey?: string | null;
  toDateKey?: string | null;
}) {
  const facilityId = (input.facilityId || "").trim();
  if (!facilityId) return;
  const clinicIds = input.clinicIds.filter((value) => value && value.trim().length > 0);
  if (clinicIds.length === 0) return;

  const nextJob: RevenueSyncJob = {
    facilityId,
    clinicIds: new Set(clinicIds),
    fromDateKey: normalizeDateKey(input.fromDateKey),
    toDateKey: normalizeDateKey(input.toDateKey || input.fromDateKey),
  };

  const existing = pendingJobsByFacility.get(facilityId);
  if (existing) {
    mergeDateRange(existing, nextJob);
    return;
  }
  pendingJobsByFacility.set(facilityId, nextJob);
}

export async function queueRevenueEncounterSync(
  db: PrismaClient | Prisma.TransactionClient,
  encounterId: string,
) {
  const encounter = await db.encounter.findUnique({
    where: { id: encounterId },
    select: {
      id: true,
      clinicId: true,
      dateOfService: true,
      clinic: {
        select: {
          facilityId: true,
          timezone: true,
        },
      },
    },
  });
  if (!encounter?.clinic?.facilityId) return;

  const dateKey = DateTime.fromJSDate(encounter.dateOfService)
    .setZone(encounter.clinic.timezone || "America/New_York")
    .toISODate() || normalizeDateKey(null);

  if (env.NODE_ENV === "test") {
    await syncRevenueCaseForEncounter(db, encounterId);
    if (encounter.clinicId) {
      await recomputePersistedRollups(prisma, {
        facilityId: encounter.clinic.facilityId,
        clinicIds: new Set([encounter.clinicId]),
        fromDateKey: dateKey,
        toDateKey: dateKey,
      });
    }
    return;
  }

  queueRevenueScopeSync({
    facilityId: encounter.clinic.facilityId,
    clinicIds: [encounter.clinicId],
    fromDateKey: dateKey,
    toDateKey: dateKey,
  });
}

export async function flushRevenueSyncQueue(db: PrismaClient = prisma) {
  if (activeDrain) return activeDrain;

  activeDrain = (async () => {
    while (pendingJobsByFacility.size > 0) {
      const jobs = [...pendingJobsByFacility.values()];
      pendingJobsByFacility.clear();
      for (const job of jobs) {
        try {
          await processSyncJob(db, job);
        } catch (error) {
          logSyncError(error, `Failed to process revenue sync job for facility ${job.facilityId}`);
        }
      }
    }
  })().finally(() => {
    activeDrain = null;
  });

  return activeDrain;
}

export function startRevenueSyncWorker(options?: {
  db?: PrismaClient;
  intervalMs?: number;
  logger?: RevenueSyncLogger;
}) {
  if (env.NODE_ENV === "test") return;
  if (syncTimer) return;

  logger = options?.logger || null;
  const db = options?.db || prisma;
  const intervalMs = options?.intervalMs || DEFAULT_SYNC_INTERVAL_MS;
  syncTimer = setInterval(() => {
    void flushRevenueSyncQueue(db);
  }, intervalMs);
  syncTimer.unref?.();
}

export async function stopRevenueSyncWorker() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  await activeDrain;
}

export function clearRevenueSyncQueueForTests() {
  pendingJobsByFacility.clear();
}
