import { AlertInboxStatus, Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
export async function resolveAlertRecipientUserIds(params) {
    const { facilityId, clinicId, roles } = params;
    const users = await prisma.user.findMany({
        where: {
            status: "active",
            roles: {
                some: {
                    ...(roles && roles.length > 0 ? { role: { in: roles } } : {}),
                    OR: clinicId
                        ? [{ facilityId }, { clinicId }, { clinic: { facilityId } }, { facilityId: null, clinicId: null }]
                        : [{ facilityId }, { clinic: { facilityId } }, { facilityId: null, clinicId: null }]
                }
            }
        },
        select: { id: true }
    });
    return Array.from(new Set(users.map((user) => user.id)));
}
export async function createInboxAlert(params) {
    const userIds = params.userIds && params.userIds.length > 0
        ? params.userIds
        : await resolveAlertRecipientUserIds({
            facilityId: params.facilityId,
            clinicId: params.clinicId,
            roles: params.roles
        });
    if (userIds.length === 0)
        return 0;
    const rows = userIds.map((userId) => ({
        userId,
        facilityId: params.facilityId,
        clinicId: params.clinicId || null,
        kind: params.kind,
        sourceId: params.sourceId,
        sourceVersionKey: params.sourceVersionKey,
        title: params.title,
        message: params.message,
        payloadJson: params.payload || null,
        status: AlertInboxStatus.active
    }));
    await prisma.$transaction(rows.map((row) => prisma.userAlertInbox.upsert({
        where: {
            userId_kind_sourceVersionKey: {
                userId: row.userId,
                kind: row.kind,
                sourceVersionKey: row.sourceVersionKey
            }
        },
        create: {
            userId: row.userId,
            facilityId: row.facilityId,
            clinicId: row.clinicId,
            kind: row.kind,
            sourceId: row.sourceId,
            sourceVersionKey: row.sourceVersionKey,
            title: row.title,
            message: row.message,
            payloadJson: (row.payloadJson || Prisma.JsonNull),
            status: row.status
        },
        update: {}
    })));
    return rows.length;
}
export async function listUserInboxAlerts(params) {
    const status = params.tab === "archived" ? AlertInboxStatus.archived : AlertInboxStatus.active;
    const [rows, total] = await prisma.$transaction([
        prisma.userAlertInbox.findMany({
            where: {
                userId: params.userId,
                status
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: params.limit
        }),
        prisma.userAlertInbox.count({
            where: {
                userId: params.userId,
                status
            }
        })
    ]);
    return { rows, total };
}
export async function updateUserInboxAlertStatus(params) {
    const now = new Date();
    return prisma.userAlertInbox.updateMany({
        where: {
            id: params.id,
            userId: params.userId
        },
        data: params.status === AlertInboxStatus.archived
            ? { status: AlertInboxStatus.archived, acknowledgedAt: now, archivedAt: now }
            : { status: AlertInboxStatus.active, archivedAt: null }
    });
}
//# sourceMappingURL=user-alert-inbox.js.map