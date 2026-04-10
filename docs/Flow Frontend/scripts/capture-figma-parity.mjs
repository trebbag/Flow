import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const apiBaseUrl =
  process.env.VITE_API_BASE_URL ||
  process.env.FRONTEND_API_BASE_URL ||
  "http://127.0.0.1:4000";

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

const previewPort = Number(process.env.FRONTEND_E2E_PORT || 4173);
const frontendBaseUrl = process.env.FRONTEND_BASE_URL || `http://localhost:${previewPort}`;

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

function authHeaders({ userId, role, facilityId } = {}) {
  const headers = {};
  if (hasBearerToken) {
    headers.authorization = `Bearer ${bearerToken.trim()}`;
    if (facilityId) headers["x-facility-id"] = facilityId;
    return headers;
  }
  const selectedUserId = userId || devUserId;
  const selectedRole = role || devRole;
  if (!selectedUserId) return headers;
  headers["x-dev-user-id"] = selectedUserId;
  headers["x-dev-role"] = selectedRole;
  if (facilityId) headers["x-facility-id"] = facilityId;
  return headers;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(pathname, { method = "GET", body, auth = null } = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const headers = auth ? authHeaders(auth === true ? undefined : auth) : {};
    if (body) headers["content-type"] = "application/json";
    const response = await fetch(`${apiBaseUrl}${pathname}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const raw = await response.text();
    let parsed = raw;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      // ignore
    }
    if (response.ok) {
      return parsed;
    }
    const retryMatch = raw.match(/retry in\s+(\d+)\s+seconds/i);
    const shouldRetry = response.status === 429 || /rate limit exceeded/i.test(raw);
    if (shouldRetry && attempt < 3) {
      const waitMs = retryMatch ? Number(retryMatch[1]) * 1000 : (attempt + 1) * 5000;
      await sleep(waitMs);
      continue;
    }
    throw new Error(`${response.status} ${response.statusText} ${pathname}: ${raw}`);
  }
  throw new Error(`Unexpected request retry exhaustion for ${pathname}`);
}

async function waitForHttp(url, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function isHttpReachable(url, timeoutMs = 1500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function startPreviewServer(cwd) {
  if (process.platform === "win32") {
    return spawn(
      "cmd.exe",
      ["/d", "/s", "/c", `pnpm exec vite preview --host localhost --port ${previewPort} --strictPort`],
      { cwd, env: process.env, stdio: "pipe" },
    );
  }

  return spawn(
    "/bin/bash",
    ["-lc", `pnpm exec vite preview --host localhost --port ${previewPort} --strictPort`],
    { cwd, env: process.env, stdio: "pipe" },
  );
}

async function createRoomingToCheckoutEncounter(adminAuth, facilityId) {
  const assignments = await request(`/admin/assignments?facilityId=${facilityId}`, {
    auth: { ...adminAuth, facilityId },
  });
  const targetAssignment =
    assignments.find((row) => row.clinicStatus === "active" && row.isOperational) || assignments[0];
  if (!targetAssignment?.clinicId) {
    throw new Error("No clinic assignment available");
  }

  const reasons = await request(
    `/admin/reasons?facilityId=${facilityId}&clinicId=${targetAssignment.clinicId}&includeInactive=true`,
    { auth: { ...adminAuth, facilityId } },
  );
  const reason = reasons.find((row) => String(row.status || "active") === "active");
  if (!reason?.id) {
    throw new Error("No active reason available for selected clinic");
  }

  const created = await request("/encounters", {
    method: "POST",
    auth: { ...adminAuth, facilityId },
    body: {
      patientId: `PT-FIGMA-AUDIT-${Date.now()}`,
      clinicId: targetAssignment.clinicId,
      reasonForVisitId: reason.id,
      walkIn: true,
      insuranceVerified: true,
    },
  });

  return {
    id: created.id,
    clinicId: targetAssignment.clinicId,
    reasonId: reason.id,
    reasonName: reason.name,
  };
}

async function findEncounterByStatus(adminAuth, facilityId, status) {
  const rows = await request(
    `/encounters?status=${encodeURIComponent(status)}`,
    {
      auth: { ...adminAuth, facilityId },
    },
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0] || null;
}

async function findReasonIdForEncounter(adminAuth, facilityId, encounterId) {
  const row = await request(`/encounters/${encounterId}`, {
    auth: { ...adminAuth, facilityId },
  });
  return (
    row?.reasonForVisitId ||
    row?.reasonId ||
    row?.reason?.id ||
    null
  );
}

async function capturePageIfHealthy(page, url, screenshotPath) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const appErrorCount = await page.getByText("Unexpected Application Error!").count();
  if (appErrorCount > 0) {
    return { captured: false, reason: "Unexpected Application Error" };
  }
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return { captured: true };
}

function buildRequiredData(templateRows, type) {
  const normalizedType = String(type || "").toLowerCase();
  const template =
    (Array.isArray(templateRows) ? templateRows : []).find((row) => {
      const t = String(row?.type || "").toLowerCase();
      return t === normalizedType || (normalizedType === "checkin" && t === "intake");
    }) || null;
  if (!template) return {};
  const required = Array.isArray(template.requiredFields)
    ? template.requiredFields
    : Array.isArray(template.fields)
      ? template.fields.filter((f) => f?.required).map((f) => f.key).filter(Boolean)
      : [];
  return Object.fromEntries(required.map((key) => [key, "figma-audit"]));
}

async function advanceEncounterStatus(adminAuth, facilityId, encounterId, toStatus) {
  const enc = await request(`/encounters/${encounterId}`, {
    auth: { ...adminAuth, facilityId },
  });
  await request(`/encounters/${encounterId}/status`, {
    method: "PATCH",
    auth: { ...adminAuth, facilityId },
    body: {
      toStatus,
      version: Number(enc?.version || 0),
    },
  });
}

async function main() {
  if (!devUserId && !hasBearerToken) {
    throw new Error("Set VITE_DEV_USER_ID/FRONTEND_DEV_USER_ID or VITE_BEARER_TOKEN/FRONTEND_BEARER_TOKEN");
  }

  const [{ chromium }] = await Promise.all([import("playwright")]);

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const frontendRoot = path.resolve(scriptDir, "..");
  const repoRoot = path.resolve(frontendRoot, "..", "..");
  const stamp = nowStamp();
  const outputDir = path.join(repoRoot, "docs", "verification", `figma-parity-${stamp}`);
  await fs.mkdir(outputDir, { recursive: true });

  const adminAuth = { userId: devUserId, role: devRole };
  const context = await request("/auth/context", { auth: adminAuth });
  const facilityId =
    context?.activeFacilityId ||
    context?.facilityId ||
    (Array.isArray(context?.availableFacilities) && context.availableFacilities[0]?.id) ||
    "";
  if (!facilityId) throw new Error("No active facility available in auth context");

    const encounter = await createRoomingToCheckoutEncounter(adminAuth, facilityId);
    const templates = await request(
      `/admin/templates?facilityId=${facilityId}&reasonId=${encounter.reasonId}&includeInactive=true`,
      { auth: { ...adminAuth, facilityId } },
    );
    const roomingData = buildRequiredData(templates, "rooming");
    const clinicianData = buildRequiredData(templates, "clinician");
    const rooms = await request(`/admin/rooms?facilityId=${facilityId}&clinicId=${encounter.clinicId}`, {
      auth: { ...adminAuth, facilityId },
    });
    const roomId = (rooms.find((row) => row.status === "active") || rooms[0])?.id;

  let preview = null;
  let browser;
  let ctx;
  let page;
  const skippedScreens = [];

  try {
    const frontendAlreadyRunning = await isHttpReachable(frontendBaseUrl);
    if (!frontendAlreadyRunning) {
      preview = startPreviewServer(frontendRoot);
      preview.stdout?.on("data", (chunk) => process.stdout.write(chunk));
      preview.stderr?.on("data", (chunk) => process.stderr.write(chunk));
      await waitForHttp(frontendBaseUrl);
    }

    browser = await chromium.launch({ headless: true });
    ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    page = await ctx.newPage();

    await page.goto(`${frontendBaseUrl}/login`, { waitUntil: "networkidle" });
    await page.getByLabel("Role").selectOption(devRole);
    if (hasBearerToken) {
      const bearerButton = page.getByRole("button", { name: "Bearer JWT" });
      if ((await bearerButton.count()) > 0) await bearerButton.first().click();
      await page.getByLabel("JWT Token").fill(bearerToken.trim());
    } else {
      const devHeaderButton = page.getByRole("button", { name: "Dev Header" });
      if ((await devHeaderButton.count()) > 0) await devHeaderButton.first().click();
      await page.getByLabel("User ID").fill(devUserId);
    }
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 10000 });

    await page.goto(`${frontendBaseUrl}/checkin`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Front Desk Check-In" }).waitFor({ timeout: 10000 });
    await page.screenshot({ path: path.join(outputDir, "checkin-page.png"), fullPage: true });

    await page.goto(`${frontendBaseUrl}/clinician`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Clinician Board" }).waitFor({ timeout: 10000 });
    await page.screenshot({ path: path.join(outputDir, "clinician-board.png"), fullPage: true });

    await page.goto(`${frontendBaseUrl}/checkout`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Front Desk Check-Out" }).waitFor({ timeout: 10000 });
    await page.screenshot({ path: path.join(outputDir, "checkout-page.png"), fullPage: true });

    await page.goto(`${frontendBaseUrl}/settings`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Admin Console" }).waitFor({ timeout: 10000 });
    await page.getByRole("tab", { name: /Reasons & Templates/i }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outputDir, "admin-templates-tab.png"), fullPage: true });
    await page.getByRole("button", { name: /Create Template/i }).first().click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outputDir, "admin-template-modal.png"), fullPage: true });

    await advanceEncounterStatus(adminAuth, facilityId, encounter.id, "Rooming");
    {
      const result = await capturePageIfHealthy(
        page,
        `${frontendBaseUrl}/encounter/${encounter.id}`,
        path.join(outputDir, "encounter-rooming.png"),
      );
      if (!result.captured) {
        skippedScreens.push({ name: "encounter-rooming.png", reason: result.reason });
      }
    }

    await request(`/encounters/${encounter.id}/rooming`, {
      method: "PATCH",
      auth: { ...adminAuth, facilityId },
      body: {
        roomId: roomId || undefined,
        data: roomingData,
      },
    });

    await advanceEncounterStatus(adminAuth, facilityId, encounter.id, "ReadyForProvider");
    {
      const result = await capturePageIfHealthy(
        page,
        `${frontendBaseUrl}/encounter/${encounter.id}`,
        path.join(outputDir, "encounter-ready-provider.png"),
      );
      if (!result.captured) {
        skippedScreens.push({ name: "encounter-ready-provider.png", reason: result.reason });
      }
    }

    let optimizingEncounterId = null;
    try {
      const readyEncounter = await request(`/encounters/${encounter.id}`, {
        auth: { ...adminAuth, facilityId },
      });
      const readyStatus = String(readyEncounter?.status || readyEncounter?.currentStatus || "");
      if (readyStatus === "ReadyForProvider") {
        await request(`/encounters/${encounter.id}/visit/start`, {
          method: "POST",
          auth: { ...adminAuth, facilityId },
          body: { version: Number(readyEncounter?.version || 0) },
        });
        optimizingEncounterId = encounter.id;
      }
    } catch {
      // fallback below
    }
    if (!optimizingEncounterId) {
      const existingOptimizing = await findEncounterByStatus(adminAuth, facilityId, "Optimizing");
      if (existingOptimizing?.id) optimizingEncounterId = existingOptimizing.id;
    }

    if (optimizingEncounterId) {
      const result = await capturePageIfHealthy(
        page,
        `${frontendBaseUrl}/encounter/${optimizingEncounterId}`,
        path.join(outputDir, "encounter-optimizing.png"),
      );
      if (!result.captured) {
        skippedScreens.push({ name: "encounter-optimizing.png", reason: result.reason });
      }
    }

    let checkoutEncounterId = null;
    if (optimizingEncounterId) {
      const optimizingEncounter = await request(`/encounters/${optimizingEncounterId}`, {
        auth: { ...adminAuth, facilityId },
      });
      const currentStatus = String(optimizingEncounter?.status || optimizingEncounter?.currentStatus || "");
      if (currentStatus === "Optimizing") {
        const reasonId = (await findReasonIdForEncounter(adminAuth, facilityId, optimizingEncounterId)) || encounter.reasonId;
        const clinicianTemplates = reasonId
          ? await request(
              `/admin/templates?facilityId=${facilityId}&reasonId=${reasonId}&type=clinician&includeInactive=true`,
              { auth: { ...adminAuth, facilityId } },
            )
          : [];
        const clinicianPayload = Object.keys(buildRequiredData(clinicianTemplates, "clinician")).length
          ? buildRequiredData(clinicianTemplates, "clinician")
          : clinicianData;
        await request(`/encounters/${optimizingEncounterId}/visit/end`, {
          method: "POST",
          auth: { ...adminAuth, facilityId },
          body: {
            version: Number(optimizingEncounter?.version || 0),
            data: clinicianPayload,
          },
        });
        checkoutEncounterId = optimizingEncounterId;
      }
    }
    if (!checkoutEncounterId) {
      const existingCheckout = await findEncounterByStatus(adminAuth, facilityId, "CheckOut");
      if (existingCheckout?.id) checkoutEncounterId = existingCheckout.id;
    }

    if (checkoutEncounterId) {
      const result = await capturePageIfHealthy(
        page,
        `${frontendBaseUrl}/encounter/${checkoutEncounterId}`,
        path.join(outputDir, "encounter-checkout.png"),
      );
      if (!result.captured) {
        skippedScreens.push({ name: "encounter-checkout.png", reason: result.reason });
      }
    }

    await fs.writeFile(
      path.join(outputDir, "metadata.json"),
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          apiBaseUrl,
          frontendBaseUrl,
          encounter,
          facilityId,
          mode: hasBearerToken ? "bearer" : "dev-header",
          skippedScreens,
        },
        null,
        2,
      ),
      "utf8",
    );

    console.log(outputDir);
  } finally {
    if (ctx) await ctx.close();
    if (browser) await browser.close();
    if (preview) {
      preview.kill("SIGTERM");
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
