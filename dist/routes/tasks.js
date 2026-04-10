import { AlertInboxKind, RoleName } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ApiError, assert } from "../lib/errors.js";
import { requireRoles } from "../lib/auth.js";
import { createInboxAlert } from "../lib/user-alert-inbox.js";
const createTaskSchema = z.object({
    encounterId: z.string().uuid(),
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
async function maybeCreateTaskAssignmentAlert(params) {
    if (!params.assignedToUserId)
        return;
    const encounter = await prisma.encounter.findUnique({
        where: { id: params.encounterId },
        include: {
            clinic: {
                select: { id: true, facilityId: true, name: true }
            }
        }
    });
    if (!encounter?.clinic?.facilityId)
        return;
    await createInboxAlert({
        facilityId: encounter.clinic.facilityId,
        clinicId: encounter.clinic.id,
        kind: AlertInboxKind.task,
        sourceId: params.taskId,
        sourceVersionKey: `task:${params.taskId}:assigned:${params.assignedToUserId}`,
        title: "New task assigned",
        message: `A new task has been assigned for encounter ${encounter.patientId}.`,
        payload: {
            encounterId: encounter.id,
            patientId: encounter.patientId,
            clinicId: encounter.clinicId
        },
        userIds: [params.assignedToUserId]
    });
}
export async function registerTaskRoutes(app) {
    const guard = requireRoles(RoleName.FrontDeskCheckIn, RoleName.MA, RoleName.Clinician, RoleName.FrontDeskCheckOut, RoleName.Admin, RoleName.RevenueCycle);
    app.get("/tasks", { preHandler: guard }, async (request) => {
        const query = request.query;
        const includeCompleted = String(query.includeCompleted || "true").toLowerCase() !== "false";
        const mine = String(query.mine || "false").toLowerCase() === "true";
        const where = {
            encounterId: query.encounterId,
            ...(mine
                ? {
                    OR: [
                        { assignedToUserId: request.user.id },
                        { assignedToRole: request.user.role, assignedToUserId: null }
                    ]
                }
                : {
                    assignedToUserId: query.assignedToUserId,
                    assignedToRole: query.assignedToRole
                }),
            ...(includeCompleted ? {} : { completedAt: null, status: { not: "completed" } })
        };
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
                }
            },
            orderBy: { createdAt: "desc" }
        });
        if (!mine)
            return rows;
        const deduped = new Map();
        rows.forEach((row) => {
            const existing = deduped.get(row.id);
            if (!existing) {
                deduped.set(row.id, row);
                return;
            }
            const rowRank = row.assignedToUserId === request.user.id ? 2 : row.assignedToRole === request.user.role ? 1 : 0;
            const existingRank = existing.assignedToUserId === request.user.id ? 2 : existing.assignedToRole === request.user.role ? 1 : 0;
            if (rowRank > existingRank) {
                deduped.set(row.id, row);
            }
        });
        return Array.from(deduped.values());
    });
    app.post("/tasks", { preHandler: guard }, async (request) => {
        const dto = createTaskSchema.parse(request.body);
        const encounter = await prisma.encounter.findUnique({ where: { id: dto.encounterId } });
        assert(encounter, 404, "Encounter not found");
        const created = await prisma.task.create({
            data: {
                encounterId: dto.encounterId,
                taskType: dto.taskType,
                description: dto.description,
                assignedToRole: dto.assignedToRole,
                assignedToUserId: dto.assignedToUserId,
                status: dto.status ?? "open",
                priority: dto.priority ?? 0,
                blocking: dto.blocking ?? false,
                createdBy: request.user.id
            }
        });
        await maybeCreateTaskAssignmentAlert({
            taskId: created.id,
            assignedToUserId: created.assignedToUserId,
            encounterId: created.encounterId
        });
        return created;
    });
    app.patch("/tasks/:id", { preHandler: guard }, async (request) => {
        const taskId = request.params.id;
        const dto = updateTaskSchema.parse(request.body);
        const task = await prisma.task.findUnique({ where: { id: taskId } });
        assert(task, 404, "Task not found");
        const assignedToUserId = dto.assignedToUserId !== undefined ? dto.assignedToUserId : task.assignedToUserId;
        const assignedToRole = dto.assignedToRole !== undefined ? dto.assignedToRole : task.assignedToRole;
        const completed = dto.completed === true || dto.status?.toLowerCase() === "completed";
        const acknowledged = dto.acknowledged === true;
        const updated = await prisma.task.update({
            where: { id: taskId },
            data: {
                assignedToRole,
                assignedToUserId,
                acknowledgedAt: acknowledged ? new Date() : task.acknowledgedAt,
                acknowledgedBy: acknowledged ? request.user.id : task.acknowledgedBy,
                completedAt: completed ? new Date() : task.completedAt,
                completedBy: completed ? request.user.id : task.completedBy,
                notes: dto.notes !== undefined ? dto.notes : task.notes,
                status: dto.status ?? (completed ? "completed" : task.status),
                priority: dto.priority ?? task.priority
            }
        });
        if (assignedToUserId &&
            assignedToUserId !== task.assignedToUserId) {
            await maybeCreateTaskAssignmentAlert({
                taskId: updated.id,
                assignedToUserId,
                encounterId: updated.encounterId
            });
        }
        return updated;
    });
    app.delete("/tasks/:id", { preHandler: guard }, async (request) => {
        const taskId = request.params.id;
        const task = await prisma.task.findUnique({ where: { id: taskId } });
        assert(task, 404, "Task not found");
        if (request.user.role !== RoleName.Admin && task.createdBy !== request.user.id) {
            throw new ApiError(403, "Only the task creator or an admin can delete this task.");
        }
        return prisma.task.delete({ where: { id: taskId } });
    });
}
//# sourceMappingURL=tasks.js.map