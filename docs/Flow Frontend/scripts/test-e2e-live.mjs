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

function authHeaders({ userId, role, facilityId } = {}) {
  const headers = {};
  if (hasBearerToken) {
    headers.authorization = `Bearer ${bearerToken.trim()}`;
    if (facilityId) {
      headers["x-facility-id"] = facilityId;
    }
    return headers;
  }

  const selectedUserId = userId || devUserId;
  const selectedRole = role || devRole;
  if (!selectedUserId) return headers;
  headers["x-dev-user-id"] = selectedUserId;
  headers["x-dev-role"] = selectedRole;
  if (facilityId) {
    headers["x-facility-id"] = facilityId;
  }
  return headers;
}

async function request(path, { method = "GET", body, auth = null } = {}) {
  const headers = auth ? authHeaders(auth === true ? undefined : auth) : {};
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
    // preserve raw body
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${path}: ${raw}`);
  }

  return parsed;
}

function findRoleScopedUser(users, { role, facilityId, clinicId }) {
  return users.find((user) => {
    if ((user.status || "").toLowerCase() !== "active") return false;
    return (user.roles || []).some((entry) => {
      if (entry.role !== role) return false;
      if (entry.clinicId && clinicId) return entry.clinicId === clinicId;
      if (entry.facilityId && facilityId) return entry.facilityId === facilityId;
      return true;
    });
  });
}

function buildRequiredData(templates, { type, clinicId }) {
  const normalizedType = String(type || "").toLowerCase();
  const matchingTemplate =
    templates.find((template) => {
      const templateType = String(template.type || "").toLowerCase();
      if (templateType !== normalizedType && !(normalizedType === "checkin" && templateType === "intake")) {
        return false;
      }
      return template.clinicId === clinicId;
    }) ||
    templates.find((template) => {
      const templateType = String(template.type || "").toLowerCase();
      if (templateType !== normalizedType && !(normalizedType === "checkin" && templateType === "intake")) {
        return false;
      }
      return !template.clinicId;
    }) ||
    null;

  if (!matchingTemplate) return {};
  const requiredFields = Array.isArray(matchingTemplate.requiredFields) && matchingTemplate.requiredFields.length > 0
    ? matchingTemplate.requiredFields
    : Array.isArray(matchingTemplate.fields)
      ? matchingTemplate.fields.filter((field) => field?.required).map((field) => field.key).filter(Boolean)
      : [];
  return Object.fromEntries(requiredFields.map((field) => [field, "e2e-live"]));
}

function isoDateToday() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseMillis(value) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function assertTimerProgress(previousIso, nextIso, stageLabel) {
  const previous = parseMillis(previousIso);
  const next = parseMillis(nextIso);
  assert.ok(previous > 0, `${stageLabel}: previous timer stamp missing`);
  assert.ok(next > 0, `${stageLabel}: next timer stamp missing`);
  assert.ok(next >= previous, `${stageLabel}: timer did not advance`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function actorForRole(user, role, adminAuth, facilityId) {
  if (user?.id) {
    return { userId: user.id, role, facilityId };
  }
  return { ...adminAuth, facilityId };
}

async function main() {
  if (!devUserId && !hasBearerToken) {
    console.info("Skipping live e2e check because no dev-user or bearer-token auth was provided.");
    return;
  }

  const adminAuth = { userId: devUserId, role: devRole };
  const context = await request("/auth/context", { auth: adminAuth });
  const facilityId =
    context?.activeFacilityId ||
    context?.facilityId ||
    (Array.isArray(context?.availableFacilities) && context.availableFacilities[0]?.id) ||
    "";
  assert.ok(facilityId, "expected an active facility context");
  const originalFacilityId = facilityId;

  let facilitySwitchTargetId =
    Array.isArray(context?.availableFacilities) &&
    context.availableFacilities.find((entry) => entry.id && entry.id !== originalFacilityId)?.id;

  let createdFacilityId = "";
  if (!facilitySwitchTargetId) {
    const createdFacility = await request("/admin/facilities", {
      method: "POST",
      auth: adminAuth,
      body: {
        name: `E2E Facility ${Date.now()}`,
        shortCode: `E2E${Date.now().toString().slice(-4)}`,
        timezone: "America/New_York",
      },
    });
    createdFacilityId = createdFacility.id;
    facilitySwitchTargetId = createdFacility.id;
  }

  let switchedFacility = false;
  try {
    const switchedContext = await request("/auth/context/facility", {
      method: "POST",
      auth: adminAuth,
      body: {
        facilityId: facilitySwitchTargetId,
      },
    });
    switchedFacility = true;
    assert.equal(
      switchedContext?.activeFacilityId || switchedContext?.facilityId,
      facilitySwitchTargetId,
      "expected active facility switch to persist",
    );

    const switchedClinics = await request(`/admin/clinics?facilityId=${facilitySwitchTargetId}&includeInactive=true`, {
      auth: { ...adminAuth, facilityId: facilitySwitchTargetId },
    });
    assert.ok(Array.isArray(switchedClinics), "switched facility clinics list should return an array");
  } finally {
    if (switchedFacility) {
      await request("/auth/context/facility", {
        method: "POST",
        auth: adminAuth,
        body: {
          facilityId: originalFacilityId,
        },
      });
    }
    if (createdFacilityId) {
      await request(`/admin/facilities/${createdFacilityId}`, {
        method: "POST",
        auth: adminAuth,
        body: {
          status: "inactive",
        },
      });
    }
  }

  const clinics = await request(`/admin/clinics?facilityId=${originalFacilityId}&includeInactive=true`, {
    auth: { ...adminAuth, facilityId: originalFacilityId },
  });
  assert.ok(Array.isArray(clinics) && clinics.length > 0, "expected at least one clinic");

  const assignments = await request(`/admin/assignments?facilityId=${originalFacilityId}`, {
    auth: { ...adminAuth, facilityId: originalFacilityId },
  });
  assert.ok(Array.isArray(assignments) && assignments.length > 0, "expected assignments for selected facility");

  const targetAssignment =
    assignments.find((row) => row.clinicStatus === "active" && row.isOperational && row.maRun === false) ||
    assignments.find((row) => row.clinicStatus === "active" && row.isOperational);
  assert.ok(targetAssignment, "expected at least one active operational clinic assignment");

  const clinic = clinics.find((row) => row.id === targetAssignment.clinicId);
  assert.ok(clinic, "expected clinic for selected assignment");
  assert.equal(clinic.status, "active", "selected clinic must be active");
  assert.ok(targetAssignment.roomCount > 0, "selected clinic must have at least one active room");

  const users = await request(`/admin/users?facilityId=${originalFacilityId}`, {
    auth: { ...adminAuth, facilityId: originalFacilityId },
  });
  assert.ok(Array.isArray(users) && users.length > 0, "expected users in selected facility");

  const checkinUser = findRoleScopedUser(users, {
    role: "FrontDeskCheckIn",
    facilityId: originalFacilityId,
    clinicId: clinic.id,
  });
  const maUser = findRoleScopedUser(users, {
    role: "MA",
    facilityId: originalFacilityId,
    clinicId: clinic.id,
  });
  const clinicianUser = findRoleScopedUser(users, {
    role: "Clinician",
    facilityId: originalFacilityId,
    clinicId: clinic.id,
  });
  const checkoutUser = findRoleScopedUser(users, {
    role: "FrontDeskCheckOut",
    facilityId: originalFacilityId,
    clinicId: clinic.id,
  });

  const checkinAuth = actorForRole(checkinUser, "FrontDeskCheckIn", adminAuth, originalFacilityId);
  const maAuth = actorForRole(maUser, "MA", adminAuth, originalFacilityId);
  const clinicianAuth = actorForRole(clinicianUser, "Clinician", adminAuth, originalFacilityId);
  const checkoutAuth = actorForRole(checkoutUser, "FrontDeskCheckOut", adminAuth, originalFacilityId);
  if (!clinic.maRun) {
    assert.ok(targetAssignment.providerUserId, "non MA-run clinic requires provider assignment");
  }

  const reasons = await request(`/admin/reasons?clinicId=${clinic.id}&facilityId=${originalFacilityId}&includeInactive=true`, {
    auth: { ...adminAuth, facilityId: originalFacilityId },
  });
  const reason = reasons.find((row) => row.active !== false);
  assert.ok(reason, "expected at least one active visit reason for selected clinic");

  const templates = await request(
    `/admin/templates?facilityId=${originalFacilityId}&clinicId=${clinic.id}&reasonForVisitId=${reason.id}`,
    {
      auth: { ...adminAuth, facilityId: originalFacilityId },
    },
  );

  const checkinData = buildRequiredData(templates, { type: "checkin", clinicId: clinic.id });
  const roomingData = buildRequiredData(templates, { type: "rooming", clinicId: clinic.id });
  const clinicianData = buildRequiredData(templates, { type: "clinician", clinicId: clinic.id });
  const checkoutData = buildRequiredData(templates, { type: "checkout", clinicId: clinic.id });

  const roomCards = await request(`/rooms/live?clinicId=${clinic.id}`, {
    auth: { ...adminAuth, facilityId: originalFacilityId },
  });
  const room = Array.isArray(roomCards)
    ? roomCards.find((row) => row.operationalStatus === "Ready")
    : null;
  assert.ok(room, "expected at least one operationally Ready room for selected clinic");

  const providerLastName = (() => {
    const displayName = String(targetAssignment.providerUserName || targetAssignment.providerName || "").trim();
    if (!displayName) return "Provider";
    const tokens = displayName.split(/\\s+/).filter(Boolean);
    return tokens[tokens.length - 1] || displayName;
  })();

  const pendingPatientPrefix = `PT-E2E-PENDING-${Date.now()}`;
  const pendingImport = await request("/incoming/import", {
    method: "POST",
    auth: checkinAuth,
    body: {
      facilityId: originalFacilityId,
      clinicId: clinic.id,
      dateOfService: isoDateToday(),
      source: "csv",
      csvText: [
        "patientId,appointmentTime,providerLastName,reasonForVisit",
        `${pendingPatientPrefix}-OK,09:05,${providerLastName},${reason.name}`,
        `${pendingPatientPrefix}-FIX,09:15,${providerLastName},UnknownReasonE2E`,
      ].join("\n"),
    },
  });
  assert.ok(pendingImport.acceptedCount >= 1, "expected at least one accepted imported row");
  assert.ok(pendingImport.pendingCount >= 1, "expected one pending row for retry");

  const pendingRows = await request(
    `/incoming/pending?facilityId=${originalFacilityId}&clinicId=${clinic.id}&date=${isoDateToday()}`,
    { auth: checkinAuth },
  );
  const pendingRow = pendingRows.find((row) => {
    const normalized = row?.normalizedJson || {};
    return String(normalized.patientId || "").includes(`${pendingPatientPrefix}-FIX`);
  });
  assert.ok(pendingRow?.id, "expected pending row created from invalid import");

  const retried = await request(`/incoming/pending/${pendingRow.id}/retry`, {
    method: "POST",
    auth: checkinAuth,
    body: {
      clinicId: clinic.id,
      patientId: `${pendingPatientPrefix}-FIX`,
      appointmentTime: "09:15",
      providerLastName,
      reasonText: reason.name,
    },
  });
  assert.equal(retried.status, "accepted", "pending retry should accept corrected row");

  const patientId = `PT-E2E-${Date.now()}`;
  const created = await request("/encounters", {
    method: "POST",
    auth: checkinAuth,
    body: {
      patientId,
      clinicId: clinic.id,
      reasonForVisitId: reason.id,
      walkIn: true,
      insuranceVerified: false,
      intakeData: checkinData,
    },
  });
  assert.ok(created?.id, "encounter create should return id");
  assert.equal(created.status || created.currentStatus, "Lobby", "new encounter should start in Lobby");

  const today = isoDateToday();
  const checkinBoard = await request(`/encounters?clinicId=${clinic.id}&date=${today}`, {
    auth: checkinAuth,
  });
  assert.ok(checkinBoard.some((row) => row.id === created.id), "check-in board should include created encounter");

  const maBoard = await request(`/encounters?clinicId=${clinic.id}&date=${today}`, {
    auth: maAuth,
  });
  assert.ok(maBoard.some((row) => row.id === created.id), "MA board should include assigned encounter");

  const roomed = await request(`/encounters/${created.id}/rooming`, {
    method: "PATCH",
    auth: maAuth,
    body: {
      roomId: room.roomId,
      data: roomingData,
    },
  });
  assert.equal(roomed.status || roomed.currentStatus, "Lobby", "room assignment should not alter status");

  const movedRooming = await request(`/encounters/${created.id}/status`, {
    method: "PATCH",
    auth: maAuth,
    body: {
      toStatus: "Rooming",
      version: roomed.version,
    },
  });
  assert.equal(movedRooming.status || movedRooming.currentStatus, "Rooming", "encounter should move to Rooming");

  await wait(25);

  const movedReady = await request(`/encounters/${created.id}/status`, {
    method: "PATCH",
    auth: maAuth,
    body: {
      toStatus: "ReadyForProvider",
      version: movedRooming.version,
    },
  });
  assert.equal(
    movedReady.status || movedReady.currentStatus,
    "ReadyForProvider",
    "encounter should move to ReadyForProvider",
  );

  let providerStarted;
  let providerEnded;
  if (!clinic.maRun) {
    const clinicianBoard = await request(`/encounters?clinicId=${clinic.id}&date=${today}`, {
      auth: clinicianAuth,
    });
    assert.ok(
      clinicianBoard.some((row) => row.id === created.id),
      "clinician board should include provider-assigned encounter",
    );

    const readySnapshot = await request(`/encounters/${created.id}`, {
      auth: clinicianAuth,
    });
    const readyEntered = readySnapshot?.alertState?.enteredStatusAt;

    providerStarted = await request(`/encounters/${created.id}/visit/start`, {
      method: "POST",
      auth: clinicianAuth,
      body: {
        version: movedReady.version,
      },
    });
    assert.equal(
      providerStarted.status || providerStarted.currentStatus,
      "Optimizing",
      "start visit should move encounter to Optimizing",
    );

    const optimizingSnapshot = await request(`/encounters/${created.id}`, {
      auth: clinicianAuth,
    });
    assertTimerProgress(readyEntered, optimizingSnapshot?.alertState?.enteredStatusAt, "Ready->Optimizing");

    await wait(25);

    providerEnded = await request(`/encounters/${created.id}/visit/end`, {
      method: "POST",
      auth: clinicianAuth,
      body: {
        version: providerStarted.version,
        data: clinicianData,
      },
    });
    assert.equal(
      providerEnded.status || providerEnded.currentStatus,
      "CheckOut",
      "end visit should move encounter to CheckOut",
    );
  } else {
    providerEnded = await request(`/encounters/${created.id}/status`, {
      method: "PATCH",
      auth: maAuth,
      body: {
        toStatus: "Optimizing",
        version: movedReady.version,
      },
    });
    const checkoutMoved = await request(`/encounters/${created.id}/status`, {
      method: "PATCH",
      auth: maAuth,
      body: {
        toStatus: "CheckOut",
        version: providerEnded.version,
      },
    });
    providerEnded = checkoutMoved;
  }

  const checkoutBoard = await request(`/encounters?clinicId=${clinic.id}&date=${today}`, {
    auth: checkoutAuth,
  });
  assert.ok(
    checkoutBoard.some((row) => row.id === created.id),
    "checkout board should include encounter in downstream status",
  );

  const checkoutSnapshot = await request(`/encounters/${created.id}`, {
    auth: checkoutAuth,
  });
  const checkoutEntered = checkoutSnapshot?.alertState?.enteredStatusAt;

  const completed = await request(`/encounters/${created.id}/checkout/complete`, {
    method: "POST",
    auth: checkoutAuth,
    body: {
      version: providerEnded.version,
      checkoutData,
    },
  });
  assert.equal(
    completed.status || completed.currentStatus,
    "Optimized",
    "checkout complete should move encounter to Optimized",
  );

  const optimizedSnapshot = await request(`/encounters/${created.id}`, {
    auth: { ...adminAuth, facilityId: originalFacilityId },
  });
  assertTimerProgress(checkoutEntered, optimizedSnapshot?.alertState?.enteredStatusAt, "CheckOut->Optimized");

  const officeDashboard = await request(`/dashboard/office-manager?clinicId=${clinic.id}&date=${today}`, {
    auth: { ...adminAuth, facilityId: originalFacilityId },
  });
  assert.ok(
    typeof officeDashboard?.queueByStatus?.Optimized === "number",
    "office manager dashboard should return queue status aggregates",
  );

  console.info("Live role-board encounter flow e2e check passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
