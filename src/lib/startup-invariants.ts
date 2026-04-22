import { env } from "./env.js";

export class StartupInvariantViolation extends Error {
  public readonly violations: string[];
  constructor(violations: string[]) {
    super(`Refusing to start — ${violations.length} production invariant${violations.length === 1 ? "" : "s"} violated:\n  - ${violations.join("\n  - ")}`);
    this.name = "StartupInvariantViolation";
    this.violations = violations;
  }
}

export function collectStartupInvariantViolations(): string[] {
  const violations: string[] = [];
  if (env.NODE_ENV !== "production") return violations;

  if (env.AUTH_ALLOW_DEV_HEADERS) {
    violations.push("AUTH_ALLOW_DEV_HEADERS must be false in production.");
  }
  if (env.AUTH_ALLOW_IMPLICIT_ADMIN) {
    violations.push("AUTH_ALLOW_IMPLICIT_ADMIN must be false in production.");
  }
  if (env.AUTH_MODE !== "jwt") {
    violations.push(`AUTH_MODE must be "jwt" in production (got "${env.AUTH_MODE}").`);
  }
  if (!env.ENTRA_STRICT_MODE) {
    violations.push("ENTRA_STRICT_MODE must be true in production.");
  }
  if (!env.JWT_ISSUER || !env.JWT_AUDIENCE) {
    violations.push("JWT_ISSUER and JWT_AUDIENCE must both be set in production.");
  }
  if (!env.JWT_JWKS_URI && !env.JWT_SECRET) {
    violations.push("Either JWT_JWKS_URI or JWT_SECRET must be set in production.");
  }
  if (env.AUTH_PROOF_HEADER_SECRET && !env.AUTH_PROOF_HMAC_SECRET) {
    violations.push(
      "When AUTH_PROOF_HEADER_SECRET is set, AUTH_PROOF_HMAC_SECRET must also be set in production to enable signed requests.",
    );
  }
  if (env.CORS_ALLOWED_ORIGINS.some((origin) => origin.startsWith("http://") && !origin.startsWith("http://localhost") && !origin.startsWith("http://127.0.0.1"))) {
    violations.push("CORS origins in production must use https:// (localhost origins excepted).");
  }

  return violations;
}

export function assertStartupInvariants() {
  const violations = collectStartupInvariantViolations();
  if (violations.length > 0) {
    throw new StartupInvariantViolation(violations);
  }
}
