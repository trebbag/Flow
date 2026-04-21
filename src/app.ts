import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { env } from "./lib/env.js";
import { ApiError } from "./lib/errors.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerIncomingRoutes } from "./routes/incoming.js";
import { registerEncounterRoutes } from "./routes/encounters.js";
import { registerSafetyRoutes } from "./routes/safety.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerAlertRoutes } from "./routes/alerts.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerRoomRoutes } from "./routes/rooms.js";
import { registerRevenueRoutes } from "./routes/revenue.js";

export function buildApp() {
  const app = Fastify({
    logger: env.NODE_ENV !== "test",
    trustProxy: env.TRUST_PROXY
  });

  app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (env.CORS_ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin '${origin}' is not allowed by CORS policy.`), false);
    },
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "x-dev-user-id",
      "x-dev-role",
      "x-proof-user-id",
      "x-proof-role",
      "x-proof-secret",
      "x-facility-id",
      "x-correlation-id",
      "Idempotency-Key"
    ]
  });

  app.register(helmet, {
    contentSecurityPolicy: false
  });

  app.register(rateLimit, {
    global: true,
    max: env.NODE_ENV === "test" ? env.RATE_LIMIT_MAX * 100 : env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    addHeadersOnExceeding: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true
    },
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
      "retry-after": true
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    const externalCorrelationId = request.headers["x-correlation-id"];
    const correlationId =
      typeof externalCorrelationId === "string" && externalCorrelationId.trim().length > 0
        ? externalCorrelationId.trim()
        : request.id;
    request.correlationId = correlationId;
    reply.header("x-correlation-id", correlationId);
  });

  app.setErrorHandler((error, request, reply) => {
    const correlationId = request.correlationId || request.id;
    const sendError = (statusCode: number, code: string, message: string, details?: unknown) => {
      reply.code(statusCode).send({
        code,
        message,
        details,
        correlationId,
      });
    };

    if (error instanceof ApiError) {
      sendError(error.statusCode, error.code, error.message, error.details);
      return;
    }

    if (error instanceof ZodError) {
      sendError(
        400,
        "VALIDATION_ERROR",
        "Validation failed",
        error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
      return;
    }

    const fastifyStatus = Number((error as { statusCode?: unknown })?.statusCode || 0);
    const fastifyCode = String((error as { code?: unknown })?.code || "");
    if (fastifyStatus >= 400 && fastifyStatus < 500) {
      sendError(fastifyStatus, fastifyCode || "REQUEST_ERROR", (error as Error).message || "Invalid request");
      return;
    }

    const prismaCode = typeof (error as { code?: unknown })?.code === "string"
      ? String((error as { code?: unknown }).code)
      : null;
    if (prismaCode) {
      if (prismaCode === "P2021" || prismaCode === "P2022") {
        sendError(500, "DATABASE_SCHEMA_OUT_OF_DATE", "Database schema is out of date. Run `pnpm db:push` and restart the server.");
        return;
      }
      if (prismaCode === "P2025") {
        sendError(404, "RECORD_NOT_FOUND", "Record not found");
        return;
      }
      if (prismaCode === "P2002") {
        sendError(409, "UNIQUE_CONSTRAINT_CONFLICT", "Conflict: record already exists");
        return;
      }
      if (prismaCode === "P2003" || prismaCode === "P2014") {
        sendError(409, "DEPENDENT_RECORD_CONFLICT", "Conflict: dependent records prevent this operation");
        return;
      }
      if (prismaCode.startsWith("P20")) {
        sendError(400, "INVALID_DATABASE_PAYLOAD", "Invalid database operation payload");
        return;
      }
    }

    const rawCode = String((error as { code?: unknown })?.code || "");
    const rawMessage = String((error as { message?: unknown })?.message || "").toLowerCase();
    if (
      rawMessage.includes("encounter_version_required")
    ) {
      sendError(409, "VERSION_MISMATCH", "Version mismatch");
      return;
    }
    if (
      rawCode === "23503" ||
      rawCode === "23505" ||
      rawCode.startsWith("SQLITE_CONSTRAINT")
    ) {
      sendError(409, "DEPENDENT_RECORD_CONFLICT", "Conflict: dependent records prevent this operation");
      return;
    }
    if (
      rawMessage.includes("no such table") ||
      rawMessage.includes("no such column")
    ) {
      sendError(500, "DATABASE_SCHEMA_OUT_OF_DATE", "Database schema is out of date. Run `pnpm db:push` and restart the server.");
      return;
    }
    if (
      rawMessage.includes("foreign key constraint failed") ||
      rawMessage.includes("constraint failed") ||
      rawMessage.includes("violates foreign key constraint") ||
      rawMessage.includes("duplicate key value")
    ) {
      sendError(409, "DEPENDENT_RECORD_CONFLICT", "Conflict: dependent records prevent this operation");
      return;
    }

    if ((error as { name?: string })?.name === "PrismaClientValidationError") {
      sendError(400, "INVALID_DATABASE_PAYLOAD", "Invalid database payload");
      return;
    }

    request.log.error(error as Error);
    if (env.NODE_ENV !== "production" && error instanceof Error && error.message) {
      sendError(500, "INTERNAL_SERVER_ERROR", error.message);
      return;
    }
    sendError(500, "INTERNAL_SERVER_ERROR", "Internal server error");
  });

  app.register(registerHealthRoutes);
  app.register(registerAuthRoutes);
  app.register(registerAdminRoutes);
  app.register(registerIncomingRoutes);
  app.register(registerEncounterRoutes);
  app.register(registerSafetyRoutes);
  app.register(registerTaskRoutes);
  app.register(registerRoomRoutes);
  app.register(registerRevenueRoutes);
  app.register(registerAlertRoutes);
  app.register(registerEventRoutes);
  app.register(registerDashboardRoutes);

  return app;
}
