import type { FastifyRequest } from "fastify";
import type { Prisma, PrismaClient } from "@prisma/client";

type DbClient = PrismaClient | Prisma.TransactionClient;

export type EntityEventInput = {
  db: DbClient;
  request: FastifyRequest;
  entityType: string;
  entityId: string;
  eventType: string;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
  facilityId?: string | null;
  clinicId?: string | null;
  actorUserId?: string | null;
};

function toJsonOrNull(value: unknown): Prisma.InputJsonValue | Prisma.NullTypes.JsonNull {
  if (value === undefined || value === null) return null as unknown as Prisma.NullTypes.JsonNull;
  try {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  } catch {
    return null as unknown as Prisma.NullTypes.JsonNull;
  }
}

export async function recordEntityEventTx(input: EntityEventInput) {
  const {
    db,
    request,
    entityType,
    entityId,
    eventType,
    before,
    after,
    metadata,
    facilityId,
    clinicId,
    actorUserId,
  } = input;

  const resolvedActor = actorUserId ?? request.user?.id ?? null;
  const resolvedFacility = facilityId ?? request.user?.facilityId ?? null;
  const resolvedClinic = clinicId ?? request.user?.clinicId ?? null;
  const requestId = request.correlationId || request.id;

  await db.entityEvent.create({
    data: {
      entityType,
      entityId,
      eventType,
      actorUserId: resolvedActor ?? undefined,
      facilityId: resolvedFacility ?? undefined,
      clinicId: resolvedClinic ?? undefined,
      requestId: requestId || undefined,
      beforeJson: toJsonOrNull(before),
      afterJson: toJsonOrNull(after),
      metadataJson: toJsonOrNull(metadata),
    },
  });
}
