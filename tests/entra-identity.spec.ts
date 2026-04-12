import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoleName } from "@prisma/client";
import { bootstrapCore, jwtHeaders, prisma, resetDb } from "./helpers.js";

const entraDirectoryMock = vi.hoisted(() => ({
  searchEntraDirectoryUsers: vi.fn(),
  getEntraDirectoryUserByObjectId: vi.fn(),
}));

vi.mock("../src/lib/entra-directory.js", () => entraDirectoryMock);

async function buildStrictApp() {
  vi.resetModules();
  vi.stubEnv("AUTH_MODE", "jwt");
  vi.stubEnv("AUTH_ALLOW_DEV_HEADERS", "false");
  vi.stubEnv("AUTH_ALLOW_IMPLICIT_ADMIN", "false");
  vi.stubEnv("ENTRA_STRICT_MODE", "true");
  vi.stubEnv("ENTRA_TENANT_ID", "test-entra-tenant");
  vi.stubEnv("JWT_SECRET", "strict-entra-test-secret");
  vi.stubEnv("JWT_ISSUER", "https://login.microsoftonline.com/test-entra-tenant/v2.0");
  vi.stubEnv("JWT_AUDIENCE", "api://strict-entra-app");

  const { buildApp } = await import("../src/app.js");
  return buildApp();
}

async function strictJwtHeaders(params: {
  oid: string;
  role?: RoleName;
  facilityId?: string | null;
  email?: string;
  userType?: string;
}) {
  return jwtHeaders({
    email: params.email,
    role: params.role,
    facilityId: params.facilityId || undefined,
    subjectClaim: { key: "oid", value: params.oid },
    extraClaims: {
      tid: "test-entra-tenant",
      userType: params.userType || "Member",
    },
  });
}

async function linkUserToStrictEntra(userId: string, objectId: string, email: string) {
  return prisma.user.update({
    where: { id: userId },
    data: {
      email,
      cognitoSub: objectId,
      entraObjectId: objectId,
      entraTenantId: "test-entra-tenant",
      entraUserPrincipalName: email,
      identityProvider: "entra",
      directoryStatus: "active",
      directoryUserType: "Member",
      directoryAccountEnabled: true,
      lastDirectorySyncAt: new Date(),
    },
  });
}

describe("Entra-only identity and provisioning", () => {
  beforeEach(async () => {
    await resetDb();
    entraDirectoryMock.searchEntraDirectoryUsers.mockReset();
    entraDirectoryMock.getEntraDirectoryUserByObjectId.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a clear message when a Microsoft account is not provisioned", async () => {
    const app = await buildStrictApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/auth/context",
        headers: await strictJwtHeaders({
          oid: "missing-user-oid",
          role: RoleName.Admin,
          email: "missing.user@clinicos1.onmicrosoft.com",
        }),
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toContain("not provisioned");
    } finally {
      await app.close();
    }
  });

  it("blocks guest users even if they are provisioned in Flow", async () => {
    const app = await buildStrictApp();
    const ctx = await bootstrapCore();

    try {
      await prisma.user.update({
        where: { id: ctx.admin.id },
        data: {
          cognitoSub: "guest-entra-oid",
          entraObjectId: "guest-entra-oid",
          entraTenantId: "test-entra-tenant",
          entraUserPrincipalName: ctx.admin.email,
          identityProvider: "entra",
          directoryStatus: "guest",
          directoryUserType: "Guest",
          directoryAccountEnabled: true,
          lastDirectorySyncAt: new Date(),
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/auth/context",
        headers: await strictJwtHeaders({
          oid: "guest-entra-oid",
          role: RoleName.Admin,
          facilityId: ctx.facility.id,
          email: ctx.admin.email,
          userType: "Guest",
        }),
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toContain("Guest");
    } finally {
      await app.close();
    }
  });

  it("recovers a stale suspended Entra mapping when the token matches by email", async () => {
    const app = await buildStrictApp();
    const ctx = await bootstrapCore();

    try {
      await prisma.user.update({
        where: { id: ctx.admin.id },
        data: {
          email: ctx.admin.email,
          cognitoSub: "stale-entra-oid",
          entraObjectId: "stale-entra-oid",
          entraTenantId: "test-entra-tenant",
          entraUserPrincipalName: ctx.admin.email,
          identityProvider: "entra",
          directoryStatus: "deleted",
          directoryUserType: "Member",
          directoryAccountEnabled: false,
          status: "suspended",
          lastDirectorySyncAt: new Date(),
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/auth/context",
        headers: await strictJwtHeaders({
          oid: "fresh-entra-oid",
          role: RoleName.Admin,
          facilityId: ctx.facility.id,
          email: ctx.admin.email,
          userType: "Member",
        }),
      });

      expect(response.statusCode).toBe(200);

      const repaired = await prisma.user.findUnique({
        where: { id: ctx.admin.id },
      });

      expect(repaired).toMatchObject({
        status: "active",
        directoryStatus: "active",
        directoryAccountEnabled: true,
        entraObjectId: "fresh-entra-oid",
        cognitoSub: "fresh-entra-oid",
      });
    } finally {
      await app.close();
    }
  });

  it("provisions Entra directory users through the admin API and blocks legacy local user creation", async () => {
    const app = await buildStrictApp();
    const ctx = await bootstrapCore();

    try {
      await linkUserToStrictEntra(ctx.admin.id, "admin-entra-oid", ctx.admin.email);

      entraDirectoryMock.getEntraDirectoryUserByObjectId.mockResolvedValue({
        objectId: "new-user-entra-oid",
        displayName: "Provisioned Nurse",
        email: "nurse@clinicos1.onmicrosoft.com",
        userPrincipalName: "nurse@clinicos1.onmicrosoft.com",
        accountEnabled: true,
        userType: "Member",
        tenantId: "test-entra-tenant",
        identityProvider: "entra",
        directoryStatus: "active",
      });

      const adminHeaders = await strictJwtHeaders({
        oid: "admin-entra-oid",
        role: RoleName.Admin,
        facilityId: ctx.facility.id,
        email: ctx.admin.email,
      });

      const provisioned = await app.inject({
        method: "POST",
        url: "/admin/users/provision",
        headers: adminHeaders,
        payload: {
          objectId: "new-user-entra-oid",
          role: RoleName.MA,
          facilityId: ctx.facility.id,
        },
      });

      expect(provisioned.statusCode).toBe(200);
      expect(provisioned.json()).toMatchObject({
        email: "nurse@clinicos1.onmicrosoft.com",
        identityProvider: "entra",
        entraObjectId: "new-user-entra-oid",
      });

      const legacyCreate = await app.inject({
        method: "POST",
        url: "/admin/users",
        headers: adminHeaders,
        payload: {
          name: "Legacy Local User",
          email: "legacy.local@test.local",
          role: RoleName.MA,
          facilityId: ctx.facility.id,
        },
      });

      expect(legacyCreate.statusCode).toBe(405);
      expect(legacyCreate.json().message).toContain("Local user creation is disabled");
    } finally {
      await app.close();
    }
  });

  it("resyncs Entra-linked users and suspends access when the directory account disappears", async () => {
    const app = await buildStrictApp();
    const ctx = await bootstrapCore();

    try {
      await linkUserToStrictEntra(ctx.admin.id, "admin-entra-oid", ctx.admin.email);
      await linkUserToStrictEntra(ctx.ma.id, "ma-entra-oid", ctx.ma.email);

      entraDirectoryMock.getEntraDirectoryUserByObjectId.mockResolvedValueOnce(null);

      const response = await app.inject({
        method: "POST",
        url: `/admin/users/${ctx.ma.id}/resync`,
        headers: await strictJwtHeaders({
          oid: "admin-entra-oid",
          role: RoleName.Admin,
          facilityId: ctx.facility.id,
          email: ctx.admin.email,
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: ctx.ma.id,
        status: "suspended",
        directoryStatus: "deleted",
      });
    } finally {
      await app.close();
    }
  });
});
