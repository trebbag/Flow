import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
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
import { isMutatingMethod, recordMutationOperationalEvent } from "./lib/operational-events.js";
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
            "x-facility-id",
            "x-correlation-id"
        ]
    });
    app.register(helmet, {
        contentSecurityPolicy: false
    });
    app.register(rateLimit, {
        global: true,
        max: env.RATE_LIMIT_MAX,
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
        const correlationId = typeof externalCorrelationId === "string" && externalCorrelationId.trim().length > 0
            ? externalCorrelationId.trim()
            : request.id;
        request.correlationId = correlationId;
        reply.header("x-correlation-id", correlationId);
    });
    app.addHook("onResponse", async (request, reply) => {
        if (!isMutatingMethod(request.method)) {
            return;
        }
        try {
            await recordMutationOperationalEvent(request, reply.statusCode);
        }
        catch (error) {
            request.log.error(error, "Failed to capture mutation operational event");
        }
    });
    app.setErrorHandler((error, request, reply) => {
        if (error instanceof ApiError) {
            reply.code(error.statusCode).send({ message: error.message });
            return;
        }
        if (error instanceof Error && error.name === "ZodError") {
            const message = error.issues?.map((item) => item.message).join(", ");
            reply.code(400).send({ message: message || "Validation failed" });
            return;
        }
        const fastifyStatus = Number(error?.statusCode || 0);
        const fastifyCode = String(error?.code || "");
        if (fastifyStatus >= 400 && fastifyStatus < 500 && fastifyCode.startsWith("FST_")) {
            reply.code(fastifyStatus).send({ message: error.message || "Invalid request" });
            return;
        }
        const prismaCode = typeof error?.code === "string"
            ? String(error.code)
            : null;
        if (prismaCode) {
            if (prismaCode === "P2021" || prismaCode === "P2022") {
                reply.code(500).send({ message: "Database schema is out of date. Run `pnpm db:push` and restart the server." });
                return;
            }
            if (prismaCode === "P2025") {
                reply.code(404).send({ message: "Record not found" });
                return;
            }
            if (prismaCode === "P2002") {
                reply.code(409).send({ message: "Conflict: record already exists" });
                return;
            }
            if (prismaCode === "P2003" || prismaCode === "P2014") {
                reply.code(409).send({ message: "Conflict: dependent records prevent this operation" });
                return;
            }
            if (prismaCode.startsWith("P20")) {
                reply.code(400).send({ message: "Invalid database operation payload" });
                return;
            }
        }
        const rawCode = String(error?.code || "");
        const rawMessage = String(error?.message || "").toLowerCase();
        if (rawCode === "23503" ||
            rawCode === "23505" ||
            rawCode.startsWith("SQLITE_CONSTRAINT")) {
            reply.code(409).send({ message: "Conflict: dependent records prevent this operation" });
            return;
        }
        if (rawMessage.includes("no such table") ||
            rawMessage.includes("no such column")) {
            reply.code(500).send({ message: "Database schema is out of date. Run `pnpm db:push` and restart the server." });
            return;
        }
        if (rawMessage.includes("foreign key constraint failed") ||
            rawMessage.includes("constraint failed") ||
            rawMessage.includes("violates foreign key constraint") ||
            rawMessage.includes("duplicate key value")) {
            reply.code(409).send({ message: "Conflict: dependent records prevent this operation" });
            return;
        }
        if (error?.name === "PrismaClientValidationError") {
            reply.code(400).send({ message: "Invalid database payload" });
            return;
        }
        request.log.error(error);
        if (env.NODE_ENV !== "production" && error instanceof Error && error.message) {
            reply.code(500).send({ message: error.message });
            return;
        }
        reply.code(500).send({ message: "Internal server error" });
    });
    app.register(registerHealthRoutes);
    app.register(registerAuthRoutes);
    app.register(registerAdminRoutes);
    app.register(registerIncomingRoutes);
    app.register(registerEncounterRoutes);
    app.register(registerSafetyRoutes);
    app.register(registerTaskRoutes);
    app.register(registerAlertRoutes);
    app.register(registerEventRoutes);
    app.register(registerDashboardRoutes);
    return app;
}
//# sourceMappingURL=app.js.map