import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  AlertInboxKind,
  RoleName,
  RoomChecklistKind,
  RoomEventType,
  RoomHoldReason,
  RoomIssueStatus,
  RoomIssueType,
  RoomOperationalStatus,
  TaskSourceType,
  TaskStatus
} from "@prisma/client";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ApiError, requireCondition } from "../lib/errors.js";
import { requireRoles } from "../lib/auth.js";
import { createInboxAlert } from "../lib/user-alert-inbox.js";
import { flushOperationalOutbox, persistMutationOperationalEventTx } from "../lib/operational-events.js";
import { recordEntityEventTx } from "../lib/entity-events.js";
import { booleanish } from "../lib/zod-helpers.js";
import {
  getPreRoomingAvailability,
  getRoomDetail,
  getRoomScopeClinicIds,
  listRoomCards,
  currentRoomDateKey,
  resolveRoomActionContext,
  transitionRoomOperationalStateInTx
} from "../lib/room-operations.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

const roomsLiveQuerySchema = z.object({
  mine: booleanish.optional(),
  clinicId: z.string().uuid().optional()
});

const roomDetailQuerySchema = z.object({
  clinicId: z.string().uuid().optional()
});

const preRoomingSchema = z.object({
  encounterId: z.string().uuid()
});

const holdSchema = z.object({
  clinicId: z.string().uuid().optional(),
  reason: z.nativeEnum(RoomHoldReason).default(RoomHoldReason.Manual),
  note: z.string().max(1000).optional()
});

const clearHoldSchema = z.object({
  clinicId: z.string().uuid().optional(),
  targetStatus: z.enum([RoomOperationalStatus.Ready, RoomOperationalStatus.NeedsTurnover]).default(RoomOperationalStatus.Ready),
  note: z.string().max(1000).optional()
});

const actionClinicSchema = z.object({
  clinicId: z.string().uuid().optional(),
  note: z.string().max(1000).optional()
});

const createIssueSchema = z.object({
  clinicId: z.string().uuid().optional(),
  encounterId: z.string().uuid().optional(),
  issueType: z.nativeEnum(RoomIssueType).default(RoomIssueType.General),
  severity: z.number().int().min(0).max(5).default(0),
  title: z.string().trim().min(1),
  description: z.string().trim().max(5000).optional(),
  placesRoomOnHold: z.boolean().default(false),
  sourceModule: z.string().trim().max(80).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const updateIssueSchema = z.object({
  status: z.nativeEnum(RoomIssueStatus).optional(),
  severity: z.number().int().min(0).max(5).optional(),
  title: z.string().trim().min(1).optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  resolutionNote: z.string().trim().max(5000).optional(),
  expectedVersion: z.number().int().nonnegative().optional()
});

const issueQuerySchema = z.object({
  roomId: z.string().uuid().optional(),
  clinicId: z.string().uuid().optional(),
  status: z.nativeEnum(RoomIssueStatus).optional(),
  includeResolved: booleanish.optional()
});

const checklistRunSchema = z.object({
  roomId: z.string().uuid(),
  clinicId: z.string().uuid().optional(),
  dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  items: z.array(z.record(z.string(), z.unknown())).optional(),
  completed: z.boolean().default(true),
  note: z.string().trim().max(5000).optional()
});

const checklistQuerySchema = z.object({
  roomId: z.string().uuid().optional(),
  clinicId: z.string().uuid().optional(),
  dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  kind: z.enum(["DayStart", "DayEnd"]).optional()
});

async function createOfficeManagerTaskAlert(params: {
  taskId: string;
  issueId: string;
  roomId: string;
  roomName: string;
  clinicId: string;
  facilityId: string;
  title: string;
}, db: DbClient = prisma) {
  await createInboxAlert({
    facilityId: params.facilityId,
    clinicId: params.clinicId,
    kind: AlertInboxKind.task,
    sourceId: params.taskId,
    sourceVersionKey: `task:${params.taskId}:role:${RoleName.OfficeManager}`,
    title: "Room issue needs follow-up",
    message: `${params.roomName}: ${params.title}`,
    payload: {
      taskId: params.taskId,
      issueId: params.issueId,
      roomId: params.roomId,
      clinicId: params.clinicId
    },
    roles: [RoleName.OfficeManager]
  }, db);
}

async function recordRoomMutationTx(params: {
  tx: Prisma.TransactionClient;
  request: FastifyRequest;
  entityType: string;
  entityId: string;
}) {
  await persistMutationOperationalEventTx({
    db: params.tx,
    request: params.request,
    entityType: params.entityType,
    entityId: params.entityId,
  });
}

export async function registerRoomRoutes(app: FastifyInstance) {
  const guard = requireRoles(RoleName.Admin, RoleName.OfficeManager, RoleName.MA);

  app.get("/rooms/live", { preHandler: guard }, async (request) => {
    const query = roomsLiveQuerySchema.parse(request.query);
    return listRoomCards({
      user: request.user!,
      clinicId: query.clinicId || null
    });
  });

  app.post("/rooms/pre-rooming-check", { preHandler: requireRoles(RoleName.Admin, RoleName.MA) }, async (request) => {
    const dto = preRoomingSchema.parse(request.body);
    return getPreRoomingAvailability({ user: request.user!, encounterId: dto.encounterId });
  });

  app.get("/rooms/issues", { preHandler: guard }, async (request) => {
    const query = issueQuerySchema.parse(request.query);
    const clinicIds = await getRoomScopeClinicIds(request.user!, query.clinicId || null);
    if (clinicIds.length === 0) return [];
    return prisma.roomIssue.findMany({
      where: {
        clinicId: { in: clinicIds },
        roomId: query.roomId,
        status: query.status || (query.includeResolved ? undefined : { in: [RoomIssueStatus.Open, RoomIssueStatus.Acknowledged] })
      },
      include: {
        room: { select: { id: true, name: true, roomNumber: true } },
        task: { select: { id: true, status: true, assignedToRole: true, assignedToUserId: true } }
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }]
    });
  });

  app.get("/rooms/checklists", { preHandler: guard }, async (request) => {
    const query = checklistQuerySchema.parse(request.query);
    const clinicIds = await getRoomScopeClinicIds(request.user!, query.clinicId || null);
    if (clinicIds.length === 0) return [];
    return prisma.roomChecklistRun.findMany({
      where: {
        clinicId: { in: clinicIds },
        roomId: query.roomId,
        dateKey: query.dateKey,
        kind: query.kind
      },
      include: { room: { select: { id: true, name: true, roomNumber: true } } },
      orderBy: [{ dateKey: "desc" }, { startedAt: "desc" }]
    });
  });

  app.get("/rooms/:id", { preHandler: guard }, async (request) => {
    const roomId = (request.params as { id: string }).id;
    const query = roomDetailQuerySchema.parse(request.query);
    return getRoomDetail({ roomId, user: request.user!, clinicId: query.clinicId || null });
  });

  app.post("/rooms/:id/actions/start-cleaning", { preHandler: guard }, async () => {
    throw new ApiError(410, "Cleaning status has been removed. Use Mark ready after turnover is complete.");
  });

  app.post("/rooms/:id/actions/mark-ready", { preHandler: guard }, async (request) => {
    const roomId = (request.params as { id: string }).id;
    const dto = actionClinicSchema.parse(request.body || {});
    const context = await resolveRoomActionContext({ roomId, user: request.user!, clinicId: dto.clinicId || null });
    const dateKey = currentRoomDateKey(context.clinic.timezone);
    const updated = await prisma.$transaction(async (tx) => {
      const dayStart = await tx.roomChecklistRun.findUnique({
        where: {
          roomId_kind_dateKey: {
            roomId,
            kind: RoomChecklistKind.DayStart,
            dateKey
          }
        },
        select: { completed: true }
      });
      if (!dayStart?.completed) {
        throw new ApiError(409, "Complete the Day Start checklist before marking this room ready.");
      }

      const result = await transitionRoomOperationalStateInTx(tx, {
        roomId,
        clinicId: context.clinic.id,
        facilityId: context.facilityId,
        toStatus: RoomOperationalStatus.Ready,
        eventType: RoomEventType.MarkedReady,
        createdByUserId: request.user!.id,
        note: dto.note || null,
        allowedFrom: [RoomOperationalStatus.NeedsTurnover, RoomOperationalStatus.NotReady, RoomOperationalStatus.Ready]
      });
      await recordRoomMutationTx({
        tx,
        request,
        entityType: "Room",
        entityId: roomId,
      });
      return result;
    });
    await flushOperationalOutbox(prisma);
    return updated;
  });

  app.post("/rooms/:id/actions/place-hold", { preHandler: guard }, async (request) => {
    const roomId = (request.params as { id: string }).id;
    const dto = holdSchema.parse(request.body || {});
    const context = await resolveRoomActionContext({ roomId, user: request.user!, clinicId: dto.clinicId || null });
    const updated = await prisma.$transaction(async (tx) => {
      const result = await transitionRoomOperationalStateInTx(tx, {
        roomId,
        clinicId: context.clinic.id,
        facilityId: context.facilityId,
        toStatus: RoomOperationalStatus.Hold,
        eventType: RoomEventType.HoldPlaced,
        createdByUserId: request.user!.id,
        note: dto.note || null,
        holdReason: dto.reason,
        holdNote: dto.note || null
      });
      await recordRoomMutationTx({
        tx,
        request,
        entityType: "Room",
        entityId: roomId,
      });
      return result;
    });
    await flushOperationalOutbox(prisma);
    return updated;
  });

  app.post("/rooms/:id/actions/clear-hold", { preHandler: guard }, async (request) => {
    const roomId = (request.params as { id: string }).id;
    const dto = clearHoldSchema.parse(request.body || {});
    const context = await resolveRoomActionContext({ roomId, user: request.user!, clinicId: dto.clinicId || null });
    const updated = await prisma.$transaction(async (tx) => {
      const result = await transitionRoomOperationalStateInTx(tx, {
        roomId,
        clinicId: context.clinic.id,
        facilityId: context.facilityId,
        toStatus: dto.targetStatus,
        eventType: RoomEventType.HoldCleared,
        createdByUserId: request.user!.id,
        note: dto.note || null,
        allowedFrom: [RoomOperationalStatus.Hold]
      });
      await recordRoomMutationTx({
        tx,
        request,
        entityType: "Room",
        entityId: roomId,
      });
      return result;
    });
    await flushOperationalOutbox(prisma);
    return updated;
  });

  app.post("/rooms/:id/issues", { preHandler: guard }, async (request) => {
    const roomId = (request.params as { id: string }).id;
    const dto = createIssueSchema.parse(request.body || {});
    const context = await resolveRoomActionContext({ roomId, user: request.user!, clinicId: dto.clinicId || null });

    if (dto.encounterId) {
      const encounter = await prisma.encounter.findFirst({
        where: { id: dto.encounterId, clinicId: context.clinic.id },
        select: { id: true }
      });
      requireCondition(encounter, 400, "Encounter is not in this room clinic scope");
    }

    const result = await prisma.$transaction(async (tx) => {
      const issue = await tx.roomIssue.create({
        data: {
          roomId,
          clinicId: context.clinic.id,
          facilityId: context.facilityId,
          encounterId: dto.encounterId || null,
          issueType: dto.issueType,
          severity: dto.severity,
          title: dto.title,
          description: dto.description || null,
          placesRoomOnHold: dto.placesRoomOnHold,
          sourceModule: dto.sourceModule || "rooms",
          metadataJson: dto.metadata ? (dto.metadata as Prisma.InputJsonValue) : undefined,
          createdByUserId: request.user!.id
        }
      });

      const task = await tx.task.create({
        data: {
          facilityId: context.facilityId,
          clinicId: context.clinic.id,
          roomId,
          encounterId: dto.encounterId || null,
          sourceType: TaskSourceType.RoomIssue,
          sourceId: issue.id,
          taskType: "RoomIssue",
          description: `${context.room.name}: ${dto.title}`,
          assignedToRole: RoleName.OfficeManager,
          status: TaskStatus.open,
          priority: dto.severity,
          blocking: dto.placesRoomOnHold,
          createdBy: request.user!.id
        }
      });

      const linkedIssue = await tx.roomIssue.update({
        where: { id: issue.id },
        data: { taskId: task.id }
      });

      if (dto.placesRoomOnHold) {
        await transitionRoomOperationalStateInTx(tx, {
          roomId,
          clinicId: context.clinic.id,
          facilityId: context.facilityId,
          toStatus: RoomOperationalStatus.Hold,
          eventType: RoomEventType.IssueCreated,
          encounterId: dto.encounterId || null,
          createdByUserId: request.user!.id,
          note: dto.title,
          holdReason: RoomHoldReason.Equipment,
          holdNote: dto.title,
          metadata: { issueId: issue.id, taskId: task.id }
        });
      } else {
        await tx.roomOperationalEvent.create({
          data: {
            roomId,
            clinicId: context.clinic.id,
            facilityId: context.facilityId,
            encounterId: dto.encounterId || null,
            eventType: RoomEventType.IssueCreated,
            fromStatus: context.room.operationalState?.currentStatus || RoomOperationalStatus.Ready,
            toStatus: context.room.operationalState?.currentStatus || RoomOperationalStatus.Ready,
            note: dto.title,
            metadataJson: { issueId: issue.id, taskId: task.id } as Prisma.InputJsonValue,
            createdByUserId: request.user!.id
          }
        });
      }

      await createOfficeManagerTaskAlert({
        taskId: task.id,
        issueId: linkedIssue.id,
        roomId,
        roomName: context.room.name,
        clinicId: context.clinic.id,
        facilityId: context.facilityId,
        title: dto.title
      }, tx);

      await recordRoomMutationTx({
        tx,
        request,
        entityType: "RoomIssue",
        entityId: linkedIssue.id,
      });

      await recordEntityEventTx({
        db: tx,
        request,
        entityType: "RoomIssue",
        entityId: linkedIssue.id,
        eventType: "room_issue.created",
        after: linkedIssue,
        facilityId: linkedIssue.facilityId,
        clinicId: linkedIssue.clinicId,
      });

      return { issue: linkedIssue, task };
    });
    await flushOperationalOutbox(prisma);
    return result;
  });

  app.patch("/rooms/issues/:issueId", { preHandler: guard }, async (request) => {
    const issueId = (request.params as { issueId: string }).issueId;
    const dto = updateIssueSchema.parse(request.body || {});
    const issue = await prisma.roomIssue.findUnique({ where: { id: issueId } });
    requireCondition(issue, 404, "Room issue not found");
    const clinicIds = await getRoomScopeClinicIds(request.user!, issue.clinicId);
    if (!clinicIds.includes(issue.clinicId)) {
      throw new ApiError(403, "Issue is outside your room scope");
    }

    const resolved = dto.status === RoomIssueStatus.Resolved;
    const updated = await prisma.$transaction(async (tx) => {
      const versionFilter: Prisma.RoomIssueWhereInput =
        dto.expectedVersion !== undefined ? { version: dto.expectedVersion } : {};
      const updateResult = await tx.roomIssue.updateMany({
        where: { id: issueId, ...versionFilter },
        data: {
          status: dto.status,
          severity: dto.severity,
          title: dto.title,
          description: dto.description === undefined ? undefined : dto.description,
          resolutionNote: dto.resolutionNote,
          resolvedAt: resolved ? new Date() : undefined,
          resolvedByUserId: resolved ? request.user!.id : undefined,
          version: { increment: 1 }
        }
      });
      if (updateResult.count === 0) {
        throw new ApiError({ statusCode: 409, code: "VERSION_MISMATCH", message: "Room issue version mismatch" });
      }
      const row = await tx.roomIssue.findUniqueOrThrow({ where: { id: issueId } });

      if (resolved) {
        await tx.roomOperationalEvent.create({
          data: {
            roomId: issue.roomId,
            clinicId: issue.clinicId,
            facilityId: issue.facilityId,
            encounterId: issue.encounterId,
            eventType: RoomEventType.IssueResolved,
            note: dto.resolutionNote || null,
            metadataJson: { issueId } as Prisma.InputJsonValue,
            createdByUserId: request.user!.id
          }
        });
      }

      await recordRoomMutationTx({
        tx,
        request,
        entityType: "RoomIssue",
        entityId: issueId,
      });

      await recordEntityEventTx({
        db: tx,
        request,
        entityType: "RoomIssue",
        entityId: issueId,
        eventType: resolved ? "room_issue.resolved" : "room_issue.updated",
        before: issue,
        after: row,
        facilityId: row.facilityId,
        clinicId: row.clinicId,
      });

      return row;
    });
    await flushOperationalOutbox(prisma);
    return updated;
  });

  async function upsertChecklist(kind: RoomChecklistKind, request: FastifyRequest) {
    const dto = checklistRunSchema.parse(request.body || {});
    const context = await resolveRoomActionContext({ roomId: dto.roomId, user: request.user!, clinicId: dto.clinicId || null });
    const dateKey = dto.dateKey || currentRoomDateKey(context.clinic.timezone);
    const eventType = kind === "DayStart" ? RoomEventType.DayStartCompleted : RoomEventType.DayEndCompleted;
    return prisma.$transaction(async (tx) => {
      const run = await tx.roomChecklistRun.upsert({
        where: {
          roomId_kind_dateKey: {
            roomId: dto.roomId,
            kind,
            dateKey
          }
        },
        create: {
          roomId: dto.roomId,
          clinicId: context.clinic.id,
          facilityId: context.facilityId,
          kind,
          dateKey,
          itemsJson: (dto.items || []) as Prisma.InputJsonValue,
          completed: dto.completed,
          completedAt: dto.completed ? new Date() : null,
          completedByUserId: dto.completed ? request.user!.id : null,
          note: dto.note || null
        },
        update: {
          itemsJson: (dto.items || []) as Prisma.InputJsonValue,
          completed: dto.completed,
          completedAt: dto.completed ? new Date() : null,
          completedByUserId: dto.completed ? request.user!.id : null,
          note: dto.note || null
        }
      });
      if (dto.completed) {
        const currentStatus = context.room.operationalState?.currentStatus || RoomOperationalStatus.Ready;
        if (
          kind === RoomChecklistKind.DayStart &&
          currentStatus !== RoomOperationalStatus.Hold &&
          currentStatus !== RoomOperationalStatus.Occupied
        ) {
          await transitionRoomOperationalStateInTx(tx, {
            roomId: dto.roomId,
            clinicId: context.clinic.id,
            facilityId: context.facilityId,
            toStatus: RoomOperationalStatus.Ready,
            eventType,
            createdByUserId: request.user!.id,
            note: dto.note || null,
            metadata: { checklistRunId: run.id, kind, dateKey }
          });
        } else {
          await tx.roomOperationalEvent.create({
            data: {
              roomId: dto.roomId,
              clinicId: context.clinic.id,
              facilityId: context.facilityId,
              eventType,
              fromStatus: currentStatus,
              toStatus: currentStatus,
              createdByUserId: request.user!.id,
              note: dto.note || null,
              metadataJson: { checklistRunId: run.id, kind, dateKey } as Prisma.InputJsonValue
            }
          });
        }
      }
      await recordRoomMutationTx({
        tx,
        request,
        entityType: "RoomChecklistRun",
        entityId: run.id,
      });
      return run;
    });
  }

  app.post("/rooms/checklists/day-start", { preHandler: guard }, async (request) => {
    const run = await upsertChecklist(RoomChecklistKind.DayStart, request);
    await flushOperationalOutbox(prisma);
    return run;
  });
  app.post("/rooms/checklists/day-end", { preHandler: guard }, async (request) => {
    const run = await upsertChecklist(RoomChecklistKind.DayEnd, request);
    await flushOperationalOutbox(prisma);
    return run;
  });
}
