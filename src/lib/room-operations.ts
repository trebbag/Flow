import {
  RoleName,
  RoomEventType,
  RoomHoldReason,
  RoomIssueStatus,
  RoomOperationalStatus
} from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { ApiError, assert } from "./errors.js";
import type { RequestUser } from "./auth.js";

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

function currentDateKey() {
  return new Date().toISOString().slice(0, 10);
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

export async function backfillRoomOperationalStates() {
  const activeRooms = await prisma.clinicRoom.findMany({
    where: { status: "active" },
    select: { id: true }
  });
  if (activeRooms.length === 0) return 0;
  const results = await prisma.$transaction(
    activeRooms.map((room) =>
      prisma.roomOperationalState.upsert({
        where: { roomId: room.id },
        create: {
          roomId: room.id,
          currentStatus: RoomOperationalStatus.Ready,
          lastReadyAt: new Date()
        },
        update: {}
      })
    )
  );
  return results.length;
}

export async function getRoomScopeClinicIds(user: RequestUser, requestedClinicId?: string | null) {
  const requested = requestedClinicId?.trim() || null;
  const clinicWhere: Prisma.ClinicWhereInput = {
    status: { not: "archived" },
    ...(user.facilityId ? { facilityId: user.facilityId } : {})
  };

  if (requested) {
    const clinic = await prisma.clinic.findUnique({
      where: { id: requested },
      select: { id: true, facilityId: true, status: true }
    });
    assert(clinic, 404, "Clinic not found");
    if (clinic.status === "archived") {
      throw new ApiError(400, "Clinic is archived");
    }
    if (user.facilityId && clinic.facilityId !== user.facilityId) {
      throw new ApiError(403, "Clinic is outside your facility scope");
    }
  }

  if (user.role === RoleName.Admin || user.role === RoleName.OfficeManager) {
    const clinics = await prisma.clinic.findMany({
      where: {
        ...clinicWhere,
        ...(requested ? { id: requested } : {})
      },
      select: { id: true }
    });
    return clinics.map((clinic) => clinic.id);
  }

  if (user.role !== RoleName.MA) {
    return user.clinicId && (!requested || requested === user.clinicId) ? [user.clinicId] : [];
  }

  const [maClinicMaps, clinicAssignments] = await Promise.all([
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
    })
  ]);

  let clinicIds = unique([
    user.clinicId,
    ...maClinicMaps.map((row) => row.clinicId),
    ...clinicAssignments.map((row) => row.clinicId)
  ]);
  if (requested) clinicIds = clinicIds.filter((id) => id === requested);
  if (requested && clinicIds.length === 0) {
    throw new ApiError(403, "Clinic is outside your MA room scope");
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
    throw new ApiError(403, "No clinics are available in your room scope");
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
  assert(room, 404, "Room not found in your scope");
  const link = params.clinicId
    ? room.clinicLinks.find((entry) => entry.clinicId === params.clinicId)
    : room.clinicLinks[0];
  assert(link?.clinic, 404, "Room is not linked to an active clinic");
  const facilityId = link.clinic.facilityId || room.facilityId || params.user.facilityId;
  assert(facilityId, 400, "Room is missing a facility scope");

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
    throw new ApiError(409, `Room is ${state.currentStatus}, not available for this action.`);
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

  if (params.toStatus === RoomOperationalStatus.Cleaning) {
    data.activeCleanerUserId = params.createdByUserId || null;
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
  assert(context.room.status === "active", 400, "Room is inactive");

  const state = context.room.operationalState || await prisma.roomOperationalState.create({
    data: {
      roomId: params.roomId,
      currentStatus: RoomOperationalStatus.Ready,
      lastReadyAt: new Date()
    }
  });

  if (state.currentStatus !== RoomOperationalStatus.Ready) {
    throw new ApiError(409, `Room ${context.room.name} is ${state.currentStatus} and cannot be assigned.`);
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

export async function markEncounterRoomNeedsTurnover(params: {
  encounter: EncounterRoomCandidate;
  userId?: string | null;
}) {
  if (!params.encounter.roomId) return null;
  const assignment = await prisma.clinicRoomAssignment.findFirst({
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
  return transitionRoomOperationalState({
    roomId: params.encounter.roomId,
    clinicId: params.encounter.clinicId,
    facilityId,
    toStatus: RoomOperationalStatus.NeedsTurnover,
    eventType: RoomEventType.PatientLeftForCheckout,
    encounterId: params.encounter.id,
    createdByUserId: params.userId || null
  });
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
      clinic: { select: { id: true, name: true, facilityId: true } },
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
            where: { dateKey: params.dateKey || currentDateKey() },
            select: { kind: true, completed: true }
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
    await prisma.$transaction(
      unique(missingStateRoomIds).map((roomId) =>
        prisma.roomOperationalState.upsert({
          where: { roomId },
          create: {
            roomId,
            currentStatus: RoomOperationalStatus.Ready,
            lastReadyAt: new Date()
          },
          update: {}
        })
      )
    );
  }

  return assignments.map((assignment) => {
    const state = assignment.room.operationalState;
    const currentStatus = state?.currentStatus || RoomOperationalStatus.Ready;
    const minutesInStatus = elapsedMinutes(state?.statusSinceAt || new Date());
    const dayStartCompleted = assignment.room.checklistRuns.some((run) => run.kind === "DayStart" && run.completed);
    const dayEndCompleted = assignment.room.checklistRuns.some((run) => run.kind === "DayEnd" && run.completed);
    return {
      id: `${assignment.clinicId}:${assignment.roomId}`,
      roomId: assignment.roomId,
      name: assignment.room.name,
      roomNumber: assignment.room.roomNumber,
      roomType: assignment.room.roomType,
      clinicId: assignment.clinicId,
      clinicName: assignment.clinic.name,
      facilityId: assignment.clinic.facilityId || assignment.room.facilityId,
      operationalStatus: currentStatus,
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
  const dateKey = currentDateKey();
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
      currentStatus: RoomOperationalStatus.Ready,
      statusSinceAt: new Date(),
      occupiedEncounterId: null,
      activeCleanerUserId: null,
      holdReason: null,
      holdNote: null,
      lastReadyAt: null,
      lastOccupiedAt: null,
      lastTurnoverAt: null
    },
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
  const encounter = await prisma.encounter.findUnique({
    where: { id: params.encounterId },
    select: { id: true, clinicId: true, roomId: true, currentStatus: true }
  });
  assert(encounter, 404, "Encounter not found");
  const rooms = await listRoomCards({ user: params.user, clinicId: encounter.clinicId });
  const readyRooms = rooms.filter((room) => room.operationalStatus === RoomOperationalStatus.Ready);
  return {
    encounterId: encounter.id,
    readyCount: readyRooms.length,
    preferredRoomId: readyRooms.length === 1 ? readyRooms[0]?.roomId || null : null,
    lastReadyRoom: readyRooms.length === 1,
    blocked: readyRooms.length === 0,
    rooms
  };
}

export async function resolveRoomActionContext(params: {
  roomId: string;
  user: RequestUser;
  clinicId?: string | null;
}) {
  return resolveRoomContext(params);
}
