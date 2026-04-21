import type { FastifyRequest } from "fastify";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "./prisma.js";
import { publishOutboxStreamEvent } from "./event-bus.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

const REVENUE_SYNC_TOPIC = "revenue.sync";
let activeOperationalDispatch: Promise<number> | null = null;

function normalizeRoute(route: string) {
  const noQuery = route.split("?")[0] || "/";
  if (noQuery === "/") return "api.root";
  return `api${noQuery
    .replace(/\/+/, "/")
    .replace(/\//g, ".")
    .replace(/[{}:]/g, "")
    .replace(/\.\.+/g, ".")
    .replace(/\.$/, "")}`;
}

function inferEntity(route: string, params: Record<string, string>) {
  const segments = route.split("?")[0].split("/").filter(Boolean);
  const entityType = segments[0] || null;

  const keys = ["id", "encounterId", "clinicId", "facilityId", "userId", "incomingId", "taskId", "revenueCaseId"];
  let entityId: string | null = null;
  for (const key of keys) {
    const candidate = params[key];
    if (typeof candidate === "string" && candidate.length > 0) {
      entityId = candidate;
      break;
    }
  }

  return { entityType, entityId };
}

function asStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, entry]) => {
    if (typeof entry === "string") {
      acc[key] = entry;
    } else if (typeof entry === "number" || typeof entry === "boolean") {
      acc[key] = String(entry);
    }
    return acc;
  }, {});
}

export function buildRequestPayloadSummary(request: FastifyRequest): Prisma.InputJsonValue {
  const params = asStringMap(request.params);
  const query = asStringMap(request.query);
  const body = request.body;
  const bodyKeys = body && typeof body === "object" ? Object.keys(body as Record<string, unknown>).slice(0, 50) : [];

  return {
    params,
    query,
    bodyKeys,
  } as Prisma.InputJsonValue;
}

export async function persistMutationOperationalEventTx(params: {
  db: DbClient;
  request: FastifyRequest;
  statusCode?: number;
  route?: string;
  entityType?: string | null;
  entityId?: string | null;
  payloadSummary?: Prisma.InputJsonValue;
}) {
  const route = params.route || params.request.routeOptions.url || params.request.url.split("?")[0] || "/";
  const method = params.request.method.toUpperCase();
  const requestId = params.request.correlationId || params.request.id;
  const idempotencyKey =
    typeof params.request.headers["idempotency-key"] === "string" && params.request.headers["idempotency-key"].trim().length > 0
      ? params.request.headers["idempotency-key"].trim()
      : null;
  const requestParams = asStringMap(params.request.params);
  const topic = normalizeRoute(route);
  const eventType = `${method.toLowerCase()}.${topic}`;
  const inferred = inferEntity(route, requestParams);
  const entityType = params.entityType ?? inferred.entityType;
  const entityId = params.entityId ?? inferred.entityId;
  const payloadSummary = params.payloadSummary ?? buildRequestPayloadSummary(params.request);
  const statusCode = params.statusCode ?? 200;

  await params.db.eventOutbox.create({
    data: {
      topic,
      eventType,
      aggregateType: entityType,
      aggregateId: entityId,
      requestId,
      payloadJson: {
        route,
        method,
        statusCode,
        actorUserId: params.request.user?.id || null,
        actorRole: params.request.user?.role || null,
        clinicId: params.request.user?.clinicId || null,
        facilityId: params.request.user?.facilityId || null,
        summary: payloadSummary,
      } as Prisma.InputJsonValue,
    },
  });

  await params.db.auditLog.create({
    data: {
      requestId,
      idempotencyKey,
      actorUserId: params.request.user?.id,
      actorRole: params.request.user?.role,
      authSource: params.request.user?.authSource,
      method,
      route,
      statusCode,
      clinicId: params.request.user?.clinicId,
      facilityId: params.request.user?.facilityId,
      entityType,
      entityId,
      payloadJson: payloadSummary,
    },
  });
}

async function dispatchOutboxRow(db: PrismaClient, row: {
  id: string;
  topic: string;
  eventType: string;
  requestId: string | null;
  status: string;
  createdAt: Date;
  aggregateType: string | null;
  aggregateId: string | null;
  payloadJson: Prisma.JsonValue;
}) {
  publishOutboxStreamEvent({
    id: row.id,
    topic: row.topic,
    eventType: row.eventType,
    requestId: row.requestId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    payload: row.payloadJson,
  });

  await db.eventOutbox.update({
    where: { id: row.id },
    data: {
      status: "dispatched",
      dispatchedAt: new Date(),
      lastError: null,
    },
  });
}

export async function dispatchOperationalOutboxById(db: PrismaClient, outboxId: string) {
  const row = await db.eventOutbox.findUnique({ where: { id: outboxId } });
  if (!row) return null;
  if (row.topic === REVENUE_SYNC_TOPIC) {
    return db.eventOutbox.update({
      where: { id: outboxId },
      data: {
        status: "dispatched",
        dispatchedAt: new Date(),
        lastError: null,
      },
    });
  }

  if (row.status !== "pending") {
    return row;
  }

  await dispatchOutboxRow(db, row);
  return db.eventOutbox.findUnique({ where: { id: outboxId } });
}

export async function flushOperationalOutbox(db: PrismaClient = prisma, limit = 100) {
  if (activeOperationalDispatch) {
    return activeOperationalDispatch;
  }

  activeOperationalDispatch = (async () => {
    const rows = await db.eventOutbox.findMany({
      where: {
        status: "pending",
        NOT: {
          topic: REVENUE_SYNC_TOPIC,
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit,
    });

    let dispatchedCount = 0;
    for (const row of rows) {
      try {
        await dispatchOutboxRow(db, row);
        dispatchedCount += 1;
      } catch (error) {
        await db.eventOutbox.update({
          where: { id: row.id },
          data: {
            status: "failed",
            attempts: { increment: 1 },
            lastError: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    return dispatchedCount;
  })().finally(() => {
    activeOperationalDispatch = null;
  });

  return activeOperationalDispatch;
}
