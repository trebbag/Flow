import type { FastifyInstance } from "fastify";
import {
  CodingStage,
  CollectionOutcome,
  FinancialEligibilityStatus,
  ProviderClarificationStatus,
  RevenueDayBucket,
  RevenueStatus,
  RevenueWorkQueue,
  RoleName,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { DateTime } from "luxon";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ApiError, assert } from "../lib/errors.js";
import { requireRoles } from "../lib/auth.js";
import {
  buildRevenueCaseList,
  createRevenueProviderClarification,
  respondToRevenueProviderClarification,
  syncRevenueCaseForEncounter,
  syncRevenueCasesForScope,
} from "../lib/revenue-cycle.js";
import { getRevenueDailyHistoryRollups, listDateKeys } from "../lib/revenue-rollups.js";
import {
  formatClinicDisplayName,
  formatProviderDisplayName,
  formatReasonDisplayName,
  formatRoomDisplayName,
  formatUserDisplayName,
} from "../lib/display-names.js";

const listRevenueCasesSchema = z.object({
  clinicId: z.string().uuid().optional(),
  dayBucket: z.nativeEnum(RevenueDayBucket).optional(),
  workQueue: z.nativeEnum(RevenueWorkQueue).optional(),
  search: z.string().optional(),
  mine: z.coerce.boolean().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

const revenueHistorySchema = z.object({
  clinicId: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

const updateRevenueCaseSchema = z.object({
  assignedToUserId: z.string().uuid().nullable().optional(),
  assignedToRole: z.nativeEnum(RoleName).nullable().optional(),
  priority: z.number().int().min(0).max(4).optional(),
  blockerCategory: z.string().nullable().optional(),
  blockerText: z.string().nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  readyForAthena: z.boolean().optional(),
  athenaHandoffConfirmed: z.boolean().optional(),
  financialReadiness: z
    .object({
      eligibilityStatus: z.nativeEnum(FinancialEligibilityStatus).optional(),
      coverageIssueCategory: z.string().nullable().optional(),
      coverageIssueText: z.string().nullable().optional(),
      referralRequired: z.boolean().optional(),
      referralStatus: z.string().nullable().optional(),
      priorAuthRequired: z.boolean().optional(),
      priorAuthStatus: z.string().nullable().optional(),
      priorAuthNumber: z.string().nullable().optional(),
      pointOfServiceAmountDueCents: z.number().int().optional(),
    })
    .optional(),
  checkoutTracking: z
    .object({
      collectionExpected: z.boolean().optional(),
      amountDueCents: z.number().int().optional(),
      amountCollectedCents: z.number().int().optional(),
      collectionOutcome: z.nativeEnum(CollectionOutcome).nullable().optional(),
      missedCollectionReason: z.string().nullable().optional(),
      trackingNote: z.string().nullable().optional(),
    })
    .optional(),
  chargeCapture: z
    .object({
      documentationComplete: z.boolean().optional(),
      codingStage: z.nativeEnum(CodingStage).optional(),
      icd10Codes: z.array(z.string()).optional(),
      cptCodes: z.array(z.string()).optional(),
      modifiers: z.array(z.string()).optional(),
      units: z.array(z.string()).optional(),
      codingNote: z.string().nullable().optional(),
    })
    .optional(),
  checklistUpdates: z
    .array(
      z.object({
        id: z.string().uuid(),
        status: z.string(),
        evidenceText: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

const providerQuerySchema = z.object({
  questionText: z.string().min(1),
  queryType: z.string().optional(),
});

const providerResponseSchema = z.object({
  responseText: z.string().min(1),
  resolve: z.boolean().optional(),
});

const rollRevenueCaseSchema = z.object({
  rollReason: z.string().min(1),
  assignedToUserId: z.string().uuid().nullable().optional(),
  assignedToRole: z.nativeEnum(RoleName).nullable().optional(),
  dueAt: z.string().datetime().optional(),
});

const revenueCloseoutSchema = z.object({
  clinicId: z.string().uuid().optional(),
  date: z.string().optional(),
  rollovers: z
    .array(
      z.object({
        revenueCaseId: z.string().uuid(),
        rollReason: z.string().min(1),
        assignedToUserId: z.string().uuid().nullable().optional(),
        assignedToRole: z.nativeEnum(RoleName).nullable().optional(),
        dueAt: z.string().datetime().optional(),
      }),
    )
    .optional(),
});

type ScopedClinic = { id: string; timezone: string; facilityId?: string | null };

async function resolveClinicsInScope(user: { clinicId: string | null; facilityId: string | null }, requestedClinicId?: string) {
  if (requestedClinicId) {
    const clinic = await prisma.clinic.findUnique({
      where: { id: requestedClinicId },
      select: { id: true, timezone: true, facilityId: true },
    });
    if (!clinic) throw new ApiError(404, "Clinic not found");
    if (user.clinicId && clinic.id !== user.clinicId) throw new ApiError(403, "Clinic is outside your assigned scope");
    if (user.facilityId && clinic.facilityId !== user.facilityId) throw new ApiError(403, "Clinic is outside your facility scope");
    return [clinic] as ScopedClinic[];
  }

  if (user.clinicId) {
    const clinic = await prisma.clinic.findUnique({
      where: { id: user.clinicId },
      select: { id: true, timezone: true, facilityId: true },
    });
    if (!clinic) throw new ApiError(404, "Assigned clinic not found");
    return [clinic] as ScopedClinic[];
  }

  const clinics = await prisma.clinic.findMany({
    where: { facilityId: user.facilityId || undefined },
    select: { id: true, timezone: true, facilityId: true },
    orderBy: { id: "asc" },
  });
  if (clinics.length === 0) throw new ApiError(404, "No clinics are available in scope");
  return clinics;
}

function mapRevenueCaseRow(row: Awaited<ReturnType<typeof buildRevenueCaseList>>[number]) {
  return {
    id: row.id,
    encounterId: row.encounterId,
    patientId: row.patientId,
    clinicId: row.clinicId,
    clinicName: formatClinicDisplayName(row.clinic),
    clinicColor: row.clinic.cardColor || "#6366f1",
    providerName: formatProviderDisplayName(row.provider),
    currentRevenueStatus: row.currentRevenueStatus,
    currentWorkQueue: row.currentWorkQueue,
    currentDayBucket: row.currentDayBucket,
    priority: row.priority,
    assignedToUserId: row.assignedToUserId,
    assignedToUserName: formatUserDisplayName(row.assignedToUser),
    assignedToRole: row.assignedToRole,
    currentBlockerCategory: row.currentBlockerCategory,
    currentBlockerText: row.currentBlockerText,
    dueAt: row.dueAt,
    rolledFromDateKey: row.rolledFromDateKey,
    rollReason: row.rollReason,
    readyForAthenaAt: row.readyForAthenaAt,
    athenaHandoffConfirmedAt: row.athenaHandoffConfirmedAt,
    closedAt: row.closedAt,
    providerQueryOpenCount: row.providerQueryOpenCount,
    encounter: {
      id: row.encounter.id,
      patientId: row.encounter.patientId,
      currentStatus: row.encounter.currentStatus,
      checkInAt: row.encounter.checkInAt,
      providerEndAt: row.encounter.providerEndAt,
      checkoutCompleteAt: row.encounter.checkoutCompleteAt,
      roomName: formatRoomDisplayName(row.encounter.room),
      reasonForVisit: formatReasonDisplayName(row.encounter.reason),
      roomingData: row.encounter.roomingData,
      clinicianData: row.encounter.clinicianData,
      checkoutData: row.encounter.checkoutData,
    },
    financialReadiness: row.financialReadiness,
    checkoutCollectionTracking: row.checkoutCollectionTracking,
    chargeCaptureRecord: row.chargeCaptureRecord,
    checklistItems: row.checklistItems,
    providerClarifications: row.providerClarifications,
    events: row.events,
  };
}

async function assertRevenueCaseReadable(revenueCaseId: string, user: { clinicId: string | null; facilityId: string | null }) {
  const revenueCase = await prisma.revenueCase.findUnique({
    where: { id: revenueCaseId },
    select: { id: true, clinicId: true, facilityId: true },
  });
  assert(revenueCase, 404, "Revenue case not found");
  if (user.clinicId && revenueCase.clinicId !== user.clinicId) throw new ApiError(403, "Revenue case is outside your assigned scope");
  if (user.facilityId && revenueCase.facilityId !== user.facilityId) throw new ApiError(403, "Revenue case is outside your facility scope");
  return revenueCase;
}

export async function registerRevenueRoutes(app: FastifyInstance) {
  const revenueGuard = requireRoles(RoleName.RevenueCycle, RoleName.Admin);

  app.get("/dashboard/revenue-cycle", { preHandler: revenueGuard }, async (request) => {
    const query = listRevenueCasesSchema.parse(request.query);
    const clinics = await resolveClinicsInScope(request.user!, query.clinicId);
    const toDate = query.to || DateTime.now().toISODate()!;
    const fromDate = query.from || toDate;
    await syncRevenueCasesForScope(prisma, {
      clinicIds: clinics.map((clinic) => clinic.id),
      facilityId: request.user!.facilityId,
      fromDateKey: fromDate,
      toDateKey: toDate,
    });

    const rows = await buildRevenueCaseList(prisma, {
      clinicIds: clinics.map((clinic) => clinic.id),
      facilityId: request.user!.facilityId,
      dayBucket: query.dayBucket,
      workQueue: query.workQueue,
      search: query.search,
      mine: query.mine,
      userId: request.user!.id,
      userRole: request.user!.role,
    });

    const todayRows = rows.filter((row) => row.currentDayBucket === RevenueDayBucket.Today);
    const collectionExpected = todayRows.reduce(
      (sum, row) => sum + (row.checkoutCollectionTracking?.collectionExpected ? row.checkoutCollectionTracking.amountDueCents : 0),
      0,
    );
    const collectionTracked = todayRows.reduce((sum, row) => sum + (row.checkoutCollectionTracking?.amountCollectedCents || 0), 0);
    const sameDayCollectionRate = collectionExpected > 0 ? Number(((collectionTracked / collectionExpected) * 100).toFixed(2)) : 0;

    const handoffDurations = todayRows
      .filter((row) => row.encounter.checkoutCompleteAt && row.athenaHandoffConfirmedAt)
      .map((row) => {
        const anchor = row.encounter.checkoutCompleteAt || row.encounter.providerEndAt;
        if (!anchor || !row.athenaHandoffConfirmedAt) return 0;
        return Math.max(0, (row.athenaHandoffConfirmedAt.getTime() - anchor.getTime()) / 3600000);
      })
      .filter((value) => value > 0);

    const averageFlowHandoffLagHours = handoffDurations.length > 0
      ? Number((handoffDurations.reduce((sum, value) => sum + value, 0) / handoffDurations.length).toFixed(2))
      : 0;

    return {
      scope: {
        clinicId: query.clinicId || request.user!.clinicId,
        from: fromDate,
        to: toDate,
      },
      kpis: {
        sameDayCollectionRate,
        averageFlowHandoffLagHours,
        athenaDaysToSubmit: null,
        athenaDaysInAR: null,
      },
      risks: {
        eligibilityBlockers: rows.filter((row) => row.currentWorkQueue === RevenueWorkQueue.FinancialReadiness).length,
        checkoutCollectionMisses: rows.filter((row) => row.currentWorkQueue === RevenueWorkQueue.CheckoutTracking).length,
        chargeCaptureNotStarted: rows.filter((row) => row.currentRevenueStatus === RevenueStatus.ChargeCaptureNeeded).length,
        providerQueriesOpen: rows.reduce((sum, row) => sum + row.providerQueryOpenCount, 0),
        readyForAthena: rows.filter((row) => row.currentRevenueStatus === RevenueStatus.ReadyForAthenaHandoff).length,
        rolledFromYesterday: rows.filter((row) => row.currentDayBucket === RevenueDayBucket.Rolled).length,
      },
      queueCounts: Object.fromEntries(
        Object.values(RevenueWorkQueue).map((queue) => [queue, rows.filter((row) => row.currentWorkQueue === queue).length]),
      ),
      cases: rows.map(mapRevenueCaseRow),
    };
  });

  app.get("/dashboard/revenue-cycle/history", { preHandler: revenueGuard }, async (request) => {
    const query = revenueHistorySchema.parse(request.query);
    const clinics = await resolveClinicsInScope(request.user!, query.clinicId);
    const effectiveTo = (query.to || DateTime.now().toISODate() || "").trim();
    const effectiveFrom = (query.from || DateTime.fromISO(effectiveTo).minus({ days: 4 }).toISODate() || "").trim();
    let dateKeys: string[];
    try {
      dateKeys = listDateKeys(effectiveFrom, effectiveTo);
    } catch (error) {
      throw new ApiError(400, error instanceof Error ? error.message : "Invalid date range");
    }

    await syncRevenueCasesForScope(prisma, {
      clinicIds: clinics.map((clinic) => clinic.id),
      facilityId: request.user!.facilityId,
      fromDateKey: effectiveFrom,
      toDateKey: effectiveTo,
    });

    const daily = await getRevenueDailyHistoryRollups(prisma, clinics, dateKeys, {
      persist: true,
      forceRecompute: true,
    });

    return {
      scope: {
        clinicId: query.clinicId || request.user!.clinicId,
        from: effectiveFrom,
        to: effectiveTo,
      },
      daily,
    };
  });

  app.get("/revenue-cases", { preHandler: revenueGuard }, async (request) => {
    const query = listRevenueCasesSchema.parse(request.query);
    const clinics = await resolveClinicsInScope(request.user!, query.clinicId);
    const toDate = query.to || DateTime.now().toISODate()!;
    const fromDate = query.from || DateTime.now().minus({ days: 14 }).toISODate()!;
    await syncRevenueCasesForScope(prisma, {
      clinicIds: clinics.map((clinic) => clinic.id),
      facilityId: request.user!.facilityId,
      fromDateKey: fromDate,
      toDateKey: toDate,
    });

    const rows = await buildRevenueCaseList(prisma, {
      clinicIds: clinics.map((clinic) => clinic.id),
      facilityId: request.user!.facilityId,
      dayBucket: query.dayBucket,
      workQueue: query.workQueue,
      search: query.search,
      mine: query.mine,
      userId: request.user!.id,
      userRole: request.user!.role,
    });

    return rows.map(mapRevenueCaseRow);
  });

  app.get("/revenue-cases/:id", { preHandler: revenueGuard }, async (request) => {
    const revenueCaseId = (request.params as { id: string }).id;
    await assertRevenueCaseReadable(revenueCaseId, request.user!);
    const rows = await buildRevenueCaseList(prisma, {
      facilityId: request.user!.facilityId,
    });
    const row = rows.find((entry) => entry.id === revenueCaseId);
    assert(row, 404, "Revenue case not found");
    return mapRevenueCaseRow(row);
  });

  app.patch("/revenue-cases/:id", { preHandler: revenueGuard }, async (request) => {
    const revenueCaseId = (request.params as { id: string }).id;
    const dto = updateRevenueCaseSchema.parse(request.body);
    const revenueCase = await assertRevenueCaseReadable(revenueCaseId, request.user!);

    await prisma.$transaction(async (tx) => {
      if (dto.financialReadiness) {
        await tx.financialReadiness.upsert({
          where: { revenueCaseId },
          create: {
            revenueCaseId,
            ...dto.financialReadiness,
          },
          update: dto.financialReadiness,
        });
      }
      if (dto.checkoutTracking) {
        await tx.checkoutCollectionTracking.upsert({
          where: { revenueCaseId },
          create: {
            revenueCaseId,
            ...dto.checkoutTracking,
          },
          update: dto.checkoutTracking,
        });
      }
      if (dto.chargeCapture) {
        await tx.chargeCaptureRecord.upsert({
          where: { revenueCaseId },
          create: {
            revenueCaseId,
            documentationComplete: dto.chargeCapture.documentationComplete ?? false,
            codingStage: dto.chargeCapture.codingStage,
            icd10CodesJson: (dto.chargeCapture.icd10Codes || []) as Prisma.InputJsonValue,
            cptCodesJson: (dto.chargeCapture.cptCodes || []) as Prisma.InputJsonValue,
            modifiersJson: (dto.chargeCapture.modifiers || []) as Prisma.InputJsonValue,
            unitsJson: (dto.chargeCapture.units || []) as Prisma.InputJsonValue,
            codingNote: dto.chargeCapture.codingNote ?? null,
            readyForAthenaAt: dto.readyForAthena ? new Date() : null,
          },
          update: {
            documentationComplete: dto.chargeCapture.documentationComplete,
            codingStage: dto.chargeCapture.codingStage,
            icd10CodesJson: dto.chargeCapture.icd10Codes ? (dto.chargeCapture.icd10Codes as Prisma.InputJsonValue) : undefined,
            cptCodesJson: dto.chargeCapture.cptCodes ? (dto.chargeCapture.cptCodes as Prisma.InputJsonValue) : undefined,
            modifiersJson: dto.chargeCapture.modifiers ? (dto.chargeCapture.modifiers as Prisma.InputJsonValue) : undefined,
            unitsJson: dto.chargeCapture.units ? (dto.chargeCapture.units as Prisma.InputJsonValue) : undefined,
            codingNote: dto.chargeCapture.codingNote,
            readyForAthenaAt: dto.readyForAthena === undefined ? undefined : dto.readyForAthena ? new Date() : null,
          },
        });
      }
      if (dto.checklistUpdates?.length) {
        for (const item of dto.checklistUpdates) {
          await tx.revenueChecklistItem.update({
            where: { id: item.id },
            data: {
              status: item.status,
              evidenceText: item.evidenceText,
              completedAt: item.status === "completed" ? new Date() : null,
              completedByUserId: item.status === "completed" ? request.user!.id : null,
            },
          });
        }
      }

      await tx.revenueCase.update({
        where: { id: revenueCaseId },
        data: {
          assignedToUserId: dto.assignedToUserId,
          assignedToRole: dto.assignedToRole,
          priority: dto.priority,
          currentBlockerCategory: dto.blockerCategory,
          currentBlockerText: dto.blockerText,
          dueAt: dto.dueAt ? new Date(dto.dueAt) : dto.dueAt === null ? null : undefined,
          readyForAthenaAt: dto.readyForAthena === undefined ? undefined : dto.readyForAthena ? new Date() : null,
          athenaHandoffConfirmedAt:
            dto.athenaHandoffConfirmed === undefined
              ? undefined
              : dto.athenaHandoffConfirmed
                ? new Date()
                : null,
        },
      });

      await tx.revenueCaseEvent.create({
        data: {
          revenueCaseId,
          eventType: "case_updated",
          actorUserId: request.user!.id,
          eventText: "Revenue case updated",
          payloadJson: dto as Prisma.InputJsonValue,
        },
      });

      await syncRevenueCaseForEncounter(tx, revenueCase.encounterId);
    });

    const rows = await buildRevenueCaseList(prisma, { facilityId: request.user!.facilityId });
    const row = rows.find((entry) => entry.id === revenueCaseId);
    assert(row, 404, "Revenue case not found");
    return mapRevenueCaseRow(row);
  });

  app.post("/revenue-cases/:id/provider-query", { preHandler: revenueGuard }, async (request) => {
    const revenueCaseId = (request.params as { id: string }).id;
    const dto = providerQuerySchema.parse(request.body);
    await assertRevenueCaseReadable(revenueCaseId, request.user!);
    const created = await createRevenueProviderClarification(prisma, {
      revenueCaseId,
      requestedByUserId: request.user!.id,
      questionText: dto.questionText,
      queryType: dto.queryType,
    });
    assert(created, 404, "Revenue case not found");
    return created;
  });

  app.post(
    "/revenue-cases/queries/:id/respond",
    { preHandler: requireRoles(RoleName.Clinician, RoleName.Admin, RoleName.RevenueCycle) },
    async (request) => {
      const clarificationId = (request.params as { id: string }).id;
      const dto = providerResponseSchema.parse(request.body);
      const updated = await respondToRevenueProviderClarification(prisma, {
        clarificationId,
        actorUserId: request.user!.id,
        responseText: dto.responseText,
        resolve: dto.resolve,
      });
      assert(updated, 404, "Provider clarification not found");
      return updated;
    },
  );

  app.post("/revenue-cases/:id/roll", { preHandler: revenueGuard }, async (request) => {
    const revenueCaseId = (request.params as { id: string }).id;
    const dto = rollRevenueCaseSchema.parse(request.body);
    await assertRevenueCaseReadable(revenueCaseId, request.user!);
    const revenueCase = await prisma.revenueCase.findUnique({ where: { id: revenueCaseId }, include: { clinic: { select: { timezone: true } } } });
    assert(revenueCase, 404, "Revenue case not found");
    const rolledFromDateKey = DateTime.now().setZone(revenueCase.clinic.timezone).toISODate() || null;

    const updated = await prisma.revenueCase.update({
      where: { id: revenueCaseId },
      data: {
        rolledFromDateKey,
        rollReason: dto.rollReason,
        currentDayBucket: RevenueDayBucket.Rolled,
        assignedToUserId: dto.assignedToUserId,
        assignedToRole: dto.assignedToRole,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : undefined,
      },
    });

    await prisma.revenueCaseEvent.create({
      data: {
        revenueCaseId,
        eventType: "rolled",
        actorUserId: request.user!.id,
        eventText: dto.rollReason,
      },
    });

    await syncRevenueCaseForEncounter(prisma, updated.encounterId);
    return updated;
  });

  app.post("/revenue-closeout", { preHandler: revenueGuard }, async (request) => {
    const dto = revenueCloseoutSchema.parse(request.body);
    const clinics = await resolveClinicsInScope(request.user!, dto.clinicId);
    const targetDate = (dto.date || DateTime.now().toISODate() || "").trim();
    await syncRevenueCasesForScope(prisma, {
      clinicIds: clinics.map((clinic) => clinic.id),
      facilityId: request.user!.facilityId,
      fromDateKey: targetDate,
      toDateKey: targetDate,
    });

    const unresolved = await prisma.revenueCase.findMany({
      where: {
        clinicId: { in: clinics.map((clinic) => clinic.id) },
        currentDayBucket: RevenueDayBucket.Today,
        currentRevenueStatus: {
          notIn: [RevenueStatus.MonitoringOnly, RevenueStatus.Closed],
        },
      },
      select: { id: true, patientId: true, currentRevenueStatus: true },
    });

    const rollovers = dto.rollovers || [];
    const rolledIds = new Set(rollovers.map((item) => item.revenueCaseId));
    const blockers = unresolved.filter((row) => !rolledIds.has(row.id));
    if (blockers.length > 0) {
      throw new ApiError(400, `${blockers.length} revenue case(s) still need rollover ownership before day close.`);
    }

    for (const rollover of rollovers) {
      await prisma.revenueCase.update({
        where: { id: rollover.revenueCaseId },
        data: {
          rolledFromDateKey: targetDate,
          rollReason: rollover.rollReason,
          currentDayBucket: RevenueDayBucket.Rolled,
          assignedToUserId: rollover.assignedToUserId,
          assignedToRole: rollover.assignedToRole,
          dueAt: rollover.dueAt ? new Date(rollover.dueAt) : undefined,
        },
      });
    }

    return {
      date: targetDate,
      rolledCount: rollovers.length,
      unresolvedCount: unresolved.length,
      status: "closed",
    };
  });
}
