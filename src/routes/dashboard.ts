import type { FastifyInstance } from "fastify";
import { AlertLevel, EncounterStatus, RoleName } from "@prisma/client";
import { DateTime } from "luxon";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ApiError } from "../lib/errors.js";
import { normalizeDate } from "../lib/dates.js";
import { requireRoles } from "../lib/auth.js";
import { getDailyHistoryRollups, listDateKeys } from "../lib/office-manager-rollups.js";
import { refreshEncounterAlertStates } from "../lib/alert-engine.js";

const dashboardQuerySchema = z.object({
  clinicId: z.string().uuid().optional(),
  date: z.string().optional()
});

const dashboardHistoryQuerySchema = z.object({
  clinicId: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional()
});

type ScopedClinic = { id: string; timezone: string };

async function resolveClinicsInScope(user: { clinicId: string | null; facilityId: string | null }, requestedClinicId?: string) {
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

    return [clinic] as ScopedClinic[];
  }

  if (user.clinicId) {
    const clinic = await prisma.clinic.findUnique({
      where: { id: user.clinicId },
      select: { id: true, timezone: true }
    });
    if (!clinic) {
      throw new ApiError(404, "Assigned clinic not found");
    }
    return [clinic] as ScopedClinic[];
  }

  const clinics = await prisma.clinic.findMany({
    where: {
      facilityId: user.facilityId || undefined
    },
    select: { id: true, timezone: true },
    orderBy: { id: "asc" }
  });

  if (clinics.length === 0) {
    throw new ApiError(404, "No clinics are available in scope");
  }

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

export async function registerDashboardRoutes(app: FastifyInstance) {
  const officeGuard = requireRoles(
    RoleName.FrontDeskCheckIn,
    RoleName.MA,
    RoleName.Clinician,
    RoleName.FrontDeskCheckOut,
    RoleName.OfficeManager,
    RoleName.Admin
  );

  app.get("/dashboard/office-manager", { preHandler: officeGuard }, async (request) => {
    const query = dashboardQuerySchema.parse(request.query);
    const matchers = await resolveEncounterMatchers(request.user!, query.clinicId, query.date);
    const scopedClinicIds = Array.from(new Set(matchers.map((matcher) => matcher.clinicId)));

    await refreshEncounterAlertStates(prisma, {
      facilityId: request.user!.facilityId,
      clinicIds: scopedClinicIds
    });

    const [statusCounts, alerts, activeSafetyCount, openTaskCount, encounters] = await Promise.all([
      prisma.encounter.groupBy({
        by: ["currentStatus"],
        where: { OR: matchers },
        _count: { _all: true }
      }),
      prisma.alertState.groupBy({
        by: ["currentAlertLevel"],
        where: { encounter: { OR: matchers } },
        _count: { _all: true }
      }),
      prisma.safetyEvent.count({
        where: {
          resolvedAt: null,
          encounter: { OR: matchers }
        }
      }),
      prisma.task.count({
        where: {
          status: { not: "completed" },
          encounter: { OR: matchers }
        }
      }),
      prisma.encounter.findMany({
        where: { OR: matchers },
        select: {
          currentStatus: true,
          checkInAt: true,
          roomingStartAt: true,
          providerStartAt: true,
          providerEndAt: true,
          checkoutCompleteAt: true
        }
      })
    ]);

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
    const effectiveTo = (query.to || DateTime.now().toISODate() || "").trim();
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
      forceRecompute: true
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

  app.get(
    "/dashboard/revenue-cycle",
    { preHandler: requireRoles(RoleName.RevenueCycle, RoleName.Admin) },
    async (request) => {
      const query = dashboardQuerySchema.parse(request.query);
      const matchers = await resolveEncounterMatchers(request.user!, query.clinicId, query.date);

      const [optimizedEncounters, statusCounts, closureCounts, openRevenueTasks] = await Promise.all([
        prisma.encounter.findMany({
          where: {
            OR: matchers,
            currentStatus: EncounterStatus.Optimized
          },
          select: {
            checkInAt: true,
            closedAt: true,
            checkoutCompleteAt: true,
            closureType: true
          }
        }),
        prisma.encounter.groupBy({
          by: ["currentStatus"],
          where: { OR: matchers },
          _count: { _all: true }
        }),
        prisma.encounter.groupBy({
          by: ["closureType"],
          where: {
            OR: matchers,
            currentStatus: EncounterStatus.Optimized,
            closureType: { not: null }
          },
          _count: { _all: true }
        }),
        prisma.task.count({
          where: {
            assignedToRole: RoleName.RevenueCycle,
            status: { not: "completed" },
            encounter: { OR: matchers }
          }
        })
      ]);

      const optimizedCount = optimizedEncounters.length;
      const collectionReadyCount = optimizedEncounters.filter((encounter) => encounter.checkoutCompleteAt !== null).length;

      const cycleMinutes = optimizedEncounters
        .filter((encounter) => encounter.checkInAt && encounter.closedAt)
        .map((encounter) => Math.max(0, Math.round((encounter.closedAt!.getTime() - encounter.checkInAt!.getTime()) / 60000)));

      const closureTypeCounts = closureCounts.reduce<Record<string, number>>((acc, row) => {
        if (!row.closureType) return acc;
        acc[row.closureType] = row._count._all;
        return acc;
      }, {});

      return {
        scope: {
          clinicId: query.clinicId || request.user!.clinicId,
          date: query.date || DateTime.now().toISODate()
        },
        optimizedCount,
        collectionReadyCount,
        avgCycleMins: averageMinutes(cycleMinutes),
        checkoutQueueCount: statusCounts.find((row) => row.currentStatus === EncounterStatus.CheckOut)?._count._all || 0,
        optimizingQueueCount: statusCounts.find((row) => row.currentStatus === EncounterStatus.Optimizing)?._count._all || 0,
        openRevenueTaskCount: openRevenueTasks,
        closureTypeCounts
      };
    }
  );
}
