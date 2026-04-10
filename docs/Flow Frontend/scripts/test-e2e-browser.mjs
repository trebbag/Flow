import assert from "node:assert/strict";
import { spawn } from "node:child_process";

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

const previewPort = Number(process.env.FRONTEND_E2E_PORT || 4173);
const frontendBaseUrl = process.env.FRONTEND_BASE_URL || `http://localhost:${previewPort}`;

function authHeaders() {
  if (hasBearerToken) {
    return {
      authorization: `Bearer ${bearerToken.trim()}`,
    };
  }
  if (!devUserId) return {};
  return {
    "x-dev-user-id": devUserId,
    "x-dev-role": devRole,
  };
}

async function request(path, { method = "GET", body, auth = false } = {}) {
  const headers = auth ? authHeaders() : {};
  if (body) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await response.text();
  let parsed = raw;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    // keep raw response
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${path}: ${raw}`);
  }
  return parsed;
}

async function waitForHttp(url, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function isHttpReachable(url, timeoutMs = 1_500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function startPreviewServer() {
  const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawn(
    pnpmCmd,
    ["exec", "vite", "preview", "--host", "localhost", "--port", String(previewPort), "--strictPort"],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: "pipe",
    },
  );

  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}

async function main() {
  if (!devUserId && !hasBearerToken) {
    console.info("Skipping browser e2e check because no dev-user or bearer-token auth was provided.");
    return;
  }

  const [{ chromium }] = await Promise.all([import("playwright")]);

  const authContext = await request("/auth/context", { auth: true });
  const facilityId =
    authContext?.activeFacilityId ||
    authContext?.facilityId ||
    (Array.isArray(authContext?.availableFacilities) && authContext.availableFacilities[0]?.id) ||
    "";
  assert.ok(facilityId, "expected active facility in auth context");
  const originalFacilityId = facilityId;

  let facilitySwitchTargetId =
    Array.isArray(authContext?.availableFacilities) &&
    authContext.availableFacilities.find((entry) => entry.id && entry.id !== originalFacilityId)?.id;
  let createdFacilityId = "";

  if (!facilitySwitchTargetId) {
    const createdFacility = await request("/admin/facilities", {
      method: "POST",
      auth: true,
      body: {
        name: `E2E Browser Facility ${Date.now()}`,
        shortCode: `E2EB${Date.now().toString().slice(-4)}`,
        timezone: "America/New_York",
      },
    });
    createdFacilityId = createdFacility.id;
    facilitySwitchTargetId = createdFacility.id;
  }

  try {
    const switched = await request("/auth/context/facility", {
      method: "POST",
      auth: true,
      body: { facilityId: facilitySwitchTargetId },
    });
    assert.equal(
      switched?.activeFacilityId || switched?.facilityId,
      facilitySwitchTargetId,
      "expected facility context to switch",
    );
  } finally {
    await request("/auth/context/facility", {
      method: "POST",
      auth: true,
      body: { facilityId: originalFacilityId },
    });
    if (createdFacilityId) {
      await request(`/admin/facilities/${createdFacilityId}`, {
        method: "POST",
        auth: true,
        body: { status: "inactive" },
      });
    }
  }

  const clinics = await request(`/admin/clinics?facilityId=${originalFacilityId}&includeInactive=true`, { auth: true });
  assert.ok(Array.isArray(clinics) && clinics.length > 0, "expected at least one clinic");
  const assignments = await request(`/admin/assignments?facilityId=${originalFacilityId}`, { auth: true });
  assert.ok(Array.isArray(assignments) && assignments.length > 0, "expected assignment rows");
  const targetAssignment =
    assignments.find((row) => row.clinicStatus === "active" && row.isOperational) || null;
  assert.ok(targetAssignment, "expected at least one active operational clinic assignment");

  const clinic = clinics.find((entry) => entry.id === targetAssignment.clinicId);
  assert.ok(clinic, "expected selected clinic from assignments");

  let reasons = await request(`/admin/reasons?facilityId=${originalFacilityId}&clinicId=${clinic.id}&includeInactive=true`, { auth: true });
  if (!Array.isArray(reasons) || reasons.length === 0) {
    reasons = [
      await request("/admin/reasons", {
        method: "POST",
        auth: true,
        body: {
          facilityId: originalFacilityId,
          name: `E2E Browser Reason ${Date.now()}`,
          appointmentLengthMinutes: 20,
          clinicIds: [clinic.id],
        },
      }),
    ];
  }
  const reason = reasons.find((entry) => entry.status === "active" || entry.active !== false) || null;
  assert.ok(reason, "expected at least one active reason for selected clinic");

  const today = new Date().toISOString().slice(0, 10);
  const incomingPatientId = `PT-E2E-INCOMING-${Date.now()}`;
  const pendingPatientId = `PT-E2E-PENDING-${Date.now()}`;
  const editedIncomingPatientId = `${incomingPatientId}-ED`;
  const providerLastName = (() => {
    const providerName = String(targetAssignment.providerUserName || "").trim();
    if (providerName) {
      const parts = providerName.split(/\s+/).filter(Boolean);
      return parts[parts.length - 1] || providerName;
    }
    return String(clinic.name || "Clinic").trim();
  })();

  await request("/incoming/import", {
    method: "POST",
    auth: true,
    body: {
      clinicId: clinic.id,
      facilityId: originalFacilityId,
      dateOfService: today,
      source: "manual",
      csvText: [
        "patientId,appointmentTime,providerLastName,reasonForVisit",
        `${incomingPatientId},09:15,${providerLastName},${reason.name}`,
        `${pendingPatientId},09:20,${providerLastName},UnknownReasonE2E`,
      ].join("\n"),
    },
  });

  const patientId = `PT-E2E-BROWSER-${Date.now()}`;
  const createdEncounter = await request("/encounters", {
    method: "POST",
    auth: true,
    body: {
      patientId,
      clinicId: clinic.id,
      reasonForVisitId: reason.id,
      walkIn: true,
      insuranceVerified: false,
    },
  });
  assert.ok(createdEncounter?.id, "encounter create should return id");

  let preview = null;
  let browser;
  let context;
  let page;
  let createdReasonName = "";

  try {
    const frontendAlreadyRunning = await isHttpReachable(frontendBaseUrl);
    if (!frontendAlreadyRunning) {
      preview = startPreviewServer();
      await waitForHttp(frontendBaseUrl);
    }

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();

    await page.goto(`${frontendBaseUrl}/login`, { waitUntil: "networkidle" });
    await page.getByLabel("Role").selectOption(devRole);
    if (hasBearerToken) {
      const bearerButton = page.getByRole("button", { name: "Bearer JWT" });
      if ((await bearerButton.count()) > 0) {
        await bearerButton.first().click();
      }
      await page.getByLabel("JWT Token").fill(bearerToken.trim());
    } else {
      const devHeaderButton = page.getByRole("button", { name: "Dev Header" });
      if ((await devHeaderButton.count()) > 0) {
        await devHeaderButton.first().click();
      }
      await page.getByLabel("User ID").fill(devUserId);
    }
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 10_000 });

    await page.goto(`${frontendBaseUrl}/checkin`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Front Desk Check-In" }).waitFor({ timeout: 10_000 });

    await page.goto(`${frontendBaseUrl}/ma-board`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "MA Board" }).waitFor({ timeout: 10_000 });

    await page.goto(`${frontendBaseUrl}/clinician`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Clinician Board" }).waitFor({ timeout: 10_000 });

    await page.goto(`${frontendBaseUrl}/checkout`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Front Desk Check-Out" }).waitFor({ timeout: 10_000 });

    await page.goto(`${frontendBaseUrl}/settings`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Admin Console" }).waitFor({ timeout: 10_000 });

    await page.getByRole("tab", { name: /Incoming Uploads/i }).click();
    const clinicScopeSelect = page
      .locator('label:has-text("Clinic Scope")')
      .locator("xpath=following-sibling::select")
      .first();
    if ((await clinicScopeSelect.count()) > 0) {
      await clinicScopeSelect.selectOption(clinic.id);
    }
    await page.getByRole("button", { name: /^Refresh$/ }).first().click();

    const importedRow = page
      .locator("div.rounded-lg.border.border-gray-100.p-3")
      .filter({ hasText: incomingPatientId })
      .first();
    await importedRow.waitFor({ timeout: 15_000 });

    const pendingCards = page.locator("div.rounded-lg.border.border-amber-200");
    const pendingCountBefore = await pendingCards.count();
    assert.ok(pendingCountBefore >= 1, "expected at least one pending review row after mixed-quality import");

    const pendingCardForRow = pendingCards.filter({ hasText: pendingPatientId }).first();
    const pendingCard = (await pendingCardForRow.count()) > 0 ? pendingCardForRow : pendingCards.first();
    await pendingCard.getByRole("button", { name: /Edit & Retry/i }).click();
    const pendingEditPanel = pendingCard.locator("div.rounded-lg.border.border-amber-200.bg-white").first();
    await pendingEditPanel.waitFor({ timeout: 10_000 });
    const clinicSelect = pendingEditPanel.locator('label:has-text("Clinic")').locator("xpath=following-sibling::select");
    if ((await clinicSelect.count()) > 0) {
      await clinicSelect.first().selectOption(clinic.id);
    }
    await pendingEditPanel.locator('label:has-text("Patient ID")').locator("xpath=following-sibling::input").fill(pendingPatientId);
    await pendingEditPanel.locator('label:has-text("Appointment Time")').locator("xpath=following-sibling::input").fill("09:20");
    await pendingEditPanel.locator('label:has-text("Provider Last Name")').locator("xpath=following-sibling::input").fill(providerLastName);
    await pendingEditPanel.locator('label:has-text("Visit Reason")').locator("xpath=following-sibling::input").fill(reason.name);
    await pendingEditPanel.getByRole("button", { name: /Retry Row/i }).click();
    await page.getByRole("button", { name: /^Refresh$/ }).first().click();
    await page.waitForTimeout(400);
    const pendingCountAfter = await pendingCards.count();
    const retriedPendingCardCount = await pendingCardForRow.count();
    assert.ok(
      pendingCountAfter <= pendingCountBefore - 1 || retriedPendingCardCount === 0,
      "expected pending row retry to reduce pending queue",
    );

    await importedRow.getByRole("button", { name: "Edit Row" }).click();
    const editPanel = importedRow.locator("div.rounded-lg.border.border-sky-100").first();
    await editPanel.waitFor({ timeout: 10_000 });
    await editPanel.locator('input[type="text"]').first().fill(editedIncomingPatientId);
    await editPanel.getByRole("button", { name: /Save Row/i }).click();

    const editedRow = page
      .locator("div.rounded-lg.border.border-gray-100.p-3")
      .filter({ hasText: editedIncomingPatientId })
      .first();
    await editedRow.waitFor({ timeout: 15_000 });

    await editedRow.getByRole("button", { name: "Disposition" }).click();
    const dispositionPanel = editedRow.locator("div.rounded-lg.border.border-amber-200").first();
    await dispositionPanel.waitFor({ timeout: 10_000 });
    await dispositionPanel.locator('input[type="text"]').first().fill("e2e disposition");
    await dispositionPanel.getByRole("button", { name: /Save Disposition/i }).click();
    await page.getByRole("button", { name: /^Refresh$/ }).first().click();
    await page.waitForTimeout(400);

    const dispositionedRow = page
      .locator("div.rounded-lg.border.border-gray-100.p-3")
      .filter({ hasText: editedIncomingPatientId })
      .first();
    await dispositionedRow.waitFor({ timeout: 15_000 });
    await Promise.any([
      dispositionedRow.getByText("Dispositioned").waitFor({ timeout: 15_000 }),
      dispositionedRow.getByText("Row is finalized and cannot be edited.").waitFor({ timeout: 15_000 }),
    ]);
    await dispositionedRow.getByText(/Disposition:\s*No Show/i).waitFor({ timeout: 15_000 });

    await page.getByRole("tab", { name: /Reasons & Templates/i }).click();
    await page.getByRole("button", { name: "Add Visit" }).click();
    createdReasonName = `E2E Reason ${Date.now()}`;
    const dialog = page.getByRole("dialog").last();
    await dialog.getByPlaceholder("e.g. Urgent Care").fill(createdReasonName);
    await dialog.locator('input[type="number"]').first().fill("25");
    await dialog.getByRole("checkbox", { name: new RegExp(clinic.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }).check();
    await dialog.getByRole("button", { name: /Add Visit Reason|Save Visit Reason/i }).click();
    let createdReason = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const refreshedReasons = await request(
        `/admin/reasons?facilityId=${originalFacilityId}&clinicId=${clinic.id}&includeInactive=true`,
        { auth: true },
      );
      createdReason = Array.isArray(refreshedReasons)
        ? refreshedReasons.find((entry) => entry.name === createdReasonName) || null
        : null;
      if (createdReason) break;
      await page.waitForTimeout(500);
    }
    assert.ok(createdReason, "expected created visit reason to persist in API");
    const refreshButton = page.getByRole("button", { name: /^Refresh$/ }).first();
    if (await refreshButton.count()) {
      await refreshButton.click();
    } else {
      await page.reload({ waitUntil: "networkidle" });
      await page.getByRole("tab", { name: /Reasons & Templates/i }).click();
    }
    await page.getByRole("tab", { name: /Reasons & Templates/i }).waitFor({ timeout: 15_000 });
    await page.getByText("Unexpected Application Error!").waitFor({ state: "detached", timeout: 1_000 }).catch(() => {});

    console.info("Browser role-flow regression checks passed.");
  } finally {
    if (createdReasonName) {
      try {
        const updatedReasons = await request(`/admin/reasons?facilityId=${facilityId}&clinicId=${clinic.id}&includeInactive=true`, {
          auth: true,
        });
        const createdReason = Array.isArray(updatedReasons)
          ? updatedReasons.find((entry) => entry.name === createdReasonName)
          : null;
        if (createdReason?.id) {
          await request(`/admin/reasons/${createdReason.id}`, {
            method: "DELETE",
            auth: true,
          });
        }
      } catch {
        // cleanup best-effort
      }
    }

    if (browser) await browser.close();
    if (preview && preview.exitCode === null) {
      preview.kill("SIGTERM");
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
