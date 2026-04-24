import {
  RoleName,
  RoomChecklistKind,
  RoomEventType,
  RoomHoldReason,
  RoomIssueStatus,
  RoomOperationalStatus
} from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { DateTime } from "luxon";
import { prisma } from "./prisma.js";
import { ApiError, requireCondition } from "./errors.js";
import type { RequestUser } from "./auth.js";
import { enterFacilityScope, runWithFacilityScope } from "./facility-scope.js";
import { listActiveTemporaryClinicOverrideIds } from "./assignment-overrides.js";

type RoomOpsTx = Prisma.TransactionClient;

type ScopedClinic = {
  id: string;
  name: string;
  facilityId: string | null;
  timezone: string;
};

type EncounterRoomCandidate = {
  id: string;
  clinicId: string;
  roomId: string | null;
};

function unique(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

export function currentRoomDateKey(timezone = "America/New_York") {
  return DateTime.now().setZone(timezone || "America/New_York").toISODate() || new Date().toISOString().slice(0, 10);
}

function elapsedMinutes(sinceAt?: Date | string | null) {
  if (!sinceAt) return 0;
  const since = typeof sinceAt === "string" ? new Date(sinceAt) : sinceAt;
  const ms = Date.now() - since.getTime();
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.floor(ms / 60000);
}

function formatTimer(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return `${hours}h ${rem}m`;
}

function isDayStartCompleted(checklistRuns: Array<{ kind: string; completed: boolean }>) {
  return checklistRuns.some((run) => run.kind === "DayStart" && run.completed);
}

function isDayEndCompleted(checklistRuns: Array<{ kind: string; completed: boolean }>) {
  return checklistRuns.some((run) => run.kind === "DayEnd" && run.completed);
}

function effectiveRoomStatus(currentStatus: RoomOperationalStatus, dayStartCompleted: boolean) {
  if (currentStatus === RoomOperationalStatus.Ready && !dayStartCompleted) {
    return RoomOperationalStatus.NotReady;
  }
  return currentStatus;
}

function readinessBlockedReason(
  currentStatus: RoomOperationalStatus,
  dayStartCompleted: boolean,
  hasStaleOccupancy = false,
) {
  if (hasStaleOccupancy) {
    return "Room has stale occupancy state";
  }
  if (currentStatus !== RoomOperationalStatus.Ready) {
    return `Room is ${currentStatus}`;
  }
  if (!dayStartCompleted) {
    return "Day Start checklist must be completed before rooming";
  }
  return null;
}

function readinessBlockedCode(
  currentStatus: RoomOperationalStatus,
  dayStartCompleted: boolean,
  hasStaleOccupancy = false,
) {
  if (hasStaleOccupancy) return "STALE_OCCUPANCY_STATE";
  if (!dayStartCompleted && currentStatus === RoomOperationalStatus.Ready) return "DAY_START_INCOMPLETE";
  if (currentStatus === RoomOperationalStatus.Hold) return "ROOM_HELD";
  if (currentStatus === RoomOperationalStatus.Occupied) return "ROOM_OCCUPIED";
  if (currentStatus === RoomOperationalStatus.NeedsTurnover) return "ROOM_NEEDS_TURNOVER";
  if (currentStatus === RoomOperationalStatus.NotReady) return "ROOM_NOT_READY";
  if (currentStatus !== RoomOperationalStatus.Ready) return "ROOM_NOT_ASSIGNABLE";
  return null;
}

function blockedReasonSummary(rooms: Array<{ readinessBlockedCode?: string | null; readinessBlockedReason?: string | null }>) {
  const byCode = new Map<string, { code: string; message: string; count: number }>();
  rooms.forEach((room) => {
    const code = room.readinessBlockedCode || "ROOM_NOT_ASSIGNABLE";
    const message = room.readinessBlockedReason || "Room is not assignable";
    const existing = byCode.get(code);
    if (existing) {
      existing.count += 1;
      return;
    }
    byCode.set(code, { code, message, count: 1 });
  });
  return Array.from(byCode.values());
}

export async function backfillRoomOperationalStates() {
  const activeRooms = await prisma.clinicRoom.findMany({
    where: { status: "active" },
    select: { id: true }
  });
  if (activeRooms.length === 0) return 0;
  const results = await prisma.$transaction(async (tx) =>
    Promise.all(
      activeRooms.map((room) =>
        tx.roomOperationalState.upsert({
          where: { roomId: room.id },
          create: {
            roomId: room.id,
            currentStatus: RoomOperationalStatus.Ready,
            lastReadyAt: new Date()
          },
          update: {}
        }),
      ),
    ),
  );
  return results.length;
}

export async function getRoomScopeClinicIds(user: RequestUser, requestedClinicId?: string | null) {
  const requested = requestedClinicId?.trim() || null;
  if (user.facilityId) {
    enterFacilityScope(user.facilityId);
  }
  const clinicWhere: Prisma.ClinicWhereInput = {
    status: { not: "archived" },
    ...(user.facilityId ? { facilityId: user.facilityId } : {})
  };

  if (requested) {
    const clinic = await prisma.clinic.findUnique({
      where: { id: requested },
      select: { id: true, facilityId: true, status: true }
    });
    requireCondition(clinic, 404, "Clinic not found", "CLINIC_NOT_FOUND");
    if (clinic.status === "archived") {
      throw new ApiError({ statusCode: 400, code: "CLINIC_ARCHIVED", message: "Clinic is archived" });
    }
    if (user.facilityId && clinic.facilityId !== user.facilityId) {
      throw new ApiError({
        statusCode: 403,
        code: "CLINIC_OUTSIDE_FACILITY_SCOPE",
        message: "Clinic is outside your facility scope",
      });
    }
    enterFacilityScope(clinic.facilityId || user.facilityId || null);
  }

  if (user.role === RoleName.Admin || user.role === RoleName.OfficeManager) {
    const clinics = await prisma.clinic.findMany({
      where: {
        ...clinicWhere,
        ...(requested ? { id: requested } : {})
      },
      select: { id: true }
    });
    enterFacilityScope(user.facilityId || null);
    return clinics.map((clinic) => clinic.id);
  }

  if (user.role !== RoleName.MA) {
    return user.clinicId && (!requested || requested === user.clinicId) ? [user.clinicId] : [];
  }

  const [maClinicMaps, clinicAssignments, temporaryOverrideClinicIds] = await Promise.all([
    prisma.maClinicMap.findMany({
      where: {
        maUserId: user.id,
        clinic: clinicWhere
      },
      select: { clinicId: true }
    }),
    prisma.clinicAssignment.findMany({
      where: {
        maUserId: user.id,
        clinic: clinicWhere
      },
      select: { clinicId: true }
    }),
    listActiveTemporaryClinicOverrideIds({
      userId: user.id,
      role: user.role,
      facilityId: user.facilityId
    })
  ]);

  let clinicIds = unique([
    user.clinicId,
    ...maClinicMaps.map((row) => row.clinicId),
    ...clinicAssignments.map((row) => row.clinicId),
    ...temporaryOverrideClinicIds
  ]);
  if (requested) clinicIds = clinicIds.filter((id) => id === requested);
  if (requested && clinicIds.length === 0) {
    throw new ApiError({
      statusCode: 403,
      code: "CLINIC_OUTSIDE_ROOM_SCOPE",
      message: "Clinic is outside your MA room scope",
    });
  }
  return clinicIds;
}

async function resolveRoomContext(params: {
  roomId: string;
  user: RequestUser;
  clinicId?: string | null;
}) {
  const clinicIds = await getRoomScopeClinicIds(params.user, params.clinicId);
  if (clinicIds.length === 0) {
    throw new ApiError({
      statusCode: 403,
      code: "ROOM_SCOPE_EMPTY",
      message: "No clinics are available in your room scope",
    });
  }

  const room = await prisma.clinicRoom.findFirst({
    where: {
      id: params.roomId,
      status: "active",
      clinicLinks: {
        some: {
          active: true,
          clinicId: { in: clinicIds }
        }
      }
    },
    include: {
      clinicLinks: {
        where: {
          active: true,
          clinicId: { in: clinicIds }
        },
        include: {
          clinic: {
            select: { id: true, name: true, facilityId: true, timezone: true }
          }
        },
        orderBy: { clinicId: "asc" }
      },
      operationalState: true
    }
  });
  requireCondition(room, 404, "Room not found in your scope", "ROOM_NOT_FOUND");
  const link = params.clinicId
    ? room.clinicLinks.find((entry) => entry.clinicId === params.clinicId)
    : room.clinicLinks[0];
  requireCondition(link?.clinic, 404, "Room is not linked to an active clinic", "ROOM_CLINIC_LINK_NOT_FOUND");
  const facilityId = link.clinic.facilityId || room.facilityId || params.user.facilityId;
  requireCondition(facilityId, 400, "Room is missing a facility scope", "ROOM_FACILITY_SCOPE_MISSING");

  return {
    room,
    clinic: link.clinic as ScopedClinic,
    facilityId
  };
}

export async function ensureRoomOperationalStateInTx(tx: RoomOpsTx, roomId: string) {
  return tx.roomOperationalState.upsert({
    where: { roomId },
    create: {
      roomId,
      currentStatus: RoomOperationalStatus.Ready,
      lastReadyAt: new Date()
    },
    update: {}
  });
}

export async function transitionRoomOperationalStateInTx(
  tx: RoomOpsTx,
  params: {
    roomId: string;
    clinicId: string;
    facilityId: string;
    toStatus: RoomOperationalStatus;
    eventType: RoomEventType;
    createdByUserId?: string | null;
    encounterId?: string | null;
    note?: string | null;
    metadata?: Record<string, unknown> | null;
    holdReason?: RoomHoldReason | null;
    holdNote?: string | null;
    allowedFrom?: RoomOperationalStatus[];
  }
) {
  const now = new Date();
  const state = await ensureRoomOperationalStateInTx(tx, params.roomId);
  if (params.allowedFrom && !params.allowedFrom.includes(state.currentStatus)) {
    throw new ApiError({
      statusCode: 409,
      code: "ROOM_STATUS_CONFLICT",
      message: `Room is ${state.currentStatus}, not available for this action.`,
    });
  }

  const data: Prisma.RoomOperationalStateUncheckedUpdateInput = {
    currentStatus: params.toStatus,
    statusSinceAt: now,
    updatedAt: now
  };

  if (params.toStatus === RoomOperationalStatus.Ready) {
    data.occupiedEncounterId = null;
    data.activeCleanerUserId = null;
    data.holdReason = null;
    data.holdNote = null;
    data.lastReadyAt = now;
  }

  if (params.toStatus === RoomOperationalStatus.Occupied) {
    data.occupiedEncounterId = params.encounterId || null;
    data.activeCleanerUserId = null;
    data.holdReason = null;
    data.holdNote = null;
    data.lastOccupiedAt = now;
  }

  if (params.toStatus === RoomOperationalStatus.NeedsTurnover) {
    data.occupiedEncounterId = null;
    data.activeCleanerUserId = null;
    data.lastTurnoverAt = now;
  }

  if (params.toStatus === RoomOperationalStatus.Hold) {
    data.holdReason = params.holdReason || RoomHoldReason.Manual;
    data.holdNote = params.holdNote || params.note || null;
  }

  const updated = await tx.roomOperationalState.update({
    where: { roomId: params.roomId },
    data
  });

  await tx.roomOperationalEvent.create({
    data: {
      roomId: params.roomId,
      clinicId: params.clinicId,
      facilityId: params.facilityId,
      encounterId: params.encounterId || null,
      eventType: params.eventType,
      fromStatus: state.currentStatus,
      toStatus: params.toStatus,
      note: params.note || null,
      metadataJson: params.metadata ? (params.metadata as Prisma.InputJsonValue) : undefined,
      createdByUserId: params.createdByUserId || null,
      occurredAt: now
    }
  });

  return updated;
}

export async function transitionRoomOperationalState(params: Parameters<typeof transitionRoomOperationalStateInTx>[1]) {
  return prisma.$transaction((tx) => transitionRoomOperationalStateInTx(tx, params));
}

export async function assertRoomAssignableForEncounter(params: {
  encounter: EncounterRoomCandidate;
  roomId: string;
  user: RequestUser;
}) {
  const context = await resolveRoomContext({
    roomId: params.roomId,
    user: params.user,
    clinicId: params.encounter.clinicId
  });
  requireCondition(context.room.status === "active", 400, "Room is inactive", "ROOM_INACTIVE");

  const state = context.room.operationalState || await prisma.roomOperationalState.create({
    data: {
      roomId: params.roomId,
      currentStatus: RoomOperationalStatus.Ready,
      lastReadyAt: new Date()
    }
  });

  if (state.currentStatus !== RoomOperationalStatus.Ready) {
    throw new ApiError({
      statusCode: 409,
      code: "ROOM_NOT_ASSIGNABLE",
      message: `Room ${context.room.name} is ${state.currentStatus} and cannot be assigned.`,
    });
  }

  const dateKey = currentRoomDateKey(context.clinic.timezone);
  const dayStart = await prisma.roomChecklistRun.findUnique({
    where: {
      roomId_kind_dateKey: {
        roomId: params.roomId,
        kind: RoomChecklistKind.DayStart,
        dateKey
      }
    },
    select: { completed: true }
  });
  if (!dayStart?.completed) {
    throw new ApiError({
      statusCode: 409,
      code: "ROOM_DAY_START_INCOMPLETE",
      message: `Room ${context.room.name} is not ready. Complete Day Start before rooming a patient.`,
    });
  }

  return { ...context, state };
}

export async function markEncounterRoomOccupiedInTx(tx: RoomOpsTx, params: {
  encounter: EncounterRoomCandidate;
  roomId: string;
  userId: string;
  facilityId: string;
}) {
  return transitionRoomOperationalStateInTx(tx, {
    roomId: params.roomId,
    clinicId: params.encounter.clinicId,
    facilityId: params.facilityId,
    toStatus: RoomOperationalStatus.Occupied,
    eventType: RoomEventType.AssignedToEncounter,
    encounterId: params.encounter.id,
    createdByUserId: params.userId,
    allowedFrom: [RoomOperationalStatus.Ready]
  });
}

export async function markEncounterRoomNeedsTurnoverInTx(tx: RoomOpsTx, params: {
  encounter: EncounterRoomCandidate;
  userId?: string | null;
}) {
  if (!params.encounter.roomId) return null;
  const assignment = await tx.clinicRoomAssignment.findFirst({
    where: {
      roomId: params.encounter.roomId,
      clinicId: params.encounter.clinicId,
      active: true
    },
    include: {
      clinic: { select: { facilityId: true } },
      room: { select: { facilityId: true } }
    }
  });
  if (!assignment) return null;
  const facilityId = assignment.clinic.facilityId || assignment.room.facilityId;
  if (!facilityId) return null;
  return transitionRoomOperationalStateInTx(tx, {
    roomId: params.encounter.roomId,
    clinicId: params.encounter.clinicId,
    facilityId,
    toStatus: RoomOperationalStatus.NeedsTurnover,
    eventType: RoomEventType.PatientLeftForCheckout,
    encounterId: params.encounter.id,
    createdByUserId: params.userId || null
  });
}

export async function markEncounterRoomNeedsTurnover(params: {
  encounter: EncounterRoomCandidate;
  userId?: string | null;
}) {
  return prisma.$transaction((tx) => markEncounterRoomNeedsTurnoverInTx(tx, params));
}

export async function listRoomCards(params: {
  user: RequestUser;
  clinicId?: string | null;
  dateKey?: string;
}) {
  const clinicIds = await getRoomScopeClinicIds(params.user, params.clinicId);
  if (clinicIds.length === 0) return [];

  const assignments = await prisma.clinicRoomAssignment.findMany({
    where: {
      active: true,
      clinicId: { in: clinicIds },
      room: { status: "active" }
    },
    include: {
      clinic: { select: { id: true, name: true, facilityId: true, timezone: true } },
      room: {
        include: {
          operationalState: {
            include: {
              occupiedEncounter: {
                select: {
                  id: true,
                  patientId: true,
                  currentStatus: true,
                  roomId: true
                }
              }
            }
          },
          roomIssues: {
            where: { status: { in: [RoomIssueStatus.Open, RoomIssueStatus.Acknowledged] } },
            select: { id: true, status: true, placesRoomOnHold: true }
          },
          checklistRuns: {
            where: params.dateKey ? { dateKey: params.dateKey } : undefined,
            select: { kind: true, completed: true, dateKey: true }
          }
        }
      }
    },
    orderBy: [
      { clinic: { name: "asc" } },
      { room: { roomNumber: "asc" } },
      { room: { name: "asc" } }
    ]
  });

  const missingStateRoomIds = assignments
    .filter((assignment) => !assignment.room.operationalState)
    .map((assignment) => assignment.roomId);
  if (missingStateRoomIds.length > 0) {
    const createdStates = await prisma.$transaction(async (tx) =>
      Promise.all(
        unique(missingStateRoomIds).map((roomId) =>
          tx.roomOperationalState.upsert({
            where: { roomId },
            create: {
              roomId,
              currentStatus: RoomOperationalStatus.Ready,
              lastReadyAt: new Date()
            },
            update: {}
          }),
        ),
      ),
    );
    const stateByRoomId = new Map(createdStates.map((state) => [state.roomId, state]));
    assignments.forEach((assignment) => {
      if (!assignment.room.operationalState) {
        const state = stateByRoomId.get(assignment.roomId);
        if (state) {
          assignment.room.operationalState = { ...state, occupiedEncounter: null };
        }
      }
    });
  }

  return assignments.map((assignment) => {
    const state = assignment.room.operationalState;
    const currentStatus = state?.currentStatus || RoomOperationalStatus.Ready;
    const dateKey = params.dateKey || currentRoomDateKey(assignment.clinic.timezone);
    const todaysChecklistRuns = assignment.room.checklistRuns.filter((run) => run.dateKey === dateKey);
    const dayStartCompleted = isDayStartCompleted(todaysChecklistRuns);
    const dayEndCompleted = isDayEndCompleted(todaysChecklistRuns);
    const hasStaleOccupancy = currentStatus === RoomOperationalStatus.Ready && Boolean(state?.occupiedEncounter);
    const operationalStatus = effectiveRoomStatus(currentStatus, dayStartCompleted);
    const blockedReason = readinessBlockedReason(currentStatus, dayStartCompleted, hasStaleOccupancy);
    const blockedCode = readinessBlockedCode(currentStatus, dayStartCompleted, hasStaleOccupancy);
    const minutesInStatus = elapsedMinutes(state?.statusSinceAt || new Date());
    return {
      id: `${assignment.clinicId}:${assignment.roomId}`,
      roomId: assignment.roomId,
      name: assignment.room.name,
      roomNumber: assignment.room.roomNumber,
      roomType: assignment.room.roomType,
      clinicId: assignment.clinicId,
      clinicName: assignment.clinic.name,
      facilityId: assignment.clinic.facilityId || assignment.room.facilityId,
      operationalStatus,
      actualOperationalStatus: currentStatus,
      statusSinceAt: state?.statusSinceAt || new Date(),
      minutesInStatus,
      timerLabel: formatTimer(minutesInStatus),
      currentEncounter: state?.occupiedEncounter
        ? {
            id: state.occupiedEncounter.id,
            patientId: state.occupiedEncounter.patientId,
            currentStatus: state.occupiedEncounter.currentStatus
          }
        : null,
      issueCount: assignment.room.roomIssues.length,
      hasOpenIssue: assignment.room.roomIssues.length > 0,
      holdReason: state?.holdReason || null,
      holdNote: state?.holdNote || null,
      dayStartCompleted,
      dayEndCompleted,
      assignable: currentStatus === RoomOperationalStatus.Ready && dayStartCompleted && !hasStaleOccupancy,
      readinessBlockedCode: blockedCode,
      readinessBlockedReason: blockedReason,
      lowStock: false,
      auditDue: false
    };
  });
}

export async function getRoomDetail(params: {
  roomId: string;
  user: RequestUser;
  clinicId?: string | null;
}) {
  const context = await resolveRoomContext(params);
  const dateKey = currentRoomDateKey(context.clinic.timezone);
  const [state, events, issues, checklistRuns] = await Promise.all([
    prisma.roomOperationalState.findUnique({
      where: { roomId: params.roomId },
      include: {
        occupiedEncounter: {
          select: { id: true, patientId: true, currentStatus: true, roomId: true }
        }
      }
    }),
    prisma.roomOperationalEvent.findMany({
      where: { roomId: params.roomId, clinicId: context.clinic.id },
      orderBy: { occurredAt: "desc" },
      take: 25
    }),
    prisma.roomIssue.findMany({
      where: { roomId: params.roomId, clinicId: context.clinic.id },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 25
    }),
    prisma.roomChecklistRun.findMany({
      where: { roomId: params.roomId, clinicId: context.clinic.id, dateKey },
      orderBy: { startedAt: "desc" }
    })
  ]);

  return {
    room: {
      id: context.room.id,
      name: context.room.name,
      roomNumber: context.room.roomNumber,
      roomType: context.room.roomType,
      facilityId: context.facilityId,
      clinicId: context.clinic.id,
      clinicName: context.clinic.name
    },
    operationalState: state || {
      roomId: params.roomId,
      currentStatus: RoomOperationalStatus.NotReady,
      statusSinceAt: new Date(),
      occupiedEncounterId: null,
      activeCleanerUserId: null,
      holdReason: null,
      holdNote: null,
      lastReadyAt: null,
      lastOccupiedAt: null,
      lastTurnoverAt: null
    },
    dayStartCompleted: checklistRuns.some((run) => run.kind === "DayStart" && run.completed),
    dayEndCompleted: checklistRuns.some((run) => run.kind === "DayEnd" && run.completed),
    events,
    issues,
    checklistRuns,
    placeholders: {
      supplies: "Coming later",
      audits: "Coming later"
    }
  };
}

export async function getPreRoomingAvailability(params: {
  user: RequestUser;
  encounterId: string;
}) {
  return runWithFacilityScope(params.user.activeFacilityId || params.user.facilityId || null, async () => {
    const encounter = await prisma.encounter.findUnique({
      where: { id: params.encounterId },
      select: {
        id: true,
        clinicId: true,
        roomId: true,
        currentStatus: true,
        clinic: { select: { timezone: true } },
      }
    });
    requireCondition(encounter, 404, "Encounter not found", "ENCOUNTER_NOT_FOUND");
    let rooms: Awaited<ReturnType<typeof listRoomCards>>;
    try {
      rooms = await listRoomCards({
        user: params.user,
        clinicId: encounter.clinicId,
        dateKey: currentRoomDateKey(encounter.clinic.timezone),
      });
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 403) {
        return {
          encounterId: encounter.id,
          readyCount: 0,
          preferredRoomId: null,
          lastReadyRoom: false,
          blocked: true,
          blockedReasons: [
            {
              code: error.code || "ROOM_SCOPE_BLOCKED",
              message: error.message || "No rooms are available in your room scope",
              count: 1,
            },
          ],
          rooms: [],
        };
      }
      throw error;
    }
    const readyRooms = rooms.filter((room) => room.assignable);
    const blockedRooms = rooms.filter((room) => !room.assignable);
    return {
      encounterId: encounter.id,
      readyCount: readyRooms.length,
      preferredRoomId: readyRooms.length === 1 ? readyRooms[0]?.roomId || null : null,
      lastReadyRoom: readyRooms.length === 1,
      blocked: readyRooms.length === 0,
      blockedReasons: readyRooms.length > 0
        ? []
        : rooms.length === 0
          ? [{ code: "NO_ROOMS_IN_SCOPE", message: "No active rooms are available in your clinic scope.", count: 1 }]
          : blockedReasonSummary(blockedRooms),
      rooms
    };
  });
}

export async function resolveRoomActionContext(params: {
  roomId: string;
  user: RequestUser;
  clinicId?: string | null;
}) {
  return resolveRoomContext(params);
}
