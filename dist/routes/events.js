import { OutboxStatus, RoleName } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { assert } from "../lib/errors.js";
import { requireRoles } from "../lib/auth.js";
import { subscribeOutboxStreamEvent } from "../lib/event-bus.js";
const listOutboxQuerySchema = z.object({
    status: z.nativeEnum(OutboxStatus).optional(),
    topic: z.string().optional(),
    limit: z.coerce.number().int().positive().max(200).default(50)
});
const listAuditQuerySchema = z.object({
    route: z.string().optional(),
    actorUserId: z.string().uuid().optional(),
    facilityId: z.string().uuid().optional(),
    limit: z.coerce.number().int().positive().max(200).default(50)
});
const failOutboxSchema = z.object({
    error: z.string().min(1)
});
function canReadEventForScope(user, payload) {
    if (user.role === RoleName.Admin || user.role === RoleName.RevenueCycle) {
        return true;
    }
    if (!payload || typeof payload !== "object") {
        return true;
    }
    const data = payload;
    const clinicId = typeof data.clinicId === "string" ? data.clinicId : null;
    const facilityId = typeof data.facilityId === "string" ? data.facilityId : null;
    if (clinicId && user.clinicId) {
        return clinicId === user.clinicId;
    }
    if (facilityId && user.facilityId) {
        return facilityId === user.facilityId;
    }
    return true;
}
export async function registerEventRoutes(app) {
    app.get("/events/outbox", { preHandler: requireRoles(RoleName.Admin, RoleName.RevenueCycle) }, async (request) => {
        const query = listOutboxQuerySchema.parse(request.query);
        return prisma.eventOutbox.findMany({
            where: {
                status: query.status,
                topic: query.topic
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: query.limit
        });
    });
    app.patch("/events/outbox/:id/dispatch", { preHandler: requireRoles(RoleName.Admin, RoleName.RevenueCycle) }, async (request) => {
        const outboxId = request.params.id;
        const row = await prisma.eventOutbox.findUnique({ where: { id: outboxId } });
        assert(row, 404, "Outbox event not found");
        return prisma.eventOutbox.update({
            where: { id: outboxId },
            data: {
                status: OutboxStatus.dispatched,
                dispatchedAt: new Date(),
                attempts: row.attempts + 1,
                lastError: null
            }
        });
    });
    app.patch("/events/outbox/:id/fail", { preHandler: requireRoles(RoleName.Admin, RoleName.RevenueCycle) }, async (request) => {
        const outboxId = request.params.id;
        const dto = failOutboxSchema.parse(request.body);
        const row = await prisma.eventOutbox.findUnique({ where: { id: outboxId } });
        assert(row, 404, "Outbox event not found");
        return prisma.eventOutbox.update({
            where: { id: outboxId },
            data: {
                status: OutboxStatus.failed,
                attempts: row.attempts + 1,
                lastError: dto.error
            }
        });
    });
    app.get("/events/audit", { preHandler: requireRoles(RoleName.Admin, RoleName.RevenueCycle) }, async (request) => {
        const query = listAuditQuerySchema.parse(request.query);
        const requestedFacilityId = query.facilityId || request.user.facilityId || null;
        if (requestedFacilityId) {
            assert(request.user.availableFacilityIds.includes(requestedFacilityId), 403, "Requested facility is outside the signed-in user's scope");
        }
        const clinicIds = requestedFacilityId
            ? (await prisma.clinic.findMany({
                where: { facilityId: requestedFacilityId },
                select: { id: true }
            })).map((row) => row.id)
            : request.user.clinicId
                ? [request.user.clinicId]
                : [];
        const scopeClauses = requestedFacilityId
            ? [
                { facilityId: requestedFacilityId },
                ...(clinicIds.length > 0 ? [{ clinicId: { in: clinicIds } }] : [])
            ]
            : clinicIds.length > 0
                ? [{ clinicId: { in: clinicIds } }]
                : [];
        return prisma.auditLog.findMany({
            where: {
                AND: [
                    {
                        route: query.route,
                        actorUserId: query.actorUserId
                    },
                    ...(scopeClauses.length > 0 ? [{ OR: scopeClauses }] : [])
                ]
            },
            orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
            take: query.limit
        });
    });
    app.get("/events/stream", {
        preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.MA, RoleName.Clinician, RoleName.FrontDeskCheckOut, RoleName.Admin, RoleName.RevenueCycle)
    }, async (request, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive"
        });
        const writeEvent = (eventName, payload) => {
            reply.raw.write(`event: ${eventName}\n`);
            reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        };
        writeEvent("connected", {
            requestId: request.correlationId || request.id,
            now: new Date().toISOString()
        });
        const unsubscribe = subscribeOutboxStreamEvent((event) => {
            if (!canReadEventForScope(request.user, event.payload)) {
                return;
            }
            writeEvent(event.eventType, event);
        });
        const keepAlive = setInterval(() => {
            reply.raw.write(":keepalive\n\n");
        }, 15000);
        const cleanup = () => {
            clearInterval(keepAlive);
            unsubscribe();
            if (!reply.raw.writableEnded) {
                reply.raw.end();
            }
        };
        request.raw.on("close", cleanup);
        request.raw.on("aborted", cleanup);
    });
}
//# sourceMappingURL=events.js.map