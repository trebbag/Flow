import { AlertInboxStatus, Prisma, RoleName } from "@prisma/client";
import type { AlertInboxKind, PrismaClient } from "@prisma/client";
import { prisma } from "./prisma.js";

type DbClient = PrismaClient | Prisma.TransactionClient;
type AlertRecipientDb = Pick<DbClient, "user">;

function buildScopedRoleClauses(params: {
  facilityId: string;
  clinicId?: string | null;
  roles?: RoleName[];
}) {
  const { facilityId, clinicId, roles } = params;
  const roleFilter =
    roles && roles.length > 0 ? { role: { in: roles } } : {};

  return {
    roleFilter,
    scopeOr: clinicId
      ? [{ facilityId }, { clinicId }, { clinic: { facilityId } }, { facilityId: null, clinicId: null }]
      : [{ facilityId }, { clinic: { facilityId } }, { facilityId: null, clinicId: null }]
  };
}

export async function resolveAlertRecipientUserIds(
  params: {
    facilityId: string;
    clinicId?: string | null;
    roles?: RoleName[];
  },
  db: AlertRecipientDb = prisma
) {
  const { facilityId, roles } = params;
  const { roleFilter, scopeOr } = buildScopedRoleClauses(params);
  const includeActiveAdminFallback = !roles || roles.length === 0 || roles.includes(RoleName.Admin);

  const users = await db.user.findMany({
    where: {
      status: "active",
      OR: [
        {
          roles: {
            some: {
              ...roleFilter,
              OR: scopeOr
            }
          }
        },
        ...(includeActiveAdminFallback
          ? [
              {
                activeFacilityId: facilityId,
                roles: {
                  some: {
                    role: RoleName.Admin
                  }
                }
              } satisfies Prisma.UserWhereInput
            ]
          : [])
      ]
    },
    select: { id: true }
  });
  return Array.from(new Set(users.map((user) => user.id)));
}

export async function createInboxAlert(params: {
  facilityId: string;
  clinicId?: string | null;
  kind: AlertInboxKind;
  sourceId: string;
  sourceVersionKey: string;
  title: string;
  message: string;
  payload?: Record<string, unknown> | null;
  userIds?: string[];
  roles?: RoleName[];
}, db: DbClient = prisma) {
  const userIds =
    params.userIds && params.userIds.length > 0
      ? params.userIds
      : await resolveAlertRecipientUserIds({
          facilityId: params.facilityId,
          clinicId: params.clinicId,
          roles: params.roles
        }, db);
  if (userIds.length === 0) return 0;

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
  await Promise.all(
    rows.map((row) =>
      db.userAlertInbox.upsert({
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
          payloadJson: (row.payloadJson || Prisma.JsonNull) as Prisma.InputJsonValue,
          status: row.status
        },
        update: {}
      })
    )
  );
  return rows.length;
}

export async function listUserInboxAlerts(params: {
  userId: string;
  tab: "active" | "archived";
  limit: number;
}) {
  const status = params.tab === "archived" ? AlertInboxStatus.archived : AlertInboxStatus.active;
  const [rows, total] = await prisma.$transaction(async (tx) => {
    const alerts = await tx.userAlertInbox.findMany({
      where: {
        userId: params.userId,
        status
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: params.limit
    });
    const count = await tx.userAlertInbox.count({
      where: {
        userId: params.userId,
        status
      }
    });
    return [alerts, count] as const;
  });

  return { rows, total };
}

export async function updateUserInboxAlertStatus(params: {
  id: string;
  userId: string;
  status: AlertInboxStatus;
}, db: DbClient = prisma) {
  const now = new Date();
  return db.userAlertInbox.updateMany({
    where: {
      id: params.id,
      userId: params.userId
    },
    data:
      params.status === AlertInboxStatus.archived
        ? { status: AlertInboxStatus.archived, acknowledgedAt: now, archivedAt: now }
        : { status: AlertInboxStatus.active, archivedAt: null }
  });
}
