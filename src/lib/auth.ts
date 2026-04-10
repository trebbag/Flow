import type { FastifyReply, FastifyRequest } from "fastify";
import { RoleName } from "@prisma/client";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { env } from "./env.js";
import { prisma } from "./prisma.js";

export type RequestUser = {
  id: string;
  role: RoleName;
  roles: RoleName[];
  clinicId: string | null;
  facilityId: string | null;
  activeFacilityId: string | null;
  availableFacilityIds: string[];
  authSource: "jwt" | "dev_header";
};

declare module "fastify" {
  interface FastifyRequest {
    user?: RequestUser;
  }
}

function asRole(value?: string | null): RoleName | null {
  if (!value) return null;
  if (Object.values(RoleName).includes(value as RoleName)) {
    return value as RoleName;
  }
  return null;
}

const jwtSecret = env.JWT_SECRET ? new TextEncoder().encode(env.JWT_SECRET) : null;
const remoteJwks = env.JWT_JWKS_URI ? createRemoteJWKSet(new URL(env.JWT_JWKS_URI)) : null;
const jwtSubjectClaims = env.JWT_SUBJECT_CLAIMS.split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const jwtRoleClaims = env.JWT_ROLE_CLAIMS.split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const jwtEmailClaims = env.JWT_EMAIL_CLAIMS.split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const jwtClinicClaims = env.JWT_CLINIC_ID_CLAIMS.split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const jwtFacilityClaims = env.JWT_FACILITY_ID_CLAIMS.split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (env.AUTH_MODE === "jwt" && !jwtSecret && !remoteJwks) {
  throw new Error("AUTH_MODE=jwt requires JWT_SECRET or JWT_JWKS_URI");
}

function claimToString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return null;
}

function claimToStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .flatMap((entry) => entry.split(/[,\s]+/))
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function firstClaim(payload: JWTPayload, keys: string[]): string | null {
  for (const key of keys) {
    const value = claimToString(payload[key]);
    if (value) return value;
  }
  return null;
}

function roleClaims(payload: JWTPayload): RoleName[] {
  const parsed = new Set<RoleName>();
  for (const key of jwtRoleClaims) {
    const values = claimToStringArray(payload[key]);
    for (const value of values) {
      const role = asRole(value);
      if (role) parsed.add(role);
    }
  }
  return Array.from(parsed.values());
}

function extractBearerToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (!authHeader || typeof authHeader !== "string") return null;
  const [scheme, token] = authHeader.split(" ");
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== "bearer") return null;
  return token.trim() || null;
}

function dedupeRoleNames(rows: Array<{ role: RoleName }>) {
  return Array.from(new Set(rows.map((row) => row.role)));
}

async function resolveFacilityScopeForRole(params: {
  selectedRole: RoleName;
  roleRows: Array<{ clinicId: string | null; facilityId: string | null; clinic?: { facilityId: string | null } | null }>;
  requestedFacilityId: string | null;
  persistedActiveFacilityId: string | null;
}) {
  const { selectedRole, roleRows, requestedFacilityId, persistedActiveFacilityId } = params;

  let availableFacilityIds: string[] = [];
  if (selectedRole === RoleName.Admin) {
    const facilities = await prisma.facility.findMany({
      where: { status: { not: "archived" } },
      select: { id: true },
      orderBy: { createdAt: "asc" }
    });
    availableFacilityIds = facilities.map((row) => row.id);
  } else {
    const ids = new Set<string>();
    roleRows.forEach((row) => {
      if (row.facilityId) ids.add(row.facilityId);
      if (row.clinic?.facilityId) ids.add(row.clinic.facilityId);
    });
    availableFacilityIds = Array.from(ids.values());
  }

  if (availableFacilityIds.length === 0) {
    return { activeFacilityId: null, availableFacilityIds };
  }

  const requested = requestedFacilityId?.trim() || null;
  const persisted = persistedActiveFacilityId?.trim() || null;
  const activeFacilityId =
    (requested && availableFacilityIds.includes(requested) ? requested : null) ||
    (persisted && availableFacilityIds.includes(persisted) ? persisted : null) ||
    availableFacilityIds[0] ||
    null;

  return { activeFacilityId, availableFacilityIds };
}

async function resolveUserFromJwt(request: FastifyRequest): Promise<RequestUser | null> {
  const token = extractBearerToken(request);
  if (!token) return null;
  if (!jwtSecret && !remoteJwks) return null;

  try {
    const verifyOptions = {
      issuer: env.JWT_ISSUER || undefined,
      audience: env.JWT_AUDIENCE || undefined
    };

    const { payload } = jwtSecret
      ? await jwtVerify(token, jwtSecret, verifyOptions)
      : await jwtVerify(token, remoteJwks!, verifyOptions);

    const subject = firstClaim(payload, jwtSubjectClaims);
    if (!subject) return null;

    const emailClaim = firstClaim(payload, jwtEmailClaims)?.toLowerCase() || null;
    const tokenRoles = roleClaims(payload);
    const clinicScope = firstClaim(payload, jwtClinicClaims);
    const facilityScope = firstClaim(payload, jwtFacilityClaims);
    const headerFacilityId = (request.headers["x-facility-id"] as string | undefined)?.trim() || null;

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { id: subject },
          { cognitoSub: subject },
          ...(emailClaim ? [{ email: emailClaim }] : [])
        ]
      },
      include: {
        roles: {
          include: {
            clinic: { select: { facilityId: true } }
          }
        }
      }
    });

    if (!user || user.roles.length === 0 || user.status !== "active") {
      return null;
    }

    const availableRoleSet = new Set(dedupeRoleNames(user.roles));
    const selectedRole = tokenRoles.find((entry) => availableRoleSet.has(entry)) ?? user.roles[0]!.role;
    const roleRows = user.roles.filter((entry) => entry.role === selectedRole);
    const facilityScopeResult = await resolveFacilityScopeForRole({
      selectedRole,
      roleRows,
      requestedFacilityId: headerFacilityId || facilityScope,
      persistedActiveFacilityId: user.activeFacilityId
    });

    const selectedScope =
      roleRows.find((entry) => {
        if (!facilityScopeResult.activeFacilityId) return true;
        return (entry.facilityId || entry.clinic?.facilityId || null) === facilityScopeResult.activeFacilityId;
      }) || roleRows[0] || user.roles[0]!;

    const clinicId =
      selectedScope.clinicId ??
      clinicScope ??
      roleRows.find((entry) => entry.clinicId && (!facilityScopeResult.activeFacilityId || entry.clinic?.facilityId === facilityScopeResult.activeFacilityId))
        ?.clinicId ??
      null;

    return {
      id: user.id,
      role: selectedRole,
      roles: Array.from(availableRoleSet.values()),
      clinicId,
      facilityId: facilityScopeResult.activeFacilityId,
      activeFacilityId: facilityScopeResult.activeFacilityId,
      availableFacilityIds: facilityScopeResult.availableFacilityIds,
      authSource: "jwt"
    };
  } catch {
    return null;
  }
}

async function resolveUserFromDevHeaders(request: FastifyRequest): Promise<RequestUser | null> {
  const headerUserId = (request.headers["x-dev-user-id"] as string | undefined)?.trim();
  const headerRole = asRole((request.headers["x-dev-role"] as string | undefined)?.trim());
  const headerFacilityId = (request.headers["x-facility-id"] as string | undefined)?.trim() || null;

  if (headerUserId) {
    const dbUser = await prisma.user.findUnique({
      where: { id: headerUserId },
      include: {
        roles: {
          include: {
            clinic: { select: { facilityId: true } }
          }
        }
      }
    });

    if (dbUser && dbUser.roles.length > 0 && dbUser.status === "active") {
      const selectedRole =
        (headerRole && dbUser.roles.some((entry) => entry.role === headerRole) ? headerRole : null) ?? dbUser.roles[0]!.role;
      const roleRows = dbUser.roles.filter((entry) => entry.role === selectedRole);
      const facilityScopeResult = await resolveFacilityScopeForRole({
        selectedRole,
        roleRows,
        requestedFacilityId: headerFacilityId,
        persistedActiveFacilityId: dbUser.activeFacilityId
      });
      const selectedScope =
        roleRows.find((entry) => {
          if (!facilityScopeResult.activeFacilityId) return true;
          return (entry.facilityId || entry.clinic?.facilityId || null) === facilityScopeResult.activeFacilityId;
        }) || roleRows[0] || dbUser.roles[0]!;

      return {
        id: dbUser.id,
        role: selectedRole,
        roles: dedupeRoleNames(dbUser.roles),
        clinicId: selectedScope.clinicId,
        facilityId: facilityScopeResult.activeFacilityId,
        activeFacilityId: facilityScopeResult.activeFacilityId,
        availableFacilityIds: facilityScopeResult.availableFacilityIds,
        authSource: "dev_header"
      };
    }

    return null;
  }

  if (!env.AUTH_ALLOW_IMPLICIT_ADMIN) {
    return null;
  }

  // explicit opt-in only, for local debugging fallback behavior
  const adminRole = await prisma.userRole.findFirst({
    where: { role: RoleName.Admin },
    include: { user: true },
    orderBy: { id: "asc" }
  });

  if (adminRole) {
    const facilities = await prisma.facility.findMany({
      where: { status: { not: "archived" } },
      select: { id: true },
      orderBy: { createdAt: "asc" }
    });
    const availableFacilityIds = facilities.map((row) => row.id);
    const activeFacilityId = adminRole.user.activeFacilityId || adminRole.facilityId || availableFacilityIds[0] || null;
    return {
      id: adminRole.userId,
      role: RoleName.Admin,
      roles: [RoleName.Admin],
      clinicId: adminRole.clinicId,
      facilityId: activeFacilityId,
      activeFacilityId,
      availableFacilityIds,
      authSource: "dev_header"
    };
  }

  return null;
}

export async function resolveRequestUser(request: FastifyRequest): Promise<RequestUser | null> {
  if (env.AUTH_MODE === "jwt") {
    return resolveUserFromJwt(request);
  }

  if (env.AUTH_MODE === "dev_header") {
    return resolveUserFromDevHeaders(request);
  }

  // hybrid mode: JWT first, then dev headers when explicitly allowed.
  const jwtUser = await resolveUserFromJwt(request);
  if (jwtUser) return jwtUser;
  if (env.AUTH_ALLOW_DEV_HEADERS) {
    return resolveUserFromDevHeaders(request);
  }
  return null;
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const user = await resolveRequestUser(request);
  if (!user) {
    const message =
      env.AUTH_MODE === "jwt"
        ? "Unauthorized. Provide a valid Bearer token."
        : "Unauthorized. Provide a valid Bearer token or x-dev-user-id/x-dev-role headers.";
    reply.code(401).send({ message });
    return;
  }
  request.user = user;
}

export function requireRoles(...allowed: RoleName[]) {
  return async function roleGuard(request: FastifyRequest, reply: FastifyReply) {
    await authenticate(request, reply);
    if (reply.sent) return;
    const role = request.user!.role;
    if (!allowed.includes(role)) {
      reply.code(403).send({ message: `Forbidden for role ${role}` });
    }
  };
}
