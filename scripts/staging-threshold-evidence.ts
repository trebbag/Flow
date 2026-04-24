import fs from "node:fs/promises";
import path from "node:path";
import { buildSignedProofHeaders } from "./proof-header-signing.js";
import {
  archiveStagingProofUsers,
  createStagingProofRoleUser,
  findStagingProofFixtureRoleUserIds,
  hasStagingProofDatabaseAccess
} from "./staging-proof-db.js";

type RoleName = "Admin" | "FrontDeskCheckIn" | "MA" | "Clinician" | "FrontDeskCheckOut" | "OfficeManager" | "RevenueCycle";

type AuthActor =
  | {
      kind: "bearer";
      role: RoleName;
      token: string;
    }
  | {
      kind: "proof";
      role: RoleName;
      userId: string;
      proofSecret: string;
      proofHmacSecret?: string;
    }
  | {
      kind: "dev";
      role: RoleName;
      userId: string;
    };

type AlertProofRow = {
  role: RoleName;
  ok: boolean;
  detail: string;
  alertId?: string;
};

type ThresholdSnapshot = {
  id: string;
  clinicId: string | null;
  metric: "stage" | "overall_visit";
  status: string | null;
  yellowAtMin: number;
  redAtMin: number;
  escalation2Min?: number | null;
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

async function headersFor(
  actor: AuthActor,
  options: {
    facilityId?: string;
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    path?: string;
    body?: unknown;
  } = {}
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json"
  };
  if (actor.kind === "bearer") {
    headers.authorization = `Bearer ${actor.token}`;
  } else if (actor.kind === "proof") {
    Object.assign(
      headers,
      await buildSignedProofHeaders({
        userId: actor.userId,
        role: actor.role,
        proofSecret: actor.proofSecret,
        proofHmacSecret: actor.proofHmacSecret,
        method: options.method,
        path: options.path || "/",
        body: options.body,
        facilityId: options.facilityId
      })
    );
  } else {
    headers["x-dev-user-id"] = actor.userId;
    headers["x-dev-role"] = actor.role;
  }
  if (options.facilityId) {
    headers["x-facility-id"] = options.facilityId;
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
    headers: await headersFor(actor, {
      facilityId: options.facilityId,
      method: options.method,
      path: pathname,
      body: options.body
    }),
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

async function ensureRoleProbeUser(params: {
  apiBaseUrl: string;
  adminActor: AuthActor;
  role: RoleName;
  facilityId: string;
}) {
  const timestamp = Date.now();
  try {
    const created = await requestJson<any>(params.apiBaseUrl, "/admin/users", params.adminActor, {
      method: "POST",
      body: {
        firstName: "Threshold",
        lastName: `Probe-${params.role}`,
        email: `threshold-probe-${params.role.toLowerCase()}-${timestamp}@flow.local`,
        role: params.role,
        facilityId: params.facilityId,
        status: "active"
      }
    });

    return String(created?.id || "");
  } catch (error) {
    const message = (error as Error).message || "";
    const canSeedViaDb =
      hasStagingProofDatabaseAccess() &&
      (message.includes("Local user creation is disabled") || message.includes("405 Method Not Allowed"));
    if (!canSeedViaDb) throw error;

    return createStagingProofRoleUser({
      role: params.role,
      facilityIds: [params.facilityId],
      namePrefix: "Threshold Probe",
    });
  }
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForThresholdLevel(params: {
  apiBaseUrl: string;
  adminActor: AuthActor;
  encounterId: string;
  facilityId: string;
  timeoutMs: number;
}) {
  const started = Date.now();
  let attempts = 0;
  while (Date.now() - started < params.timeoutMs) {
    attempts += 1;
    const encounter = await requestJson<any>(
      params.apiBaseUrl,
      `/encounters/${params.encounterId}`,
      params.adminActor,
      { facilityId: params.facilityId }
    );
    const level = String(encounter?.alertLevel || encounter?.alertState?.currentAlertLevel || "Green");
    if (level === "Yellow" || level === "Red") {
      return { ok: true, level, attempts, elapsedMs: Date.now() - started };
    }
    await sleep(5_000);
  }

  return {
    ok: false,
    level: "Green",
    attempts,
    elapsedMs: Date.now() - started
  };
}

function parseEncounterAlertLevel(encounter: any) {
  return String(encounter?.alertLevel || encounter?.alertState?.currentAlertLevel || "Green");
}

async function verifyThresholdVisibleForRole(params: {
  apiBaseUrl: string;
  actor: AuthActor;
  facilityId: string;
  encounterId: string;
}): Promise<AlertProofRow> {
  const role = params.actor.role;
  const alertRows = await requestJson<{ items: Array<any> }>(
    params.apiBaseUrl,
    "/alerts?tab=active&limit=200",
    params.actor,
    { facilityId: params.facilityId }
  );

  const hit = (alertRows.items || []).find((item) => {
    const payloadEncounterId = String(item?.payload?.encounterId || "").trim();
    const sourceId = String(item?.sourceId || "").trim();
    const kind = String(item?.kind || "").trim();
    return kind === "threshold" && (payloadEncounterId === params.encounterId || sourceId === params.encounterId);
  });

  if (hit) {
    return {
      role,
      ok: true,
      detail: "Threshold alert present in active inbox",
      alertId: String(hit.id || "")
    };
  }

  const encounter = await requestJson<any>(
    params.apiBaseUrl,
    `/encounters/${params.encounterId}`,
    params.actor,
    { facilityId: params.facilityId }
  );
  const level = parseEncounterAlertLevel(encounter);
  if (level === "Yellow" || level === "Red") {
    return {
      role,
      ok: true,
      detail: `Encounter alert state ${level} visible; active inbox row was not returned for this role`
    };
  }

  return {
    role,
    ok: false,
    detail: `No active threshold inbox row and encounter alert state is ${level}`
  };
}

async function writeReport(params: {
  reportPath: string;
  startedAt: Date;
  finishedAt: Date;
  apiBaseUrl: string;
  authMode: string;
  missing: string[];
  encounterId: string;
  clinicId: string;
  thresholdRowId: string;
  thresholdWait: { ok: boolean; level: string; attempts: number; elapsedMs: number };
  roleResults: AlertProofRow[];
}) {
  const lines: string[] = [];
  lines.push("# Staging Threshold Trigger Evidence (All Roles)");
  lines.push("");
  lines.push(`- Started: ${params.startedAt.toISOString()}`);
  lines.push(`- Finished: ${params.finishedAt.toISOString()}`);
  lines.push(`- API Base URL: ${params.apiBaseUrl || "(missing)"}`);
  lines.push(`- Auth Mode: ${params.authMode}`);
  lines.push(`- Encounter ID: ${params.encounterId || "(none)"}`);
  lines.push(`- Clinic ID: ${params.clinicId || "(none)"}`);
  lines.push(`- Threshold Row ID: ${params.thresholdRowId || "(none)"}`);
  lines.push("");

  if (params.missing.length > 0) {
    lines.push("## Missing Inputs");
    lines.push("");
    params.missing.forEach((entry) => lines.push(`- ${entry}`));
    lines.push("");
  }

  lines.push("## Threshold Trigger");
  lines.push("");
  lines.push(`- Trigger reached: ${params.thresholdWait.ok ? "yes" : "no"}`);
  lines.push(`- Level reached: ${params.thresholdWait.level}`);
  lines.push(`- Poll attempts: ${params.thresholdWait.attempts}`);
  lines.push(`- Elapsed ms: ${params.thresholdWait.elapsedMs}`);
  lines.push("");

  lines.push("## Role Alert Evidence");
  lines.push("");
  lines.push("| Role | Result | Detail | Alert ID |");
  lines.push("|---|---|---|---|");
  if (params.roleResults.length === 0) {
    lines.push("| (none) | FAIL | No role alert checks executed | - |");
  } else {
    params.roleResults.forEach((row) => {
      const result = row.ok ? "PASS" : "FAIL";
      lines.push(`| ${row.role} | ${result} | ${row.detail.replace(/\|/g, "\\|")} | ${row.alertId || "-"} |`);
    });
  }

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
  const proofUserId =
    (process.env.STAGING_PROOF_USER_ID || process.env.STAGING_FRONTEND_PROOF_USER_ID || "").trim();
  const proofRole =
    ((process.env.STAGING_PROOF_ROLE || process.env.STAGING_FRONTEND_PROOF_ROLE || "Admin").trim() || "Admin") as RoleName;
  const proofSecret =
    (process.env.STAGING_PROOF_SECRET || process.env.STAGING_FRONTEND_PROOF_SECRET || "").trim();
  const proofHmacSecret =
    (process.env.STAGING_PROOF_HMAC_SECRET || process.env.STAGING_FRONTEND_PROOF_HMAC_SECRET || "").trim();

  const missing: string[] = [];
  if (!apiBaseUrl) {
    missing.push("Set STAGING_FRONTEND_API_BASE_URL (or PILOT_API_BASE_URL)");
  }
  if (!adminBearer && !devUserId && !(proofUserId && proofSecret)) {
    missing.push("Provide STAGING_PROOF_USER_ID + STAGING_PROOF_SECRET, STAGING_FRONTEND_BEARER_TOKEN, or STAGING_VITE_DEV_USER_ID");
  }
  if (proofUserId && proofSecret && !proofHmacSecret) {
    missing.push("Provide STAGING_PROOF_HMAC_SECRET (or STAGING_FRONTEND_PROOF_HMAC_SECRET) for signed proof-header requests");
  }

  const authMode = proofUserId && proofSecret
    ? "proof-header"
    : adminBearer
      ? "bearer"
      : devUserId
        ? "dev-header"
        : "none";

  let encounterId = "";
  let clinicId = "";
  let thresholdRowId = "";
  let thresholdWait = { ok: false, level: "Green", attempts: 0, elapsedMs: 0 };
  const roleResults: AlertProofRow[] = [];

  const createdProbeUserIds: string[] = [];
  let thresholdBackup: ThresholdSnapshot | null = null;
  let activeFacilityId = "";

  if (missing.length === 0) {
    const adminActor: AuthActor = proofUserId && proofSecret
      ? { kind: "proof", role: proofRole, userId: proofUserId, proofSecret, proofHmacSecret }
      : adminBearer
        ? { kind: "bearer", role: "Admin", token: adminBearer }
        : { kind: "dev", role: devRole, userId: devUserId };

    try {
      const context = await requestJson<any>(apiBaseUrl, "/auth/context", adminActor);
      const facilityIds = parseAvailableFacilityIds(context);
      const facilityId = String(context?.activeFacilityId || context?.facilityId || facilityIds[0] || "").trim();
      if (!facilityId) {
        throw new Error("No active facility available for threshold evidence run");
      }
      activeFacilityId = facilityId;

      const clinics = await requestJson<any[]>(
        apiBaseUrl,
        `/admin/clinics?facilityId=${encodeURIComponent(facilityId)}&includeInactive=true`,
        adminActor,
        { facilityId }
      );
      const assignments = await requestJson<any[]>(
        apiBaseUrl,
        `/admin/assignments?facilityId=${encodeURIComponent(facilityId)}`,
        adminActor,
        { facilityId }
      );

      const targetAssignment =
        assignments.find((row) => row.clinicStatus === "active" && row.isOperational) || assignments[0];
      if (!targetAssignment?.clinicId) {
        throw new Error("No clinic assignment available for threshold evidence run");
      }
      clinicId = String(targetAssignment.clinicId);

      const clinicRow = clinics.find((row) => String(row.id) === clinicId);
      if (!clinicRow || String(clinicRow.status || "") !== "active") {
        throw new Error("Selected clinic is not active");
      }

      const reasons = await requestJson<any[]>(
        apiBaseUrl,
        `/admin/reasons?facilityId=${encodeURIComponent(facilityId)}&clinicId=${encodeURIComponent(clinicId)}&includeInactive=true`,
        adminActor,
        { facilityId }
      );
      const reason = reasons.find((row) => String(row.status || "active") === "active");
      if (!reason?.id) {
        throw new Error("No active visit reason found for selected clinic");
      }

      const thresholdRows = await requestJson<any[]>(
        apiBaseUrl,
        `/admin/thresholds?facilityId=${encodeURIComponent(facilityId)}`,
        adminActor,
        { facilityId }
      );
      const lobbyThreshold =
        thresholdRows.find(
          (row) =>
            String(row.metric || "stage") === "stage" &&
            String(row.status || "") === "Lobby" &&
            (row.clinicId === null || row.clinicId === undefined)
        ) || null;
      if (!lobbyThreshold?.id) {
        throw new Error("No facility-default Lobby threshold row found");
      }

      thresholdBackup = {
        id: String(lobbyThreshold.id),
        clinicId: lobbyThreshold.clinicId || null,
        metric: String(lobbyThreshold.metric || "stage") as "stage" | "overall_visit",
        status: lobbyThreshold.status || null,
        yellowAtMin: Number(lobbyThreshold.yellowAtMin),
        redAtMin: Number(lobbyThreshold.redAtMin),
        escalation2Min:
          lobbyThreshold.escalation2Min === null || lobbyThreshold.escalation2Min === undefined
            ? null
            : Number(lobbyThreshold.escalation2Min)
      };
      thresholdRowId = thresholdBackup.id;

      const loweredThreshold = {
        facilityId,
        clinicId: null,
        metric: "stage",
        status: "Lobby",
        yellowAtMin: 1,
        redAtMin: Math.max(2, Number(thresholdBackup.redAtMin) || 2),
        escalation2Min:
          thresholdBackup.escalation2Min === null || thresholdBackup.escalation2Min === undefined
            ? undefined
            : Math.max(3, Number(thresholdBackup.escalation2Min))
      };
      await requestJson(apiBaseUrl, "/admin/thresholds", adminActor, {
        method: "POST",
        facilityId,
        body: loweredThreshold
      });

      const roleActors = new Map<RoleName, AuthActor>();
      roleActors.set("Admin", adminActor);

      const roleTargets: RoleName[] = ["FrontDeskCheckIn", "MA", "Clinician", "FrontDeskCheckOut", "OfficeManager", "RevenueCycle"];
      const fixtureRoleUserIds =
        proofUserId && proofSecret && hasStagingProofDatabaseAccess()
          ? await findStagingProofFixtureRoleUserIds({ facilityId })
          : new Map<RoleName, string>();

      if (proofUserId && proofSecret) {
        for (const role of roleTargets) {
          const fixtureUserId = fixtureRoleUserIds.get(role);
          const userId = fixtureUserId || await ensureRoleProbeUser({ apiBaseUrl, adminActor, role, facilityId });
          if (!userId) {
            throw new Error(`Failed to create threshold probe user for ${role}`);
          }
          if (!fixtureUserId) {
            createdProbeUserIds.push(userId);
          }
          roleActors.set(role, { kind: "proof", role, userId, proofSecret, proofHmacSecret });
        }
      } else if (devUserId) {
        for (const role of roleTargets) {
          const userId = await ensureRoleProbeUser({ apiBaseUrl, adminActor, role, facilityId });
          if (!userId) {
            throw new Error(`Failed to create threshold probe user for ${role}`);
          }
          createdProbeUserIds.push(userId);
          roleActors.set(role, { kind: "dev", role, userId });
        }
      } else {
        for (const role of roleTargets) {
          const token = (process.env[roleTokenEnvKey(role)] || "").trim();
          if (!token) {
            roleResults.push({
              role,
              ok: false,
              detail: `Missing ${roleTokenEnvKey(role)} for role proof`
            });
            continue;
          }
          roleActors.set(role, { kind: "bearer", role, token });
        }
      }

      const checkInActor = roleActors.get("FrontDeskCheckIn") || adminActor;
      const createdEncounter = await requestJson<any>(apiBaseUrl, "/encounters", checkInActor, {
        method: "POST",
        facilityId,
        body: {
          patientId: `PT-STAGING-THR-${Date.now()}`,
          clinicId,
          reasonForVisitId: String(reason.id),
          walkIn: true,
          insuranceVerified: true,
          intakeData: {
            source: "staging-threshold-proof"
          }
        }
      });
      encounterId = String(createdEncounter?.id || "");
      if (!encounterId) {
        throw new Error("Encounter creation did not return an id");
      }

      thresholdWait = await waitForThresholdLevel({
        apiBaseUrl,
        adminActor,
        encounterId,
        facilityId,
        timeoutMs: 90_000
      });
      if (!thresholdWait.ok) {
        throw new Error("Threshold level did not reach Yellow/Red within timeout window");
      }

      const rolesToVerify: RoleName[] = ["Admin", "FrontDeskCheckIn", "MA", "Clinician", "FrontDeskCheckOut", "OfficeManager", "RevenueCycle"];
      for (const role of rolesToVerify) {
        const actor = roleActors.get(role);
        if (!actor) {
          if (!roleResults.some((row) => row.role === role)) {
            roleResults.push({ role, ok: false, detail: "No actor configured for role" });
          }
          continue;
        }

        try {
          roleResults.push(
            await verifyThresholdVisibleForRole({
              apiBaseUrl,
              actor,
              facilityId,
              encounterId
            })
          );
        } catch (error) {
          roleResults.push({ role, ok: false, detail: (error as Error).message });
        }
      }
    } finally {
      if (thresholdBackup) {
        try {
          await requestJson(
            apiBaseUrl,
            "/admin/thresholds",
            proofUserId && proofSecret
              ? { kind: "proof", role: proofRole, userId: proofUserId, proofSecret, proofHmacSecret }
              : adminBearer
                ? { kind: "bearer", role: "Admin", token: adminBearer }
                : { kind: "dev", role: devRole, userId: devUserId },
            {
              method: "POST",
              facilityId: activeFacilityId,
              body: {
                facilityId: activeFacilityId,
                clinicId: thresholdBackup.clinicId,
                metric: thresholdBackup.metric,
                status: thresholdBackup.status,
                yellowAtMin: thresholdBackup.yellowAtMin,
                redAtMin: thresholdBackup.redAtMin,
                escalation2Min:
                  thresholdBackup.escalation2Min === null || thresholdBackup.escalation2Min === undefined
                    ? undefined
                    : thresholdBackup.escalation2Min
              }
            }
          );
        } catch {
          // best effort restore
        }
      }

      if (createdProbeUserIds.length > 0) {
        const adminActor: AuthActor = proofUserId && proofSecret
          ? { kind: "proof", role: proofRole, userId: proofUserId, proofSecret, proofHmacSecret }
          : adminBearer
            ? { kind: "bearer", role: "Admin", token: adminBearer }
            : { kind: "dev", role: devRole, userId: devUserId };
        await cleanupRoleProbeUsers({
          apiBaseUrl,
          adminActor,
          userIds: createdProbeUserIds
        });
        await archiveStagingProofUsers({
          userIds: createdProbeUserIds,
          facilityId: activeFacilityId,
        });
      }
    }
  }

  const finishedAt = new Date();
  const reportPath = path.resolve(
    repoRoot,
    "docs",
    "verification",
    `staging-threshold-evidence-${nowStamp()}.md`
  );

  await writeReport({
    reportPath,
    startedAt,
    finishedAt,
    apiBaseUrl,
    authMode,
    missing,
    encounterId,
    clinicId,
    thresholdRowId,
    thresholdWait,
    roleResults
  });

  console.info(`Threshold evidence report written: ${reportPath}`);

  const failedRoles = roleResults.filter((row) => !row.ok);
  if (missing.length > 0 || !thresholdWait.ok || failedRoles.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
