import type { FastifyReply, FastifyRequest } from "fastify";
import { RoleName } from "@prisma/client";
export type RequestUser = {
    id: string;
    role: RoleName;
    roles: RoleName[];
    clinicId: string | null;
    facilityId: string | null;
    activeFacilityId: string | null;
    availableFacilityIds: string[];
    authSource: "jwt" | "dev_header";
    identityProvider?: string | null;
    entraObjectId?: string | null;
    entraTenantId?: string | null;
};
declare module "fastify" {
    interface FastifyRequest {
        user?: RequestUser;
    }
}
export declare function resolveRequestUser(request: FastifyRequest): Promise<RequestUser | null>;
export declare function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
export declare function requireRoles(...allowed: RoleName[]): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
