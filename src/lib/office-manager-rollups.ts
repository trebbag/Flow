import {
  AlertLevel,
  EncounterStatus,
  type OfficeManagerDailyRollup,
  type Prisma,
  type PrismaClient
} from "@prisma/client";
import { DateTime } from "luxon";
import { normalizeDate } from "./dates.js";
import { formatProviderDisplayName } from "./display-names.js";
import { ApiError } from "./errors.js";

export const MAX_HISTORY_DAYS = 31;

const encounterStatuses = Object.values(EncounterStatus);
const alertLevels = Object.values(AlertLevel);
const activeStatuses: EncounterStatus[] = [
  EncounterStatus.Lobby,
  EncounterStatus.Rooming,
  EncounterStatus.ReadyForProvider,
  EncounterStatus.Optimizing,
  EncounterStatus.CheckOut
];

export type ScopedClinic = { id: string; timezone: string };

type StageTotals = { count: number; totalMinutes: number };

export type ProviderRollupRaw = {
  providerName: string;
  encounterCount: number;
  activeCount: number;
  completedCount: number;
  stageTotals: Record<string, StageTotals>;
};

export type DailyClinicRollupRaw = {
  clinicId: string;
  dateKey: string;
  queueByStatus: Record<EncounterStatus, number>;
  alertsByLevel: Record<AlertLevel, number>;
  encounterCount: number;
  lobbyWaitTotalMins: number;
  lobbyWaitSamples: number;
  roomingWaitTotalMins: number;
  roomingWaitSamples: number;
  providerVisitTotalMins: number;
  providerVisitSamples: number;
  stageRollups: Array<{ status: EncounterStatus; count: number; totalMinutes: number }>;
  providerRollups: ProviderRollupRaw[];
};

export type DailyHistoryRollupView = {
  date: string;
  queueByStatus: Record<EncounterStatus, number>;
  alertsByLevel: Record<AlertLevel, number>;
  encounterCount: number;
  avgLobbyWaitMins: number;
  avgRoomingWaitMins: number;
  avgProviderVisitMins: number;
  stageRollups: Array<{ status: EncounterStatus; count: number; avgMinutes: number }>;
  providerRollups: Array<{
    providerName: string;
    encounterCount: number;
    activeCount: number;
    completedCount: number;
    stageAverages: Record<string, number>;
  }>;
};

function emptyStatusMap() {
  return Object.fromEntries(encounterStatuses.map((status) => [status, 0])) as Record<EncounterStatus, number>;
}

function emptyAlertMap() {
  return Object.fromEntries(alertLevels.map((level) => [level, 0])) as Record<AlertLevel, number>;
}

function averageMinutes(total: number, samples: number) {
  if (samples <= 0) return 0;
  return Math.round(total / samples);
}

function asRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: Prisma.JsonValue | null | undefined): unknown[] {
  if (!Array.isArray(value)) return [];
  return value as unknown[];
}

function readNumber(value: unknown) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function parseStatusMap(value: Prisma.JsonValue | null | undefined) {
  const map = emptyStatusMap();
  const raw = asRecord(value);
  if (!raw) return map;
  encounterStatuses.forEach((status) => {
    map[status] = readNumber(raw[status]);
  });
  return map;
}

function parseAlertMap(value: Prisma.JsonValue | null | undefined) {
  const map = emptyAlertMap();
  const raw = asRecord(value);
  if (!raw) return map;
  alertLevels.forEach((level) => {
    map[level] = readNumber(raw[level]);
  });
  return map;
}

function parseStageRollups(value: Prisma.JsonValue | null | undefined) {
  const byStatus = new Map<EncounterStatus, StageTotals>();
  encounterStatuses.forEach((status) => {
    byStatus.set(status, { count: 0, totalMinutes: 0 });
  });

  asArray(value).forEach((entry) => {
    const row = entry as Record<string, unknown>;
    const status = row.status as EncounterStatus;
    if (!encounterStatuses.includes(status)) return;
    byStatus.set(status, {
      count: readNumber(row.count),
      totalMinutes: readNumber(row.totalMinutes)
    });
  });

  return encounterStatuses.map((status) => {
    const totals = byStatus.get(status) || { count: 0, totalMinutes: 0 };
    return {
      status,
      count: totals.count,
      totalMinutes: totals.totalMinutes
    };
  });
}

function parseProviderRollups(value: Prisma.JsonValue | null | undefined): ProviderRollupRaw[] {
  const parsed: ProviderRollupRaw[] = [];

  asArray(value).forEach((entry) => {
    const row = entry as Record<string, unknown>;
    const providerName = String(row.providerName || "").trim() || "Unassigned";
    const stageTotalsRaw = asRecord((row.stageTotals || {}) as Prisma.JsonValue) || {};
    const stageTotals: Record<string, StageTotals> = {};

    Object.entries(stageTotalsRaw).forEach(([stage, totals]) => {
      const detail = (totals || {}) as Record<string, unknown>;
      stageTotals[stage] = {
        count: readNumber(detail.count),
        totalMinutes: readNumber(detail.totalMinutes)
      };
    });

    parsed.push({
      providerName,
      encounterCount: readNumber(row.encounterCount),
      activeCount: readNumber(row.activeCount),
      completedCount: readNumber(row.completedCount),
      stageTotals
    });
  });

  return parsed;
}

function buildReferenceNowMillis(dateKey: string) {
  const todayKey = DateTime.utc().toISODate();
  if (dateKey === todayKey) {
    return Date.now();
  }
  return DateTime.fromISO(dateKey, { zone: "utc" }).endOf("day").toMillis();
}

function computeMinutesInStage(
  encounter: {
    currentStatus: EncounterStatus;
    checkInAt: Date | null;
    roomingStartAt: Date | null;
    providerStartAt: Date | null;
    providerEndAt: Date | null;
  },
  referenceNowMillis: number
) {
  if (encounter.currentStatus === EncounterStatus.Lobby && encounter.checkInAt) {
    return Math.max(0, Math.round((referenceNowMillis - encounter.checkInAt.getTime()) / 60000));
  }

  if (encounter.currentStatus === EncounterStatus.Rooming && encounter.roomingStartAt) {
    return Math.max(0, Math.round((referenceNowMillis - encounter.roomingStartAt.getTime()) / 60000));
  }

  if (
    encounter.currentStatus === EncounterStatus.ReadyForProvider &&
    encounter.roomingStartAt &&
    encounter.providerStartAt
  ) {
    return Math.max(
      0,
      Math.round((encounter.providerStartAt.getTime() - encounter.roomingStartAt.getTime()) / 60000)
    );
  }

  if (encounter.currentStatus === EncounterStatus.Optimizing && encounter.providerStartAt) {
    return Math.max(0, Math.round((referenceNowMillis - encounter.providerStartAt.getTime()) / 60000));
  }

  if (encounter.currentStatus === EncounterStatus.CheckOut && encounter.providerEndAt) {
    return Math.max(0, Math.round((referenceNowMillis - encounter.providerEndAt.getTime()) / 60000));
  }

  if (encounter.providerStartAt && encounter.providerEndAt) {
    return Math.max(
      0,
      Math.round((encounter.providerEndAt.getTime() - encounter.providerStartAt.getTime()) / 60000)
    );
  }

  return 0;
}

export function listDateKeys(fromDate: string, toDate: string, maxDays = MAX_HISTORY_DAYS) {
  const start = DateTime.fromISO(fromDate, { zone: "utc" }).startOf("day");
  const end = DateTime.fromISO(toDate, { zone: "utc" }).startOf("day");

  if (!start.isValid || !end.isValid || start > end) {
    throw new ApiError({
      statusCode: 400,
      code: "INVALID_DATE_RANGE",
      message: "Invalid date range",
    });
  }

  const days = end.diff(start, "days").days;
  if (days > maxDays) {
    throw new ApiError({
      statusCode: 400,
      code: "DATE_RANGE_TOO_LARGE",
      message: `Date range cannot exceed ${maxDays} days`,
    });
  }

  const keys: string[] = [];
  let cursor = start;
  while (cursor <= end) {
    keys.push(cursor.toISODate() || cursor.toFormat("yyyy-MM-dd"));
    cursor = cursor.plus({ days: 1 });
  }
  return keys;
}

export async function computeDailyClinicRollup(
  prisma: PrismaClient,
  clinic: ScopedClinic,
  dateKey: string
): Promise<DailyClinicRollupRaw> {
  const dateOfService = normalizeDate(dateKey, clinic.timezone);
  const referenceNowMillis = buildReferenceNowMillis(dateKey);

  const [statusCounts, alerts, encounters] = await Promise.all([
    prisma.encounter.groupBy({
      by: ["currentStatus"],
      where: { clinicId: clinic.id, dateOfService },
      _count: { _all: true }
    }),
    prisma.alertState.groupBy({
      by: ["currentAlertLevel"],
      where: { encounter: { clinicId: clinic.id, dateOfService } },
      _count: { _all: true }
    }),
    prisma.encounter.findMany({
      where: { clinicId: clinic.id, dateOfService },
      select: {
        currentStatus: true,
        checkInAt: true,
        roomingStartAt: true,
        providerStartAt: true,
        providerEndAt: true,
        provider: {
          select: { name: true, active: true }
        }
      }
    })
  ]);

  const queueByStatus = emptyStatusMap();
  statusCounts.forEach((row) => {
    queueByStatus[row.currentStatus] = row._count._all;
  });

  const alertsByLevel = emptyAlertMap();
  alerts.forEach((row) => {
    alertsByLevel[row.currentAlertLevel] = row._count._all;
  });

  let lobbyWaitTotalMins = 0;
  let lobbyWaitSamples = 0;
  let roomingWaitTotalMins = 0;
  let roomingWaitSamples = 0;
  let providerVisitTotalMins = 0;
  let providerVisitSamples = 0;

  const stageAccumulator = new Map<EncounterStatus, StageTotals>();
  encounterStatuses.forEach((status) => stageAccumulator.set(status, { count: 0, totalMinutes: 0 }));

  const providerAccumulator = new Map<
    string,
    {
      encounterCount: number;
      activeCount: number;
      completedCount: number;
      stageTotals: Record<string, StageTotals>;
    }
  >();

  encounters.forEach((encounter) => {
    if (encounter.currentStatus === EncounterStatus.Lobby && encounter.checkInAt) {
      lobbyWaitTotalMins += Math.max(
        0,
        Math.round((referenceNowMillis - encounter.checkInAt.getTime()) / 60000)
      );
      lobbyWaitSamples += 1;
    }

    if (encounter.roomingStartAt && !encounter.providerStartAt) {
      roomingWaitTotalMins += Math.max(
        0,
        Math.round((referenceNowMillis - encounter.roomingStartAt.getTime()) / 60000)
      );
      roomingWaitSamples += 1;
    }

    if (encounter.providerStartAt && encounter.providerEndAt) {
      providerVisitTotalMins += Math.max(
        0,
        Math.round((encounter.providerEndAt.getTime() - encounter.providerStartAt.getTime()) / 60000)
      );
      providerVisitSamples += 1;
    }

    const providerName = formatProviderDisplayName(encounter.provider);
    if (!providerAccumulator.has(providerName)) {
      providerAccumulator.set(providerName, {
        encounterCount: 0,
        activeCount: 0,
        completedCount: 0,
        stageTotals: {}
      });
    }

    const provider = providerAccumulator.get(providerName)!;
    provider.encounterCount += 1;
    if (activeStatuses.includes(encounter.currentStatus)) {
      provider.activeCount += 1;
    }
    if (encounter.currentStatus === EncounterStatus.Optimized) {
      provider.completedCount += 1;
    }

    const minutesInStage = computeMinutesInStage(encounter, referenceNowMillis);
    const stageTotals = stageAccumulator.get(encounter.currentStatus) || { count: 0, totalMinutes: 0 };
    stageTotals.count += 1;
    stageTotals.totalMinutes += minutesInStage;
    stageAccumulator.set(encounter.currentStatus, stageTotals);

    if (!provider.stageTotals[encounter.currentStatus]) {
      provider.stageTotals[encounter.currentStatus] = { count: 0, totalMinutes: 0 };
    }
    provider.stageTotals[encounter.currentStatus]!.count += 1;
    provider.stageTotals[encounter.currentStatus]!.totalMinutes += minutesInStage;
  });

  const stageRollups = encounterStatuses.map((status) => {
    const totals = stageAccumulator.get(status) || { count: 0, totalMinutes: 0 };
    return {
      status,
      count: totals.count,
      totalMinutes: totals.totalMinutes
    };
  });

  const providerRollups = Array.from(providerAccumulator.entries())
    .map(([providerName, totals]) => ({
      providerName,
      encounterCount: totals.encounterCount,
      activeCount: totals.activeCount,
      completedCount: totals.completedCount,
      stageTotals: totals.stageTotals
    }))
    .sort((a, b) => b.encounterCount - a.encounterCount || a.providerName.localeCompare(b.providerName));

  return {
    clinicId: clinic.id,
    dateKey,
    queueByStatus,
    alertsByLevel,
    encounterCount: encounters.length,
    lobbyWaitTotalMins,
    lobbyWaitSamples,
    roomingWaitTotalMins,
    roomingWaitSamples,
    providerVisitTotalMins,
    providerVisitSamples,
    stageRollups,
    providerRollups
  };
}

export async function upsertDailyClinicRollup(prisma: PrismaClient, rollup: DailyClinicRollupRaw) {
  await prisma.officeManagerDailyRollup.upsert({
    where: {
      clinicId_dateKey: {
        clinicId: rollup.clinicId,
        dateKey: rollup.dateKey
      }
    },
    create: {
      clinicId: rollup.clinicId,
      dateKey: rollup.dateKey,
      queueByStatus: rollup.queueByStatus,
      alertsByLevel: rollup.alertsByLevel,
      encounterCount: rollup.encounterCount,
      lobbyWaitTotalMins: rollup.lobbyWaitTotalMins,
      lobbyWaitSamples: rollup.lobbyWaitSamples,
      roomingWaitTotalMins: rollup.roomingWaitTotalMins,
      roomingWaitSamples: rollup.roomingWaitSamples,
      providerVisitTotalMins: rollup.providerVisitTotalMins,
      providerVisitSamples: rollup.providerVisitSamples,
      stageRollupsJson: rollup.stageRollups,
      providerRollupsJson: rollup.providerRollups
    },
    update: {
      queueByStatus: rollup.queueByStatus,
      alertsByLevel: rollup.alertsByLevel,
      encounterCount: rollup.encounterCount,
      lobbyWaitTotalMins: rollup.lobbyWaitTotalMins,
      lobbyWaitSamples: rollup.lobbyWaitSamples,
      roomingWaitTotalMins: rollup.roomingWaitTotalMins,
      roomingWaitSamples: rollup.roomingWaitSamples,
      providerVisitTotalMins: rollup.providerVisitTotalMins,
      providerVisitSamples: rollup.providerVisitSamples,
      stageRollupsJson: rollup.stageRollups,
      providerRollupsJson: rollup.providerRollups,
      computedAt: new Date()
    }
  });
}

function parseStoredRollup(row: OfficeManagerDailyRollup): DailyClinicRollupRaw {
  return {
    clinicId: row.clinicId,
    dateKey: row.dateKey,
    queueByStatus: parseStatusMap(row.queueByStatus),
    alertsByLevel: parseAlertMap(row.alertsByLevel),
    encounterCount: row.encounterCount,
    lobbyWaitTotalMins: row.lobbyWaitTotalMins,
    lobbyWaitSamples: row.lobbyWaitSamples,
    roomingWaitTotalMins: row.roomingWaitTotalMins,
    roomingWaitSamples: row.roomingWaitSamples,
    providerVisitTotalMins: row.providerVisitTotalMins,
    providerVisitSamples: row.providerVisitSamples,
    stageRollups: parseStageRollups(row.stageRollupsJson),
    providerRollups: parseProviderRollups(row.providerRollupsJson)
  };
}

function mergeDailyClinicRollups(dateKey: string, rows: DailyClinicRollupRaw[]): DailyHistoryRollupView {
  const queueByStatus = emptyStatusMap();
  const alertsByLevel = emptyAlertMap();
  let encounterCount = 0;
  let lobbyWaitTotalMins = 0;
  let lobbyWaitSamples = 0;
  let roomingWaitTotalMins = 0;
  let roomingWaitSamples = 0;
  let providerVisitTotalMins = 0;
  let providerVisitSamples = 0;

  const stageAccumulator = new Map<EncounterStatus, StageTotals>();
  encounterStatuses.forEach((status) => stageAccumulator.set(status, { count: 0, totalMinutes: 0 }));

  const providerAccumulator = new Map<
    string,
    {
      encounterCount: number;
      activeCount: number;
      completedCount: number;
      stageTotals: Record<string, StageTotals>;
    }
  >();

  rows.forEach((row) => {
    encounterStatuses.forEach((status) => {
      queueByStatus[status] += row.queueByStatus[status] || 0;
    });
    alertLevels.forEach((level) => {
      alertsByLevel[level] += row.alertsByLevel[level] || 0;
    });

    encounterCount += row.encounterCount;
    lobbyWaitTotalMins += row.lobbyWaitTotalMins;
    lobbyWaitSamples += row.lobbyWaitSamples;
    roomingWaitTotalMins += row.roomingWaitTotalMins;
    roomingWaitSamples += row.roomingWaitSamples;
    providerVisitTotalMins += row.providerVisitTotalMins;
    providerVisitSamples += row.providerVisitSamples;

    row.stageRollups.forEach((stage) => {
      const totals = stageAccumulator.get(stage.status) || { count: 0, totalMinutes: 0 };
      totals.count += stage.count;
      totals.totalMinutes += stage.totalMinutes;
      stageAccumulator.set(stage.status, totals);
    });

    row.providerRollups.forEach((provider) => {
      if (!providerAccumulator.has(provider.providerName)) {
        providerAccumulator.set(provider.providerName, {
          encounterCount: 0,
          activeCount: 0,
          completedCount: 0,
          stageTotals: {}
        });
      }
      const totals = providerAccumulator.get(provider.providerName)!;
      totals.encounterCount += provider.encounterCount;
      totals.activeCount += provider.activeCount;
      totals.completedCount += provider.completedCount;
      Object.entries(provider.stageTotals || {}).forEach(([stage, detail]) => {
        if (!totals.stageTotals[stage]) {
          totals.stageTotals[stage] = { count: 0, totalMinutes: 0 };
        }
        totals.stageTotals[stage]!.count += detail.count;
        totals.stageTotals[stage]!.totalMinutes += detail.totalMinutes;
      });
    });
  });

  const stageRollups = encounterStatuses.map((status) => {
    const totals = stageAccumulator.get(status) || { count: 0, totalMinutes: 0 };
    return {
      status,
      count: totals.count,
      avgMinutes: averageMinutes(totals.totalMinutes, totals.count)
    };
  });

  const providerRollups = Array.from(providerAccumulator.entries())
    .map(([providerName, totals]) => ({
      providerName,
      encounterCount: totals.encounterCount,
      activeCount: totals.activeCount,
      completedCount: totals.completedCount,
      stageAverages: Object.fromEntries(
        Object.entries(totals.stageTotals).map(([stage, detail]) => [
          stage,
          averageMinutes(detail.totalMinutes, detail.count)
        ])
      )
    }))
    .sort((a, b) => b.encounterCount - a.encounterCount || a.providerName.localeCompare(b.providerName));

  return {
    date: dateKey,
    queueByStatus,
    alertsByLevel,
    encounterCount,
    avgLobbyWaitMins: averageMinutes(lobbyWaitTotalMins, lobbyWaitSamples),
    avgRoomingWaitMins: averageMinutes(roomingWaitTotalMins, roomingWaitSamples),
    avgProviderVisitMins: averageMinutes(providerVisitTotalMins, providerVisitSamples),
    stageRollups,
    providerRollups
  };
}

type DailyHistoryOptions = {
  persist?: boolean;
  forceRecompute?: boolean;
  cacheOnly?: boolean;
};

export async function getDailyHistoryRollups(
  prisma: PrismaClient,
  clinics: ScopedClinic[],
  dateKeys: string[],
  options: DailyHistoryOptions = {}
) {
  const persist = options.persist ?? true;
  const forceRecompute = options.forceRecompute ?? false;

  const byClinicDate = new Map<string, DailyClinicRollupRaw>();
  const buildKey = (clinicId: string, dateKey: string) => `${clinicId}::${dateKey}`;

  if (!forceRecompute) {
    const existing = await prisma.officeManagerDailyRollup.findMany({
      where: {
        clinicId: { in: clinics.map((clinic) => clinic.id) },
        dateKey: { in: dateKeys }
      }
    });
    existing.forEach((row) => {
      byClinicDate.set(buildKey(row.clinicId, row.dateKey), parseStoredRollup(row));
    });
  }

  if (!options.cacheOnly) {
    await Promise.all(
      dateKeys.flatMap((dateKey) =>
        clinics.map(async (clinic) => {
          const key = buildKey(clinic.id, dateKey);
          if (!forceRecompute && byClinicDate.has(key)) return;

          const computed = await computeDailyClinicRollup(prisma, clinic, dateKey);
          byClinicDate.set(key, computed);
          if (persist) {
            await upsertDailyClinicRollup(prisma, computed);
          }
        })
      )
    );
  }

  return dateKeys.map((dateKey) => {
    const rows = clinics.map((clinic) => byClinicDate.get(buildKey(clinic.id, dateKey))!).filter(Boolean);
    return mergeDailyClinicRollups(dateKey, rows);
  });
}
