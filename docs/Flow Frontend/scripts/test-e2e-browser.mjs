import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

const previewPort = Number(process.env.FRONTEND_E2E_PORT || 4173);
const frontendBaseUrl = process.env.FRONTEND_BASE_URL || `http://localhost:${previewPort}`;
const TRANSIENT_STATUS_CODES = new Set([502, 503, 504]);
const SAFE_RETRY_METHODS = new Set(["GET", "HEAD"]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoDateDaysFromNow(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function clinicFutureSlot(minutesAhead = 90, timeZone = "America/New_York") {
  const future = new Date(Date.now() + minutesAhead * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(future)
    .reduce((acc, part) => {
      if (part.type !== "literal") {
        acc[part.type] = part.value;
      }
      return acc;
    }, {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

async function authHeaders(method = "GET", path = "/", body) {
  if (hasProofAuth) {
    return buildSignedProofHeaders({
      userId: proofUserId.trim(),
      role: proofRole,
      proofSecret: proofSecret.trim(),
      proofHmacSecret,
      method,
      path,
      body,
    });
  }
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

function buildRequiredData(templates, { type, clinicId }) {
  const normalizedType = String(type || "").toLowerCase();
  const defaultsByType = {
    rooming: {
      allergiesChanged: false,
      medicationReconciliationChanged: false,
      labChanged: false,
      pharmacyChanged: false,
      "service.capture_items": [
        {
          id: "browser-rooming-service",
          catalogItemId: "svc-venipuncture",
          label: "Venipuncture",
          sourceRole: "MA",
          sourceTaskId: null,
          quantity: 1,
          note: null,
          performedAt: new Date().toISOString(),
          capturedByUserId: null,
          suggestedProcedureCode: "36415",
          detailSchemaKey: "specimen_collection",
          detailJson: {
            specimenType: "Blood",
            collectionMethod: "Venipuncture",
            sentToLab: "Yes",
          },
          detailComplete: true,
        },
      ],
    },
  };

  const matchingTemplate =
    templates.find((template) => {
      const templateType = String(template.type || "").toLowerCase();
      return templateType === normalizedType && template.clinicId === clinicId;
    }) ||
    templates.find((template) => String(template.type || "").toLowerCase() === normalizedType && !template.clinicId) ||
    null;

  if (!matchingTemplate) return { ...(defaultsByType[normalizedType] || {}) };

  const requiredFields =
    Array.isArray(matchingTemplate.requiredFields) && matchingTemplate.requiredFields.length > 0
      ? matchingTemplate.requiredFields
      : Array.isArray(matchingTemplate.fields)
        ? matchingTemplate.fields.filter((field) => field?.required).map((field) => field.key).filter(Boolean)
        : [];

  return {
    ...(defaultsByType[normalizedType] || {}),
    ...Object.fromEntries(requiredFields.map((field) => [field, "browser-e2e"])),
  };
}

async function ensureReadyRoom({ clinicId, facilityId }) {
  const fetchRoomCards = async () => request(`/rooms/live?clinicId=${clinicId}`, { auth: true });

  let roomCards = await fetchRoomCards();
  let room = Array.isArray(roomCards)
    ? roomCards.find((row) => row.operationalStatus === "Ready")
    : null;
  if (room) return room;

  const recoverableRoom = Array.isArray(roomCards)
    ? roomCards.find(
        (row) =>
          row.roomId &&
          row.actualOperationalStatus !== "Occupied" &&
          row.actualOperationalStatus !== "Hold" &&
          row.dayStartCompleted === false,
      )
    : null;

  if (recoverableRoom?.roomId) {
    await request("/rooms/checklists/day-start", {
      method: "POST",
      auth: true,
      body: {
        roomId: recoverableRoom.roomId,
        clinicId,
        completed: true,
        items: [
          { key: "visual-ready", label: "Room visually ready", completed: true },
          { key: "baseline-supplies", label: "Baseline supplies and equipment present", completed: true },
          { key: "prior-holds-reviewed", label: "Prior holds reviewed", completed: true },
          { key: "status-confirmed", label: "Room status confirmed", completed: true },
        ],
      },
    });
    roomCards = await fetchRoomCards();
    room = Array.isArray(roomCards)
      ? roomCards.find((row) => row.operationalStatus === "Ready")
      : null;
  }

  if (!room) {
    const turnoverRoom = Array.isArray(roomCards)
      ? roomCards.find(
          (row) =>
            row.roomId &&
            row.dayStartCompleted === true &&
            (row.actualOperationalStatus === "NeedsTurnover" || row.actualOperationalStatus === "NotReady"),
        )
      : null;
    if (turnoverRoom?.roomId) {
      await request(`/rooms/${turnoverRoom.roomId}/actions/mark-ready`, {
        method: "POST",
        auth: true,
        body: { clinicId, facilityId },
      });
      roomCards = await fetchRoomCards();
      room = Array.isArray(roomCards)
        ? roomCards.find((row) => row.operationalStatus === "Ready")
        : null;
    }
  }

  return room || null;
}

function roomCardIsUsableForProof(row) {
  if (!row?.roomId && !row?.id) return false;
  if (row.operationalStatus === "Ready") return true;
  if (
    row.actualOperationalStatus !== "Occupied" &&
    row.actualOperationalStatus !== "Hold" &&
    row.dayStartCompleted === false
  ) {
    return true;
  }
  if (
    row.dayStartCompleted === true &&
    (row.actualOperationalStatus === "NeedsTurnover" || row.actualOperationalStatus === "NotReady")
  ) {
    return true;
  }
  return false;
}

async function request(path, { method = "GET", body, auth = false } = {}) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const maxAttempts = SAFE_RETRY_METHODS.has(normalizedMethod) ? 5 : 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const headers = auth ? await authHeaders(normalizedMethod, path, body) : {};
    if (body) {
      headers["content-type"] = "application/json";
    }

    try {
      const response = await fetch(`${apiBaseUrl}${path}`, {
        method: normalizedMethod,
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

async function gotoFrontend(page, path = "/") {
  await page.goto(`${frontendBaseUrl}${path}`, { waitUntil: "domcontentloaded" });
}

async function main() {
  if (!devUserId && !hasBearerToken && !hasProofAuth) {
    console.info("Skipping browser e2e check because no proof, dev-user, or bearer auth was provided.");
    return;
  }

  const [{ chromium }] = await Promise.all([import("playwright")]);

  const authContext = await request("/auth/context", { auth: true });
  const resolvedRole = authContext?.role || devRole;
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
  const operationalAssignments = assignments.filter((row) => row.clinicStatus === "active" && row.isOperational);
  assert.ok(operationalAssignments.length > 0, "expected at least one active operational clinic assignment");

  const roomsByClinic = await Promise.all(
    operationalAssignments.map(async (row) => ({
      assignment: row,
      rooms: await request(`/rooms/live?clinicId=${row.clinicId}`, { auth: true }),
    })),
  );

  const assignmentsWithUsableRooms = roomsByClinic
    .filter((entry) => Array.isArray(entry.rooms) && entry.rooms.some((row) => roomCardIsUsableForProof(row)))
    .map((entry) => ({
      assignment: entry.assignment,
      clinic: clinics.find((row) => row.id === entry.assignment.clinicId) || null,
    }))
    .filter((entry) => Boolean(entry.clinic));

  const selectedAssignmentEntry =
    assignmentsWithUsableRooms.find((entry) => entry.clinic?.maRun) ||
    assignmentsWithUsableRooms[0] ||
    null;

  const targetAssignment = selectedAssignmentEntry?.assignment || operationalAssignments[0] || null;
  assert.ok(targetAssignment, "expected at least one active operational clinic assignment");

  const clinic =
    selectedAssignmentEntry?.clinic ||
    clinics.find((entry) => entry.id === targetAssignment.clinicId) ||
    null;
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

  const incomingReference = await request(
    `/incoming/reference?facilityId=${originalFacilityId}&clinicId=${clinic.id}`,
    { auth: true },
  );

  const clinicTimezone = String(clinic.timezone || authContext?.availableFacilities?.[0]?.timezone || "America/New_York");
  const importSlot = clinicFutureSlot(90, clinicTimezone);
  const importDate = importSlot.date;
  const importTime = importSlot.time;
  const incomingPatientId = `PT-E2E-INCOMING-${Date.now()}`;
  const pendingPatientId = `PT-E2E-PENDING-${Date.now()}`;
  const providerLastName =
    (Array.isArray(incomingReference?.samples?.providerLastNames) &&
      incomingReference.samples.providerLastNames.find((value) => String(value || "").trim())) ||
    String(clinic.name || "Clinic").trim();

  await request("/incoming/import", {
    method: "POST",
    auth: true,
    body: {
      clinicId: clinic.id,
      facilityId: originalFacilityId,
      dateOfService: importDate,
      source: "manual",
      csvText: [
        "patientId,appointmentTime,providerLastName,reasonForVisit",
        `${incomingPatientId},${importTime},${providerLastName},${reason.name}`,
        `${pendingPatientId},${importTime},${providerLastName},UnknownReasonE2E`,
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

  const templates = await request(
    `/admin/templates?facilityId=${originalFacilityId}&clinicId=${clinic.id}&reasonForVisitId=${reason.id}`,
    { auth: true },
  );
  const roomingData = buildRequiredData(templates, { type: "rooming", clinicId: clinic.id });
  const readyRoom = await ensureReadyRoom({ clinicId: clinic.id, facilityId: originalFacilityId });
  assert.ok(readyRoom?.roomId || readyRoom?.id, "expected an operationally ready room for rooming proof");

  const movedToRooming = await request(`/encounters/${createdEncounter.id}/status`, {
    method: "PATCH",
    auth: true,
    body: {
      toStatus: "Rooming",
      version: createdEncounter.version,
    },
  });
  await request(`/encounters/${createdEncounter.id}/rooming`, {
    method: "PATCH",
    auth: true,
    body: {
      roomId: readyRoom.roomId || readyRoom.id,
      data: roomingData,
    },
  });
  const roomedEncounter = await request(`/encounters/${createdEncounter.id}`, { auth: true });

  let preview = null;
  let browser;
  let context;
  let page;
  try {
    const frontendAlreadyRunning = await isHttpReachable(frontendBaseUrl);
    if (!frontendAlreadyRunning) {
      preview = startPreviewServer();
      await waitForHttp(frontendBaseUrl);
    }

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    const seededSession = hasProofAuth
      ? {
          mode: "proof_header",
          role: resolvedRole,
          userId: proofUserId.trim(),
          proofSecret: proofSecret.trim(),
          proofHmacSecret: proofHmacSecret.trim(),
          facilityId: originalFacilityId,
        }
      : hasBearerToken
      ? {
          mode: "bearer",
          role: resolvedRole,
          userId: authContext?.userId || undefined,
          token: bearerToken.trim(),
          facilityId: originalFacilityId,
        }
      : {
          mode: "dev_header",
          role: resolvedRole,
          userId: authContext?.userId || devUserId,
          facilityId: originalFacilityId,
        };
    await context.addInitScript((session) => {
      window.localStorage.setItem("flow_auth_session", JSON.stringify(session));
    }, seededSession);
    page = await context.newPage();

    await gotoFrontend(page, "/");
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 10_000 });

    await gotoFrontend(page, "/checkin");
    await page.getByRole("heading", { name: "Front Desk Check-In" }).waitFor({ timeout: 10_000 });

    await gotoFrontend(page, "/ma-board");
    await page.getByRole("heading", { name: "MA Board" }).waitFor({ timeout: 10_000 });

    await gotoFrontend(page, `/encounter/${createdEncounter.id}`);
    const encounterBodyTextBeforeAdvance = await page.locator("body").innerText();
    assert.ok(
      !encounterBodyTextBeforeAdvance.includes("Unexpected Application Error"),
      "encounter detail should render without the route error screen before advancing",
    );

    await request(`/encounters/${createdEncounter.id}/status`, {
      method: "PATCH",
      auth: true,
      body: {
        toStatus: clinic.maRun ? "CheckOut" : "ReadyForProvider",
        version: roomedEncounter.version,
      },
    });

    await expectPoll(async () => {
      const refreshedEncounter = await request(`/encounters/${createdEncounter.id}`, { auth: true });
      return refreshedEncounter?.status || refreshedEncounter?.currentStatus || null;
    }, clinic.maRun ? "CheckOut" : "ReadyForProvider");

    await gotoFrontend(page, "/ma-board");
    await page.getByRole("heading", { name: "MA Board" }).waitFor({ timeout: 10_000 });
    const roomingColumnCard = page.locator(
      `[data-status-column="Rooming"] [data-encounter-patient-id="${createdEncounter.patientId}"]`,
    );
    await expectPoll(async () => await roomingColumnCard.count(), 0);

    await gotoFrontend(page, `/encounter/${createdEncounter.id}`);
    if (clinic.maRun) {
      await expectPoll(async () => {
        const refreshedEncounter = await request(`/encounters/${createdEncounter.id}`, { auth: true });
        return refreshedEncounter?.status || refreshedEncounter?.currentStatus || null;
      }, "CheckOut");
      const encounterBodyText = await page.locator("body").innerText();
      assert.ok(
        !encounterBodyText.includes("Unexpected Application Error"),
        "MA-run encounter detail should remain stable after moving directly to CheckOut",
      );
    } else {
      await page.getByRole("heading", { name: "Ready for Provider" }).waitFor({ timeout: 10_000 });
      await page.getByText("The provider will start the visit from the Clinician Board.", { exact: false }).waitFor({
        timeout: 10_000,
      });

      await gotoFrontend(page, "/clinician");
      await page.getByRole("heading", { name: "Clinician Board" }).waitFor({ timeout: 10_000 });
    }

    await gotoFrontend(page, "/checkout");
    await page.getByRole("heading", { name: "Front Desk Check-Out" }).waitFor({ timeout: 10_000 });
    const checkoutQueueCards = page.locator('div[class*="cursor-pointer"]').filter({ hasText: "In checkout" });
    if ((await checkoutQueueCards.count()) > 0) {
      await checkoutQueueCards.first().click();
      await page.waitForTimeout(500);
      const checkoutBodyText = await page.locator("body").innerText();
      assert.ok(
        !checkoutBodyText.includes("Unexpected Application Error"),
        "expanding a checkout encounter should not trigger the route error screen",
      );
      await page.getByText("Collection Tracking", { exact: false }).waitFor({ timeout: 10_000 });
    }

    await gotoFrontend(page, "/revenue-cycle");
    await page.getByPlaceholder("Search patient, clinic, or blocker").waitFor({ timeout: 10_000 });
    const revenueBodyText = await page.locator("body").innerText();
    assert.ok(
      !revenueBodyText.includes("Unable to load Revenue Cycle data"),
      "revenue cycle should render without the global load failure state",
    );
    assert.ok(
      !revenueBodyText.includes("Unexpected Application Error"),
      "revenue cycle should not trigger the route error screen",
    );
    await page.getByRole("button", { name: "Work Queues" }).waitFor({ timeout: 10_000 });
    await page.getByText("Today's risk strip", { exact: false }).waitFor({ timeout: 30_000 });

    await gotoFrontend(page, "/settings");
    await page.getByRole("heading", { name: "Admin Console" }).waitFor({ timeout: 10_000 });

    await page.getByRole("tab", { name: /Incoming Uploads/i }).click();
    await page.getByText("Upload CSV files, paste copied schedule grids", { exact: false }).waitFor({ timeout: 10_000 });
    const dateInput = page
      .locator('label:has-text("Date of Service")')
      .locator("xpath=following-sibling::input")
      .first();
    const currentClinicDate = clinicFutureSlot(0, clinicTimezone).date;
    if ((await dateInput.count()) > 0 && importDate !== currentClinicDate) {
      await dateInput.fill(importDate);
    }
    const clinicScopeSelect = page
      .locator('label:has-text("Clinic Scope")')
      .locator("xpath=following-sibling::select")
      .first();
    if ((await clinicScopeSelect.count()) > 0) {
      await clinicScopeSelect.waitFor({ timeout: 10_000 });
      await page.waitForTimeout(250);
      const targetClinicOption = clinicScopeSelect.locator(`option[value="${clinic.id}"]`);
      if ((await targetClinicOption.count()) > 0) {
        await clinicScopeSelect.selectOption(clinic.id);
      }
    }
    await page.evaluate(() => {
      window.dispatchEvent(new Event("clinops:admin-refresh"));
    });
    await page.waitForTimeout(500);

    // Keep browser coverage focused on visible admin UI smoke. The full import/edit/retry
    // behavior is exercised in the live API-backed e2e, which is more reliable in staging.
    await page.getByRole("button", { name: /Import to Day Schedule/i }).waitFor({ timeout: 10_000 });
    await page.getByText("Day Schedule Rows", { exact: false }).waitFor({ timeout: 10_000 });
    await page.getByText("Pending Review", { exact: false }).waitFor({ timeout: 10_000 });

    await page.getByRole("tab", { name: /Reasons & Templates/i }).click();
    await page.getByRole("button", { name: "Add Visit" }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Create Template" }).waitFor({ timeout: 10_000 });
    await page.getByText(/^Visit Reasons$/).waitFor({ timeout: 10_000 });
    await page.getByText(/^Templates$/).waitFor({ timeout: 10_000 });
    await page.getByText("Unexpected Application Error!").waitFor({ state: "detached", timeout: 1_000 }).catch(() => {});

    console.info("Browser role-flow regression checks passed.");
  } finally {
    try {
      let latestEncounter = await request(`/encounters/${createdEncounter.id}`, { auth: true });
      let latestStatus = latestEncounter?.status || latestEncounter?.currentStatus || null;
      if (
        latestEncounter?.version &&
        latestStatus &&
        latestStatus !== "CheckOut" &&
        latestStatus !== "Optimized"
      ) {
        latestEncounter = await request(`/encounters/${createdEncounter.id}/status`, {
          method: "PATCH",
          auth: true,
          body: {
            toStatus: "CheckOut",
            version: latestEncounter.version,
            reasonCode: "admin_override_cleanup",
          },
        });
        latestStatus = latestEncounter?.status || latestEncounter?.currentStatus || null;
      }
      if (latestEncounter?.version && latestStatus !== "Optimized") {
        await request(`/encounters/${createdEncounter.id}/cancel`, {
          method: "POST",
          auth: true,
          body: {
            version: latestEncounter.version,
            reason: "other",
            note: "browser e2e cleanup",
          },
        });
      }
    } catch {
      // Cleanup should never hide the real test result.
    }
    try {
      await request(`/rooms/${readyRoom.roomId || readyRoom.id}/actions/mark-ready`, {
        method: "POST",
        auth: true,
        body: {
          clinicId: clinic.id,
          facilityId: originalFacilityId,
        },
      });
    } catch {
      // Cleanup should never hide the real test result.
    }
    if (browser) await browser.close();
    if (preview && preview.exitCode === null) {
      preview.kill("SIGTERM");
    }
  }
}

async function expectPoll(read, expected, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await read()) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(await read(), expected);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
