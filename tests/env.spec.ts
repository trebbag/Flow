import { afterEach, describe, expect, it, vi } from "vitest";

describe("environment boolean parsing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("treats string false values as false in production auth flags", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_MODE", "jwt");
    vi.stubEnv("AUTH_ALLOW_DEV_HEADERS", "false");
    vi.stubEnv("AUTH_ALLOW_IMPLICIT_ADMIN", "false");
    vi.stubEnv("ENTRA_STRICT_MODE", "true");
    vi.stubEnv("JWT_SECRET", "test-secret");
    vi.stubEnv("JWT_ISSUER", "https://login.microsoftonline.com/test-tenant/v2.0");
    vi.stubEnv("JWT_AUDIENCE", "api://test-app");

    const { env } = await import("../src/lib/env.js");
    const { collectStartupInvariantViolations } = await import("../src/lib/startup-invariants.js");

    expect(env.AUTH_ALLOW_DEV_HEADERS).toBe(false);
    expect(env.AUTH_ALLOW_IMPLICIT_ADMIN).toBe(false);
    expect(env.ENTRA_STRICT_MODE).toBe(true);
    expect(collectStartupInvariantViolations()).toEqual([]);
  });
});
