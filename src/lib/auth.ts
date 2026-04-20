import type { FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { RoleName } from "@prisma/client";
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from "jose";
import { env } from "./env.js";
import { ApiError } from "./errors.js";
import { prisma } from "./prisma.js";

export type RequestUser = {
  id: string;
  role: RoleName;
  roles: RoleName[];
  clinicId: string | null;
  facilityId: string | null;
  activeFacilityId: string | null;
  availableFacilityIds: string[];
  authSource: "jwt" | "dev_header" | "proof_header";
  identityProvider?: string | null;
  entraObjectId?: string | null;
  entraTenantId?: string | null;
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

function splitEnvList(value?: string | null) {
  return (value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const jwtSecret = env.JWT_SECRET ? new TextEncoder().encode(env.JWT_SECRET) : null;
const remoteJwks = env.JWT_JWKS_URI ? createRemoteJWKSet(new URL(env.JWT_JWKS_URI)) : null;
const jwtSubjectClaims = splitEnvList(env.JWT_SUBJECT_CLAIMS);
const jwtRoleClaims = splitEnvList(env.JWT_ROLE_CLAIMS);
const jwtEmailClaims = splitEnvList(env.JWT_EMAIL_CLAIMS);
const jwtClinicClaims = splitEnvList(env.JWT_CLINIC_ID_CLAIMS);
const jwtFacilityClaims = splitEnvList(env.JWT_FACILITY_ID_CLAIMS);
const jwtIssuers = Array.from(
  new Set(
    [env.JWT_ISSUER]
      .filter((value): value is string => Boolean(value))
      .flatMap((value) => {
        const derived = [value.trim()];
        const v2IssuerMatch = /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/v2\.0\/?$/i.exec(value.trim());
        if (v2IssuerMatch?.[1]) {
          derived.push(`https://sts.windows.net/${v2IssuerMatch[1]}/`);
        }
        return derived;
      })
  )
);
const jwtAudiences = Array.from(
  new Set(
    splitEnvList(env.JWT_AUDIENCE)
      .filter(Boolean)
      .flatMap((value) => {
        const derived = [value];
        const appIdUriMatch = /^api:\/\/([^/]+)$/.exec(value);
        if (appIdUriMatch?.[1]) {
          derived.push(appIdUriMatch[1]);
        }
        return derived;
      })
  )
);

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

function hasBearerToken(request: FastifyRequest) {
  return Boolean(extractBearerToken(request));
}

function matchesProofSecret(candidate: string | null) {
  const expected = env.AUTH_PROOF_HEADER_SECRET?.trim() || "";
  const provided = candidate?.trim() || "";
  if (!expected || !provided) return false;
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  if (expectedBytes.length !== providedBytes.length) return false;
  return timingSafeEqual(expectedBytes, providedBytes);
}

function dedupeRoleNames(rows: Array<{ role: RoleName }>) {
  return Array.from(new Set(rows.map((row) => row.role)));
}

function resolveLegacyIdentityAlias(params: {
  subject: string;
  entraObjectIdClaim: string | null;
  cognitoSub: string | null | undefined;
}) {
  return params.entraObjectIdClaim || params.cognitoSub || params.subject;
}

function resolveStoredEntraObjectId(user: {
  entraObjectId: string | null;
  cognitoSub: string | null;
}) {
  return user.entraObjectId || user.cognitoSub || null;
}

async function resolveHeaderScopedUser(params: {
  userId: string | null;
  role: RoleName | null;
  facilityId: string | null;
  authSource: RequestUser["authSource"];
}) {
  const headerUserId = params.userId?.trim() || null;
  if (!headerUserId) return null;

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

  if (!dbUser || dbUser.roles.length === 0 || dbUser.status !== "active") {
    return null;
  }

  const selectedRole =
    (params.role && dbUser.roles.some((entry) => entry.role === params.role) ? params.role : null) ?? dbUser.roles[0]!.role;
  const roleRows = dbUser.roles.filter((entry) => entry.role === selectedRole);
  const facilityScopeResult = await resolveFacilityScopeForRole({
    selectedRole,
    roleRows,
    requestedFacilityId: params.facilityId,
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
    authSource: params.authSource
  } satisfies RequestUser;
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
      issuer: jwtIssuers.length > 0 ? jwtIssuers : undefined,
      audience: jwtAudiences.length > 0 ? jwtAudiences : undefined
    };

    const { payload } = jwtSecret
      ? await jwtVerify(token, jwtSecret, verifyOptions)
      : await jwtVerify(token, remoteJwks!, verifyOptions);

    const entraObjectIdClaim =
      claimToString(payload.oid) ||
      claimToString(payload.objectidentifier) ||
      null;
    const subject = entraObjectIdClaim || firstClaim(payload, jwtSubjectClaims);
    if (!subject) {
      request.log.warn(
        {
          authStage: "jwt_subject_missing",
          subjectClaims: jwtSubjectClaims
        },
        "JWT verified but no supported subject claim was present"
      );
      return null;
    }

    const emailClaim = firstClaim(payload, jwtEmailClaims)?.toLowerCase() || null;
    const tokenTenantId = claimToString(payload.tid) || null;
    const tokenIdentityType = claimToString(payload.idtyp)?.toLowerCase() || null;
    const tokenUserType = claimToString(payload.userType) || null;
    const tokenRoles = roleClaims(payload);
    const clinicScope = firstClaim(payload, jwtClinicClaims);
    const facilityScope = firstClaim(payload, jwtFacilityClaims);
    const headerFacilityId = (request.headers["x-facility-id"] as string | undefined)?.trim() || null;

    if (env.ENTRA_STRICT_MODE) {
      if (tokenIdentityType === "app") {
        throw new ApiError({ statusCode: 403, code: "JWT_APPLICATION_TOKEN_FORBIDDEN", message: "User sign-in is required. Application tokens are not allowed." });
      }
      if (env.ENTRA_TENANT_ID && tokenTenantId && tokenTenantId !== env.ENTRA_TENANT_ID) {
        throw new ApiError({ statusCode: 403, code: "JWT_TENANT_MISMATCH", message: "This Microsoft account belongs to the wrong tenant." });
      }
      if (tokenUserType && tokenUserType.toLowerCase() !== "member") {
        throw new ApiError({ statusCode: 403, code: "JWT_GUEST_ACCOUNT_FORBIDDEN", message: "Guest and B2B Microsoft accounts are not allowed." });
      }
    }

    const userInclude = {
      roles: {
        include: {
          clinic: { select: { facilityId: true } }
        }
      }
    } as const;

    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { id: subject },
          { entraObjectId: subject },
          { cognitoSub: subject },
          ...(emailClaim ? [{ email: emailClaim }] : [])
        ]
      },
      include: userInclude
    });

    if (!user) {
      throw new ApiError({ statusCode: 403, code: "FLOW_ACCOUNT_NOT_PROVISIONED", message: "This Microsoft account is not provisioned for Flow." });
    }

    const matchedBySubject = user.id === subject || user.entraObjectId === subject || user.cognitoSub === subject;
    const matchedByEmail = Boolean(emailClaim) && user.email === emailClaim;
    const staleDirectorySuspension =
      env.ENTRA_STRICT_MODE &&
      matchedByEmail &&
      user.identityProvider === "entra" &&
      user.status === "suspended" &&
      user.roles.length > 0 &&
      (user.directoryAccountEnabled === false ||
        ["deleted", "disabled", "guest"].includes(String(user.directoryStatus || "").toLowerCase()));

    if (staleDirectorySuspension) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          status: "active",
          entraObjectId: subject,
          entraTenantId: tokenTenantId || user.entraTenantId || env.ENTRA_TENANT_ID || null,
          entraUserPrincipalName: emailClaim || user.entraUserPrincipalName || null,
          identityProvider: "entra",
          cognitoSub: resolveLegacyIdentityAlias({
            subject,
            entraObjectIdClaim,
            cognitoSub: user.cognitoSub,
          }),
          directoryStatus: "active",
          directoryUserType: tokenUserType || user.directoryUserType || "Member",
          directoryAccountEnabled: true,
          lastDirectorySyncAt: new Date()
        },
        include: userInclude
      });
    }

    if (user.status === "archived") {
      throw new ApiError({ statusCode: 403, code: "FLOW_ACCOUNT_ARCHIVED", message: "This Flow account has been archived." });
    }

    if (user.status === "suspended") {
      throw new ApiError({ statusCode: 403, code: "FLOW_ACCOUNT_SUSPENDED", message: "This Flow account is suspended." });
    }

    if (user.roles.length === 0) {
      throw new ApiError({ statusCode: 403, code: "FLOW_ACCOUNT_ROLE_ASSIGNMENTS_MISSING", message: "This Flow account is missing role assignments." });
    }

    if (env.ENTRA_STRICT_MODE) {
      if (user.identityProvider && user.identityProvider !== "entra") {
        throw new ApiError({ statusCode: 403, code: "FLOW_ACCOUNT_NOT_LINKED_TO_ENTRA", message: "This Flow account is not linked to Microsoft Entra." });
      }
      if (user.directoryUserType && user.directoryUserType.toLowerCase() !== "member") {
        throw new ApiError({ statusCode: 403, code: "FLOW_ACCOUNT_GUEST_FORBIDDEN", message: "Guest and B2B Microsoft accounts are not allowed." });
      }
      if (user.directoryAccountEnabled === false || ["disabled", "deleted", "guest"].includes(String(user.directoryStatus || "").toLowerCase())) {
        throw new ApiError({ statusCode: 403, code: "FLOW_ACCOUNT_DIRECTORY_INACTIVE", message: "This Microsoft account is not active in the directory." });
      }
    }

    const shouldBackfillIdentity =
      user.entraObjectId !== subject ||
      !user.identityProvider ||
      (tokenTenantId && user.entraTenantId !== tokenTenantId) ||
      (emailClaim && user.entraUserPrincipalName !== emailClaim) ||
      !user.cognitoSub;

    if (shouldBackfillIdentity) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          entraObjectId: subject,
          entraTenantId: tokenTenantId || user.entraTenantId || env.ENTRA_TENANT_ID || null,
          entraUserPrincipalName: emailClaim || user.entraUserPrincipalName || null,
          identityProvider: "entra",
          cognitoSub: resolveLegacyIdentityAlias({
            subject,
            entraObjectIdClaim,
            cognitoSub: user.cognitoSub,
          }),
          lastDirectorySyncAt: new Date()
        }
      });
    }

    if (!user || user.roles.length === 0 || user.status !== "active") {
      request.log.warn(
        {
          authStage: "jwt_user_not_mapped",
          subject,
          emailClaim,
          userFound: Boolean(user),
          userStatus: user?.status || null,
          roleCount: user?.roles.length || 0
        },
        "JWT verified but no active Flow user mapping was found"
      );
      throw new ApiError({ statusCode: 403, code: "FLOW_ACCOUNT_NOT_PROVISIONED", message: "This Microsoft account is not provisioned for Flow." });
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
      authSource: "jwt",
      identityProvider: user.identityProvider,
      entraObjectId: resolveStoredEntraObjectId(user),
      entraTenantId: user.entraTenantId || tokenTenantId
    };
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    let tokenIssuer: string | null = null;
    let tokenAudience: string | string[] | null = null;
    try {
      const decoded = decodeJwt(token);
      tokenIssuer = claimToString(decoded.iss);
      tokenAudience = Array.isArray(decoded.aud)
        ? decoded.aud.filter((value): value is string => typeof value === "string")
        : claimToString(decoded.aud);
    } catch {
      // Ignore decode errors; the verification failure details are still useful.
    }
    request.log.warn(
      {
        authStage: "jwt_verify_failed",
        error: error instanceof Error ? error.message : String(error),
        configuredIssuer: jwtIssuers,
        configuredAudience: jwtAudiences,
        tokenIssuer,
        tokenAudience
      },
      "JWT verification failed"
    );
    return null;
  }
}

async function resolveUserFromDevHeaders(request: FastifyRequest): Promise<RequestUser | null> {
  const headerUserId = (request.headers["x-dev-user-id"] as string | undefined)?.trim();
  const headerRole = asRole((request.headers["x-dev-role"] as string | undefined)?.trim());
  const headerFacilityId = (request.headers["x-facility-id"] as string | undefined)?.trim() || null;
  const scopedUser = await resolveHeaderScopedUser({
    userId: headerUserId,
    role: headerRole,
    facilityId: headerFacilityId,
    authSource: "dev_header",
  });
  if (scopedUser) return scopedUser;
  if (headerUserId) return null;

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

async function resolveUserFromProofHeaders(request: FastifyRequest): Promise<RequestUser | null> {
  if (!env.AUTH_PROOF_HEADER_SECRET) return null;
  const proofSecret = (request.headers["x-proof-secret"] as string | undefined)?.trim() || null;
  if (!matchesProofSecret(proofSecret)) return null;

  const headerUserId = (request.headers["x-proof-user-id"] as string | undefined)?.trim() || null;
  const headerRole = asRole((request.headers["x-proof-role"] as string | undefined)?.trim());
  const headerFacilityId = (request.headers["x-facility-id"] as string | undefined)?.trim() || null;

  return resolveHeaderScopedUser({
    userId: headerUserId,
    role: headerRole,
    facilityId: headerFacilityId,
    authSource: "proof_header",
  });
}

export async function resolveRequestUser(request: FastifyRequest): Promise<RequestUser | null> {
  const proofUser = await resolveUserFromProofHeaders(request);
  if (proofUser) return proofUser;

  if (env.AUTH_MODE === "jwt") {
    return resolveUserFromJwt(request);
  }

  if (env.AUTH_MODE === "dev_header") {
    return resolveUserFromDevHeaders(request);
  }

  // hybrid mode: JWT first, then dev headers when explicitly allowed.
  const jwtUser = await resolveUserFromJwt(request);
  if (jwtUser) return jwtUser;
  if (env.AUTH_ALLOW_DEV_HEADERS && !hasBearerToken(request)) {
    return resolveUserFromDevHeaders(request);
  }
  return null;
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  let user: RequestUser | null = null;
  try {
    user = await resolveRequestUser(request);
  } catch (error) {
    if (error instanceof ApiError) {
      reply.code(error.statusCode).send({ message: error.message });
      return;
    }
    throw error;
  }
  if (!user) {
    const message =
      env.AUTH_MODE === "jwt"
        ? "Unauthorized. Provide a valid Bearer token or proof headers."
        : "Unauthorized. Provide a valid Bearer token, proof headers, or x-dev-user-id/x-dev-role headers.";
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
