import { AlertInboxKind, AlertInboxStatus, AlertLevel, AlertThresholdMetric, EncounterStatus, type Prisma, type PrismaClient } from "@prisma/client";
import { resolveAlertRecipientUserIds } from "./user-alert-inbox.js";

const monitoredStatuses: EncounterStatus[] = [
  EncounterStatus.Lobby,
  EncounterStatus.Rooming,
  EncounterStatus.ReadyForProvider,
  EncounterStatus.Optimizing,
  EncounterStatus.CheckOut
];

const levelRank: Record<AlertLevel, number> = {
  [AlertLevel.Green]: 0,
  [AlertLevel.Yellow]: 1,
  [AlertLevel.Red]: 2
};

type ThresholdRow = {
  id: string;
  facilityId: string;
  clinicId: string | null;
  metric: AlertThresholdMetric;
  status: EncounterStatus | null;
  reasonForVisitId: string | null;
  providerId: string | null;
  yellowAtMin: number;
  redAtMin: number;
  escalation2Min: number | null;
};

type EncounterRow = {
  id: string;
  patientId: string;
  clinicId: string;
  providerId: string | null;
  reasonForVisitId: string | null;
  currentStatus: EncounterStatus;
  checkInAt: Date | null;
  roomingStartAt: Date | null;
  roomingCompleteAt: Date | null;
  providerStartAt: Date | null;
  providerEndAt: Date | null;
  clinic: { facilityId: string | null };
  alertState: {
    enteredStatusAt: Date;
    currentAlertLevel: AlertLevel;
    yellowTriggeredAt: Date | null;
    redTriggeredAt: Date | null;
    escalationTriggeredAt: Date | null;
  } | null;
  safetyEvents: Array<{ id: string }>;
};

function minutesElapsed(from: Date | null | undefined, now: Date) {
  if (!from) return 0;
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60000));
}

function fallbackStageStart(encounter: EncounterRow) {
  if (encounter.currentStatus === EncounterStatus.Lobby) return encounter.checkInAt;
  if (encounter.currentStatus === EncounterStatus.Rooming) return encounter.roomingStartAt || encounter.checkInAt;
  if (encounter.currentStatus === EncounterStatus.ReadyForProvider) {
    return encounter.roomingCompleteAt || encounter.roomingStartAt || encounter.checkInAt;
  }
  if (encounter.currentStatus === EncounterStatus.Optimizing) {
    return encounter.providerStartAt || encounter.roomingCompleteAt || encounter.checkInAt;
  }
  if (encounter.currentStatus === EncounterStatus.CheckOut) {
    return encounter.providerEndAt || encounter.providerStartAt || encounter.checkInAt;
  }
  return encounter.checkInAt;
}

function thresholdScore(threshold: ThresholdRow, encounter: EncounterRow) {
  let score = 0;
  if (threshold.clinicId) {
    if (threshold.clinicId !== encounter.clinicId) return -1;
    score += 8;
  }
  if (threshold.reasonForVisitId) {
    if (threshold.reasonForVisitId !== encounter.reasonForVisitId) return -1;
    score += 4;
  }
  if (threshold.providerId) {
    if (threshold.providerId !== encounter.providerId) return -1;
    score += 2;
  }
  return score;
}

function pickBestThreshold(
  thresholds: ThresholdRow[],
  metric: AlertThresholdMetric,
  encounter: EncounterRow,
  status: EncounterStatus | null
) {
  let best: ThresholdRow | null = null;
  let bestScore = -1;

  for (const threshold of thresholds) {
    if (threshold.metric !== metric) continue;
    if (metric === AlertThresholdMetric.stage && threshold.status !== status) continue;
    if (metric === AlertThresholdMetric.overall_visit && threshold.status !== null) continue;

    const score = thresholdScore(threshold, encounter);
    if (score < 0) continue;

    if (score > bestScore) {
      best = threshold;
      bestScore = score;
    }
  }

  return best;
}

function levelForMinutes(minutes: number, threshold: ThresholdRow | null) {
  if (!threshold) return AlertLevel.Green;
  if (minutes >= threshold.redAtMin) return AlertLevel.Red;
  if (minutes >= threshold.yellowAtMin) return AlertLevel.Yellow;
  return AlertLevel.Green;
}

function maxLevel(levels: AlertLevel[]) {
  let current: AlertLevel = AlertLevel.Green;
  for (const level of levels) {
    if (levelRank[level] > levelRank[current]) {
      current = level;
    }
  }
  return current;
}

function shouldEscalate(minutes: number, threshold: ThresholdRow | null) {
  if (!threshold?.escalation2Min) return false;
  return minutes >= threshold.escalation2Min;
}

export async function refreshEncounterAlertStates(
  prisma: PrismaClient,
  options: {
    facilityId?: string | null;
    clinicIds?: string[];
    encounterIds?: string[];
    now?: Date;
  } = {}
) {
  const now = options.now || new Date();
  const clinicIds = (options.clinicIds || []).filter(Boolean);
  const encounterIds = (options.encounterIds || []).filter(Boolean);

  const where: Prisma.EncounterWhereInput = {
    currentStatus: { in: monitoredStatuses },
    ...(options.facilityId ? { clinic: { facilityId: options.facilityId } } : {}),
    ...(clinicIds.length > 0 ? { clinicId: { in: clinicIds } } : {}),
    ...(encounterIds.length > 0 ? { id: { in: encounterIds } } : {})
  };

  const encounters = await prisma.encounter.findMany({
    where,
    select: {
      id: true,
      patientId: true,
      clinicId: true,
      providerId: true,
      reasonForVisitId: true,
      currentStatus: true,
      checkInAt: true,
      roomingStartAt: true,
      roomingCompleteAt: true,
      providerStartAt: true,
      providerEndAt: true,
      clinic: { select: { facilityId: true } },
      alertState: {
        select: {
          enteredStatusAt: true,
          currentAlertLevel: true,
          yellowTriggeredAt: true,
          redTriggeredAt: true,
          escalationTriggeredAt: true
        }
      },
      safetyEvents: {
        where: { resolvedAt: null },
        select: { id: true },
        take: 1
      }
    }
  });

  if (encounters.length === 0) {
    return { scannedCount: 0, updatedCount: 0 };
  }

  const facilityIds = Array.from(new Set(encounters.map((row) => row.clinic.facilityId).filter(Boolean))) as string[];
  if (facilityIds.length === 0) {
    return { scannedCount: encounters.length, updatedCount: 0 };
  }

  const thresholdRows = await prisma.alertThreshold.findMany({
    where: {
      facilityId: { in: facilityIds }
    }
  });

  const thresholdsByFacility = new Map<string, ThresholdRow[]>();
  thresholdRows.forEach((row) => {
    if (!thresholdsByFacility.has(row.facilityId)) {
      thresholdsByFacility.set(row.facilityId, []);
    }
    thresholdsByFacility.get(row.facilityId)!.push(row as ThresholdRow);
  });

  let updatedCount = 0;
  const recipientCache = new Map<string, string[]>();

  await prisma.$transaction(async (tx) => {
    const resolveRecipients = async (facilityId: string, clinicId: string) => {
      const key = `${facilityId}:${clinicId}`;
      const cached = recipientCache.get(key);
      if (cached) return cached;
      const ids = await resolveAlertRecipientUserIds(
        {
          facilityId,
          clinicId
        },
        tx
      );
      recipientCache.set(key, ids);
      return ids;
    };

    const upsertThresholdAlerts = async (params: {
      recipients: string[];
      facilityId: string;
      clinicId: string;
      sourceVersionKey: string;
      encounterId: string;
      patientId: string;
      level: AlertLevel;
      status: EncounterStatus;
    }) => {
      for (const userId of params.recipients) {
        await tx.userAlertInbox.upsert({
          where: {
            userId_kind_sourceVersionKey: {
              userId,
              kind: AlertInboxKind.threshold,
              sourceVersionKey: params.sourceVersionKey
            }
          },
          create: {
            userId,
            facilityId: params.facilityId,
            clinicId: params.clinicId,
            kind: AlertInboxKind.threshold,
            sourceId: params.encounterId,
            sourceVersionKey: params.sourceVersionKey,
            title: `${params.level} threshold reached`,
            message: `Encounter ${params.patientId} reached ${params.level} threshold in ${params.status}.`,
            payloadJson: {
              encounterId: params.encounterId,
              patientId: params.patientId,
              clinicId: params.clinicId,
              level: params.level,
              status: params.status
            } as Prisma.InputJsonValue,
            status: AlertInboxStatus.active
          },
          update: {}
        });
      }
    };

    for (const encounter of encounters as EncounterRow[]) {
      const facilityId = encounter.clinic.facilityId;
      if (!facilityId) continue;

      const facilityThresholds = thresholdsByFacility.get(facilityId) || [];
      const stageThreshold = pickBestThreshold(
        facilityThresholds,
        AlertThresholdMetric.stage,
        encounter,
        encounter.currentStatus
      );
      const overallThreshold = pickBestThreshold(
        facilityThresholds,
        AlertThresholdMetric.overall_visit,
        encounter,
        null
      );

      const stageStart = encounter.alertState?.enteredStatusAt || fallbackStageStart(encounter);
      const stageMinutes = minutesElapsed(stageStart, now);
      const overallMinutes = minutesElapsed(encounter.checkInAt || stageStart, now);

      const stageLevel = levelForMinutes(stageMinutes, stageThreshold);
      const overallLevel = levelForMinutes(overallMinutes, overallThreshold);
      const safetyActive = encounter.safetyEvents.length > 0;
      const nextLevel = safetyActive ? AlertLevel.Red : maxLevel([stageLevel, overallLevel]);

      const escalateTriggered =
        safetyActive ||
        shouldEscalate(stageMinutes, stageThreshold) ||
        shouldEscalate(overallMinutes, overallThreshold);

      if (!encounter.alertState) {
        await tx.alertState.create({
          data: {
            encounterId: encounter.id,
            enteredStatusAt: stageStart || now,
            currentAlertLevel: nextLevel,
            yellowTriggeredAt: nextLevel !== AlertLevel.Green ? now : null,
            redTriggeredAt: nextLevel === AlertLevel.Red ? now : null,
            escalationTriggeredAt: escalateTriggered ? now : null
          }
        });
        updatedCount += 1;
        if (!safetyActive && (nextLevel === AlertLevel.Yellow || nextLevel === AlertLevel.Red)) {
          const recipients = await resolveRecipients(facilityId, encounter.clinicId);
          if (recipients.length > 0) {
            const sourceVersionKey = `threshold:${encounter.id}:${encounter.currentStatus}:${(stageStart || now).toISOString()}:${nextLevel}`;
            await upsertThresholdAlerts({
              recipients,
              facilityId,
              clinicId: encounter.clinicId,
              sourceVersionKey,
              encounterId: encounter.id,
              patientId: encounter.patientId,
              level: nextLevel,
              status: encounter.currentStatus
            });
          }
        }
        continue;
      }

      const needsYellowStamp = nextLevel !== AlertLevel.Green && !encounter.alertState.yellowTriggeredAt;
      const needsRedStamp = nextLevel === AlertLevel.Red && !encounter.alertState.redTriggeredAt;
      const needsEscalationStamp = escalateTriggered && !encounter.alertState.escalationTriggeredAt;
      const levelChanged = encounter.alertState.currentAlertLevel !== nextLevel;

      if (!needsYellowStamp && !needsRedStamp && !needsEscalationStamp && !levelChanged) {
        continue;
      }

      await tx.alertState.update({
        where: { encounterId: encounter.id },
        data: {
          currentAlertLevel: nextLevel,
          ...(needsYellowStamp ? { yellowTriggeredAt: now } : {}),
          ...(needsRedStamp ? { redTriggeredAt: now } : {}),
          ...(needsEscalationStamp ? { escalationTriggeredAt: now } : {})
        }
      });
      updatedCount += 1;
      if (
        !safetyActive &&
        levelChanged &&
        (nextLevel === AlertLevel.Yellow || nextLevel === AlertLevel.Red)
      ) {
        const recipients = await resolveRecipients(facilityId, encounter.clinicId);
        if (recipients.length > 0) {
          const sourceVersionKey = `threshold:${encounter.id}:${encounter.currentStatus}:${(stageStart || now).toISOString()}:${nextLevel}`;
          await upsertThresholdAlerts({
            recipients,
            facilityId,
            clinicId: encounter.clinicId,
            sourceVersionKey,
            encounterId: encounter.id,
            patientId: encounter.patientId,
            level: nextLevel,
            status: encounter.currentStatus
          });
        }
      }
    }
  });

  return {
    scannedCount: encounters.length,
    updatedCount
  };
}
