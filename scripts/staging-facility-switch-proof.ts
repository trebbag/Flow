import fs from "node:fs/promises";
import path from "node:path";

type RoleName = "Admin" | "FrontDeskCheckIn" | "MA" | "Clinician" | "FrontDeskCheckOut" | "RevenueCycle";

type AuthActor =
  | {
      kind: "bearer";
      role: RoleName;
      token: string;
    }
  | {
      kind: "dev";
      role: RoleName;
      userId: string;
    };

type ProbeResult = {
  role: RoleName;
  userId: string;
  ok: boolean;
  skipped: boolean;
  detail: string;
  availableFacilities: string[];
  switchedTo?: string;
  switchedBackTo?: string;
};

function nowStamp() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function roleTokenEnvKey(role: RoleName) {
  return `STAGING_ROLE_TOKEN_${role.toUpperCase()}`;
}

function headersFor(actor: AuthActor, facilityId?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json"
  };
  if (actor.kind === "bearer") {
    headers.authorization = `Bearer ${actor.token}`;
  } else {
    headers["x-dev-user-id"] = actor.userId;
    headers["x-dev-role"] = actor.role;
  }
  if (facilityId) {
    headers["x-facility-id"] = facilityId;
  }
  return headers;
}

async function requestJson<T>(
  apiBaseUrl: string,
  pathname: string,
  actor: AuthActor,
  options: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    facilityId?: string;
    body?: unknown;
  } = {}
): Promise<T> {
  const url = `${apiBaseUrl.replace(/\/$/, "")}${pathname}`;
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: headersFor(actor, options.facilityId),
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const raw = await response.text();
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = raw;
  }

  if (!response.ok) {
    const message =
      typeof parsed === "object" && parsed && "message" in (parsed as Record<string, unknown>)
        ? String((parsed as Record<string, unknown>).message)
        : raw || response.statusText;
    throw new Error(`${response.status} ${response.statusText} ${pathname}: ${message}`);
  }

  return parsed as T;
}

function parseAvailableFacilityIds(context: any) {
  if (!Array.isArray(context?.availableFacilities)) return [];
  return context.availableFacilities
    .map((row: any) => String(row?.id || "").trim())
    .filter(Boolean);
}

async function ensureTwoFacilities(apiBaseUrl: string, adminActor: AuthActor) {
  const context = await requestJson<any>(apiBaseUrl, "/auth/context", adminActor);
  const available = parseAvailableFacilityIds(context);
  if (available.length >= 2) {
    return {
      facilityIds: [available[0]!, available[1]!],
      createdFacilityId: ""
    };
  }

  const created = await requestJson<any>(apiBaseUrl, "/admin/facilities", adminActor, {
    method: "POST",
    body: {
      name: `Switch Probe Facility ${Date.now()}`,
      shortCode: `SP${String(Date.now()).slice(-4)}`,
      timezone: "America/New_York"
    }
  });

  const refreshed = await requestJson<any>(apiBaseUrl, "/auth/context", adminActor);
  const refreshedIds = parseAvailableFacilityIds(refreshed);
  if (refreshedIds.length < 2) {
    throw new Error("Unable to provision two facilities for switch proof");
  }

  return {
    facilityIds: [refreshedIds[0]!, refreshedIds[1]!],
    createdFacilityId: String(created?.id || "")
  };
}

async function createRoleProbeUser(params: {
  apiBaseUrl: string;
  adminActor: AuthActor;
  role: RoleName;
  facilityIds: string[];
}) {
  const timestamp = Date.now();
  const created = await requestJson<any>(params.apiBaseUrl, "/admin/users", params.adminActor, {
    method: "POST",
    body: {
      firstName: "Switch",
      lastName: `Probe-${params.role}`,
      email: `switch-probe-${params.role.toLowerCase()}-${timestamp}@flow.local`,
      role: params.role,
      facilityIds: params.facilityIds,
      status: "active"
    }
  });

  return String(created?.id || "");
}

async function cleanupRoleProbeUsers(params: {
  apiBaseUrl: string;
  adminActor: AuthActor;
  userIds: string[];
}) {
  for (const userId of params.userIds) {
    try {
      await requestJson(params.apiBaseUrl, `/admin/users/${userId}`, params.adminActor, {
        method: "POST",
        body: { status: "suspended" }
      });
      await requestJson(params.apiBaseUrl, `/admin/users/${userId}`, params.adminActor, {
        method: "DELETE"
      });
    } catch {
      // best effort cleanup only
    }
  }
}

async function probeRoleFacilitySwitch(params: {
  apiBaseUrl: string;
  actor: AuthActor;
}): Promise<ProbeResult> {
  const context = await requestJson<any>(params.apiBaseUrl, "/auth/context", params.actor);
  const availableFacilities = parseAvailableFacilityIds(context);
  const current = String(context?.activeFacilityId || context?.facilityId || "").trim();

  if (availableFacilities.length < 2) {
    return {
      role: params.actor.role,
      userId: params.actor.kind === "dev" ? params.actor.userId : "token",
      ok: false,
      skipped: true,
      detail: "User has fewer than two facilities in scope",
      availableFacilities
    };
  }

  const originalFacilityId = current || availableFacilities[0]!;
  const targetFacilityId = availableFacilities.find((id) => id !== originalFacilityId) || availableFacilities[1]!;

  const switched = await requestJson<any>(params.apiBaseUrl, "/auth/context/facility", params.actor, {
    method: "POST",
    body: { facilityId: targetFacilityId }
  });
  const switchedActive = String(switched?.activeFacilityId || switched?.facilityId || "").trim();
  if (switchedActive !== targetFacilityId) {
    throw new Error(`Switch did not persist for ${params.actor.role}; expected ${targetFacilityId}, got ${switchedActive || "(empty)"}`);
  }

  const restored = await requestJson<any>(params.apiBaseUrl, "/auth/context/facility", params.actor, {
    method: "POST",
    body: { facilityId: originalFacilityId }
  });
  const restoredActive = String(restored?.activeFacilityId || restored?.facilityId || "").trim();
  if (restoredActive !== originalFacilityId) {
    throw new Error(`Restore did not persist for ${params.actor.role}; expected ${originalFacilityId}, got ${restoredActive || "(empty)"}`);
  }

  return {
    role: params.actor.role,
    userId: params.actor.kind === "dev" ? params.actor.userId : "token",
    ok: true,
    skipped: false,
    detail: "Switch and restore persisted",
    availableFacilities,
    switchedTo: targetFacilityId,
    switchedBackTo: originalFacilityId
  };
}

async function writeReport(params: {
  reportPath: string;
  startedAt: Date;
  finishedAt: Date;
  apiBaseUrl: string;
  authMode: string;
  missing: string[];
  results: ProbeResult[];
}) {
  const lines: string[] = [];
  lines.push("# Staging Facility Switch Proof (Role-by-Role)");
  lines.push("");
  lines.push(`- Started: ${params.startedAt.toISOString()}`);
  lines.push(`- Finished: ${params.finishedAt.toISOString()}`);
  lines.push(`- API Base URL: ${params.apiBaseUrl || "(missing)"}`);
  lines.push(`- Auth Mode: ${params.authMode}`);
  lines.push("");

  if (params.missing.length > 0) {
    lines.push("## Missing Inputs");
    lines.push("");
    params.missing.forEach((entry) => lines.push(`- ${entry}`));
    lines.push("");
  }

  lines.push("## Role Results");
  lines.push("");
  lines.push("| Role | Result | Detail | Facilities In Scope |");
  lines.push("|---|---|---|---|");
  if (params.results.length === 0) {
    lines.push("| (none) | FAIL | No role probes executed | - |");
  } else {
    params.results.forEach((row) => {
      const result = row.ok ? "PASS" : row.skipped ? "SKIP" : "FAIL";
      lines.push(
        `| ${row.role} | ${result} | ${row.detail.replace(/\|/g, "\\|")} | ${row.availableFacilities.join(", ") || "-"} |`
      );
    });
  }

  lines.push("");
  lines.push("## Evidence Notes");
  lines.push("");
  params.results.forEach((row) => {
    if (!row.ok) return;
    lines.push(`- ${row.role}: switched to \`${row.switchedTo}\` then restored to \`${row.switchedBackTo}\`.`);
  });

  await fs.mkdir(path.dirname(params.reportPath), { recursive: true });
  await fs.writeFile(params.reportPath, `${lines.join("\n")}\n`, "utf8");
}

async function main() {
  const startedAt = new Date();
  const repoRoot = process.cwd();

  const apiBaseUrl = (process.env.STAGING_FRONTEND_API_BASE_URL || process.env.PILOT_API_BASE_URL || "").trim();
  const adminBearer = (process.env.STAGING_FRONTEND_BEARER_TOKEN || "").trim();
  const devUserId = (process.env.STAGING_VITE_DEV_USER_ID || "").trim();
  const devRole = ((process.env.STAGING_VITE_DEV_ROLE || "Admin").trim() || "Admin") as RoleName;

  const missing: string[] = [];
  if (!apiBaseUrl) {
    missing.push("Set STAGING_FRONTEND_API_BASE_URL (or PILOT_API_BASE_URL)");
  }
  if (!adminBearer && !devUserId) {
    missing.push("Provide STAGING_FRONTEND_BEARER_TOKEN or STAGING_VITE_DEV_USER_ID");
  }

  const authMode = adminBearer ? "bearer" : devUserId ? "dev-header" : "none";
  const results: ProbeResult[] = [];

  let createdFacilityId = "";
  const createdProbeUserIds: string[] = [];

  if (missing.length === 0) {
    const adminActor: AuthActor = adminBearer
      ? { kind: "bearer", role: "Admin", token: adminBearer }
      : { kind: "dev", role: devRole, userId: devUserId };

    const { facilityIds, createdFacilityId: facilityId } = await ensureTwoFacilities(apiBaseUrl, adminActor);
    createdFacilityId = facilityId;

    try {
      // Always verify admin role explicitly.
      results.push(await probeRoleFacilitySwitch({ apiBaseUrl, actor: adminActor }));

      const roleProbeTargets: RoleName[] = [
        "FrontDeskCheckIn",
        "MA",
        "Clinician",
        "FrontDeskCheckOut",
        "RevenueCycle"
      ];

      if (devUserId) {
        for (const role of roleProbeTargets) {
          const userId = await createRoleProbeUser({
            apiBaseUrl,
            adminActor,
            role,
            facilityIds
          });
          if (!userId) {
            results.push({
              role,
              userId: "",
              ok: false,
              skipped: false,
              detail: "Failed to create probe user",
              availableFacilities: []
            });
            continue;
          }
          createdProbeUserIds.push(userId);
          results.push(
            await probeRoleFacilitySwitch({
              apiBaseUrl,
              actor: { kind: "dev", role, userId }
            })
          );
        }
      } else {
        for (const role of roleProbeTargets) {
          const token = (process.env[roleTokenEnvKey(role)] || "").trim();
          if (!token) {
            results.push({
              role,
              userId: "",
              ok: false,
              skipped: true,
              detail: `Missing ${roleTokenEnvKey(role)} for bearer role proof`,
              availableFacilities: []
            });
            continue;
          }

          try {
            results.push(
              await probeRoleFacilitySwitch({
                apiBaseUrl,
                actor: { kind: "bearer", role, token }
              })
            );
          } catch (error) {
            results.push({
              role,
              userId: "token",
              ok: false,
              skipped: false,
              detail: (error as Error).message,
              availableFacilities: []
            });
          }
        }
      }
    } finally {
      if (createdProbeUserIds.length > 0) {
        await cleanupRoleProbeUsers({ apiBaseUrl, adminActor, userIds: createdProbeUserIds });
      }
      if (createdFacilityId) {
        try {
          await requestJson(apiBaseUrl, `/admin/facilities/${createdFacilityId}`, adminActor, {
            method: "POST",
            body: { status: "inactive" }
          });
        } catch {
          // best effort
        }
      }
    }
  }

  const finishedAt = new Date();
  const reportPath = path.resolve(
    repoRoot,
    "docs",
    "verification",
    `staging-facility-switch-roles-${nowStamp()}.md`
  );

  await writeReport({
    reportPath,
    startedAt,
    finishedAt,
    apiBaseUrl,
    authMode,
    missing,
    results
  });

  console.info(`Facility switch proof written: ${reportPath}`);

  const failed = results.filter((row) => !row.ok);
  if (missing.length > 0 || failed.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
