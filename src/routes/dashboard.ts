import type { FastifyInstance } from "fastify";
import { AlertLevel, EncounterStatus, ProviderClarificationStatus, RoleName, TaskStatus, type Prisma } from "@prisma/client";
import { DateTime } from "luxon";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ApiError } from "../lib/errors.js";
import { normalizeDate } from "../lib/dates.js";
import { requireRoles } from "../lib/auth.js";
import { enterFacilityScope } from "../lib/facility-scope.js";
import { getDailyHistoryRollups, listDateKeys } from "../lib/office-manager-rollups.js";
import { getRoomDailyHistoryRollups } from "../lib/room-rollups.js";
import { refreshEncounterAlertStates } from "../lib/alert-engine.js";
import { getRevenueDailyHistoryRollups } from "../lib/revenue-rollups.js";
import { buildRevenueExpectationSummary, getRevenueSettings } from "../lib/revenue-cycle.js";
import { clinicDateKeyNow, clinicUtcDayRangeFromDateKey } from "../lib/clinic-time.js";

const dashboardQuerySchema = z.object({
  clinicId: z.string().uuid().optional(),
  date: z.string().optional()
});

const dashboardHistoryQuerySchema = z.object({
  clinicId: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  recompute: z.string().optional()
});

type ScopedClinic = { id: string; timezone: string; facilityId?: string | null };

async function resolveClinicsInScope(user: { clinicId: string | null; facilityId: string | null }, requestedClinicId?: string) {
  if (user.facilityId) {
    enterFacilityScope(user.facilityId);
  }

  if (requestedClinicId) {
    const clinic = await prisma.clinic.findUnique({
      where: { id: requestedClinicId },
      select: { id: true, timezone: true, facilityId: true }
    });

    if (!clinic) {
      throw new ApiError(404, "Clinic not found");
    }

    if (user.clinicId && clinic.id !== user.clinicId) {
      throw new ApiError(403, "Clinic is outside your assigned scope");
    }

    if (user.facilityId && clinic.facilityId !== user.facilityId) {
      throw new ApiError(403, "Clinic is outside your facility scope");
    }

    enterFacilityScope(clinic.facilityId || user.facilityId || null);
    return [clinic] as ScopedClinic[];
  }

  if (user.clinicId) {
    const clinic = await prisma.clinic.findUnique({
      where: { id: user.clinicId },
      select: { id: true, timezone: true, facilityId: true }
    });
    if (!clinic) {
      throw new ApiError(404, "Assigned clinic not found");
    }
    enterFacilityScope(clinic.facilityId || user.facilityId || null);
    return [clinic] as ScopedClinic[];
  }

  const clinics = await prisma.clinic.findMany({
    where: {
      facilityId: user.facilityId || undefined
    },
    select: { id: true, timezone: true, facilityId: true },
    orderBy: { id: "asc" }
  });

  if (clinics.length === 0) {
    throw new ApiError(404, "No clinics are available in scope");
  }
  enterFacilityScope(clinics[0]?.facilityId || user.facilityId || null);

  return clinics;
}

async function resolveEncounterMatchers(
  user: { clinicId: string | null; facilityId: string | null },
  requestedClinicId?: string,
  requestedDate?: string
) {
  const clinics = await resolveClinicsInScope(user, requestedClinicId);
  const effectiveDate = (requestedDate || DateTime.now().toISODate() || "").trim();
  if (!effectiveDate) {
    throw new ApiError(400, "Date is required");
  }

  return clinics.map((clinic) => ({
    clinicId: clinic.id,
    dateOfService: normalizeDate(effectiveDate, clinic.timezone)
  }));
}

function averageMinutes(values: number[]) {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function readNumber(value: unknown) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function accumulateRecord(target: Record<string, number>, source: Record<string, number> | null | undefined) {
  Object.entries(source || {}).forEach(([key, value]) => {
    target[key] = (target[key] || 0) + readNumber(value);
  });
}

function topEntries(value: Record<string, number> | null | undefined, limit = 8) {
  return Object.entries(value || {})
    .map(([label, count]) => ({ label, count: readNumber(count) }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

function queryBoolean(value: string | undefined, defaultValue = false) {
  if (value === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function dateRangeBounds(fromDate: string, toDate: string, timezone: string) {
  const start = clinicUtcDayRangeFromDateKey(fromDate, timezone).start;
  const end = clinicUtcDayRangeFromDateKey(toDate, timezone).end;
  return {
    start,
    end,
  };
}

export async function registerDashboardRoutes(app: FastifyInstance) {
  const officeGuard = requireRoles(
    RoleName.FrontDeskCheckIn,
    RoleName.MA,
    RoleName.Clinician,
    RoleName.FrontDeskCheckOut,
    RoleName.OfficeManager,
    RoleName.Admin
  );
  const ownerAnalyticsGuard = requireRoles(RoleName.OfficeManager, RoleName.Admin);

  app.get("/dashboard/office-manager", { preHandler: officeGuard }, async (request) => {
    const query = dashboardQuerySchema.parse(request.query);
    const matchers = await resolveEncounterMatchers(request.user!, query.clinicId, query.date);

    const statusCounts = await prisma.encounter.groupBy({
      by: ["currentStatus"],
      where: { OR: matchers },
      _count: { _all: true }
    });
    const alerts = await prisma.alertState.groupBy({
      by: ["currentAlertLevel"],
      where: { encounter: { OR: matchers } },
      _count: { _all: true }
    });
    const activeSafetyCount = await prisma.safetyEvent.count({
      where: {
        resolvedAt: null,
        encounter: { OR: matchers }
      }
    });
    const openTaskCount = await prisma.task.count({
      where: {
        status: { not: TaskStatus.completed },
        encounter: { OR: matchers }
      }
    });
    const encounters = await prisma.encounter.findMany({
      where: { OR: matchers },
      select: {
        currentStatus: true,
        checkInAt: true,
        roomingStartAt: true,
        providerStartAt: true,
        providerEndAt: true,
        checkoutCompleteAt: true
      }
    });

    const statusMap = Object.fromEntries(
      Object.values(EncounterStatus).map((status) => [
        status,
        statusCounts.find((row) => row.currentStatus === status)?._count._all || 0
      ])
    );

    const alertMap = Object.fromEntries(
      Object.values(AlertLevel).map((severity) => [
        severity,
        alerts.find((row) => row.currentAlertLevel === severity)?._count._all || 0
      ])
    );

    const now = Date.now();
    const lobbyWaits = encounters
      .filter((encounter) => encounter.currentStatus === EncounterStatus.Lobby && encounter.checkInAt)
      .map((encounter) => Math.max(0, Math.round((now - encounter.checkInAt!.getTime()) / 60000)));

    const roomingWaits = encounters
      .filter((encounter) => encounter.roomingStartAt && !encounter.providerStartAt)
      .map((encounter) => Math.max(0, Math.round((now - encounter.roomingStartAt!.getTime()) / 60000)));

    const providerVisitMins = encounters
      .filter((encounter) => encounter.providerStartAt && encounter.providerEndAt)
      .map((encounter) => Math.max(0, Math.round((encounter.providerEndAt!.getTime() - encounter.providerStartAt!.getTime()) / 60000)));

    return {
      scope: {
        clinicId: query.clinicId || request.user!.clinicId,
        date: query.date || DateTime.now().toISODate()
      },
      queueByStatus: statusMap,
      alertsByLevel: alertMap,
      activeSafetyCount,
      openTaskCount,
      avgLobbyWaitMins: averageMinutes(lobbyWaits),
      avgRoomingWaitMins: averageMinutes(roomingWaits),
      avgProviderVisitMins: averageMinutes(providerVisitMins),
      inProgressCount:
        statusMap.Lobby + statusMap.Rooming + statusMap.ReadyForProvider + statusMap.Optimizing + statusMap.CheckOut
    };
  });

  app.get("/dashboard/office-manager/history", { preHandler: officeGuard }, async (request) => {
    const query = dashboardHistoryQuerySchema.parse(request.query);
    const clinics = await resolveClinicsInScope(request.user!, query.clinicId);
    await refreshEncounterAlertStates(prisma, {
      facilityId: request.user!.facilityId,
      clinicIds: clinics.map((clinic) => clinic.id)
    });
    const effectiveTo = (query.to || clinicDateKeyNow(clinics[0]?.timezone) || "").trim();
    if (!effectiveTo) {
      throw new ApiError(400, "to is required");
    }
    const effectiveFrom = (
      query.from || DateTime.fromISO(effectiveTo).minus({ days: 4 }).toISODate() || ""
    ).trim();
    if (!effectiveFrom) {
      throw new ApiError(400, "from is required");
    }

    let dateKeys: string[];
    try {
      dateKeys = listDateKeys(effectiveFrom, effectiveTo);
    } catch (error) {
      throw new ApiError(400, error instanceof Error ? error.message : "Invalid date range");
    }

    const daily = await getDailyHistoryRollups(prisma, clinics, dateKeys, {
      persist: true,
      forceRecompute: queryBoolean(query.recompute)
    });

    return {
      scope: {
        clinicId: query.clinicId || request.user!.clinicId,
        from: effectiveFrom,
        to: effectiveTo
      },
      daily
    };
  });

  app.get("/dashboard/rooms/history", { preHandler: officeGuard }, async (request) => {
    const query = dashboardHistoryQuerySchema.parse(request.query);
    const clinics = await resolveClinicsInScope(request.user!, query.clinicId);
    const effectiveTo = (query.to || clinicDateKeyNow(clinics[0]?.timezone) || "").trim();
    if (!effectiveTo) {
      throw new ApiError(400, "to is required");
    }
    const effectiveFrom = (
      query.from || DateTime.fromISO(effectiveTo).minus({ days: 4 }).toISODate() || ""
    ).trim();
    if (!effectiveFrom) {
      throw new ApiError(400, "from is required");
    }

    let dateKeys: string[];
    try {
      dateKeys = listDateKeys(effectiveFrom, effectiveTo);
    } catch (error) {
      throw new ApiError(400, error instanceof Error ? error.message : "Invalid date range");
    }

    const daily = await getRoomDailyHistoryRollups(prisma, clinics, dateKeys, {
      persist: true,
      forceRecompute: queryBoolean(query.recompute)
    });

    return {
      scope: {
        clinicId: query.clinicId || request.user!.clinicId,
        from: effectiveFrom,
        to: effectiveTo
      },
      daily
    };
  });

  app.get("/dashboard/owner-analytics", { preHandler: ownerAnalyticsGuard }, async (request) => {
    const query = dashboardHistoryQuerySchema.parse(request.query);
    const clinics = await resolveClinicsInScope(request.user!, query.clinicId);
    const forceRecompute = queryBoolean(query.recompute);
    if (forceRecompute) {
      await refreshEncounterAlertStates(prisma, {
        facilityId: request.user!.facilityId,
        clinicIds: clinics.map((clinic) => clinic.id),
      });
    }

    const effectiveTo = (query.to || clinicDateKeyNow(clinics[0]?.timezone) || "").trim();
    if (!effectiveTo) {
      throw new ApiError(400, "to is required");
    }
    const effectiveFrom = (
      query.from || DateTime.fromISO(effectiveTo).minus({ days: 6 }).toISODate() || ""
    ).trim();
    if (!effectiveFrom) {
      throw new ApiError(400, "from is required");
    }

    let dateKeys: string[];
    try {
      dateKeys = listDateKeys(effectiveFrom, effectiveTo);
    } catch (error) {
      throw new ApiError(400, error instanceof Error ? error.message : "Invalid date range");
    }

    const clinicIds = clinics.map((clinic) => clinic.id);
    const todayMatchers = clinics.map((clinic) => ({
      clinicId: clinic.id,
      dateOfService: normalizeDate(clinicDateKeyNow(clinic.timezone), clinic.timezone),
    }));
    const { start, end } = dateRangeBounds(effectiveFrom, effectiveTo, clinics[0]?.timezone || "America/New_York");
    const facilityId = request.user!.facilityId || clinics[0]?.facilityId || null;

    const useCachedRollupsOnly = !forceRecompute;
    const warnings: Array<{ section: string; message: string }> = [];

    const readSection = async <T>(name: string, work: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await work();
      } catch (error) {
        warnings.push({
          section: name,
          message: error instanceof Error ? error.message : `${name} could not be loaded`,
        });
        request.log.warn(
          {
            correlationId: request.correlationId || request.id,
            section: name,
            error: error instanceof Error ? error.message : String(error),
          },
          "Owner analytics section failed",
        );
        return fallback;
      }
    };

    const [
      officeDaily,
      roomDaily,
      revenueDaily,
      currentEncounters,
      rangeRevenueCases,
      activeSafetyCount,
      blockingTaskCount,
      settings,
    ] = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const db = tx as unknown as typeof prisma;
      return Promise.all([
        readSection("officeDaily", () => getDailyHistoryRollups(db, clinics, dateKeys, {
          persist: forceRecompute,
          forceRecompute,
          cacheOnly: useCachedRollupsOnly,
        }), []),
        readSection("roomDaily", () => getRoomDailyHistoryRollups(db, clinics, dateKeys, {
          persist: forceRecompute,
          forceRecompute,
          cacheOnly: useCachedRollupsOnly,
        }), []),
        readSection("revenueDaily", () => getRevenueDailyHistoryRollups(db, clinics, dateKeys, {
          persist: forceRecompute,
          forceRecompute,
          cacheOnly: useCachedRollupsOnly,
        }), []),
        readSection("currentEncounters", () => tx.encounter.findMany({
          where: { OR: todayMatchers },
          select: {
            id: true,
            currentStatus: true,
            checkInAt: true,
            providerStartAt: true,
            providerEndAt: true,
            checkoutCompleteAt: true,
            assignedMaUserId: true,
            provider: { select: { name: true } },
          },
        }), []),
        readSection("rangeRevenueCases", () => tx.revenueCase.findMany({
          where: {
            clinicId: { in: clinicIds },
            dateOfService: { gte: start, lt: end },
          },
          select: {
            currentBlockerCategory: true,
            currentBlockerText: true,
            dueAt: true,
            financialReadiness: {
              select: {
                primaryPayerName: true,
                financialClass: true,
              },
            },
            checkoutCollectionTracking: {
              select: {
                collectionOutcome: true,
              },
            },
            chargeCaptureRecord: {
              select: {
                documentationComplete: true,
                icd10CodesJson: true,
                procedureLinesJson: true,
                serviceCaptureItemsJson: true,
              },
            },
            providerClarifications: {
              where: { status: { not: ProviderClarificationStatus.Resolved } },
              select: { id: true },
            },
          },
        }), []),
        readSection("activeSafetyCount", () => tx.safetyEvent.count({
          where: {
            resolvedAt: null,
            encounter: { OR: todayMatchers },
          },
        }), 0),
        readSection("blockingTaskCount", () => tx.task.count({
          where: {
            blocking: true,
            status: { not: TaskStatus.completed },
            encounter: { OR: todayMatchers },
          },
        }), 0),
        facilityId ? readSection("revenueSettings", () => getRevenueSettings(tx, facilityId), null) : Promise.resolve(null),
      ]);
    });

    const latestOffice = officeDaily[officeDaily.length - 1] || null;
    const latestRoom = roomDaily[roomDaily.length - 1] || null;
    const latestRevenue = revenueDaily[revenueDaily.length - 1] || null;
    const maUserIds = Array.from(
      new Set(currentEncounters.map((encounter) => encounter.assignedMaUserId).filter((value): value is string => Boolean(value))),
    );
    const maUsers = maUserIds.length
      ? await prisma.user.findMany({
          where: { id: { in: maUserIds } },
          select: { id: true, name: true },
        })
      : [];
    const maById = new Map(maUsers.map((row) => [row.id, row.name]));

    const avgCycleTimeMins =
      officeDaily.length > 0
        ? Math.round(
            officeDaily.reduce(
              (sum, day) => sum + day.avgLobbyWaitMins + day.avgRoomingWaitMins + day.avgProviderVisitMins,
              0,
            ) / officeDaily.length,
          )
        : 0;

    const throughputDaily = officeDaily.map((day, index) => ({
      dateKey: day.date,
      encounterCount: day.encounterCount,
      avgCycleTimeMins: day.avgLobbyWaitMins + day.avgRoomingWaitMins + day.avgProviderVisitMins,
      inProgressCount:
        readNumber(day.queueByStatus.Lobby) +
        readNumber(day.queueByStatus.Rooming) +
        readNumber(day.queueByStatus.ReadyForProvider) +
        readNumber(day.queueByStatus.Optimizing) +
        readNumber(day.queueByStatus.CheckOut),
      rolledCount: readNumber(revenueDaily[index]?.rolledCount),
    }));

    const revenueDailySeries = revenueDaily.map((day) => ({
      dateKey: day.date,
      expectedGrossChargeCents: day.expectedGrossChargeCents,
      expectedNetReimbursementCents: day.expectedNetReimbursementCents,
      sameDayCollectionExpectedCents: day.sameDayCollectionExpectedCents,
      sameDayCollectionTrackedCents: day.sameDayCollectionTrackedCents,
      sameDayCollectionVisitRate: day.sameDayCollectionVisitRate,
      sameDayCollectionDollarRate: day.sameDayCollectionDollarRate,
    }));

    const missedCollectionReasons: Record<string, number> = {};
    const collectionOutcomes: Record<string, number> = {};
    const rolloverReasons: Record<string, number> = {};
    revenueDaily.forEach((day) => {
      accumulateRecord(missedCollectionReasons, day.missedCollectionReasons);
      accumulateRecord(rolloverReasons, day.rollReasons);
    });

    const hourOfDay: Record<string, number> = {};
    currentEncounters.forEach((encounter) => {
      if (!encounter.checkInAt) return;
      const label = DateTime.fromJSDate(encounter.checkInAt).toFormat("ha");
      hourOfDay[label] = (hourOfDay[label] || 0) + 1;
    });

    const providerAggregate = new Map<
      string,
      { encounterCount: number; activeCount: number; completedCount: number; optimizingTotal: number; optimizingSamples: number }
    >();
    officeDaily.forEach((day) => {
      day.providerRollups.forEach((provider) => {
        const key = provider.providerName || "Unassigned";
        if (!providerAggregate.has(key)) {
          providerAggregate.set(key, {
            encounterCount: 0,
            activeCount: 0,
            completedCount: 0,
            optimizingTotal: 0,
            optimizingSamples: 0,
          });
        }
        const row = providerAggregate.get(key)!;
        row.encounterCount += provider.encounterCount;
        row.activeCount += provider.activeCount;
        row.completedCount += provider.completedCount;
        const optimizing = readNumber(provider.stageAverages?.Optimizing);
        if (optimizing > 0) {
          row.optimizingTotal += optimizing;
          row.optimizingSamples += 1;
        }
      });
    });

    const providerSummaries = Array.from(providerAggregate.entries())
      .map(([providerName, row]) => ({
        providerName,
        encounterCount: row.encounterCount,
        activeCount: row.activeCount,
        completedCount: row.completedCount,
        avgOptimizingMins: row.optimizingSamples > 0 ? Math.round(row.optimizingTotal / row.optimizingSamples) : 0,
      }))
      .sort((a, b) => b.encounterCount - a.encounterCount)
      .slice(0, 8);

    const maVolume = new Map<string, number>();
    currentEncounters.forEach((encounter) => {
      const maName = maById.get(encounter.assignedMaUserId || "")?.trim();
      if (!maName) return;
      maVolume.set(maName, (maVolume.get(maName) || 0) + 1);
    });
    const staffSummaries = Array.from(maVolume.entries())
      .map(([label, count]) => ({ label, role: "MA", encounterCount: count }))
      .sort((a, b) => b.encounterCount - a.encounterCount)
      .slice(0, 8);

    let missingChargeMappingCount = 0;
    let missingReimbursementMappingCount = 0;
    let documentationIncompleteCount = 0;
    let providerQueriesOpen = 0;
    let staleUnresolvedCount = 0;
    rangeRevenueCases.forEach((row) => {
      const outcomeLabel = row.checkoutCollectionTracking?.collectionOutcome || null;
      if (outcomeLabel) {
        collectionOutcomes[outcomeLabel] = (collectionOutcomes[outcomeLabel] || 0) + 1;
      }
      const expectation = buildRevenueExpectationSummary({
        chargeCapture: {
          documentationComplete: Boolean(row.chargeCaptureRecord?.documentationComplete),
          icd10CodesJson: Array.isArray(row.chargeCaptureRecord?.icd10CodesJson) ? (row.chargeCaptureRecord?.icd10CodesJson as string[]) : [],
          procedureLinesJson: Array.isArray(row.chargeCaptureRecord?.procedureLinesJson) ? (row.chargeCaptureRecord?.procedureLinesJson as any[]) : [],
          serviceCaptureItemsJson: Array.isArray(row.chargeCaptureRecord?.serviceCaptureItemsJson) ? (row.chargeCaptureRecord?.serviceCaptureItemsJson as any[]) : [],
        },
        chargeSchedule: settings?.chargeSchedule || [],
        reimbursementRules: settings?.reimbursementRules || [],
        financialReadiness: row.financialReadiness
          ? {
              primaryPayerName: row.financialReadiness.primaryPayerName,
              financialClass: row.financialReadiness.financialClass,
            }
          : null,
      });
      if (expectation.missingChargeMapping) missingChargeMappingCount += 1;
      if (expectation.missingReimbursementMapping) missingReimbursementMappingCount += 1;
      if (row.currentBlockerCategory === "documentation_incomplete") documentationIncompleteCount += 1;
      providerQueriesOpen += row.providerClarifications.length;
      if (row.dueAt && row.currentBlockerText && row.dueAt.getTime() < Date.now()) staleUnresolvedCount += 1;
    });

    return {
      scope: {
        clinicId: query.clinicId || request.user!.clinicId,
        from: effectiveFrom,
        to: effectiveTo,
      },
      overview: {
        encounterCount: latestOffice?.encounterCount || 0,
        inProgressCount:
          readNumber(latestOffice?.queueByStatus?.Lobby) +
          readNumber(latestOffice?.queueByStatus?.Rooming) +
          readNumber(latestOffice?.queueByStatus?.ReadyForProvider) +
          readNumber(latestOffice?.queueByStatus?.Optimizing) +
          readNumber(latestOffice?.queueByStatus?.CheckOut),
        avgCycleTimeMins,
        sameDayCollectionExpectedCents: latestRevenue?.sameDayCollectionExpectedCents || 0,
        sameDayCollectionTrackedCents: latestRevenue?.sameDayCollectionTrackedCents || 0,
        sameDayCollectionDollarRate: latestRevenue?.sameDayCollectionDollarRate || 0,
        expectedGrossChargeCents: latestRevenue?.expectedGrossChargeCents || 0,
        expectedNetReimbursementCents: latestRevenue?.expectedNetReimbursementCents || 0,
        unresolvedBlockers: rangeRevenueCases.filter((row) => Boolean(row.currentBlockerText)).length,
      },
      throughput: {
        stageCounts: latestOffice?.queueByStatus || {},
        stageDurations: latestOffice?.stageRollups || [],
        daily: throughputDaily,
        hourOfDay: topEntries(hourOfDay, 12),
        leakage: {
          rolledCount: latestRevenue?.rolledCount || 0,
          providerQueriesOpen,
        },
      },
      revenue: {
        daily: revenueDailySeries,
        queueCounts: latestRevenue?.queueCounts || {},
        missedCollectionReasons: topEntries(missedCollectionReasons),
        collectionOutcomes: topEntries(collectionOutcomes),
        mappingGaps: {
          missingChargeMappingCount,
          missingReimbursementMappingCount,
        },
      },
      providersAndStaff: {
        providers: providerSummaries,
        staff: staffSummaries,
      },
      roomsAndCapacity: {
        current: latestRoom
          ? {
              roomCount: latestRoom.roomCount,
              avgOccupiedMins: latestRoom.avgOccupiedMins,
              avgTurnoverMins: latestRoom.avgTurnoverMins,
              turnoverCount: latestRoom.turnoverCount,
              holdCount: latestRoom.holdCount,
              issueCount: latestRoom.issueCount,
            }
          : {
              roomCount: 0,
              avgOccupiedMins: 0,
              avgTurnoverMins: 0,
              turnoverCount: 0,
              holdCount: 0,
              issueCount: 0,
            },
        daily: roomDaily.map((day) => ({
          dateKey: day.date,
          roomCount: day.roomCount,
          avgOccupiedMins: day.avgOccupiedMins,
          avgTurnoverMins: day.avgTurnoverMins,
          turnoverCount: day.turnoverCount,
          holdCount: day.holdCount,
          issueCount: day.issueCount,
        })),
        issueTypes: latestRoom?.issueRollups?.map((issue) => ({
          label: issue.issueType,
          count: issue.count,
        })) || [],
      },
      exceptionsAndRisk: {
        documentationIncompleteCount,
        providerQueriesOpen,
        rolloverReasons: topEntries(rolloverReasons),
        staleUnresolvedCount,
        activeSafetyCount,
        blockingTaskCount,
      },
      warnings,
    };
  });
}
