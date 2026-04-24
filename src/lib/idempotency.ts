import crypto from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Prisma, PrismaClient } from "@prisma/client";
import { ApiError } from "./errors.js";
import { recordIdempotencyReplay } from "./metrics.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

type IdempotencyReplay<T> =
  | { kind: "fresh"; key: string | null; requestHash: string | null; routeKey: string }
  | { kind: "replay"; key: string; statusCode: number; response: T };

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const objectValue = value as Record<string, unknown>;
  const keys = Object.keys(objectValue).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`).join(",")}}`;
}

function hashPayload(payload: unknown) {
  return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function resolveIdempotencyKey(request: FastifyRequest) {
  const header = request.headers["idempotency-key"];
  if (typeof header !== "string") return null;
  const value = header.trim();
  return value.length > 0 ? value : null;
}

export function requireMutationIdempotencyKey(request: FastifyRequest) {
  const method = request.method.toUpperCase();
  if (method !== "POST" && method !== "PATCH" && method !== "DELETE") return;
  if (resolveIdempotencyKey(request)) return;

  throw new ApiError({
    statusCode: 428,
    code: "IDEMPOTENCY_KEY_REQUIRED",
    message: "Mutating requests must include an Idempotency-Key header.",
    details: {
      header: "Idempotency-Key",
      method
    }
  });
}

function resolveRouteKey(request: FastifyRequest, explicitRouteKey?: string) {
  return explicitRouteKey || request.routeOptions.url || request.url.split("?")[0] || "/";
}

function asJsonResponse<T>(value: T) {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

export async function beginIdempotentMutation<T>(params: {
  db: DbClient;
  request: FastifyRequest;
  routeKey?: string;
  payload?: unknown;
}): Promise<IdempotencyReplay<T>> {
  const key = resolveIdempotencyKey(params.request);
  const routeKey = resolveRouteKey(params.request, params.routeKey);
  if (!key) {
    return { kind: "fresh", key: null, requestHash: null, routeKey };
  }

  const requestHash = hashPayload({
    routeKey,
    body: params.payload ?? null,
    actorUserId: params.request.user?.id || null,
    facilityId: params.request.user?.facilityId || null,
  });

  const existing = await params.db.idempotencyRecord.findUnique({
    where: {
      actorUserId_method_routeKey_idempotencyKey: {
        actorUserId: params.request.user?.id || "anonymous",
        method: params.request.method.toUpperCase(),
        routeKey,
        idempotencyKey: key,
      },
    },
  });

  if (!existing) {
    return { kind: "fresh", key, requestHash, routeKey };
  }

  if (existing.requestHash !== requestHash) {
    throw new ApiError({
      statusCode: 409,
      code: "IDEMPOTENCY_KEY_REUSED",
      message: "This idempotency key was already used with a different request payload.",
    });
  }

  recordIdempotencyReplay(routeKey);
  return {
    kind: "replay",
    key,
    statusCode: existing.statusCode,
    response: existing.responseJson as T,
  };
}

export async function commitIdempotentMutation<T>(params: {
  db: DbClient;
  request: FastifyRequest;
  routeKey: string;
  key: string | null;
  requestHash: string | null;
  statusCode?: number;
  response: T;
}) {
  if (!params.key || !params.requestHash) {
    return params.response;
  }

  await params.db.idempotencyRecord.upsert({
    where: {
      actorUserId_method_routeKey_idempotencyKey: {
        actorUserId: params.request.user?.id || "anonymous",
        method: params.request.method.toUpperCase(),
        routeKey: params.routeKey,
        idempotencyKey: params.key,
      },
    },
    create: {
      actorUserId: params.request.user?.id || "anonymous",
      method: params.request.method.toUpperCase(),
      routeKey: params.routeKey,
      idempotencyKey: params.key,
      requestHash: params.requestHash,
      statusCode: params.statusCode || 200,
      responseJson: asJsonResponse(params.response) as Prisma.InputJsonValue,
    },
    update: {
      requestHash: params.requestHash,
      statusCode: params.statusCode || 200,
      responseJson: asJsonResponse(params.response) as Prisma.InputJsonValue,
    },
  });

  return params.response;
}

export async function withIdempotentMutation<T>(params: {
  db: DbClient;
  request: FastifyRequest;
  routeKey?: string;
  payload?: unknown;
  statusCode?: number;
  execute: () => Promise<T>;
}) {
  const started = await beginIdempotentMutation<T>({
    db: params.db,
    request: params.request,
    routeKey: params.routeKey,
    payload: params.payload,
  });

  if (started.kind === "replay") {
    return started.response;
  }

  const result = await params.execute();
  return commitIdempotentMutation({
    db: params.db,
    request: params.request,
    routeKey: started.routeKey,
    key: started.key,
    requestHash: started.requestHash,
    statusCode: params.statusCode,
    response: result,
  });
}
