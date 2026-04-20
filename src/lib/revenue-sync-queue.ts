import type { PrismaClient, Prisma } from "@prisma/client";
import { DateTime } from "luxon";
import { env } from "./env.js";
import { prisma } from "./prisma.js";
import { syncRevenueCaseForEncounter, syncRevenueCasesForScope } from "./revenue-cycle.js";
import { getRevenueDailyHistoryRollups, listDateKeys } from "./revenue-rollups.js";
import { clinicDateKeyFromDate, clinicDateKeyNow } from "./clinic-time.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

type RevenueSyncJob = {
  facilityId: string;
  clinicIds: Set<string>;
  fromDateKey: string;
  toDateKey: string;
  outboxIds: string[];
};

type RevenueSyncLogger = {
  error?: (error: unknown, message?: string) => void;
};

export type RevenueSyncWorkerStatus = {
  running: boolean;
  pendingCount: number;
  lastSuccessfulDrainAt: string | null;
  lastFailedDrainAt: string | null;
  lastError: string | null;
};

const DEFAULT_SYNC_INTERVAL_MS = 60_000;
const REVENUE_SYNC_TOPIC = "revenue.sync";
const REVENUE_SYNC_EVENT = "revenue.sync.requested";
let syncTimer: NodeJS.Timeout | null = null;
let activeDrain: Promise<void> | null = null;
let logger: RevenueSyncLogger | null = null;
let lastSuccessfulDrainAt: Date | null = null;
let lastFailedDrainAt: Date | null = null;
let lastError: string | null = null;

function normalizeDateKey(value: string | null | undefined, timezone?: string | null) {
  const trimmed = (value || "").trim();
  if (trimmed) return trimmed;
  return clinicDateKeyNow(timezone);
}

function mergeDateRange(existing: RevenueSyncJob, incoming: RevenueSyncJob) {
  existing.fromDateKey = existing.fromDateKey <= incoming.fromDateKey ? existing.fromDateKey : incoming.fromDateKey;
  existing.toDateKey = existing.toDateKey >= incoming.toDateKey ? existing.toDateKey : incoming.toDateKey;
  incoming.clinicIds.forEach((clinicId) => existing.clinicIds.add(clinicId));
  existing.outboxIds.push(...incoming.outboxIds);
}

function logSyncError(error: unknown, message: string) {
  lastFailedDrainAt = new Date();
  lastError = error instanceof Error ? error.message : String(error);
  if (logger?.error) {
    logger.error(error, message);
    return;
  }
  console.error(message, error);
}

async function recomputePersistedRollups(db: PrismaClient, job: RevenueSyncJob) {
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

function parseJobPayload(payload: Prisma.JsonValue | null | undefined): RevenueSyncJob | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  const facilityId = typeof value.facilityId === "string" ? value.facilityId.trim() : "";
  const clinicIds = Array.isArray(value.clinicIds)
    ? value.clinicIds.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  const fromDateKey = typeof value.fromDateKey === "string" ? value.fromDateKey.trim() : "";
  const toDateKey = typeof value.toDateKey === "string" ? value.toDateKey.trim() : "";
  if (!facilityId || clinicIds.length === 0 || !fromDateKey || !toDateKey) return null;
  return {
    facilityId,
    clinicIds: new Set(clinicIds),
    fromDateKey,
    toDateKey,
    outboxIds: [],
  };
}

export async function queueRevenueScopeSync(
  db: DbClient,
  input: {
    facilityId: string | null | undefined;
    clinicIds: string[];
    fromDateKey?: string | null;
    toDateKey?: string | null;
    timezone?: string | null;
    requestId?: string | null;
  },
) {
  const facilityId = (input.facilityId || "").trim();
  if (!facilityId) return;
  const clinicIds = input.clinicIds.filter((value) => value && value.trim().length > 0);
  if (clinicIds.length === 0) return;

  await db.eventOutbox.create({
    data: {
      topic: REVENUE_SYNC_TOPIC,
      eventType: REVENUE_SYNC_EVENT,
      aggregateType: "Facility",
      aggregateId: facilityId,
      requestId: input.requestId || null,
      payloadJson: {
        facilityId,
        clinicIds,
        fromDateKey: normalizeDateKey(input.fromDateKey, input.timezone),
        toDateKey: normalizeDateKey(input.toDateKey || input.fromDateKey, input.timezone),
      } as Prisma.InputJsonValue,
    },
  });
}

export async function queueRevenueEncounterSync(db: DbClient, encounterId: string, requestId?: string | null) {
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

  const dateKey = clinicDateKeyFromDate(encounter.dateOfService, encounter.clinic.timezone || "America/New_York");

  if (env.NODE_ENV === "test") {
    await syncRevenueCaseForEncounter(db, encounterId);
    if (encounter.clinicId) {
      await recomputePersistedRollups(prisma, {
        facilityId: encounter.clinic.facilityId,
        clinicIds: new Set([encounter.clinicId]),
        fromDateKey: dateKey,
        toDateKey: dateKey,
        outboxIds: [],
      });
    }
    return;
  }

  await queueRevenueScopeSync(db, {
    facilityId: encounter.clinic.facilityId,
    clinicIds: [encounter.clinicId],
    fromDateKey: dateKey,
    toDateKey: dateKey,
    timezone: encounter.clinic.timezone,
    requestId,
  });
}

async function loadPendingJobs(db: PrismaClient) {
  const rows = await db.eventOutbox.findMany({
    where: {
      topic: REVENUE_SYNC_TOPIC,
      eventType: REVENUE_SYNC_EVENT,
      status: "pending",
    },
    orderBy: { createdAt: "asc" },
    take: 500,
  });

  const jobsByFacility = new Map<string, RevenueSyncJob>();
  for (const row of rows) {
    const parsed = parseJobPayload(row.payloadJson);
    if (!parsed) {
      await db.eventOutbox.update({
        where: { id: row.id },
        data: {
          status: "failed",
          attempts: { increment: 1 },
          lastError: "Malformed revenue sync payload",
        },
      });
      continue;
    }
    parsed.outboxIds.push(row.id);
    const existing = jobsByFacility.get(parsed.facilityId);
    if (existing) {
      mergeDateRange(existing, parsed);
      continue;
    }
    jobsByFacility.set(parsed.facilityId, parsed);
  }

  return [...jobsByFacility.values()];
}

export async function flushRevenueSyncQueue(db: PrismaClient = prisma) {
  if (activeDrain) return activeDrain;

  activeDrain = (async () => {
    const jobs = await loadPendingJobs(db);
    for (const job of jobs) {
      try {
        await processSyncJob(db, job);
        await db.eventOutbox.updateMany({
          where: { id: { in: job.outboxIds } },
          data: {
            status: "dispatched",
            dispatchedAt: new Date(),
            lastError: null,
          },
        });
        lastSuccessfulDrainAt = new Date();
        lastError = null;
      } catch (error) {
        await db.eventOutbox.updateMany({
          where: { id: { in: job.outboxIds } },
          data: {
            attempts: { increment: 1 },
            lastError: error instanceof Error ? error.message : String(error),
          },
        });
        logSyncError(error, `Failed to process revenue sync job for facility ${job.facilityId}`);
      }
    }
  })().finally(() => {
    activeDrain = null;
  });

  return activeDrain;
}

export async function getRevenueSyncWorkerStatus(db: PrismaClient = prisma): Promise<RevenueSyncWorkerStatus> {
  const pendingCount = await db.eventOutbox.count({
    where: {
      topic: REVENUE_SYNC_TOPIC,
      eventType: REVENUE_SYNC_EVENT,
      status: "pending",
    },
  });

  return {
    running: Boolean(activeDrain || syncTimer),
    pendingCount,
    lastSuccessfulDrainAt: lastSuccessfulDrainAt?.toISOString() || null,
    lastFailedDrainAt: lastFailedDrainAt?.toISOString() || null,
    lastError,
  };
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

export async function clearRevenueSyncQueueForTests(db: PrismaClient = prisma) {
  await db.eventOutbox.deleteMany({
    where: {
      topic: REVENUE_SYNC_TOPIC,
      eventType: REVENUE_SYNC_EVENT,
    },
  });
}
