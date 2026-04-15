import type { FastifyInstance } from "fastify";
import { AlertInboxKind, RoleName, TaskSourceType } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ApiError, assert } from "../lib/errors.js";
import { requireRoles } from "../lib/auth.js";
import { createInboxAlert } from "../lib/user-alert-inbox.js";

const createTaskSchema = z.object({
  facilityId: z.string().uuid().optional(),
  clinicId: z.string().uuid().optional(),
  encounterId: z.string().uuid().optional(),
  roomId: z.string().uuid().optional(),
  sourceType: z.nativeEnum(TaskSourceType).optional(),
  sourceId: z.string().uuid().optional(),
  taskType: z.string().min(1),
  description: z.string().min(1),
  assignedToRole: z.nativeEnum(RoleName).optional(),
  assignedToUserId: z.string().uuid().optional(),
  status: z.string().optional(),
  priority: z.number().int().optional(),
  blocking: z.boolean().optional()
});

const updateTaskSchema = z.object({
  assignedToRole: z.nativeEnum(RoleName).optional(),
  assignedToUserId: z.string().uuid().optional(),
  acknowledged: z.boolean().optional(),
  notes: z.string().max(5000).optional(),
  status: z.string().optional(),
  priority: z.number().int().optional(),
  completed: z.boolean().optional()
});

async function maybeCreateTaskAssignmentAlert(params: {
  taskId: string;
  assignedToUserId: string | null | undefined;
  assignedToRole: RoleName | null | undefined;
  encounterId: string | null | undefined;
  roomId: string | null | undefined;
  facilityId: string | null | undefined;
  clinicId: string | null | undefined;
  taskType: string;
  description: string;
}) {
  if (!params.assignedToUserId && !params.assignedToRole) return;

  let scope: { facilityId: string | null; clinicId: string | null; label: string; payload: Record<string, unknown> } = {
    facilityId: params.facilityId || null,
    clinicId: params.clinicId || null,
    label: params.description,
    payload: {
      taskId: params.taskId,
      taskType: params.taskType
    }
  };

  if (params.encounterId) {
    const encounter = await prisma.encounter.findUnique({
      where: { id: params.encounterId },
      include: {
        clinic: {
          select: { id: true, facilityId: true, name: true }
        }
      }
    });
    if (encounter?.clinic?.facilityId) {
      scope = {
        facilityId: encounter.clinic.facilityId,
        clinicId: encounter.clinic.id,
        label: `encounter ${encounter.patientId}`,
        payload: {
          ...scope.payload,
          encounterId: encounter.id,
          patientId: encounter.patientId,
          clinicId: encounter.clinicId
        }
      };
    }
  } else if (params.roomId) {
    const room = await prisma.clinicRoom.findUnique({
      where: { id: params.roomId },
      include: {
        clinicLinks: {
          where: params.clinicId ? { clinicId: params.clinicId, active: true } : { active: true },
          include: { clinic: { select: { id: true, facilityId: true, name: true } } },
          take: 1
        }
      }
    });
    const link = room?.clinicLinks[0];
    if (room && (link?.clinic.facilityId || room.facilityId || params.facilityId)) {
      scope = {
        facilityId: link?.clinic.facilityId || room.facilityId || params.facilityId || null,
        clinicId: link?.clinic.id || params.clinicId || null,
        label: `room ${room.name}`,
        payload: {
          ...scope.payload,
          roomId: room.id,
          roomName: room.name,
          clinicId: link?.clinic.id || params.clinicId || null
        }
      };
    }
  }

  if (!scope.facilityId) return;

  await createInboxAlert({
    facilityId: scope.facilityId,
    clinicId: scope.clinicId,
    kind: AlertInboxKind.task,
    sourceId: params.taskId,
    sourceVersionKey: params.assignedToUserId
      ? `task:${params.taskId}:assigned:${params.assignedToUserId}`
      : `task:${params.taskId}:role:${params.assignedToRole}`,
    title: "New task assigned",
    message: `A new ${params.taskType} task has been assigned for ${scope.label}.`,
    payload: scope.payload,
    ...(params.assignedToUserId
      ? { userIds: [params.assignedToUserId] }
      : { roles: [params.assignedToRole!] })
  });
}

async function resolveTaskScope(dto: {
  facilityId?: string;
  clinicId?: string;
  encounterId?: string;
  roomId?: string;
}) {
  if (!dto.encounterId && !dto.roomId) {
    throw new ApiError(400, "Task must reference an encounter or a room.");
  }

  let facilityId = dto.facilityId || null;
  let clinicId = dto.clinicId || null;

  if (dto.encounterId) {
    const encounter = await prisma.encounter.findUnique({
      where: { id: dto.encounterId },
      include: { clinic: { select: { id: true, facilityId: true } } }
    }
    );
    assert(encounter, 404, "Encounter not found");
    clinicId = encounter.clinicId;
    facilityId = encounter.clinic?.facilityId || facilityId;
  }

  if (dto.roomId) {
    const room = await prisma.clinicRoom.findUnique({
      where: { id: dto.roomId },
      include: {
        clinicLinks: {
          where: clinicId ? { clinicId, active: true } : { active: true },
          include: { clinic: { select: { id: true, facilityId: true } } },
          take: 1
        }
      }
    });
    assert(room, 404, "Room not found");
    const link = room.clinicLinks[0];
    clinicId = clinicId || link?.clinicId || null;
    facilityId = facilityId || link?.clinic.facilityId || room.facilityId;
  }

  assert(facilityId, 400, "Task facility scope is required.");
  assert(clinicId, 400, "Task clinic scope is required.");
  return { facilityId, clinicId };
}

export async function registerTaskRoutes(app: FastifyInstance) {
  const guard = requireRoles(
    RoleName.FrontDeskCheckIn,
    RoleName.MA,
    RoleName.Clinician,
    RoleName.FrontDeskCheckOut,
    RoleName.OfficeManager,
    RoleName.Admin,
    RoleName.RevenueCycle
  );

  app.get("/tasks", { preHandler: guard }, async (request) => {
    const query = request.query as {
      encounterId?: string;
      assignedToUserId?: string;
      assignedToRole?: RoleName;
      roomId?: string;
      mine?: string;
      includeCompleted?: string;
    };
    const includeCompleted = String(query.includeCompleted || "true").toLowerCase() !== "false";
    const mine = String(query.mine || "false").toLowerCase() === "true";
    const where = {
      encounterId: query.encounterId,
      roomId: query.roomId,
      ...(mine
        ? {
            OR: [
              { assignedToUserId: request.user!.id },
              { assignedToRole: request.user!.role, assignedToUserId: null }
            ]
          }
        : {
            assignedToUserId: query.assignedToUserId,
            assignedToRole: query.assignedToRole
          }),
      ...(includeCompleted ? {} : { completedAt: null, status: { not: "completed" } })
    } as const;

    const rows = await prisma.task.findMany({
      where,
      include: {
        encounter: {
          select: {
            id: true,
            patientId: true,
            clinicId: true,
            currentStatus: true,
            checkInAt: true
          }
        },
        room: {
          select: {
            id: true,
            name: true,
            roomNumber: true,
            roomType: true
          }
        }
      },
      orderBy: { createdAt: "desc" }
    });

    if (!mine) return rows;

    const deduped = new Map<string, (typeof rows)[number]>();
    rows.forEach((row) => {
      const existing = deduped.get(row.id);
      if (!existing) {
        deduped.set(row.id, row);
        return;
      }
      const rowRank = row.assignedToUserId === request.user!.id ? 2 : row.assignedToRole === request.user!.role ? 1 : 0;
      const existingRank =
        existing.assignedToUserId === request.user!.id ? 2 : existing.assignedToRole === request.user!.role ? 1 : 0;
      if (rowRank > existingRank) {
        deduped.set(row.id, row);
      }
    });

    return Array.from(deduped.values());
  });

  app.post("/tasks", { preHandler: guard }, async (request) => {
    const dto = createTaskSchema.parse(request.body);

    const scope = await resolveTaskScope(dto);

    const created = await prisma.task.create({
      data: {
        facilityId: scope.facilityId,
        clinicId: scope.clinicId,
        encounterId: dto.encounterId || null,
        roomId: dto.roomId || null,
        sourceType: dto.sourceType,
        sourceId: dto.sourceId || null,
        taskType: dto.taskType,
        description: dto.description,
        assignedToRole: dto.assignedToRole,
        assignedToUserId: dto.assignedToUserId,
        status: dto.status ?? "open",
        priority: dto.priority ?? 0,
        blocking: dto.blocking ?? false,
        createdBy: request.user!.id
      }
    });
    await maybeCreateTaskAssignmentAlert({
      taskId: created.id,
      assignedToUserId: created.assignedToUserId,
      assignedToRole: created.assignedToRole,
      encounterId: created.encounterId,
      roomId: created.roomId,
      facilityId: created.facilityId,
      clinicId: created.clinicId,
      taskType: created.taskType,
      description: created.description
    });
    return created;
  });

  app.patch("/tasks/:id", { preHandler: guard }, async (request) => {
    const taskId = (request.params as { id: string }).id;
    const dto = updateTaskSchema.parse(request.body);

    const task = await prisma.task.findUnique({ where: { id: taskId } });
    assert(task, 404, "Task not found");

    const assignedToUserId =
      dto.assignedToUserId !== undefined ? dto.assignedToUserId : task.assignedToUserId;
    const assignedToRole = dto.assignedToRole !== undefined ? dto.assignedToRole : task.assignedToRole;
    const completed = dto.completed === true || dto.status?.toLowerCase() === "completed";
    const acknowledged = dto.acknowledged === true;

    const updated = await prisma.task.update({
      where: { id: taskId },
      data: {
        assignedToRole,
        assignedToUserId,
        acknowledgedAt: acknowledged ? new Date() : task.acknowledgedAt,
        acknowledgedBy: acknowledged ? request.user!.id : task.acknowledgedBy,
        completedAt: completed ? new Date() : task.completedAt,
        completedBy: completed ? request.user!.id : task.completedBy,
        notes: dto.notes !== undefined ? dto.notes : task.notes,
        status: dto.status ?? (completed ? "completed" : task.status),
        priority: dto.priority ?? task.priority
      }
    });
    if (
      assignedToUserId &&
      assignedToUserId !== task.assignedToUserId
    ) {
      await maybeCreateTaskAssignmentAlert({
        taskId: updated.id,
        assignedToUserId,
        assignedToRole: updated.assignedToRole,
        encounterId: updated.encounterId,
        roomId: updated.roomId,
        facilityId: updated.facilityId,
        clinicId: updated.clinicId,
        taskType: updated.taskType,
        description: updated.description
      });
    }
    if (!assignedToUserId && assignedToRole && assignedToRole !== task.assignedToRole) {
      await maybeCreateTaskAssignmentAlert({
        taskId: updated.id,
        assignedToUserId: null,
        assignedToRole,
        encounterId: updated.encounterId,
        roomId: updated.roomId,
        facilityId: updated.facilityId,
        clinicId: updated.clinicId,
        taskType: updated.taskType,
        description: updated.description
      });
    }
    return updated;
  });

  app.delete("/tasks/:id", { preHandler: guard }, async (request) => {
    const taskId = (request.params as { id: string }).id;
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    assert(task, 404, "Task not found");

    if (request.user!.role !== RoleName.Admin && task.createdBy !== request.user!.id) {
      throw new ApiError(403, "Only the task creator or an admin can delete this task.");
    }

    return prisma.task.delete({ where: { id: taskId } });
  });
}
