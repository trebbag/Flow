import "dotenv/config";
import { z } from "zod";
import { booleanish } from "./zod-helpers.js";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z
    .string()
    .default("http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173"),
  CORS_ORIGINS: z.string().optional(),
  SAFETY_WORD: z.string().min(3).default("ANCHOR"),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  TRUST_PROXY: booleanish.default(false),
  LOG_LEVEL: z.string().trim().default("info"),
  AUTH_MODE: z.enum(["dev_header", "jwt", "hybrid"]).optional(),
  AUTH_ALLOW_DEV_HEADERS: booleanish.optional(),
  AUTH_PROOF_HEADER_SECRET: z.string().trim().optional(),
  AUTH_PROOF_HMAC_SECRET: z.string().trim().optional(),
  AUTH_PROOF_HMAC_MAX_SKEW_SECONDS: z.coerce.number().int().positive().default(300),
  AUTH_PROOF_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  AUTH_PROOF_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  AUTH_ALLOW_IMPLICIT_ADMIN: booleanish.default(false),
  ENTRA_STRICT_MODE: booleanish.optional(),
  ENTRA_TENANT_ID: z.string().trim().optional(),
  ENTRA_GRAPH_API_BASE_URL: z.string().trim().default("https://graph.microsoft.com/v1.0"),
  ENTRA_GRAPH_SCOPE: z.string().trim().default("https://graph.microsoft.com/.default"),
  ENTRA_GRAPH_MANAGED_IDENTITY_CLIENT_ID: z.string().trim().optional(),
  JWT_ISSUER: z.string().trim().optional(),
  JWT_AUDIENCE: z.string().trim().optional(),
  JWT_JWKS_URI: z.string().trim().optional(),
  JWT_SECRET: z.string().trim().optional(),
  JWT_SUBJECT_CLAIMS: z.string().default("oid,objectidentifier,sub"),
  JWT_ROLE_CLAIMS: z.string().default("clinops_role,custom:role,role,roles"),
  JWT_EMAIL_CLAIMS: z.string().default("email,upn,preferred_username"),
  JWT_CLINIC_ID_CLAIMS: z.string().default("clinic_id,clinicId,custom:clinic_id"),
  JWT_FACILITY_ID_CLAIMS: z.string().default("facility_id,facilityId,custom:facility_id"),
  PHI_ENCRYPTION_KEY: z.string().trim().optional(),
  PHI_ENCRYPTION_KEY_ID: z.string().trim().default("v1"),
  ATHENA_TIMEOUT_MS: z.coerce.number().int().positive().default(7000),
  ATHENA_RETRY_COUNT: z.coerce.number().int().min(0).default(2),
  ATHENA_RETRY_BACKOFF_MS: z.coerce.number().int().positive().default(400)
});

const parsed = envSchema.parse(process.env);

const defaultAuthMode = parsed.NODE_ENV === "production" ? "jwt" : "hybrid";
const defaultAllowDevHeaders = parsed.NODE_ENV !== "production";
const defaultEntraStrictMode = parsed.NODE_ENV === "production";
const allowedCorsOrigins = (parsed.CORS_ORIGINS || parsed.CORS_ORIGIN)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function deriveTenantId(jwtIssuer?: string) {
  const issuer = jwtIssuer?.trim();
  if (!issuer) return "";

  const v2Match = /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/v2\.0\/?$/i.exec(issuer);
  if (v2Match?.[1]) {
    return v2Match[1];
  }

  const legacyMatch = /^https:\/\/sts\.windows\.net\/([^/]+)\/?$/i.exec(issuer);
  return legacyMatch?.[1] || "";
}

const resolvedTenantId = parsed.ENTRA_TENANT_ID || deriveTenantId(parsed.JWT_ISSUER);

export const env = {
  ...parsed,
  CORS_ALLOWED_ORIGINS: allowedCorsOrigins,
  AUTH_MODE: parsed.AUTH_MODE ?? defaultAuthMode,
  AUTH_ALLOW_DEV_HEADERS: parsed.AUTH_ALLOW_DEV_HEADERS ?? defaultAllowDevHeaders,
  ENTRA_STRICT_MODE: parsed.ENTRA_STRICT_MODE ?? defaultEntraStrictMode,
  ENTRA_TENANT_ID: resolvedTenantId
};
