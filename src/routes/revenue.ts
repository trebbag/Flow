import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CodingStage,
  CollectionOutcome,
  FinancialEligibilityStatus,
  FinancialRequirementStatus,
  ProviderClarificationStatus,
  RevenueCloseoutState,
  RevenueDayBucket,
  RevenueStatus,
  RevenueWorkQueue,
  RoleName,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { DateTime } from "luxon";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ApiError, requireCondition } from "../lib/errors.js";
import { requireRoles } from "../lib/auth.js";
import { enterFacilityScope } from "../lib/facility-scope.js";
import { clinicDateKeyNow } from "../lib/clinic-time.js";
import { withIdempotentMutation } from "../lib/idempotency.js";
import { paginateItems, paginationQuerySchema, resolveOptionalPagination } from "../lib/pagination.js";
import { booleanish } from "../lib/zod-helpers.js";
import {
  buildRevenueCaseList,
  buildRevenueExpectationSummary,
  createRevenueProviderClarification,
  getRevenueSettings,
  normalizeChargeCaptureInput,
  respondToRevenueProviderClarification,
  syncRevenueCaseForEncounter,
  syncRevenueCasesForScope,
  type RevenueProcedureLine,
  type RevenueServiceCaptureItem,
} from "../lib/revenue-cycle.js";
import { getRevenueDailyHistoryRollups, listDateKeys } from "../lib/revenue-rollups.js";
import {
  formatClinicDisplayName,
  formatProviderDisplayName,
  formatReasonDisplayName,
  formatRoomDisplayName,
  formatUserDisplayName,
} from "../lib/display-names.js";
import {
  normalizeDocumentationSummaryJson,
  normalizeEncounterJsonRead,
  normalizeProcedureLinesJson,
  normalizeServiceCaptureItemsJson,
  normalizeStringArrayJson,
} from "../lib/persisted-json.js";
import { flushOperationalOutbox, persistMutationOperationalEventTx } from "../lib/operational-events.js";
import { buildIntegrityWarning, recordPersistedJsonAlert } from "../lib/persisted-json-alerts.js";
import { recordEntityEventTx } from "../lib/entity-events.js";

const listRevenueCasesSchema = z
  .object({
    clinicId: z.string().uuid().optional(),
    encounterId: z.string().uuid().optional(),
    dayBucket: z.nativeEnum(RevenueDayBucket).optional(),
    workQueue: z.nativeEnum(RevenueWorkQueue).optional(),
    search: z.string().optional(),
    mine: booleanish.optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    includeCases: booleanish.optional(),
  })
  .merge(paginationQuerySchema);

const revenueHistorySchema = z.object({
  clinicId: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

function readStringArray(value: Prisma.JsonValue | null | undefined): string[] {
  return normalizeStringArrayJson(value);
}

function readProcedureLines(value: Prisma.JsonValue | null | undefined): RevenueProcedureLine[] {
  return normalizeProcedureLinesJson(value) as RevenueProcedureLine[];
}

function readJsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  return normalizeDocumentationSummaryJson(value);
}

async function recordRevenueMutationTx(params: {
  tx: Prisma.TransactionClient;
  request: FastifyRequest;
  revenueCaseId: string;
}) {
  await persistMutationOperationalEventTx({
    db: params.tx,
    request: params.request,
    entityType: "RevenueCase",
    entityId: params.revenueCaseId,
  });
}

function mapChargeCaptureRecord(
  record: Awaited<ReturnType<typeof buildRevenueCaseList>>[number]["chargeCaptureRecord"] | null | undefined,
) {
  if (!record) return null;
  return {
    ...record,
    icd10CodesJson: readStringArray(record.icd10CodesJson),
    procedureLinesJson: readProcedureLines(record.procedureLinesJson),
    serviceCaptureItemsJson: readServiceCaptureItems(record.serviceCaptureItemsJson),
    cptCodesJson: readStringArray(record.cptCodesJson),
    modifiersJson: readStringArray(record.modifiersJson),
    unitsJson: readStringArray(record.unitsJson),
    documentationSummaryJson: readJsonObject(record.documentationSummaryJson),
  };
}

function readServiceCaptureItems(value: Prisma.JsonValue | null | undefined): RevenueServiceCaptureItem[] {
  return normalizeServiceCaptureItemsJson(value) as RevenueServiceCaptureItem[];
}

const updateRevenueCaseSchema = z.object({
  assignedToUserId: z.string().uuid().nullable().optional(),
  assignedToRole: z.nativeEnum(RoleName).nullable().optional(),
  priority: z.number().int().min(0).max(4).optional(),
  blockerCategory: z.string().nullable().optional(),
  blockerText: z.string().nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  readyForAthena: z.boolean().optional(),
  athenaHandoffConfirmed: z.boolean().optional(),
  athenaHandoffStarted: z.boolean().optional(),
  athenaHandoffNote: z.string().nullable().optional(),
      financialReadiness: z
    .object({
      eligibilityStatus: z.nativeEnum(FinancialEligibilityStatus).optional(),
      registrationVerified: z.boolean().optional(),
      contactInfoVerified: z.boolean().optional(),
      coverageIssueCategory: z.string().nullable().optional(),
      coverageIssueText: z.string().nullable().optional(),
      primaryPayerName: z.string().nullable().optional(),
      primaryPlanName: z.string().nullable().optional(),
      secondaryPayerName: z.string().nullable().optional(),
      financialClass: z.string().nullable().optional(),
      benefitsSummaryText: z.string().nullable().optional(),
      patientEstimateAmountCents: z.number().int().optional(),
      referralRequired: z.boolean().optional(),
      referralStatus: z.nativeEnum(FinancialRequirementStatus).nullable().optional(),
      priorAuthRequired: z.boolean().optional(),
      priorAuthStatus: z.nativeEnum(FinancialRequirementStatus).nullable().optional(),
      priorAuthNumber: z.string().nullable().optional(),
      pointOfServiceAmountDueCents: z.number().int().optional(),
      estimateExplainedToPatient: z.boolean().optional(),
      outstandingPriorBalanceCents: z.number().int().optional(),
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
      procedureLines: z
        .array(
          z.object({
            lineId: z.string().optional(),
            cptCode: z.string().min(1),
            modifiers: z.array(z.string()).optional(),
            units: z.number().int().min(1).optional(),
            diagnosisPointers: z.array(z.number().int().min(1)).optional(),
          }),
        )
        .optional(),
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

const providerClarificationPatchSchema = z.object({
  responseText: z.string().min(1).optional(),
  status: z.nativeEnum(ProviderClarificationStatus).optional(),
  resolve: z.boolean().optional(),
});

const assignRevenueCaseSchema = z.object({
  assignedToUserId: z.string().uuid().nullable().optional(),
  assignedToRole: z.nativeEnum(RoleName),
});

const rollRevenueCaseSchema = z.object({
  rollReason: z.string().min(1),
  assignedToUserId: z.string().uuid().nullable().optional(),
  assignedToRole: z.nativeEnum(RoleName).nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).optional(),
});

const revenueCloseoutSchema = z.object({
  clinicId: z.string().uuid().optional(),
  date: z.string().optional(),
  note: z.string().nullable().optional(),
  items: z
    .array(
      z.object({
        revenueCaseId: z.string().uuid(),
        ownerUserId: z.string().uuid().nullable().optional(),
        ownerRole: z.nativeEnum(RoleName).nullable().optional(),
        reasonNotCompleted: z.string().min(1),
        nextAction: z.string().min(1),
        dueAt: z.string().datetime({ offset: true }),
        rollover: z.boolean(),
      }),
    )
    .optional(),
});

const athenaHandoffConfirmSchema = z.object({
  athenaHandoffNote: z.string().nullable().optional(),
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

type ScopedClinic = {
  id: string;
  name: string;
  shortCode?: string | null;
  timezone: string;
  facilityId?: string | null;
};

async function resolveClinicsInScope(user: { clinicId: string | null; facilityId: string | null }, requestedClinicId?: string) {
  if (user.facilityId) {
    enterFacilityScope(user.facilityId);
  }

  if (requestedClinicId) {
    const clinic = await prisma.clinic.findUnique({
      where: { id: requestedClinicId },
      select: { id: true, name: true, shortCode: true, timezone: true, facilityId: true },
    });
    if (!clinic) throw new ApiError(404, "Clinic not found");
    if (user.clinicId && clinic.id !== user.clinicId) throw new ApiError(403, "Clinic is outside your assigned scope");
    if (user.facilityId && clinic.facilityId !== user.facilityId) throw new ApiError(403, "Clinic is outside your facility scope");
    enterFacilityScope(clinic.facilityId || user.facilityId || null);
    return [clinic] as ScopedClinic[];
  }

  if (user.clinicId) {
    const clinic = await prisma.clinic.findUnique({
      where: { id: user.clinicId },
      select: { id: true, name: true, shortCode: true, timezone: true, facilityId: true },
    });
    if (!clinic) throw new ApiError(404, "Assigned clinic not found");
    enterFacilityScope(clinic.facilityId || user.facilityId || null);
    return [clinic] as ScopedClinic[];
  }

  const clinics = await prisma.clinic.findMany({
    where: { facilityId: user.facilityId || undefined },
    select: { id: true, name: true, shortCode: true, timezone: true, facilityId: true },
    orderBy: { id: "asc" },
  });
  if (clinics.length === 0) throw new ApiError(404, "No clinics are available in scope");
  enterFacilityScope(clinics[0]?.facilityId || user.facilityId || null);
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
    closeoutState: row.closeoutState,
    readyForAthenaAt: row.readyForAthenaAt,
    athenaHandoffOwnerUserId: row.athenaHandoffOwnerUserId,
    athenaHandoffStartedAt: row.athenaHandoffStartedAt,
    athenaHandoffConfirmedAt: row.athenaHandoffConfirmedAt,
    athenaHandoffConfirmedByUserId: row.athenaHandoffConfirmedByUserId,
    athenaHandoffNote: row.athenaHandoffNote,
    athenaChargeEnteredAt: row.athenaChargeEnteredAt,
    athenaClaimSubmittedAt: row.athenaClaimSubmittedAt,
    athenaDaysToSubmit: row.athenaDaysToSubmit,
    athenaDaysInAR: row.athenaDaysInAR,
    athenaClaimStatus: row.athenaClaimStatus,
    athenaPatientBalanceCents: row.athenaPatientBalanceCents,
    athenaLastSyncAt: row.athenaLastSyncAt,
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
      roomingData: normalizeEncounterJsonRead("roomingData", row.encounter.roomingData),
      clinicianData: normalizeEncounterJsonRead("clinicianData", row.encounter.clinicianData),
      checkoutData: normalizeEncounterJsonRead("checkoutData", row.encounter.checkoutData),
    },
    financialReadiness: row.financialReadiness,
    checkoutCollectionTracking: row.checkoutCollectionTracking,
    chargeCaptureRecord: mapChargeCaptureRecord(row.chargeCaptureRecord),
    checklistItems: row.checklistItems,
    providerClarifications: row.providerClarifications,
    events: row.events,
  };
}

function accumulateCounts(target: Record<string, number>, source: Record<string, number> | null | undefined) {
  Object.entries(source || {}).forEach(([key, value]) => {
    target[key] = (target[key] || 0) + Number(value || 0);
  });
}

function averageNumbers(values: number[]) {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function averageNullableNumbers(values: Array<number | null | undefined>) {
  const usable = values.filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));
  return usable.length > 0 ? averageNumbers(usable) : null;
}

function sortCountEntries(counts: Record<string, number>, limit = 5) {
  return Object.entries(counts)
    .filter(([, value]) => Number(value) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count: Number(count) }));
}

async function assertRevenueCaseReadable(revenueCaseId: string, user: { clinicId: string | null; facilityId: string | null }) {
  const revenueCase = await prisma.revenueCase.findUnique({
    where: { id: revenueCaseId },
    select: { id: true, clinicId: true, facilityId: true, encounterId: true },
  });
  requireCondition(revenueCase, 404, "Revenue case not found");
  if (user.clinicId && revenueCase.clinicId !== user.clinicId) throw new ApiError(403, "Revenue case is outside your assigned scope");
  if (user.facilityId && revenueCase.facilityId !== user.facilityId) throw new ApiError(403, "Revenue case is outside your facility scope");
  return revenueCase;
}

function assertAthenaHandoffRole(role: RoleName | null | undefined) {
  requireCondition(
    role === RoleName.RevenueCycle || role === RoleName.OfficeManager || role === RoleName.Admin,
    400,
    "Athena handoff ownership must stay with Revenue Cycle, Office Manager, or Admin.",
  );
}

export async function registerRevenueRoutes(app: FastifyInstance) {
  const revenueGuard = requireRoles(RoleName.RevenueCycle, RoleName.OfficeManager, RoleName.Admin);

  app.get("/dashboard/revenue-cycle", { preHandler: revenueGuard }, async (request) => {
    const query = listRevenueCasesSchema.parse(request.query);
    const clinics = await resolveClinicsInScope(request.user!, query.clinicId);
    const toDate = query.to || clinicDateKeyNow(clinics[0]?.timezone);
    const fromDate = query.from || toDate;
    const facilityId = request.user!.facilityId || clinics[0]?.facilityId;
    requireCondition(facilityId, 400, "Revenue settings require a facility scope.");
    const settings = await getRevenueSettings(prisma, facilityId);

    const rows = await buildRevenueCaseList(prisma, {
      clinicIds: clinics.map((clinic) => clinic.id),
      facilityId: request.user!.facilityId,
      encounterId: query.encounterId,
      fromDateKey: fromDate,
      toDateKey: toDate,
      dayBucket: query.dayBucket,
      workQueue: query.workQueue,
      search: query.search,
      mine: query.mine,
      userId: request.user!.id,
      userRole: request.user!.role,
      detailLevel: "summary",
    });

    const todayRows = rows.filter((row) => row.currentDayBucket === RevenueDayBucket.Today);
    const collectionExpectedVisitCount = todayRows.filter((row) => row.checkoutCollectionTracking?.collectionExpected).length;
    const collectionCapturedVisitCount = todayRows.filter((row) => (row.checkoutCollectionTracking?.amountCollectedCents || 0) > 0).length;
    const collectionExpectedCents = todayRows.reduce(
      (sum, row) => sum + (row.checkoutCollectionTracking?.collectionExpected ? row.checkoutCollectionTracking.amountDueCents : 0),
      0,
    );
    const collectionCapturedCents = todayRows.reduce((sum, row) => sum + (row.checkoutCollectionTracking?.amountCollectedCents || 0), 0);
    const sameDayCollectionVisitRate = collectionExpectedVisitCount > 0
      ? Number(((collectionCapturedVisitCount / collectionExpectedVisitCount) * 100).toFixed(2))
      : 0;
    const sameDayCollectionDollarRate = collectionExpectedCents > 0
      ? Number(((collectionCapturedCents / collectionExpectedCents) * 100).toFixed(2))
      : 0;
    const expectationRows = todayRows.map((row) =>
      buildRevenueExpectationSummary({
        chargeCapture: {
          documentationComplete: Boolean(row.chargeCaptureRecord?.documentationComplete),
          icd10CodesJson: readStringArray(row.chargeCaptureRecord?.icd10CodesJson),
          procedureLinesJson: readProcedureLines(row.chargeCaptureRecord?.procedureLinesJson),
          serviceCaptureItemsJson: readServiceCaptureItems(row.chargeCaptureRecord?.serviceCaptureItemsJson),
        },
        chargeSchedule: settings.chargeSchedule,
        reimbursementRules: settings.reimbursementRules,
        financialReadiness: row.financialReadiness
          ? {
              primaryPayerName: row.financialReadiness.primaryPayerName,
              financialClass: row.financialReadiness.financialClass,
            }
          : null,
      }),
    );
    const expectedGrossChargeCents = expectationRows.reduce((sum, row) => sum + row.expectedGrossChargeCents, 0);
    const expectedNetReimbursementCents = expectationRows.reduce((sum, row) => sum + row.expectedNetReimbursementCents, 0);
    const serviceCaptureCompletedVisitCount = expectationRows.filter((row) => row.serviceCaptureCompleted).length;
    const clinicianCodingEnteredVisitCount = expectationRows.filter((row) => row.clinicianCodingEntered).length;
    const chargeCaptureReadyVisitCount = expectationRows.filter((row) => row.chargeCaptureReady).length;

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
    const athenaDaysToSubmit = averageNullableNumbers(rows.map((row) => row.athenaDaysToSubmit));
    const athenaDaysInAR = averageNullableNumbers(rows.map((row) => row.athenaDaysInAR));

    const response = {
      scope: {
        clinicId: query.clinicId || request.user!.clinicId,
        from: fromDate,
        to: toDate,
      },
      kpis: {
        sameDayCollectionExpectedVisitCount: collectionExpectedVisitCount,
        sameDayCollectionCapturedVisitCount: collectionCapturedVisitCount,
        sameDayCollectionExpectedCents: collectionExpectedCents,
        sameDayCollectionCapturedCents: collectionCapturedCents,
        sameDayCollectionVisitRate,
        sameDayCollectionDollarRate,
        expectedGrossChargeCents,
        expectedNetReimbursementCents,
        serviceCaptureCompletedVisitCount,
        clinicianCodingEnteredVisitCount,
        chargeCaptureReadyVisitCount,
        averageFlowHandoffLagHours,
        athenaDaysToSubmit,
        athenaDaysInAR,
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
      settings: {
        missedCollectionReasons: settings.missedCollectionReasons,
        providerQueryTemplates: settings.providerQueryTemplates,
        athenaLinkTemplate: settings.athenaLinkTemplate,
        serviceCatalog: settings.serviceCatalog,
        chargeSchedule: settings.chargeSchedule,
        estimateDefaults: settings.estimateDefaults,
        reimbursementRules: settings.reimbursementRules,
        checklistDefaults: settings.checklistDefaults,
      },
    };

    if (query.includeCases) {
      return {
        ...response,
        cases: rows.map(mapRevenueCaseRow),
      };
    }

    return response;
  });

  app.get("/dashboard/revenue-cycle/history", { preHandler: revenueGuard }, async (request) => {
    const query = revenueHistorySchema.parse(request.query);
    const clinics = await resolveClinicsInScope(request.user!, query.clinicId);
    const effectiveTo = (query.to || clinicDateKeyNow(clinics[0]?.timezone) || "").trim();
    const effectiveFrom = (query.from || DateTime.fromISO(effectiveTo).minus({ days: 4 }).toISODate() || "").trim();
    let dateKeys: string[];
    try {
      dateKeys = listDateKeys(effectiveFrom, effectiveTo);
    } catch (error) {
      throw new ApiError(400, error instanceof Error ? error.message : "Invalid date range");
    }

    const daily = await getRevenueDailyHistoryRollups(prisma, clinics, dateKeys, {
      persist: true,
      forceRecompute: false,
    });
    const clinicNameById = new Map(clinics.map((clinic) => [clinic.id, formatClinicDisplayName({ name: clinic.name })]));
    const unfinishedQueueCounts: Record<string, number> = {};
    const unfinishedOwnerCounts: Record<string, number> = {};
    const unfinishedProviderCounts: Record<string, number> = {};
    const unfinishedReasonCounts: Record<string, number> = {};
    const unfinishedClinicCounts: Record<string, number> = {};

    daily.forEach((entry) => {
      accumulateCounts(unfinishedQueueCounts, entry.unfinishedQueueCounts);
      accumulateCounts(unfinishedOwnerCounts, entry.unfinishedOwnerCounts);
      accumulateCounts(unfinishedProviderCounts, entry.unfinishedProviderCounts);
      accumulateCounts(unfinishedReasonCounts, entry.rollReasons);
      const clinicLabel = clinicNameById.get(entry.clinicId) || entry.clinicId;
      unfinishedClinicCounts[clinicLabel] =
        (unfinishedClinicCounts[clinicLabel] || 0) +
        Object.values(entry.unfinishedQueueCounts || {}).reduce((sum, value) => sum + Number(value || 0), 0);
    });

    const ownerIds = Object.keys(unfinishedOwnerCounts).filter((value) => /^[0-9a-f-]{36}$/i.test(value));
    const providerIds = Object.keys(unfinishedProviderCounts).filter((value) => /^[0-9a-f-]{36}$/i.test(value));
    const [ownerRows, providerRows] = await Promise.all([
      ownerIds.length > 0
        ? prisma.user.findMany({
            where: { id: { in: ownerIds } },
            select: { id: true, name: true, status: true },
          })
        : Promise.resolve([]),
      providerIds.length > 0
        ? prisma.user.findMany({
            where: { id: { in: providerIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);
    const ownerNameById = new Map(ownerRows.map((row) => [row.id, formatUserDisplayName(row)]));
    const providerNameById = new Map(providerRows.map((row) => [row.id, row.name || "Unassigned"]));

    return {
      scope: {
        clinicId: query.clinicId || request.user!.clinicId,
        from: effectiveFrom,
        to: effectiveTo,
      },
      daily: daily.map((entry) => ({
        clinicId: entry.clinicId,
        clinicName: clinicNameById.get(entry.clinicId) || entry.clinicId,
        dateKey: entry.date,
        sameDayCollectionExpectedVisitCount: entry.sameDayCollectionExpectedVisitCount,
        sameDayCollectionCapturedVisitCount: entry.sameDayCollectionCapturedVisitCount,
        sameDayCollectionExpectedCents: entry.sameDayCollectionExpectedCents,
        sameDayCollectionTrackedCents: entry.sameDayCollectionTrackedCents,
        sameDayCollectionVisitRate: entry.sameDayCollectionVisitRate,
        sameDayCollectionDollarRate: entry.sameDayCollectionDollarRate,
        expectedGrossChargeCents: entry.expectedGrossChargeCents,
        expectedNetReimbursementCents: entry.expectedNetReimbursementCents,
        serviceCaptureCompletedVisitCount: entry.serviceCaptureCompletedVisitCount,
        clinicianCodingEnteredVisitCount: entry.clinicianCodingEnteredVisitCount,
        chargeCaptureReadyVisitCount: entry.chargeCaptureReadyVisitCount,
        financiallyClearedCount: entry.financiallyClearedCount,
        chargeCaptureCompletedCount: entry.chargeCaptureCompletedCount,
        athenaHandoffConfirmedCount: entry.athenaHandoffConfirmedCount,
        rolledCount: entry.rolledCount,
        avgFlowHandoffHours: entry.avgFlowHandoffHours,
        avgAthenaDaysToSubmit: entry.avgAthenaDaysToSubmit,
        avgAthenaDaysInAR: entry.avgAthenaDaysInAR,
        queueCountsJson: entry.queueCounts,
        missedCollectionReasonsJson: entry.missedCollectionReasons,
        rollReasonsJson: entry.rollReasons,
        queryAgingJson: entry.queryAging,
        unfinishedQueueCountsJson: entry.unfinishedQueueCounts,
        unfinishedOwnerCountsJson: Object.fromEntries(
          Object.entries(entry.unfinishedOwnerCounts || {}).map(([key, value]) => [ownerNameById.get(key) || key, value]),
        ),
        unfinishedProviderCountsJson: Object.fromEntries(
          Object.entries(entry.unfinishedProviderCounts || {}).map(([key, value]) => [providerNameById.get(key) || key, value]),
        ),
        computedAt: new Date().toISOString(),
      })),
      summary: {
        unfinishedQueues: sortCountEntries(unfinishedQueueCounts),
        unfinishedReasons: sortCountEntries(unfinishedReasonCounts),
        unfinishedOwners: sortCountEntries(
          Object.fromEntries(Object.entries(unfinishedOwnerCounts).map(([key, value]) => [ownerNameById.get(key) || key, value])),
        ),
        unfinishedProviders: sortCountEntries(
          Object.fromEntries(Object.entries(unfinishedProviderCounts).map(([key, value]) => [providerNameById.get(key) || key, value])),
        ),
        unfinishedClinics: sortCountEntries(unfinishedClinicCounts),
        averageFlowHandoffLagHours: averageNumbers(
          daily.map((entry) => entry.avgFlowHandoffHours).filter((value) => Number.isFinite(value) && value > 0),
        ),
        averageAthenaDaysToSubmit: averageNullableNumbers(daily.map((entry) => entry.avgAthenaDaysToSubmit)),
        averageAthenaDaysInAR: averageNullableNumbers(daily.map((entry) => entry.avgAthenaDaysInAR)),
        rolledCount: daily.reduce((sum, entry) => sum + entry.rolledCount, 0),
      },
    };
  });

  app.get("/revenue-cases", { preHandler: revenueGuard }, async (request) => {
    const query = listRevenueCasesSchema.parse(request.query);
    const clinics = await resolveClinicsInScope(request.user!, query.clinicId);
    const toDate = query.to || clinicDateKeyNow(clinics[0]?.timezone);
    const fromDate = query.from || DateTime.fromISO(toDate).minus({ days: 14 }).toISODate()!;
    const pagination = resolveOptionalPagination(
      {
        cursor: query.cursor,
        pageSize: query.pageSize ?? 100,
      },
      { pageSize: 100 },
    )!;

    const rows = await buildRevenueCaseList(prisma, {
      clinicIds: clinics.map((clinic) => clinic.id),
      facilityId: request.user!.facilityId,
      encounterId: query.encounterId,
      fromDateKey: fromDate,
      toDateKey: toDate,
      dayBucket: query.dayBucket,
      workQueue: query.workQueue,
      search: query.search,
      mine: query.mine,
      userId: request.user!.id,
      userRole: request.user!.role,
      detailLevel: "summary",
      pagination,
    });

    const mappedRows = rows.map(mapRevenueCaseRow);
    return paginateItems(mappedRows, pagination);
  });

  app.get("/revenue-cases/:id", { preHandler: revenueGuard }, async (request) => {
    const revenueCaseId = (request.params as { id: string }).id;
    await assertRevenueCaseReadable(revenueCaseId, request.user!);
    const rows = await buildRevenueCaseList(prisma, {
      revenueCaseId,
      facilityId: request.user!.facilityId,
      detailLevel: "full",
    });
    const row = rows[0] || null;
    requireCondition(row, 404, "Revenue case not found");
    const mapped = mapRevenueCaseRow(row);
    const integrityWarnings = [
      row.encounter.roomingData !== null && mapped.encounter.roomingData === null ? buildIntegrityWarning("roomingData") : null,
      row.encounter.clinicianData !== null && mapped.encounter.clinicianData === null ? buildIntegrityWarning("clinicianData") : null,
      row.encounter.checkoutData !== null && mapped.encounter.checkoutData === null ? buildIntegrityWarning("checkoutData") : null,
      row.chargeCaptureRecord?.documentationSummaryJson !== null &&
      mapped.chargeCaptureRecord?.documentationSummaryJson === null
        ? buildIntegrityWarning("documentationSummaryJson")
        : null,
      Array.isArray(row.chargeCaptureRecord?.procedureLinesJson) &&
      row.chargeCaptureRecord.procedureLinesJson.length > 0 &&
      (mapped.chargeCaptureRecord?.procedureLinesJson?.length || 0) === 0
        ? buildIntegrityWarning("procedureLinesJson")
        : null,
      Array.isArray(row.chargeCaptureRecord?.serviceCaptureItemsJson) &&
      row.chargeCaptureRecord.serviceCaptureItemsJson.length > 0 &&
      (mapped.chargeCaptureRecord?.serviceCaptureItemsJson?.length || 0) === 0
        ? buildIntegrityWarning("serviceCaptureItemsJson")
        : null,
    ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

    if (integrityWarnings.length > 0) {
      await Promise.all(
        integrityWarnings.map((warning) =>
          recordPersistedJsonAlert({
            facilityId: row.facilityId,
            clinicId: row.clinicId,
            entityType: "RevenueCase",
            entityId: row.id,
            field: warning.field,
            requestId: request.correlationId || request.id,
          }),
        ),
      );
    }

    return {
      ...mapped,
      integrityWarnings,
    };
  });

  app.patch("/revenue-cases/:id", { preHandler: revenueGuard }, async (request) => {
    const revenueCaseId = (request.params as { id: string }).id;
    const dto = updateRevenueCaseSchema.parse(request.body);
    return withIdempotentMutation({
      db: prisma,
      request,
      payload: dto,
      execute: async () => {
        const revenueCase = await assertRevenueCaseReadable(revenueCaseId, request.user!);
        if (dto.checkoutTracking?.collectionOutcome && ["CollectedPartial", "NotCollected", "Deferred"].includes(dto.checkoutTracking.collectionOutcome)) {
          requireCondition(
            dto.checkoutTracking.missedCollectionReason,
            400,
            "A missed-collection reason is required for partial, deferred, or not-collected outcomes.",
            "MISSED_COLLECTION_REASON_REQUIRED",
          );
        }

        await prisma.$transaction(async (tx) => {
          if (dto.financialReadiness) {
            const beforeReadiness = await tx.financialReadiness.findUnique({
              where: { revenueCaseId },
            });
            const afterReadiness = await tx.financialReadiness.upsert({
              where: { revenueCaseId },
              create: {
                revenueCaseId,
                ...dto.financialReadiness,
              },
              update: dto.financialReadiness,
            });
            await recordEntityEventTx({
              db: tx,
              request,
              entityType: "FinancialReadiness",
              entityId: revenueCaseId,
              eventType: beforeReadiness ? "financial_readiness.updated" : "financial_readiness.created",
              before: beforeReadiness,
              after: afterReadiness,
              facilityId: revenueCase.facilityId,
              clinicId: revenueCase.clinicId,
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
            const beforeCharge = await tx.chargeCaptureRecord.findUnique({
              where: { revenueCaseId },
            });
            const normalized = normalizeChargeCaptureInput(dto.chargeCapture);
            const afterCharge = await tx.chargeCaptureRecord.upsert({
              where: { revenueCaseId },
              create: {
                revenueCaseId,
                documentationComplete: normalized.documentationComplete,
                codingStage: normalized.codingStage,
                icd10CodesJson: normalized.icd10CodesJson as Prisma.InputJsonValue,
                procedureLinesJson: normalized.procedureLinesJson as Prisma.InputJsonValue,
                cptCodesJson: normalized.cptCodesJson as Prisma.InputJsonValue,
                modifiersJson: normalized.modifiersJson as Prisma.InputJsonValue,
                unitsJson: normalized.unitsJson as Prisma.InputJsonValue,
                codingNote: normalized.codingNote,
                readyForAthenaAt: dto.readyForAthena ? new Date() : null,
              },
              update: {
                documentationComplete: normalized.documentationComplete,
                codingStage: normalized.codingStage,
                icd10CodesJson: normalized.icd10CodesJson as Prisma.InputJsonValue,
                procedureLinesJson: normalized.procedureLinesJson as Prisma.InputJsonValue,
                cptCodesJson: normalized.cptCodesJson as Prisma.InputJsonValue,
                modifiersJson: normalized.modifiersJson as Prisma.InputJsonValue,
                unitsJson: normalized.unitsJson as Prisma.InputJsonValue,
                codingNote: normalized.codingNote,
                readyForAthenaAt: dto.readyForAthena === undefined ? undefined : dto.readyForAthena ? new Date() : null,
              },
            });
            await recordEntityEventTx({
              db: tx,
              request,
              entityType: "ChargeCaptureRecord",
              entityId: revenueCaseId,
              eventType: beforeCharge ? "charge_capture.updated" : "charge_capture.created",
              before: beforeCharge,
              after: afterCharge,
              facilityId: revenueCase.facilityId,
              clinicId: revenueCase.clinicId,
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
              athenaHandoffStartedAt: dto.athenaHandoffStarted === undefined ? undefined : dto.athenaHandoffStarted ? new Date() : null,
              athenaHandoffConfirmedAt:
                dto.athenaHandoffConfirmed === undefined
                  ? undefined
                  : dto.athenaHandoffConfirmed
                    ? new Date()
                    : null,
              athenaHandoffConfirmedByUserId:
                dto.athenaHandoffConfirmed === undefined
                  ? undefined
                  : dto.athenaHandoffConfirmed
                    ? request.user!.id
                    : null,
              athenaHandoffNote: dto.athenaHandoffNote,
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
          await recordRevenueMutationTx({
            tx,
            request,
            revenueCaseId,
          });
        });

        await flushOperationalOutbox(prisma);
        const row = (
          await buildRevenueCaseList(prisma, {
            revenueCaseId,
            facilityId: request.user!.facilityId,
            detailLevel: "full",
          })
        )[0];
        requireCondition(row, 404, "Revenue case not found", "REVENUE_CASE_NOT_FOUND");
        return mapRevenueCaseRow(row);
      },
    });
  });

  app.patch("/revenue-cases/:id/assign", { preHandler: revenueGuard }, async (request) => {
    const revenueCaseId = (request.params as { id: string }).id;
    const dto = assignRevenueCaseSchema.parse(request.body);
    return withIdempotentMutation({
      db: prisma,
      request,
      payload: dto,
      execute: async () => {
        await assertRevenueCaseReadable(revenueCaseId, request.user!);
        assertAthenaHandoffRole(dto.assignedToRole);

        const updated = await prisma.$transaction(async (tx) => {
          const row = await tx.revenueCase.update({
            where: { id: revenueCaseId },
            data: {
              assignedToUserId: dto.assignedToUserId,
              assignedToRole: dto.assignedToRole,
            },
          });

          await tx.revenueCaseEvent.create({
            data: {
              revenueCaseId,
              eventType: "assignment_updated",
              actorUserId: request.user!.id,
              eventText: `Assigned to ${dto.assignedToRole}${dto.assignedToUserId ? ` (${dto.assignedToUserId})` : ""}`,
            },
          });

          await syncRevenueCaseForEncounter(tx, row.encounterId);
          await recordRevenueMutationTx({
            tx,
            request,
            revenueCaseId,
          });
          return row;
        });
        await flushOperationalOutbox(prisma);
        const row = (
          await buildRevenueCaseList(prisma, {
            revenueCaseId,
            facilityId: request.user!.facilityId,
            detailLevel: "full",
          })
        )[0];
        requireCondition(row, 404, "Revenue case not found", "REVENUE_CASE_NOT_FOUND");
        return mapRevenueCaseRow(row);
      },
    });
  });

  app.post("/revenue-cases/:id/provider-clarifications", { preHandler: revenueGuard }, async (request) => {
    const revenueCaseId = (request.params as { id: string }).id;
    const dto = providerQuerySchema.parse(request.body);
    return withIdempotentMutation({
      db: prisma,
      request,
      payload: dto,
      execute: async () => {
        await assertRevenueCaseReadable(revenueCaseId, request.user!);
        const created = await prisma.$transaction(async (tx) => {
          const row = await createRevenueProviderClarification(tx, {
            revenueCaseId,
            requestedByUserId: request.user!.id,
            questionText: dto.questionText,
            queryType: dto.queryType,
          });
          requireCondition(row, 404, "Revenue case not found", "REVENUE_CASE_NOT_FOUND");
          await recordRevenueMutationTx({
            tx,
            request,
            revenueCaseId,
          });
          return row;
        });
        await flushOperationalOutbox(prisma);
        requireCondition(created, 404, "Revenue case not found", "REVENUE_CASE_NOT_FOUND");
        return created;
      },
    });
  });

  app.post("/revenue-cases/:id/provider-query", { preHandler: revenueGuard }, async (request) => {
    const revenueCaseId = (request.params as { id: string }).id;
    const dto = providerQuerySchema.parse(request.body);
    return withIdempotentMutation({
      db: prisma,
      request,
      payload: dto,
      execute: async () => {
        await assertRevenueCaseReadable(revenueCaseId, request.user!);
        const created = await prisma.$transaction(async (tx) => {
          const row = await createRevenueProviderClarification(tx, {
            revenueCaseId,
            requestedByUserId: request.user!.id,
            questionText: dto.questionText,
            queryType: dto.queryType,
          });
          requireCondition(row, 404, "Revenue case not found", "REVENUE_CASE_NOT_FOUND");
          await recordRevenueMutationTx({
            tx,
            request,
            revenueCaseId,
          });
          return row;
        });
        await flushOperationalOutbox(prisma);
        requireCondition(created, 404, "Revenue case not found", "REVENUE_CASE_NOT_FOUND");
        return created;
      },
    });
  });

  const patchProviderClarification = async (request: any) => {
    const clarificationId = (request.params as { id: string }).id;
    const dto = providerClarificationPatchSchema.parse(request.body);
    return withIdempotentMutation({
      db: prisma,
      request,
      payload: dto,
      execute: async () => {
        requireCondition(
          dto.responseText || dto.status || dto.resolve !== undefined,
          400,
          "No provider clarification updates were supplied.",
          "PROVIDER_QUERY_UPDATE_REQUIRED",
        );
        const updated = await prisma.$transaction(async (tx) => {
          const row = await respondToRevenueProviderClarification(tx, {
            clarificationId,
            actorUserId: request.user!.id,
            responseText: dto.responseText || "Updated in Flow",
            resolve: dto.resolve ?? dto.status === ProviderClarificationStatus.Resolved,
          });
          requireCondition(row, 404, "Provider clarification not found", "PROVIDER_QUERY_NOT_FOUND");
          const finalRow =
            dto.status === ProviderClarificationStatus.Open
              ? await tx.providerClarification.update({
                  where: { id: clarificationId },
                  data: {
                    status: ProviderClarificationStatus.Open,
                    respondedAt: null,
                    resolvedAt: null,
                  },
                })
              : row;
          await recordRevenueMutationTx({
            tx,
            request,
            revenueCaseId: finalRow.revenueCaseId,
          });
          return finalRow;
        });
        await flushOperationalOutbox(prisma);
        requireCondition(updated, 404, "Provider clarification not found", "PROVIDER_QUERY_NOT_FOUND");
        return updated;
      },
    });
  };

  app.patch(
    "/provider-clarifications/:id",
    { preHandler: requireRoles(RoleName.Clinician, RoleName.Admin, RoleName.RevenueCycle, RoleName.OfficeManager) },
    patchProviderClarification,
  );

  app.post(
    "/revenue-cases/queries/:id/respond",
    { preHandler: requireRoles(RoleName.Clinician, RoleName.Admin, RoleName.RevenueCycle, RoleName.OfficeManager) },
    patchProviderClarification,
  );

  app.post("/revenue-cases/:id/athena-handoff-confirm", { preHandler: revenueGuard }, async (request) => {
    const revenueCaseId = (request.params as { id: string }).id;
    const dto = athenaHandoffConfirmSchema.parse(request.body);
    return withIdempotentMutation({
      db: prisma,
      request,
      payload: dto,
      execute: async () => {
        await assertRevenueCaseReadable(revenueCaseId, request.user!);
        assertAthenaHandoffRole(request.user!.role);

        await prisma.$transaction(async (tx) => {
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

          const revenueCase = await tx.revenueCase.findUnique({ where: { id: revenueCaseId } });
          requireCondition(revenueCase, 404, "Revenue case not found", "REVENUE_CASE_NOT_FOUND");

          await tx.revenueCase.update({
            where: { id: revenueCaseId },
            data: {
              athenaHandoffOwnerUserId: revenueCase.athenaHandoffOwnerUserId || request.user!.id,
              athenaHandoffStartedAt: revenueCase.athenaHandoffStartedAt || new Date(),
              athenaHandoffConfirmedAt: new Date(),
              athenaHandoffConfirmedByUserId: request.user!.id,
              athenaHandoffNote: dto.athenaHandoffNote || null,
              closeoutState:
                revenueCase.closeoutState === RevenueCloseoutState.ClosedResolved
                  ? RevenueCloseoutState.ClosedResolved
                  : RevenueCloseoutState.Open,
            },
          });

          await tx.revenueCaseEvent.create({
            data: {
              revenueCaseId,
              eventType: "athena_handoff_confirmed",
              actorUserId: request.user!.id,
              eventText: dto.athenaHandoffNote || "Athena handoff confirmed in Flow",
            },
          });

          await syncRevenueCaseForEncounter(tx, revenueCase.encounterId);
          await recordRevenueMutationTx({
            tx,
            request,
            revenueCaseId,
          });
        });

        await flushOperationalOutbox(prisma);
        const row = (
          await buildRevenueCaseList(prisma, {
            revenueCaseId,
            facilityId: request.user!.facilityId,
            detailLevel: "full",
          })
        )[0];
        requireCondition(row, 404, "Revenue case not found", "REVENUE_CASE_NOT_FOUND");
        return mapRevenueCaseRow(row);
      },
    });
  });

  app.post("/revenue-cases/:id/roll", { preHandler: revenueGuard }, async (request) => {
    const revenueCaseId = (request.params as { id: string }).id;
    const dto = rollRevenueCaseSchema.parse(request.body);
    return withIdempotentMutation({
      db: prisma,
      request,
      payload: dto,
      execute: async () => {
        await assertRevenueCaseReadable(revenueCaseId, request.user!);
        const revenueCase = await prisma.revenueCase.findUnique({ where: { id: revenueCaseId }, include: { clinic: { select: { timezone: true } } } });
        requireCondition(revenueCase, 404, "Revenue case not found", "REVENUE_CASE_NOT_FOUND");
        const rolledFromDateKey = clinicDateKeyNow(revenueCase.clinic.timezone) || null;

        const updated = await prisma.$transaction(async (tx) => {
          const updated = await tx.revenueCase.update({
            where: { id: revenueCaseId },
            data: {
              rolledFromDateKey,
              rollReason: dto.rollReason,
              currentDayBucket: RevenueDayBucket.Rolled,
              assignedToUserId: dto.assignedToUserId,
              assignedToRole: dto.assignedToRole,
              dueAt: dto.dueAt ? new Date(dto.dueAt) : undefined,
              closeoutState: RevenueCloseoutState.RolledOver,
            },
          });

          await tx.revenueCaseEvent.create({
            data: {
              revenueCaseId,
              eventType: "rolled",
              actorUserId: request.user!.id,
              eventText: dto.rollReason,
            },
          });

          await syncRevenueCaseForEncounter(tx, updated.encounterId);
          await recordRevenueMutationTx({
            tx,
            request,
            revenueCaseId,
          });
          return updated;
        });
        await flushOperationalOutbox(prisma);
        return updated;
      },
    });
  });

  app.post("/revenue-closeout", { preHandler: revenueGuard }, async (request) => {
    const dto = revenueCloseoutSchema.parse(request.body);
    return withIdempotentMutation({
      db: prisma,
      request,
      payload: dto,
      execute: async () => {
        const clinics = await resolveClinicsInScope(request.user!, dto.clinicId);
        requireCondition(clinics.length === 1, 400, "Revenue day close is clinic-specific. Select a single clinic before closing the day.", "REVENUE_CLOSEOUT_REQUIRES_SINGLE_CLINIC");
        const targetDate = (dto.date || clinicDateKeyNow(clinics[0]?.timezone) || "").trim();
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
          select: {
            id: true,
            patientId: true,
            providerId: true,
            encounterId: true,
            currentWorkQueue: true,
            currentRevenueStatus: true,
            assignedToUserId: true,
            assignedToRole: true,
          },
        });

        const items = dto.items || [];
        const itemMap = new Map(items.map((item) => [item.revenueCaseId, item]));
        const missing = unresolved.filter((row) => !itemMap.has(row.id));
        if (missing.length > 0) {
          throw new ApiError({
            statusCode: 400,
            code: "REVENUE_CLOSEOUT_METADATA_MISSING",
            message: `${missing.length} unresolved revenue case(s) still need closeout metadata.`,
          });
        }

        for (const item of items) {
          requireCondition(item.ownerUserId || item.ownerRole, 400, "Every unresolved case needs an owner.", "REVENUE_CLOSEOUT_OWNER_REQUIRED");
        }

        const closeout = await prisma.$transaction(async (tx) => {
          const run = await tx.revenueCloseoutRun.create({
            data: {
              facilityId: request.user!.facilityId!,
              clinicId: clinics[0]!.id,
              dateKey: targetDate,
              closedByUserId: request.user!.id,
              unresolvedCount: unresolved.length,
              rolledCount: items.filter((item) => item.rollover).length,
              note: dto.note || null,
            },
          });

          for (const unresolvedCase of unresolved) {
            const item = itemMap.get(unresolvedCase.id)!;
            await tx.revenueCloseoutItem.create({
              data: {
                closeoutRunId: run.id,
                revenueCaseId: unresolvedCase.id,
                queue: unresolvedCase.currentWorkQueue,
                snapshotStatus: unresolvedCase.currentRevenueStatus,
                ownerUserId: item.ownerUserId || unresolvedCase.assignedToUserId || null,
                ownerRole: item.ownerRole || unresolvedCase.assignedToRole || RoleName.RevenueCycle,
                reasonNotCompleted: item.reasonNotCompleted,
                nextAction: item.nextAction,
                dueAt: new Date(item.dueAt),
                rollover: item.rollover,
                patientId: unresolvedCase.patientId,
                providerId: unresolvedCase.providerId,
              },
            });

            await tx.revenueCase.update({
              where: { id: unresolvedCase.id },
              data: {
                assignedToUserId: item.ownerUserId || unresolvedCase.assignedToUserId || null,
                assignedToRole: item.ownerRole || unresolvedCase.assignedToRole || RoleName.RevenueCycle,
                dueAt: new Date(item.dueAt),
                rolledFromDateKey: item.rollover ? targetDate : null,
                rollReason: item.rollover ? item.reasonNotCompleted : null,
                closeoutState: item.rollover ? RevenueCloseoutState.RolledOver : RevenueCloseoutState.ClosedUnresolved,
                currentDayBucket: item.rollover ? RevenueDayBucket.Rolled : RevenueDayBucket.Yesterday,
              },
            });

            await tx.revenueChecklistItem.updateMany({
              where: {
                revenueCaseId: unresolvedCase.id,
                group: "day_close",
              },
              data: {
                status: "completed",
                completedAt: new Date(),
                completedByUserId: request.user!.id,
                evidenceText: `${item.reasonNotCompleted} | Next: ${item.nextAction}`,
              },
            });

            await tx.revenueCaseEvent.create({
              data: {
                revenueCaseId: unresolvedCase.id,
                eventType: item.rollover ? "closeout_rolled" : "closeout_unresolved",
                actorUserId: request.user!.id,
                eventText: item.reasonNotCompleted,
                payloadJson: {
                  nextAction: item.nextAction,
                  dueAt: item.dueAt,
                  rollover: item.rollover,
                } as Prisma.InputJsonValue,
              },
            });
          }

          await persistMutationOperationalEventTx({
            db: tx,
            request,
            entityType: "RevenueCloseoutRun",
            entityId: run.id,
          });

          return {
            date: targetDate,
            rolledCount: items.filter((item) => item.rollover).length,
            unresolvedCount: unresolved.length,
            status: "closed",
          };
        });
        await flushOperationalOutbox(prisma);
        return closeout;
      },
    });
  });
}
