import fs from "node:fs/promises";
import path from "node:path";
import { buildSignedProofHeaders } from "./proof-header-signing.js";

type TimedResult = {
  name: string;
  method: string;
  path: string;
  status: number | null;
  ok: boolean;
  durationMs: number;
  note?: string;
};

function baseUrl() {
  return (process.env.FLOW_PERF_API_BASE_URL || process.env.STAGING_FRONTEND_API_BASE_URL || process.env.PILOT_API_BASE_URL || "http://localhost:4000").replace(/\/$/, "");
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function requestTimeoutMs() {
  const parsed = Number(process.env.FLOW_PERF_REQUEST_TIMEOUT_MS || "45000");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 45_000;
}

async function authHeaders(method: string, requestPath: string, body?: unknown) {
  const bearer = (process.env.STAGING_FRONTEND_BEARER_TOKEN || process.env.FRONTEND_BEARER_TOKEN || "").trim();
  if (bearer) return { Authorization: `Bearer ${bearer}` };

  const devUserId = (process.env.STAGING_VITE_DEV_USER_ID || process.env.FRONTEND_DEV_USER_ID || "").trim();
  if (devUserId) {
    return {
      "x-dev-user-id": devUserId,
      "x-dev-role": (process.env.STAGING_VITE_DEV_ROLE || process.env.FRONTEND_DEV_ROLE || "Admin").trim() || "Admin",
    };
  }

  const proofUserId = (process.env.STAGING_PROOF_USER_ID || process.env.STAGING_FRONTEND_PROOF_USER_ID || "").trim();
  const proofSecret = (process.env.STAGING_PROOF_SECRET || process.env.STAGING_FRONTEND_PROOF_SECRET || "").trim();
  if (proofUserId && proofSecret) {
    return buildSignedProofHeaders({
      userId: proofUserId,
      role: (process.env.STAGING_PROOF_ROLE || process.env.STAGING_FRONTEND_PROOF_ROLE || "Admin").trim() || "Admin",
      proofSecret,
      proofHmacSecret: (process.env.STAGING_PROOF_HMAC_SECRET || process.env.STAGING_FRONTEND_PROOF_HMAC_SECRET || "").trim(),
      method,
      path: requestPath,
      body,
      facilityId: (process.env.STAGING_FACILITY_ID || process.env.FLOW_PERF_FACILITY_ID || "").trim() || undefined,
    });
  }

  return {};
}

async function timedFetch(name: string, method: string, requestPath: string, body?: unknown): Promise<{ result: TimedResult; json: unknown }> {
  const startedAt = Date.now();
  const headers = await authHeaders(method, requestPath, body);
  try {
    const response = await fetch(`${baseUrl()}${requestPath}`, {
      method,
      headers: {
        ...headers,
        ...(body ? { "Content-Type": "application/json" } : {}),
        "x-correlation-id": `perf-${nowStamp()}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        ...(method !== "GET" ? { "Idempotency-Key": `perf-${nowStamp()}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(requestTimeoutMs()),
    });
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    const result = {
      name,
      method,
      path: requestPath,
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - startedAt,
    };
    console.info(`${name}: ${result.status} in ${result.durationMs}ms`);
    return { result, json };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const result = {
      name,
      method,
      path: requestPath,
      status: null,
      ok: false,
      durationMs,
      note: message,
    };
    console.info(`${name}: failed in ${durationMs}ms (${message})`);
    return { result, json: null };
  }
}

async function main() {
  const results: TimedResult[] = [];
  const health = await timedFetch("Health", "GET", "/health");
  results.push(health.result);
  const ready = await timedFetch("Readiness", "GET", "/ready");
  results.push(ready.result);

  const encounters = await timedFetch("Encounter Board Page", "GET", "/encounters?pageSize=25");
  results.push(encounters.result);
  const lobbyEncounters = await timedFetch("Lobby Encounter Probe", "GET", "/encounters?status=Lobby&pageSize=1");
  results.push(lobbyEncounters.result);
  const encounterItems = Array.isArray((lobbyEncounters.json as { items?: unknown[] })?.items)
    ? ((lobbyEncounters.json as { items?: unknown[] }).items || [])
    : [];
  const lobbyEncounter = encounterItems.find((row) => (row as { currentStatus?: string; status?: string }).currentStatus === "Lobby" || (row as { status?: string }).status === "Lobby") as { id?: string } | undefined;

  results.push((await timedFetch("Analytics", "GET", "/dashboard/owner-analytics")).result);
  results.push((await timedFetch("Revenue Dashboard", "GET", "/dashboard/revenue-cycle")).result);
  results.push((await timedFetch("Revenue Queue Page", "GET", "/revenue-cases?pageSize=25")).result);
  results.push((await timedFetch("Admin Facilities", "GET", "/admin/facilities")).result);
  results.push((await timedFetch("Admin Clinics", "GET", "/admin/clinics")).result);
  results.push((await timedFetch("Office Manager Summary", "GET", "/dashboard/office-manager")).result);
  results.push((await timedFetch("Incoming Page", "GET", "/incoming?pageSize=25")).result);

  if (lobbyEncounter?.id) {
    results.push((await timedFetch("Pre-rooming Check", "POST", "/rooms/pre-rooming-check", { encounterId: lobbyEncounter.id })).result);
  } else {
    results.push({
      name: "Pre-rooming Check",
      method: "POST",
      path: "/rooms/pre-rooming-check",
      status: null,
      ok: true,
      durationMs: 0,
      note: "Skipped because no Lobby encounter was present in the first encounter page.",
    });
  }

  if (process.env.FLOW_PERF_VERIFY_MUTATIONS === "1") {
    results.push({
      name: "Check-in Create",
      method: "POST",
      path: "/encounters",
      status: null,
      ok: true,
      durationMs: 0,
      note: "Mutation timing is intentionally left to role-proof/UAT scripts because it requires facility-specific clinic/reason IDs.",
    });
  }

  const reportPath = path.join(process.cwd(), "docs", "verification", `PERFORMANCE_VERIFY_${nowStamp()}.md`);
  const lines = [
    "# Flow Performance Verification",
    "",
    `- API Base URL: ${baseUrl()}`,
    `- Captured At: ${new Date().toISOString()}`,
    "",
    "| Surface | Method | Path | Status | Duration | Result | Note |",
    "|---|---:|---|---:|---:|---|---|",
    ...results.map((result) =>
      `| ${result.name} | ${result.method} | \`${result.path}\` | ${result.status ?? "skipped"} | ${result.durationMs}ms | ${result.ok ? "PASS" : "FAIL"} | ${result.note || ""} |`
    ),
    "",
  ];
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, lines.join("\n"), "utf8");
  console.info(`Performance verification written to ${reportPath}`);

  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    throw new Error(`${failures.length} performance verification request(s) failed.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
