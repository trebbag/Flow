import type { FastifyRequest } from "fastify";
export declare function isMutatingMethod(method: string): boolean;
export declare function recordMutationOperationalEvent(request: FastifyRequest, statusCode: number): Promise<void>;
