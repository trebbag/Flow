import assert from "node:assert/strict";
import { buildSignedProofHeaders } from "./proof-header-signing.mjs";

const apiBaseUrl =
  process.env.VITE_API_BASE_URL ||
  process.env.FRONTEND_API_BASE_URL ||
  "http://localhost:4000";

const devUserId =
  process.env.VITE_DEV_USER_ID ||
  process.env.FRONTEND_DEV_USER_ID ||
  "";
const devRole =
  process.env.VITE_DEV_ROLE ||
  process.env.FRONTEND_DEV_ROLE ||
  "Admin";
const proofUserId =
  process.env.VITE_PROOF_USER_ID ||
  process.env.FRONTEND_PROOF_USER_ID ||
  "";
const proofRole =
  process.env.VITE_PROOF_ROLE ||
  process.env.FRONTEND_PROOF_ROLE ||
  "Admin";
const proofSecret =
  process.env.VITE_PROOF_SECRET ||
  process.env.FRONTEND_PROOF_SECRET ||
  "";
const proofHmacSecret =
  process.env.VITE_PROOF_HMAC_SECRET ||
  process.env.FRONTEND_PROOF_HMAC_SECRET ||
  "";
const bearerToken =
  process.env.VITE_BEARER_TOKEN ||
  process.env.FRONTEND_BEARER_TOKEN ||
  "";
const hasProofAuth = proofUserId.trim().length > 0 && proofSecret.trim().length > 0;
const hasBearerToken = bearerToken.trim().length > 0;
const TRANSIENT_STATUS_CODES = new Set([502, 503, 504]);
const SAFE_RETRY_METHODS = new Set(["GET", "HEAD"]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dateIso() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function request(path, { auth = false, method = "GET" } = {}) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const maxAttempts = SAFE_RETRY_METHODS.has(normalizedMethod) ? 5 : 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const headers = {};
    if (auth) {
      if (hasProofAuth) {
        Object.assign(
          headers,
          await buildSignedProofHeaders({
            userId: proofUserId.trim(),
            role: proofRole,
            proofSecret: proofSecret.trim(),
            proofHmacSecret,
            method: normalizedMethod,
            path,
          }),
        );
      } else if (hasBearerToken) {
        headers.authorization = `Bearer ${bearerToken.trim()}`;
      } else if (devUserId) {
        headers["x-dev-user-id"] = devUserId;
        headers["x-dev-role"] = devRole;
      }
    }

    try {
      const response = await fetch(`${apiBaseUrl}${path}`, { method: normalizedMethod, headers });
      const raw = await response.text();
      let parsed = raw;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        // keep raw body
      }
      if (response.ok) {
        return parsed;
      }

      const error = new Error(`${response.status} ${response.statusText} for ${path}: ${raw}`);
      const canRetry = attempt < maxAttempts && TRANSIENT_STATUS_CODES.has(response.status);
      if (!canRetry) {
        throw error;
      }
      lastError = error;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isNetworkError =
        /fetch failed/i.test(message) ||
        /ECONNRESET/i.test(message) ||
        /ECONNREFUSED/i.test(message) ||
        /ETIMEDOUT/i.test(message) ||
        /socket hang up/i.test(message);
      const canRetry = attempt < maxAttempts && SAFE_RETRY_METHODS.has(normalizedMethod) && isNetworkError;
      if (!canRetry) {
        throw error;
      }
      lastError = error;
    }

    await delay(attempt * 1_500);
  }

  throw lastError;
}

async function main() {
  const health = await request("/health");
  assert.equal(health?.status, "ok", "/health should return status=ok");

  if (!devUserId && !hasBearerToken && !hasProofAuth) {
    console.info(
      "Skipping authenticated contract checks because proof, dev-user, or bearer auth is not set.",
    );
    return;
  }

  const today = dateIso();
  const context = await request("/auth/context", { auth: true });
  assert.ok(context?.userId, "/auth/context should include userId");
  assert.ok(context?.role, "/auth/context should include role");
  const facilityId =
    context?.activeFacilityId ||
    context?.facilityId ||
    (Array.isArray(context?.availableFacilities) && context.availableFacilities[0]?.id) ||
    "";
  assert.ok(facilityId, "/auth/context should include an active facility");

  const clinics = await request(`/admin/clinics?facilityId=${facilityId}&includeInactive=true`, { auth: true });
  assert.ok(Array.isArray(clinics), "/admin/clinics should return an array");

  const assignments = await request(`/admin/assignments?facilityId=${facilityId}`, { auth: true });
  assert.ok(Array.isArray(assignments), "/admin/assignments should return an array");

  const reasons = await request(`/admin/reasons?facilityId=${facilityId}&includeInactive=true`, { auth: true });
  assert.ok(Array.isArray(reasons), "/admin/reasons should return an array");

  const rooms = await request(`/admin/rooms?facilityId=${facilityId}&includeInactive=true`, { auth: true });
  assert.ok(Array.isArray(rooms), "/admin/rooms should return an array");

  const users = await request(`/admin/users?facilityId=${facilityId}`, { auth: true });
  assert.ok(Array.isArray(users), "/admin/users should return an array");

  const encounters = await request(`/encounters?legacyArray=1&date=${today}&facilityId=${facilityId}`, { auth: true });
  assert.ok(Array.isArray(encounters), "/encounters should return an array");

  const incoming = await request(`/incoming?legacyArray=1&date=${today}&facilityId=${facilityId}`, { auth: true });
  assert.ok(Array.isArray(incoming), "/incoming should return an array");

  const tasks = await request("/tasks", { auth: true });
  assert.ok(Array.isArray(tasks), "/tasks should return an array");

  const officeDashboard = await request(`/dashboard/office-manager?date=${today}&facilityId=${facilityId}`, { auth: true });
  assert.ok(typeof officeDashboard === "object" && officeDashboard !== null, "office-manager dashboard should return an object");

  const revenueDashboard = await request(`/dashboard/revenue-cycle?date=${today}&facilityId=${facilityId}`, { auth: true });
  assert.ok(typeof revenueDashboard === "object" && revenueDashboard !== null, "revenue-cycle dashboard should return an object");

  console.info("Contract checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
