import type { FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { publishOutboxStreamEvent } from "./event-bus.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutatingMethod(method: string) {
  return MUTATING_METHODS.has(method.toUpperCase());
}

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

  const keys = ["id", "encounterId", "clinicId", "facilityId", "userId", "incomingId", "taskId"];
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

function buildPayloadSummary(request: FastifyRequest): Prisma.InputJsonValue {
  const params = asStringMap(request.params);
  const query = asStringMap(request.query);
  const body = request.body;
  const bodyKeys = body && typeof body === "object" ? Object.keys(body as Record<string, unknown>).slice(0, 50) : [];

  return {
    params,
    query,
    bodyKeys
  } as Prisma.InputJsonValue;
}

export async function recordMutationOperationalEvent(request: FastifyRequest, statusCode: number) {
  const route = request.routeOptions.url || request.url.split("?")[0] || "/";
  const method = request.method.toUpperCase();
  const requestId = request.correlationId || request.id;
  const params = asStringMap(request.params);
  const topic = normalizeRoute(route);
  const eventType = `${method.toLowerCase()}.${topic}`;
  const { entityType, entityId } = inferEntity(route, params);
  const payloadSummary = buildPayloadSummary(request);

  const outbox = await prisma.eventOutbox.create({
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
        actorUserId: request.user?.id || null,
        actorRole: request.user?.role || null,
        clinicId: request.user?.clinicId || null,
        facilityId: request.user?.facilityId || null,
        summary: payloadSummary
      } as Prisma.InputJsonValue
    }
  });

  await prisma.auditLog.create({
    data: {
      requestId,
      actorUserId: request.user?.id,
      actorRole: request.user?.role,
      authSource: request.user?.authSource,
      method,
      route,
      statusCode,
      clinicId: request.user?.clinicId,
      facilityId: request.user?.facilityId,
      entityType,
      entityId,
      payloadJson: payloadSummary
    }
  });

  publishOutboxStreamEvent({
    id: outbox.id,
    topic: outbox.topic,
    eventType: outbox.eventType,
    requestId: outbox.requestId,
    status: outbox.status,
    createdAt: outbox.createdAt.toISOString(),
    aggregateType: outbox.aggregateType,
    aggregateId: outbox.aggregateId,
    payload: outbox.payloadJson
  });
}
