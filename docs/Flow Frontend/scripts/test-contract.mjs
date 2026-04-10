import assert from "node:assert/strict";

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
const bearerToken =
  process.env.VITE_BEARER_TOKEN ||
  process.env.FRONTEND_BEARER_TOKEN ||
  "";
const hasBearerToken = bearerToken.trim().length > 0;

function dateIso() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function request(path, { auth = false } = {}) {
  const headers = {};
  if (auth) {
    if (hasBearerToken) {
      headers.authorization = `Bearer ${bearerToken.trim()}`;
    } else if (devUserId) {
      headers["x-dev-user-id"] = devUserId;
      headers["x-dev-role"] = devRole;
    }
  }

  const response = await fetch(`${apiBaseUrl}${path}`, { headers });
  const raw = await response.text();
  let parsed = raw;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    // keep raw body
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${path}: ${raw}`);
  }
  return parsed;
}

async function main() {
  const health = await request("/health");
  assert.equal(health?.status, "ok", "/health should return status=ok");

  if (!devUserId && !hasBearerToken) {
    console.info(
      "Skipping authenticated contract checks because dev-user or bearer-token auth is not set.",
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

  const encounters = await request(`/encounters?date=${today}&facilityId=${facilityId}`, { auth: true });
  assert.ok(Array.isArray(encounters), "/encounters should return an array");

  const incoming = await request(`/incoming?date=${today}&facilityId=${facilityId}`, { auth: true });
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
