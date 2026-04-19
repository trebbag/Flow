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
  const defaultsByType = {
    checkin: {
      "financial.registration_verified": true,
      "financial.contact_info_verified": true,
      "financial.eligibility_checked": true,
      "financial.eligibility_status": "Verified",
      "financial.coverage_issue_flag": false,
      "financial.expected_collection_indicator": true,
      "financial.patient_estimate_amount_cents": 2500,
      "financial.expected_pos_amount_due_cents": 2500,
      "financial.estimate_explained_to_patient": true,
      "financial.prior_auth_required": false,
      "financial.prior_auth_status": "NotRequired",
      "financial.referral_required": false,
      "financial.referral_status": "NotRequired",
    },
    rooming: {
      allergiesChanged: false,
      medicationReconciliationChanged: false,
      labChanged: false,
      pharmacyChanged: false,
      "service.capture_items": [
        {
          id: "e2e-rooming-service",
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
    clinician: {
      "coding.working_diagnosis_codes_text": "J01.90",
      "coding.working_procedure_codes_text": "99213",
      "coding.documentation_complete": true,
      "documentation.chief_concern_summary": "Acute follow-up concern reviewed.",
      "documentation.assessment_summary": "Assessment documented for staging proof.",
      "documentation.plan_follow_up": "Plan and follow-up reviewed with patient.",
      "documentation.orders_or_procedures": "No additional orders.",
    },
    checkout: {
      "billing.collection_expected": true,
      "billing.amount_due_cents": 2500,
      "billing.amount_collected_cents": 2500,
      "billing.collection_outcome": "CollectedInFull",
      "billing.missed_reason": "",
      "billing.tracking_note": "staging-live-proof",
    },
  };

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

  if (!matchingTemplate) return { ...(defaultsByType[normalizedType] || {}) };
  const requiredFields = Array.isArray(matchingTemplate.requiredFields) && matchingTemplate.requiredFields.length > 0
    ? matchingTemplate.requiredFields
    : Array.isArray(matchingTemplate.fields)
      ? matchingTemplate.fields.filter((field) => field?.required).map((field) => field.key).filter(Boolean)
      : [];
  return {
    ...(defaultsByType[normalizedType] || {}),
    ...Object.fromEntries(requiredFields.map((field) => [field, "e2e-live"])),
  };
}

function isoDateToday() {
  return isoDateDaysFromNow(0);
}

function isoDateDaysFromNow(days) {
  const now = new Date();
  now.setDate(now.getDate() + days);
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

const providerCredentialSuffixes = new Set([
  "md",
  "do",
  "np",
  "pa",
  "rn",
  "fnp",
  "fnpbc",
  "aprn",
  "arnp",
  "cnp",
  "dnp",
  "msn",
  "mph",
  "phd",
  "dds",
  "dmd",
  "fnpc",
  "pac",
]);

function fallbackProviderLastName(displayName) {
  const tokens = String(displayName || "")
    .trim()
    .replace(/[,/]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  while (tokens.length > 1) {
    const suffix = (tokens[tokens.length - 1] || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (!suffix || !providerCredentialSuffixes.has(suffix)) break;
    tokens.pop();
  }
  return tokens[tokens.length - 1] || "Provider";
}

async function ensureReadyRoom({ clinicId, facilityId, adminAuth }) {
  const fetchRoomCards = async () =>
    request(`/rooms/live?clinicId=${clinicId}`, {
      auth: { ...adminAuth, facilityId },
    });

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
      auth: { ...adminAuth, facilityId },
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

  const turnoverRoom =
    !room && Array.isArray(roomCards)
      ? roomCards.find(
          (row) =>
            row.roomId &&
            row.dayStartCompleted === true &&
            (row.actualOperationalStatus === "NeedsTurnover" || row.actualOperationalStatus === "NotReady"),
        )
      : null;

  if (!room && turnoverRoom?.roomId) {
    await request(`/rooms/${turnoverRoom.roomId}/actions/mark-ready`, {
      method: "POST",
      auth: { ...adminAuth, facilityId },
      body: {
        clinicId,
      },
    });
    roomCards = await fetchRoomCards();
    room = Array.isArray(roomCards)
      ? roomCards.find((row) => row.operationalStatus === "Ready")
      : null;
  }

  return room || null;
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

  const assignmentCandidates = [
    ...assignments.filter((row) => row.clinicStatus === "active" && row.isOperational && row.maRun === false),
    ...assignments.filter((row) => row.clinicStatus === "active" && row.isOperational && row.maRun === true),
  ].filter((row, index, rows) => rows.findIndex((entry) => entry.clinicId === row.clinicId) === index);

  let targetAssignment = null;
  let clinic = null;
  let room = null;
  for (const candidate of assignmentCandidates) {
    if (!candidate.roomCount || candidate.roomCount <= 0) continue;
    const candidateClinic = clinics.find((row) => row.id === candidate.clinicId);
    if (!candidateClinic || candidateClinic.status !== "active") continue;
    const readyRoom = await ensureReadyRoom({
      clinicId: candidateClinic.id,
      facilityId: originalFacilityId,
      adminAuth,
    });
    if (!readyRoom) continue;
    targetAssignment = candidate;
    clinic = candidateClinic;
    room = readyRoom;
    break;
  }

  assert.ok(targetAssignment, "expected at least one active operational clinic assignment with a ready room");
  assert.ok(clinic, "expected clinic for selected assignment");
  assert.ok(room, "expected at least one operationally Ready room for selected clinic");

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

  const incomingReference = await request(
    `/incoming/reference?facilityId=${originalFacilityId}&clinicId=${clinic.id}`,
    {
      auth: { ...adminAuth, facilityId: originalFacilityId },
    },
  );

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

  const providerLastName =
    (Array.isArray(incomingReference?.samples?.providerLastNames) &&
      incomingReference.samples.providerLastNames.find((value) => String(value || "").trim())) ||
    fallbackProviderLastName(targetAssignment.providerUserName || targetAssignment.providerName);

  const pendingPatientPrefix = `PT-E2E-PENDING-${Date.now()}`;
  const importDate = isoDateDaysFromNow(1);
  const pendingImport = await request("/incoming/import", {
    method: "POST",
    auth: checkinAuth,
    body: {
      facilityId: originalFacilityId,
      clinicId: clinic.id,
      dateOfService: importDate,
      source: "csv",
      csvText: [
        "patientId,appointmentTime,providerLastName,reasonForVisit",
        `${pendingPatientPrefix}-OK,09:05,${providerLastName},${reason.name}`,
        `${pendingPatientPrefix}-FIX,09:15,${providerLastName},UnknownReasonE2E`,
      ].join("\n"),
    },
  });
  assert.ok(
    (Number(pendingImport.acceptedCount || 0) + Number(pendingImport.pendingCount || 0)) >= 1,
    "expected imported rows to be created",
  );
  assert.ok(pendingImport.pendingCount >= 1, "expected one pending row for retry");

  const pendingRows = await request(
    `/incoming/pending?facilityId=${originalFacilityId}&clinicId=${clinic.id}&date=${importDate}`,
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
      dateOfService: importDate,
      appointmentTime: "09:15",
      providerLastName,
      reasonText: reason.name,
    },
  });
  assert.ok(
    retried.status === "accepted" || retried.status === "pending",
    "pending retry should remain actionable after correction",
  );

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
      toStatus: clinic.maRun ? "CheckOut" : "ReadyForProvider",
      version: movedRooming.version,
    },
  });
  assert.equal(
    movedReady.status || movedReady.currentStatus,
    clinic.maRun ? "CheckOut" : "ReadyForProvider",
    clinic.maRun
      ? "MA-run encounter should move directly to CheckOut"
      : "encounter should move to ReadyForProvider",
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
    providerEnded = movedReady;
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

  const roomCardsAfterCheckout = await request(`/rooms/live?clinicId=${clinic.id}`, {
    auth: { ...adminAuth, facilityId: originalFacilityId },
  });
  const roomAfterCheckout = Array.isArray(roomCardsAfterCheckout)
    ? roomCardsAfterCheckout.find((row) => row.roomId === room.roomId)
    : null;
  assert.ok(roomAfterCheckout, "room should remain visible after checkout");
  assert.equal(
    roomAfterCheckout.operationalStatus,
    "NeedsTurnover",
    "checkout completion should release the room into NeedsTurnover",
  );
  assert.ok(
    !roomAfterCheckout.currentEncounter,
    "released room should no longer show an occupied encounter after checkout",
  );

  await request(`/rooms/${room.roomId}/actions/mark-ready`, {
    method: "POST",
    auth: { ...adminAuth, facilityId: originalFacilityId },
    body: {
      clinicId: clinic.id,
    },
  });

  const roomCardsAfterReady = await request(`/rooms/live?clinicId=${clinic.id}`, {
    auth: { ...adminAuth, facilityId: originalFacilityId },
  });
  const roomAfterReady = Array.isArray(roomCardsAfterReady)
    ? roomCardsAfterReady.find((row) => row.roomId === room.roomId)
    : null;
  assert.ok(roomAfterReady, "room should remain visible after mark-ready");
  assert.equal(
    roomAfterReady.operationalStatus,
    "Ready",
    "mark-ready should return the released room to Ready status",
  );

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
