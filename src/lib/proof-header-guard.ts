import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { env } from "./env.js";
import { recordProofHeaderReject } from "./metrics.js";

type Bucket = { windowStartMs: number; count: number };
const buckets = new Map<string, Bucket>();

function bucketKey(request: FastifyRequest): string {
  const ip = (request.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || request.ip || "unknown";
  return `proof:${ip}`;
}

function enforceProofRateLimit(request: FastifyRequest): boolean {
  const now = Date.now();
  const key = bucketKey(request);
  const windowMs = env.AUTH_PROOF_RATE_LIMIT_WINDOW_MS;
  const limit = env.AUTH_PROOF_RATE_LIMIT_MAX;
  const current = buckets.get(key);
  if (!current || now - current.windowStartMs >= windowMs) {
    buckets.set(key, { windowStartMs: now, count: 1 });
    return true;
  }
  current.count += 1;
  if (current.count > limit) {
    recordProofHeaderReject("rate_limited");
    return false;
  }
  return true;
}

function timingSafeEqualString(expected: string, candidate: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  if (expectedBytes.length !== candidateBytes.length) return false;
  return timingSafeEqual(expectedBytes, candidateBytes);
}

function readRawBody(request: FastifyRequest): string {
  const body = request.body;
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return "";
  }
}

function verifyProofHmac(request: FastifyRequest): boolean {
  const hmacSecret = env.AUTH_PROOF_HMAC_SECRET?.trim();
  if (!hmacSecret) {
    return true;
  }

  const timestampHeader = (request.headers["x-proof-timestamp"] as string | undefined)?.trim();
  const signatureHeader = (request.headers["x-proof-signature"] as string | undefined)?.trim();
  if (!timestampHeader || !signatureHeader) {
    recordProofHeaderReject("missing_hmac");
    return false;
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    recordProofHeaderReject("hmac_bad_timestamp");
    return false;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const skew = Math.abs(nowSeconds - timestamp);
  if (skew > env.AUTH_PROOF_HMAC_MAX_SKEW_SECONDS) {
    recordProofHeaderReject("hmac_timestamp_skew");
    return false;
  }

  const method = request.method.toUpperCase();
  const path = request.url.split("?")[0] || "/";
  const bodyHash = createHmac("sha256", hmacSecret)
    .update(readRawBody(request))
    .digest("hex");
  const canonical = [method, path, timestamp, bodyHash].join("\n");
  const expected = createHmac("sha256", hmacSecret).update(canonical).digest("hex");
  if (!timingSafeEqualString(expected, signatureHeader)) {
    recordProofHeaderReject("hmac_mismatch");
    return false;
  }

  return true;
}

export function verifyProofHeaderRequest(request: FastifyRequest):
  | { ok: true }
  | { ok: false; reason: "rate_limited" | "hmac_invalid" } {
  if (!enforceProofRateLimit(request)) {
    return { ok: false, reason: "rate_limited" };
  }
  if (!verifyProofHmac(request)) {
    return { ok: false, reason: "hmac_invalid" };
  }
  return { ok: true };
}

export function resetProofHeaderRateLimiterForTest(): void {
  buckets.clear();
}
