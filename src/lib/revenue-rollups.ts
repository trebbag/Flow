import {
  CodingStage,
  CollectionOutcome,
  ProviderClarificationStatus,
  RevenueStatus,
  RevenueWorkQueue,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";
import { DateTime } from "luxon";
import { listDateKeys, type ScopedClinic } from "./office-manager-rollups.js";

function asRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asNumberRecord(value: Prisma.JsonValue | null | undefined): Record<string, number> {
  const raw = asRecord(value);
  return Object.fromEntries(Object.entries(raw).map(([key, entry]) => [key, readNumber(entry)]));
}

function readNumber(value: unknown) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function average(total: number, count: number) {
  if (count <= 0) return 0;
  return Number((total / count).toFixed(2));
}

export type RevenueDailyHistoryPoint = {
  clinicId: string;
  facilityId: string | null;
  date: string;
  sameDayCollectionExpectedVisitCount: number;
  sameDayCollectionCapturedVisitCount: number;
  sameDayCollectionExpectedCents: number;
  sameDayCollectionTrackedCents: number;
  sameDayCollectionVisitRate: number;
  sameDayCollectionDollarRate: number;
  financiallyClearedCount: number;
  chargeCaptureCompletedCount: number;
  athenaHandoffConfirmedCount: number;
  rolledCount: number;
  avgFlowHandoffHours: number;
  avgAthenaDaysToSubmit: number | null;
  avgAthenaDaysInAR: number | null;
  queueCounts: Record<string, number>;
  missedCollectionReasons: Record<string, number>;
  rollReasons: Record<string, number>;
  queryAging: Record<string, number>;
  unfinishedQueueCounts: Record<string, number>;
  unfinishedOwnerCounts: Record<string, number>;
  unfinishedProviderCounts: Record<string, number>;
};

function emptyQueueCounts() {
  return Object.fromEntries(Object.values(RevenueWorkQueue).map((queue) => [queue, 0])) as Record<string, number>;
}

function bucketQueryAge(openedAt: Date, now: Date) {
  const hours = Math.max(0, (now.getTime() - openedAt.getTime()) / 3600000);
  if (hours < 4) return "lt4h";
  if (hours < 8) return "lt8h";
  if (hours < 24) return "lt24h";
  return "gte24h";
}

export async function computeRevenueDailyRollup(
  prisma: PrismaClient,
  clinic: ScopedClinic,
  dateKey: string,
): Promise<RevenueDailyHistoryPoint> {
  const start = DateTime.fromISO(dateKey, { zone: clinic.timezone }).startOf("day").toUTC().toJSDate();
  const end = DateTime.fromJSDate(start).plus({ days: 1 }).toJSDate();

  const cases = await prisma.revenueCase.findMany({
    where: {
      clinicId: clinic.id,
      dateOfService: { gte: start, lt: end },
    },
    include: {
      checkoutCollectionTracking: true,
      chargeCaptureRecord: true,
      providerClarifications: {
        where: { status: { not: ProviderClarificationStatus.Resolved } },
      },
      encounter: {
        select: {
          providerEndAt: true,
          checkoutCompleteAt: true,
          clinic: { select: { facilityId: true } },
        },
      },
    },
  });
  const closeoutRun = await prisma.revenueCloseoutRun.findFirst({
    where: { clinicId: clinic.id, dateKey },
    include: { items: true },
    orderBy: { createdAt: "desc" },
  });

  let expectedVisitCount = 0;
  let capturedVisitCount = 0;
  let expected = 0;
  let tracked = 0;
  let financiallyClearedCount = 0;
  let chargeCaptureCompletedCount = 0;
  let athenaHandoffConfirmedCount = 0;
  let rolledCount = 0;
  let handoffHoursTotal = 0;
  let handoffHourSamples = 0;
  let athenaDaysToSubmitTotal = 0;
  let athenaDaysToSubmitSamples = 0;
  let athenaDaysInARTotal = 0;
  let athenaDaysInARSamples = 0;
  const queueCounts = emptyQueueCounts();
  const missedCollectionReasons: Record<string, number> = {};
  const rollReasons: Record<string, number> = {};
  const queryAging: Record<string, number> = { lt4h: 0, lt8h: 0, lt24h: 0, gte24h: 0 };
  const unfinishedQueueCounts: Record<string, number> = {};
  const unfinishedOwnerCounts: Record<string, number> = {};
  const unfinishedProviderCounts: Record<string, number> = {};
  let facilityId: string | null = null;

  cases.forEach((item) => {
    facilityId = facilityId || item.facilityId || item.encounter.clinic?.facilityId || null;
    queueCounts[item.currentWorkQueue] = (queueCounts[item.currentWorkQueue] || 0) + 1;
    if (item.currentRevenueStatus !== RevenueStatus.FinancialReadinessNeeded) financiallyClearedCount += 1;
    if (item.chargeCaptureRecord?.codingStage === CodingStage.ReadyForAthena) chargeCaptureCompletedCount += 1;
    if (item.athenaHandoffConfirmedAt) athenaHandoffConfirmedCount += 1;
    if (item.rolledFromDateKey || item.rollReason) rolledCount += 1;
    if (item.rollReason) {
      rollReasons[item.rollReason] = (rollReasons[item.rollReason] || 0) + 1;
    }
    if (item.athenaDaysToSubmit !== null && item.athenaDaysToSubmit !== undefined) {
      athenaDaysToSubmitTotal += item.athenaDaysToSubmit;
      athenaDaysToSubmitSamples += 1;
    }
    if (item.athenaDaysInAR !== null && item.athenaDaysInAR !== undefined) {
      athenaDaysInARTotal += item.athenaDaysInAR;
      athenaDaysInARSamples += 1;
    }

    const tracking = item.checkoutCollectionTracking;
    if (tracking?.collectionExpected) {
      expectedVisitCount += 1;
      expected += tracking.amountDueCents;
    }
    if ((tracking?.amountCollectedCents || 0) > 0) capturedVisitCount += 1;
    tracked += tracking?.amountCollectedCents || 0;
    if (tracking?.missedCollectionReason) {
      missedCollectionReasons[tracking.missedCollectionReason] = (missedCollectionReasons[tracking.missedCollectionReason] || 0) + 1;
    }

    item.providerClarifications.forEach((query) => {
      queryAging[bucketQueryAge(query.openedAt, new Date())] += 1;
    });

    const anchor = item.encounter.checkoutCompleteAt || item.encounter.providerEndAt;
    if (anchor && item.athenaHandoffConfirmedAt) {
      handoffHoursTotal += Math.max(0, (item.athenaHandoffConfirmedAt.getTime() - anchor.getTime()) / 3600000);
      handoffHourSamples += 1;
    }
  });

  closeoutRun?.items.forEach((item) => {
    unfinishedQueueCounts[item.queue] = (unfinishedQueueCounts[item.queue] || 0) + 1;
    const ownerKey = item.ownerUserId || item.ownerRole || "unassigned";
    unfinishedOwnerCounts[ownerKey] = (unfinishedOwnerCounts[ownerKey] || 0) + 1;
    const providerKey = item.providerId || "unassigned";
    unfinishedProviderCounts[providerKey] = (unfinishedProviderCounts[providerKey] || 0) + 1;
    rollReasons[item.reasonNotCompleted] = (rollReasons[item.reasonNotCompleted] || 0) + 1;
  });

  const sameDayCollectionVisitRate = expectedVisitCount > 0 ? Number(((capturedVisitCount / expectedVisitCount) * 100).toFixed(2)) : 0;
  const sameDayCollectionDollarRate = expected > 0 ? Number(((tracked / expected) * 100).toFixed(2)) : 0;

  return {
    clinicId: clinic.id,
    facilityId,
    date: dateKey,
    sameDayCollectionExpectedVisitCount: expectedVisitCount,
    sameDayCollectionCapturedVisitCount: capturedVisitCount,
    sameDayCollectionExpectedCents: expected,
    sameDayCollectionTrackedCents: tracked,
    sameDayCollectionVisitRate,
    sameDayCollectionDollarRate,
    financiallyClearedCount,
    chargeCaptureCompletedCount,
    athenaHandoffConfirmedCount,
    rolledCount,
    avgFlowHandoffHours: average(handoffHoursTotal, handoffHourSamples),
    avgAthenaDaysToSubmit: athenaDaysToSubmitSamples > 0 ? average(athenaDaysToSubmitTotal, athenaDaysToSubmitSamples) : null,
    avgAthenaDaysInAR: athenaDaysInARSamples > 0 ? average(athenaDaysInARTotal, athenaDaysInARSamples) : null,
    queueCounts,
    missedCollectionReasons,
    rollReasons,
    queryAging,
    unfinishedQueueCounts,
    unfinishedOwnerCounts,
    unfinishedProviderCounts,
  };
}

export async function getRevenueDailyHistoryRollups(
  prisma: PrismaClient,
  clinics: ScopedClinic[],
  dateKeys: string[],
  options?: { persist?: boolean; forceRecompute?: boolean },
) {
  const results: RevenueDailyHistoryPoint[] = [];

  for (const clinic of clinics) {
    for (const dateKey of dateKeys) {
      const existing = !options?.forceRecompute
        ? await prisma.revenueCycleDailyRollup.findUnique({
            where: { clinicId_dateKey: { clinicId: clinic.id, dateKey } },
          })
        : null;

      if (existing) {
        results.push({
          clinicId: existing.clinicId,
          facilityId: existing.facilityId,
          date: existing.dateKey,
          sameDayCollectionExpectedVisitCount: existing.sameDayCollectionExpectedVisitCount,
          sameDayCollectionCapturedVisitCount: existing.sameDayCollectionCapturedVisitCount,
          sameDayCollectionExpectedCents: existing.sameDayCollectionExpectedCents,
          sameDayCollectionTrackedCents: existing.sameDayCollectionTrackedCents,
          sameDayCollectionVisitRate: existing.sameDayCollectionVisitRate,
          sameDayCollectionDollarRate: existing.sameDayCollectionDollarRate,
          financiallyClearedCount: existing.financiallyClearedCount,
          chargeCaptureCompletedCount: existing.chargeCaptureCompletedCount,
          athenaHandoffConfirmedCount: existing.athenaHandoffConfirmedCount,
          rolledCount: existing.rolledCount,
          avgFlowHandoffHours: existing.avgFlowHandoffHours,
          avgAthenaDaysToSubmit: existing.avgAthenaDaysToSubmit ?? null,
          avgAthenaDaysInAR: existing.avgAthenaDaysInAR ?? null,
          queueCounts: asNumberRecord(existing.queueCountsJson),
          missedCollectionReasons: asNumberRecord(existing.missedCollectionReasonsJson),
          rollReasons: asNumberRecord(existing.rollReasonsJson),
          queryAging: asNumberRecord(existing.queryAgingJson),
          unfinishedQueueCounts: asNumberRecord(existing.unfinishedQueueCountsJson),
          unfinishedOwnerCounts: asNumberRecord(existing.unfinishedOwnerCountsJson),
          unfinishedProviderCounts: asNumberRecord(existing.unfinishedProviderCountsJson),
        });
        continue;
      }

      const computed = await computeRevenueDailyRollup(prisma, clinic, dateKey);
      results.push(computed);
      if (options?.persist && computed.facilityId) {
        await prisma.revenueCycleDailyRollup.upsert({
          where: { clinicId_dateKey: { clinicId: clinic.id, dateKey } },
          create: {
            facilityId: computed.facilityId,
            clinicId: clinic.id,
            dateKey,
            sameDayCollectionExpectedVisitCount: computed.sameDayCollectionExpectedVisitCount,
            sameDayCollectionCapturedVisitCount: computed.sameDayCollectionCapturedVisitCount,
            sameDayCollectionExpectedCents: computed.sameDayCollectionExpectedCents,
            sameDayCollectionTrackedCents: computed.sameDayCollectionTrackedCents,
            sameDayCollectionVisitRate: computed.sameDayCollectionVisitRate,
            sameDayCollectionDollarRate: computed.sameDayCollectionDollarRate,
            financiallyClearedCount: computed.financiallyClearedCount,
            chargeCaptureCompletedCount: computed.chargeCaptureCompletedCount,
            athenaHandoffConfirmedCount: computed.athenaHandoffConfirmedCount,
            rolledCount: computed.rolledCount,
            avgFlowHandoffHours: computed.avgFlowHandoffHours,
            avgAthenaDaysToSubmit: computed.avgAthenaDaysToSubmit,
            avgAthenaDaysInAR: computed.avgAthenaDaysInAR,
            queueCountsJson: computed.queueCounts as Prisma.InputJsonValue,
            missedCollectionReasonsJson: computed.missedCollectionReasons as Prisma.InputJsonValue,
            rollReasonsJson: computed.rollReasons as Prisma.InputJsonValue,
            queryAgingJson: computed.queryAging as Prisma.InputJsonValue,
            unfinishedQueueCountsJson: computed.unfinishedQueueCounts as Prisma.InputJsonValue,
            unfinishedOwnerCountsJson: computed.unfinishedOwnerCounts as Prisma.InputJsonValue,
            unfinishedProviderCountsJson: computed.unfinishedProviderCounts as Prisma.InputJsonValue,
          },
          update: {
            sameDayCollectionExpectedVisitCount: computed.sameDayCollectionExpectedVisitCount,
            sameDayCollectionCapturedVisitCount: computed.sameDayCollectionCapturedVisitCount,
            sameDayCollectionExpectedCents: computed.sameDayCollectionExpectedCents,
            sameDayCollectionTrackedCents: computed.sameDayCollectionTrackedCents,
            sameDayCollectionVisitRate: computed.sameDayCollectionVisitRate,
            sameDayCollectionDollarRate: computed.sameDayCollectionDollarRate,
            financiallyClearedCount: computed.financiallyClearedCount,
            chargeCaptureCompletedCount: computed.chargeCaptureCompletedCount,
            athenaHandoffConfirmedCount: computed.athenaHandoffConfirmedCount,
            rolledCount: computed.rolledCount,
            avgFlowHandoffHours: computed.avgFlowHandoffHours,
            avgAthenaDaysToSubmit: computed.avgAthenaDaysToSubmit,
            avgAthenaDaysInAR: computed.avgAthenaDaysInAR,
            queueCountsJson: computed.queueCounts as Prisma.InputJsonValue,
            missedCollectionReasonsJson: computed.missedCollectionReasons as Prisma.InputJsonValue,
            rollReasonsJson: computed.rollReasons as Prisma.InputJsonValue,
            queryAgingJson: computed.queryAging as Prisma.InputJsonValue,
            unfinishedQueueCountsJson: computed.unfinishedQueueCounts as Prisma.InputJsonValue,
            unfinishedOwnerCountsJson: computed.unfinishedOwnerCounts as Prisma.InputJsonValue,
            unfinishedProviderCountsJson: computed.unfinishedProviderCounts as Prisma.InputJsonValue,
            computedAt: new Date(),
          },
        });
      }
    }
  }

  return results.sort((a, b) => a.date.localeCompare(b.date));
}

export { listDateKeys };
