import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoleName, RoomEventType, RoomIssueStatus, RoomIssueType, RoomOperationalStatus, ScheduleSource, TemplateType } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { DateTime } from "luxon";
import { buildApp } from "../src/app.js";
import { ensurePatientRecord } from "../src/lib/patients.js";
import { authHeaders, bootstrapCore, jwtHeaders, prisma, resetDb } from "./helpers.js";

const app = buildApp();

async function createRevenueWorkflowEncounter(params: {
  clinicId: string;
  providerId: string;
  reasonForVisitId: string;
  checkinUserId: string;
  checkoutUserId: string;
  maUserId: string;
  clinicianUserId: string;
  roomId?: string;
  patientId?: string;
  roomingData?: Record<string, unknown>;
  clinicianData?: Record<string, unknown>;
  checkoutData?: Record<string, unknown>;
}) {
  const created = await app.inject({
    method: "POST",
    url: "/encounters",
    headers: authHeaders(params.checkinUserId, RoleName.FrontDeskCheckIn),
    payload: {
      patientId: params.patientId || "PT-REV-001",
      clinicId: params.clinicId,
      providerId: params.providerId,
      reasonForVisitId: params.reasonForVisitId,
      walkIn: true,
      intakeData: {
        "financial.registration_demographics_verified": true,
        "financial.contact_info_verified": true,
        "financial.eligibility_checked": true,
        "financial.eligibility_status": "Clear",
        "financial.primary_payer_name": "Aetna",
        "financial.primary_plan_name": "Open Access",
        "financial.financial_class": "Commercial",
        "financial.benefits_summary": "Benefits verified for same-day visit.",
        "financial.patient_estimate_amount_cents": 3200,
        "financial.expected_pos_collection_amount_cents": 3200,
        "financial.estimate_explained_to_patient": true,
        "financial.prior_balance_cents": 0,
        "financial.prior_auth_required": false,
        "financial.prior_auth_status": "NotRequired",
        "financial.referral_required": false,
        "financial.referral_status": "NotRequired",
      },
    },
  });
  expect(created.statusCode).toBe(200);
  let encounter = created.json();

  const toRooming = await app.inject({
    method: "PATCH",
    url: `/encounters/${encounter.id}/status`,
    headers: authHeaders(params.maUserId, RoleName.MA),
    payload: {
      toStatus: "Rooming",
      version: encounter.version,
    },
  });
  expect(toRooming.statusCode).toBe(200);
  encounter = toRooming.json();

  const roomId =
    params.roomId ||
    (
      await prisma.clinicRoomAssignment.findFirst({
        where: {
          clinicId: params.clinicId,
          active: true,
        },
        select: { roomId: true },
        orderBy: { createdAt: "asc" },
      })
    )?.roomId;
  expect(roomId).toBeTruthy();

  const saveRooming = await app.inject({
    method: "PATCH",
    url: `/encounters/${encounter.id}/rooming`,
    headers: authHeaders(params.maUserId, RoleName.MA),
    payload: {
      roomId,
      data: {
        vitals: "120/80",
        allergiesChanged: "No",
        medicationReconciliationChanged: "No",
        labChanged: "No",
        pharmacyChanged: "No",
        "service.capture_items": [
          {
            id: "svc-test-1",
            catalogItemId: "svc-venipuncture",
            label: "Venipuncture",
            sourceRole: "MA",
            quantity: 1,
            suggestedProcedureCode: "36415",
            expectedChargeCents: 1800,
            detailSchemaKey: "specimen_collection",
            detailJson: {
              specimenType: "Blood",
              collectionMethod: "Venipuncture",
              sentToLab: "Yes",
            },
            detailComplete: true,
          },
        ],
        ...(params.roomingData || {}),
      },
    },
  });
  expect(saveRooming.statusCode).toBe(200);
  encounter = saveRooming.json();

  const toReady = await app.inject({
    method: "PATCH",
    url: `/encounters/${encounter.id}/status`,
    headers: authHeaders(params.maUserId, RoleName.MA),
    payload: {
      toStatus: "ReadyForProvider",
      version: encounter.version,
    },
  });
  expect(toReady.statusCode).toBe(200);
  encounter = toReady.json();

  const startVisit = await app.inject({
    method: "POST",
    url: `/encounters/${encounter.id}/visit/start`,
    headers: authHeaders(params.clinicianUserId, RoleName.Clinician),
    payload: {
      version: encounter.version,
    },
  });
  expect(startVisit.statusCode).toBe(200);
  encounter = startVisit.json();

  const endVisit = await app.inject({
    method: "POST",
    url: `/encounters/${encounter.id}/visit/end`,
    headers: authHeaders(params.clinicianUserId, RoleName.Clinician),
    payload: {
      version: encounter.version,
      data: {
        "coding.working_diagnosis_codes_text": "J01.90",
        "coding.working_procedure_codes_text": "99213",
        assessment: "Visit complete",
        "documentation.chief_concern_summary": "Follow-up visit review",
        "documentation.assessment_summary": "Assessment documented for revenue handoff.",
        "documentation.plan_follow_up": "Plan documented and follow-up instructions provided.",
        "documentation.orders_or_procedures": "Orders and performed procedures documented.",
        ...(params.clinicianData || {}),
      },
    },
  });
  expect(endVisit.statusCode).toBe(200);
  encounter = endVisit.json();

  if (params.checkoutData) {
    const completeCheckout = await app.inject({
      method: "POST",
      url: `/encounters/${encounter.id}/checkout/complete`,
      headers: authHeaders(params.checkoutUserId, RoleName.Admin),
      payload: {
        version: encounter.version,
        checkoutData: params.checkoutData,
      },
    });
    expect(completeCheckout.statusCode).toBe(200);
    encounter = completeCheckout.json();
  }

  return encounter;
}

describe("Flow backend core relationships", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("checks in from incoming schedule and marks incoming row as checked in", async () => {
    const ctx = await bootstrapCore();

    const response = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-100",
        clinicId: ctx.clinic.id,
        incomingId: ctx.incoming.id
      }
    });

    expect(response.statusCode).toBe(200);
    const encounter = response.json();
    expect(encounter.currentStatus).toBe("Lobby");
    expect(encounter.providerId).toBe(ctx.provider.id);
    expect(encounter.reasonForVisitId).toBe(ctx.reason.id);

    const incoming = await prisma.incomingSchedule.findUnique({ where: { id: ctx.incoming.id } });
    expect(incoming?.checkedInEncounterId).toBe(encounter.id);
    expect(incoming?.checkedInAt).not.toBeNull();
  });

  it("replays idempotent encounter creation and rejects key reuse with a different payload", async () => {
    const ctx = await bootstrapCore();
    const baseHeaders = {
      ...authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      "Idempotency-Key": "encounter-create-pt-100",
    };

    const first = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: baseHeaders,
      payload: {
        patientId: "PT-IDEMPOTENT-1",
        clinicId: ctx.clinic.id,
        providerId: ctx.provider.id,
        reasonForVisitId: ctx.reason.id,
        walkIn: true,
      },
    });

    expect(first.statusCode).toBe(200);
    const created = first.json();

    const replay = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: baseHeaders,
      payload: {
        patientId: "PT-IDEMPOTENT-1",
        clinicId: ctx.clinic.id,
        providerId: ctx.provider.id,
        reasonForVisitId: ctx.reason.id,
        walkIn: true,
      },
    });

    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(created.id);

    const records = await prisma.encounter.findMany({
      where: {
        clinicId: ctx.clinic.id,
        patientId: "PT-IDEMPOTENT-1",
      },
    });
    expect(records).toHaveLength(1);

    const conflicting = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: baseHeaders,
      payload: {
        patientId: "PT-IDEMPOTENT-2",
        clinicId: ctx.clinic.id,
        providerId: ctx.provider.id,
        reasonForVisitId: ctx.reason.id,
        walkIn: true,
      },
    });

    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json()).toEqual(
      expect.objectContaining({
        code: "IDEMPOTENCY_KEY_REUSED",
      }),
    );
  });

  it("reuses a canonical patient record when source identifiers differ but DOB-backed identity matches", async () => {
    const ctx = await bootstrapCore();
    const dob = new Date(Date.UTC(1990, 0, 2, 0, 0, 0));

    const primary = await ensurePatientRecord(prisma, {
      facilityId: ctx.facility.id,
      sourcePatientId: "MRN-001",
      displayName: "Jane Doe",
      dateOfBirth: dob,
    });

    const alias = await ensurePatientRecord(prisma, {
      facilityId: ctx.facility.id,
      sourcePatientId: "ALT 999",
      displayName: "Jane Doe",
      dateOfBirth: dob,
    });

    expect(alias.id).toBe(primary.id);
    expect(await prisma.patient.count()).toBe(1);
  });

  it("normalizes patient name aliases before DOB-backed matching", async () => {
    const ctx = await bootstrapCore();
    const dob = new Date(Date.UTC(1988, 6, 14, 0, 0, 0));

    const primary = await ensurePatientRecord(prisma, {
      facilityId: ctx.facility.id,
      sourcePatientId: "ROB-100",
      displayName: "Robert Smith",
      dateOfBirth: dob,
    });

    const alias = await ensurePatientRecord(prisma, {
      facilityId: ctx.facility.id,
      sourcePatientId: "BOB-200",
      displayName: "Bob Smith",
      dateOfBirth: dob,
    });

    expect(alias.id).toBe(primary.id);
    expect(await prisma.patient.count()).toBe(1);
  });

  it("creates patient identity reviews instead of silently merging ambiguous canonical matches", async () => {
    const ctx = await bootstrapCore();
    const dob = new Date(Date.UTC(1988, 6, 14, 0, 0, 0));

    const primary = await prisma.patient.create({
      data: {
        facilityId: ctx.facility.id,
        sourcePatientId: "ROB-100",
        normalizedSourcePatientId: "rob100",
        displayName: "Robert Smith",
        dateOfBirth: dob,
      },
    });
    const duplicate = await prisma.patient.create({
      data: {
        facilityId: ctx.facility.id,
        sourcePatientId: "BOB-200",
        normalizedSourcePatientId: "bob200",
        displayName: "Bob Smith",
        dateOfBirth: dob,
      },
    });

    const created = await ensurePatientRecord(prisma, {
      facilityId: ctx.facility.id,
      sourcePatientId: "NEW-300",
      displayName: "Bob Smith",
      dateOfBirth: dob,
    });

    expect(created.id).not.toBe(primary.id);
    expect(created.id).not.toBe(duplicate.id);
    expect(await prisma.patient.count()).toBe(3);

    const review = await prisma.patientIdentityReview.findFirst({
      where: {
        facilityId: ctx.facility.id,
        normalizedSourcePatientId: "new300",
        status: "open",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(review?.reasonCode).toBe("AMBIGUOUS_ALIAS_MATCH");
    expect(review?.matchedPatientIdsJson).toEqual(
      expect.arrayContaining([primary.id, duplicate.id]),
    );
  });

  it("allows admins to resolve patient identity reviews onto a canonical patient", async () => {
    const ctx = await bootstrapCore();
    const dob = new Date(Date.UTC(1991, 2, 9, 0, 0, 0));

    const canonical = await prisma.patient.create({
      data: {
        facilityId: ctx.facility.id,
        sourcePatientId: "MRN-001",
        normalizedSourcePatientId: "mrn001",
        displayName: "Jane Doe",
        dateOfBirth: dob,
      },
    });
    await prisma.patientIdentityReview.create({
      data: {
        facilityId: ctx.facility.id,
        sourcePatientId: "ALT-999",
        normalizedSourcePatientId: "alt999",
        displayName: "Jane Doe",
        normalizedDisplayName: "jane doe",
        dateOfBirth: dob,
        reasonCode: "AMBIGUOUS_ALIAS_MATCH",
        matchedPatientIdsJson: [canonical.id],
      },
    });

    const reviews = await app.inject({
      method: "GET",
      url: `/admin/patient-identity-reviews?facilityId=${ctx.facility.id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
    });
    expect(reviews.statusCode).toBe(200);
    const openReview = (reviews.json() as Array<{ id: string }>)[0];
    expect(openReview?.id).toBeTruthy();

    const resolved = await app.inject({
      method: "POST",
      url: `/admin/patient-identity-reviews/${openReview.id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        status: "resolved",
        patientId: canonical.id,
      },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toEqual(
      expect.objectContaining({
        status: "resolved",
        patientId: canonical.id,
      }),
    );

    const alias = await prisma.patientAlias.findFirst({
      where: {
        patientId: canonical.id,
        aliasType: "source_patient_id",
        normalizedAliasValue: "alt999",
      },
    });
    expect(alias?.aliasValue).toBe("ALT-999");
  });

  it("surfaces integrity warnings for malformed patient identity review JSON", async () => {
    const ctx = await bootstrapCore();

    const review = await prisma.patientIdentityReview.create({
      data: {
        facilityId: ctx.facility.id,
        sourcePatientId: "ALT-JSON-1",
        normalizedSourcePatientId: "altjson1",
        reasonCode: "AMBIGUOUS_ALIAS_MATCH",
        matchedPatientIdsJson: { invalid: true } as unknown as Prisma.InputJsonValue,
        contextJson: ["unexpected"] as unknown as Prisma.InputJsonValue,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/admin/patient-identity-reviews?facilityId=${ctx.facility.id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
    });

    expect(response.statusCode).toBe(200);
    const rows = response.json() as Array<{
      id: string;
      integrityWarnings?: Array<{ field: string }>;
      matchedPatientIds?: string[];
      contextJson?: Record<string, unknown> | null;
    }>;
    const malformed = rows.find((row) => row.id === review.id);
    expect(malformed?.matchedPatientIds).toEqual([]);
    expect(malformed?.contextJson).toBeNull();
    expect(malformed?.integrityWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "matchedPatientIdsJson" }),
        expect.objectContaining({ field: "contextJson" }),
      ]),
    );

    const alerts = await prisma.userAlertInbox.findMany({
      where: {
        facilityId: ctx.facility.id,
        sourceId: { in: [`patientIdentityReview:${review.id}:matchedPatientIdsJson`, `patientIdentityReview:${review.id}:contextJson`] },
      },
    });
    expect(alerts).toHaveLength(2);
  });

  it("enforces encounter version bumps at the persistence layer for business-field updates", async () => {
    const ctx = await bootstrapCore();
    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-VERSION-TRIGGER-1",
        clinicId: ctx.clinic.id,
        providerId: ctx.provider.id,
        reasonForVisitId: ctx.reason.id,
        walkIn: true,
      },
    });
    expect(created.statusCode).toBe(200);
    const encounter = created.json();

    await expect(
      prisma.encounter.update({
        where: { id: encounter.id },
        data: {
          checkInAt: new Date(),
        },
      }),
    ).rejects.toMatchObject({
      code: "P2003",
    });
  });

  it("rejects stale rooming writes after the encounter version has advanced", async () => {
    const ctx = await bootstrapCore();
    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-ROOMING-CAS-1",
        clinicId: ctx.clinic.id,
        providerId: ctx.provider.id,
        reasonForVisitId: ctx.reason.id,
        walkIn: true,
      },
    });
    expect(created.statusCode).toBe(200);
    let encounter = created.json();

    const toRooming = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/status`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: {
        toStatus: "Rooming",
        version: encounter.version,
      },
    });
    expect(toRooming.statusCode).toBe(200);
    encounter = toRooming.json();

    const firstSave = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/rooming`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: {
        roomId: ctx.clinicRoomA.id,
        version: encounter.version,
        data: {
          allergiesChanged: "No",
          medicationReconciliationChanged: "No",
          labChanged: "No",
          pharmacyChanged: "No",
          "service.capture_items": [],
        },
      },
    });
    expect(firstSave.statusCode).toBe(200);

    const staleSave = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/rooming`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: {
        roomId: ctx.clinicRoomA.id,
        version: encounter.version,
        data: {
          allergiesChanged: "Yes",
        },
      },
    });
    expect(staleSave.statusCode).toBe(409);
    expect(staleSave.json()).toEqual(
      expect.objectContaining({
        code: "VERSION_MISMATCH",
      }),
    );
  });

  it("reports readiness with database and revenue sync worker state", async () => {
    await bootstrapCore();

    const response = await app.inject({
      method: "GET",
      url: "/ready",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        status: "ready",
        database: expect.objectContaining({ status: "ok" }),
        revenueSyncWorker: expect.objectContaining({
          running: expect.any(Boolean),
          pendingCount: expect.any(Number),
        }),
      }),
    );
  });

  it("accepts required intake yes/no fields when the value is explicitly No", async () => {
    const ctx = await bootstrapCore();

    const intakeTemplate = await prisma.template.create({
      data: {
        facilityId: ctx.facility.id,
        name: "Intake Default",
        status: "active",
        active: true,
        reasonForVisitId: ctx.reason.id,
        type: TemplateType.intake,
        fieldsJson: [
          {
            key: "financial.registration_demographics_verified",
            label: "Registration / Demographics Verified",
            type: "yesNo",
            required: true,
          },
          {
            key: "financial.estimate_explained_to_patient",
            label: "Estimate Explained",
            type: "yesNo",
            required: true,
          },
        ],
        jsonSchema: { type: "object" },
        uiSchema: {},
        requiredFields: [
          "financial.registration_demographics_verified",
          "financial.estimate_explained_to_patient",
        ],
      },
    });
    await prisma.templateReasonAssignment.create({
      data: {
        templateId: intakeTemplate.id,
        reasonId: ctx.reason.id,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-INTAKE-NO",
        clinicId: ctx.clinic.id,
        providerId: ctx.provider.id,
        reasonForVisitId: ctx.reason.id,
        walkIn: true,
        intakeData: {
          "financial.registration_demographics_verified": "No",
          "financial.estimate_explained_to_patient": false,
        },
      },
    });

    expect(response.statusCode).toBe(200);
  });

  it("returns 401 when request has no auth context", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/auth/context"
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns correlation and rate-limit headers", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        origin: "http://localhost:5173",
        "x-correlation-id": "corr-header-test"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-correlation-id"]).toBe("corr-header-test");
    expect(response.headers["x-ratelimit-limit"]).toBeDefined();
    expect(response.headers["x-ratelimit-remaining"]).toBeDefined();
  });

  it("authenticates via JWT bearer token and resolves scoped role", async () => {
    const ctx = await bootstrapCore();
    const headers = await jwtHeaders({
      sub: "sub-admin-test",
      email: ctx.admin.email,
      role: RoleName.Admin,
      facilityId: ctx.facility.id
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/context",
      headers
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      userId: ctx.admin.id,
      role: RoleName.Admin,
      facilityId: ctx.facility.id
    });
  });

  it("authenticates via Entra-style oid claim mapped through cognitoSub", async () => {
    const ctx = await bootstrapCore();
    await prisma.user.update({
      where: { id: ctx.admin.id },
      data: { cognitoSub: "entra-admin-oid-001" }
    });

    const headers = await jwtHeaders({
      subjectClaim: { key: "oid", value: "entra-admin-oid-001" },
      role: RoleName.Admin,
      facilityId: ctx.facility.id
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/context",
      headers
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      userId: ctx.admin.id,
      role: RoleName.Admin,
      facilityId: ctx.facility.id
    });
  });

  it("dispositions incoming row into an optimized encounter", async () => {
    const ctx = await bootstrapCore();

    const response = await app.inject({
      method: "POST",
      url: `/incoming/${ctx.incoming.id}/disposition`,
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        reason: "no_show",
        note: "Patient did not arrive"
      }
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.status).toBe("Optimized");

    const encounter = await prisma.encounter.findUnique({ where: { id: payload.encounterId } });
    expect(encounter?.currentStatus).toBe("Optimized");
    expect(encounter?.closureType).toBe("no_show");

    const incoming = await prisma.incomingSchedule.findUnique({ where: { id: ctx.incoming.id } });
    expect(incoming?.dispositionEncounterId).toBe(payload.encounterId);
  });

  it("captures audit and outbox records for mutating requests", async () => {
    const ctx = await bootstrapCore();
    const correlationId = "corr-audit-001";

    const response = await app.inject({
      method: "POST",
      url: `/incoming/${ctx.incoming.id}/disposition`,
      headers: {
        ...authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
        "x-correlation-id": correlationId
      },
      payload: {
        reason: "no_show",
        note: "Did not arrive"
      }
    });

    expect(response.statusCode).toBe(200);

    const audit = await prisma.auditLog.findFirst({
      where: { requestId: correlationId },
      orderBy: { occurredAt: "desc" }
    });
    expect(audit).toBeTruthy();
    expect(audit?.method).toBe("POST");
    expect(audit?.route).toBe("/incoming/:id/disposition");

    const outbox = await prisma.eventOutbox.findFirst({
      where: { requestId: correlationId },
      orderBy: { createdAt: "desc" }
    });
    expect(outbox).toBeTruthy();
    expect(outbox?.topic).toContain("incoming");
    expect(outbox?.status).toBe("dispatched");

    const outboxList = await app.inject({
      method: "GET",
      url: "/events/outbox",
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(outboxList.statusCode).toBe(200);
    expect(outboxList.json().length).toBeGreaterThan(0);
  });

  it("scopes audit log reads to the active facility and rejects out-of-scope facility filters", async () => {
    const ctx = await bootstrapCore();

    const secondaryFacility = await prisma.facility.create({
      data: {
        name: "Secondary Facility",
        shortCode: "SF",
        timezone: "America/New_York"
      }
    });
    const secondaryAdmin = await prisma.user.create({
      data: {
        email: "admin-secondary@test.local",
        name: "Secondary Admin",
        activeFacilityId: secondaryFacility.id
      }
    });
    await prisma.userRole.create({
      data: {
        userId: secondaryAdmin.id,
        role: RoleName.Admin,
        facilityId: secondaryFacility.id
      }
    });

    const firstRoom = await app.inject({
      method: "POST",
      url: "/admin/rooms",
      headers: {
        ...authHeaders(ctx.admin.id, RoleName.Admin),
        "x-facility-id": ctx.facility.id
      },
      payload: {
        facilityId: ctx.facility.id,
        name: "Primary Room",
        roomType: "exam"
      }
    });
    expect(firstRoom.statusCode).toBe(200);

    const secondRoom = await app.inject({
      method: "POST",
      url: "/admin/rooms",
      headers: {
        ...authHeaders(secondaryAdmin.id, RoleName.Admin),
        "x-facility-id": secondaryFacility.id
      },
      payload: {
        facilityId: secondaryFacility.id,
        name: "Secondary Room",
        roomType: "exam"
      }
    });
    expect(secondRoom.statusCode).toBe(200);

    const inScopeAudit = await app.inject({
      method: "GET",
      url: `/events/audit?facilityId=${ctx.facility.id}`,
      headers: {
        ...authHeaders(ctx.admin.id, RoleName.Admin),
        "x-facility-id": ctx.facility.id
      }
    });

    expect(inScopeAudit.statusCode).toBe(200);
    const inScopeRows = inScopeAudit.json();
    expect(inScopeRows.length).toBeGreaterThan(0);
    expect(inScopeRows.some((row: any) => row.facilityId === secondaryFacility.id)).toBe(false);

    const forbiddenAudit = await app.inject({
      method: "GET",
      url: `/events/audit?facilityId=${secondaryFacility.id}`,
      headers: {
        ...authHeaders(ctx.revenue.id, RoleName.RevenueCycle),
        "x-facility-id": ctx.facility.id
      }
    });

    expect(forbiddenAudit.statusCode).toBe(403);
  });

  it("enforces unique live room numbers per facility while allowing archived duplicates and appending restored rooms", async () => {
    const ctx = await bootstrapCore();
    const roomA = await prisma.clinicRoom.findFirstOrThrow({
      where: { facilityId: ctx.facility.id, roomNumber: 1 }
    });

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO ClinicRoom (id, facilityId, name, roomNumber, roomType, status, sortOrder)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        ctx.facility.id,
        "Duplicate Live Room",
        1,
        "exam",
        "active",
        99
      )
    ).rejects.toThrow();

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO ClinicRoom (id, facilityId, name, roomNumber, roomType, status, sortOrder)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        ctx.facility.id,
        "Archived Historical Room",
        1,
        "exam",
        "archived",
        100
      )
    ).resolves.toBe(1);

    await prisma.clinicRoom.update({
      where: { id: roomA.id },
      data: { status: "archived" }
    });

    const created = await app.inject({
      method: "POST",
      url: "/admin/rooms",
      headers: {
        ...authHeaders(ctx.admin.id, RoleName.Admin),
        "x-facility-id": ctx.facility.id
      },
      payload: {
        facilityId: ctx.facility.id,
        name: "New Live Room",
        roomType: "exam"
      }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().roomNumber).toBe(3);

    const restored = await app.inject({
      method: "POST",
      url: `/admin/rooms/${roomA.id}/restore`,
      headers: {
        ...authHeaders(ctx.admin.id, RoleName.Admin),
        "x-facility-id": ctx.facility.id
      }
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().roomNumber).toBe(4);

    const liveRooms = await prisma.clinicRoom.findMany({
      where: {
        facilityId: ctx.facility.id,
        status: { in: ["active", "inactive"] }
      },
      orderBy: { roomNumber: "asc" }
    });
    expect(liveRooms.map((room) => room.roomNumber)).toEqual([2, 3, 4]);
  });

  it("supports MA-run clinic check-in without provider and assigns MA from clinic mapping", async () => {
    const ctx = await bootstrapCore();

    const response = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-MA-RUN-1",
        clinicId: ctx.maRunClinic.id,
        reasonForVisitId: ctx.reasonMaRun.id,
        walkIn: true
      }
    });

    expect(response.statusCode).toBe(200);
    const encounter = response.json();
    expect(encounter.providerId).toBeNull();
    expect(encounter.assignedMaUserId).toBe(ctx.maTwo.id);
    expect(encounter.currentStatus).toBe("Lobby");
  });

  it("moves MA-run encounters from rooming directly to checkout", async () => {
    const ctx = await bootstrapCore();

    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-MA-RUN-ROOMING-1",
        clinicId: ctx.maRunClinic.id,
        reasonForVisitId: ctx.reasonMaRun.id,
        walkIn: true,
      },
    });
    expect(created.statusCode).toBe(200);
    let encounter = created.json();

    const toRooming = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/status`,
      headers: authHeaders(ctx.maTwo.id, RoleName.MA),
      payload: {
        toStatus: "Rooming",
        version: encounter.version,
      },
    });
    expect(toRooming.statusCode).toBe(200);
    encounter = toRooming.json();

    const saveRooming = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/rooming`,
      headers: authHeaders(ctx.maTwo.id, RoleName.MA),
      payload: {
        roomId: ctx.clinicRoomB.id,
        data: {
          allergiesChanged: "No",
          medicationReconciliationChanged: "No",
          labChanged: "No",
          pharmacyChanged: "No",
          "service.capture_items": [
            {
              id: "svc-ma-run-1",
              catalogItemId: "svc-flu-shot",
              label: "Flu Shot",
              sourceRole: "MA",
              quantity: 1,
              suggestedProcedureCode: "90471",
              detailSchemaKey: "vaccine",
              detailJson: {
                productServiceLabel: "Influenza vaccine",
                site: "Left deltoid",
                route: "IM",
                lotNumber: "LOT-123",
                expirationDate: "2026-12-31",
                dose: "0.5 mL",
              },
              detailComplete: true,
            },
          ],
        },
      },
    });
    expect(saveRooming.statusCode).toBe(200);
    encounter = saveRooming.json();

    const toReadyBlocked = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/status`,
      headers: authHeaders(ctx.maTwo.id, RoleName.MA),
      payload: {
        toStatus: "ReadyForProvider",
        version: encounter.version,
      },
    });
    expect(toReadyBlocked.statusCode).toBe(400);
    expect(toReadyBlocked.json().message).toContain("Invalid transition");

    const toCheckout = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/status`,
      headers: authHeaders(ctx.maTwo.id, RoleName.MA),
      payload: {
        toStatus: "CheckOut",
        version: encounter.version,
      },
    });
    expect(toCheckout.statusCode).toBe(200);
    expect(toCheckout.json()).toEqual(
      expect.objectContaining({
        currentStatus: "CheckOut",
        providerId: null,
        roomId: ctx.clinicRoomB.id,
      }),
    );
    expect(toCheckout.json().roomingCompleteAt).toBeTruthy();
    expect(toCheckout.json().providerEndAt).toBeTruthy();

    const roomState = await prisma.roomOperationalState.findUnique({
      where: { roomId: ctx.clinicRoomB.id },
    });
    expect(roomState?.currentStatus).toBe("NeedsTurnover");
    expect(roomState?.occupiedEncounterId).toBeNull();
  });

  it("returns office-manager dashboard aggregates", async () => {
    const ctx = await bootstrapCore();
    const date = ctx.day.toISOString().slice(0, 10);

    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-DASH-1",
        clinicId: ctx.clinic.id,
        incomingId: ctx.incoming.id
      }
    });
    expect(created.statusCode).toBe(200);

    const dashboard = await app.inject({
      method: "GET",
      url: `/dashboard/office-manager?clinicId=${ctx.clinic.id}&date=${date}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });

    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().queueByStatus.Lobby).toBeGreaterThanOrEqual(1);
  });

  it("returns office-manager historical rollups", async () => {
    const ctx = await bootstrapCore();
    const date = ctx.day.toISOString().slice(0, 10);

    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-HISTORY-1",
        clinicId: ctx.clinic.id,
        incomingId: ctx.incoming.id
      }
    });
    expect(created.statusCode).toBe(200);

    const history = await app.inject({
      method: "GET",
      url: `/dashboard/office-manager/history?clinicId=${ctx.clinic.id}&from=${date}&to=${date}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });

    expect(history.statusCode).toBe(200);
    const payload = history.json();
    expect(Array.isArray(payload.daily)).toBe(true);
    expect(payload.daily.length).toBe(1);
    expect(payload.daily[0].date).toBe(date);
    expect(payload.daily[0].encounterCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(payload.daily[0].providerRollups)).toBe(true);
    expect(Array.isArray(payload.daily[0].stageRollups)).toBe(true);

    const persisted = await prisma.officeManagerDailyRollup.findFirst({
      where: { clinicId: ctx.clinic.id, dateKey: date }
    });
    expect(persisted).toBeTruthy();

    const secondRead = await app.inject({
      method: "GET",
      url: `/dashboard/office-manager/history?clinicId=${ctx.clinic.id}&from=${date}&to=${date}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(secondRead.statusCode).toBe(200);
    expect(secondRead.json().daily[0].encounterCount).toBe(payload.daily[0].encounterCount);
  });

  it("returns persisted room daily history rollups", async () => {
    const ctx = await bootstrapCore();
    const date = DateTime.now().setZone("America/New_York").minus({ days: 1 }).toISODate()!;
    const at = (hour: number, minute: number) =>
      DateTime.fromISO(date, { zone: "America/New_York" }).plus({ hours: hour, minutes: minute }).toUTC().toJSDate();

    await prisma.roomChecklistRun.create({
      data: {
        roomId: ctx.clinicRoomA.id,
        clinicId: ctx.clinic.id,
        facilityId: ctx.facility.id,
        kind: "DayStart",
        dateKey: date,
        itemsJson: [{ key: "visual-ready", label: "Room visually ready", completed: true }],
        completed: true,
        completedAt: at(7, 55),
        completedByUserId: ctx.admin.id
      }
    });

    await prisma.roomOperationalEvent.createMany({
      data: [
        {
          roomId: ctx.clinicRoomA.id,
          clinicId: ctx.clinic.id,
          facilityId: ctx.facility.id,
          eventType: RoomEventType.MarkedReady,
          fromStatus: RoomOperationalStatus.NotReady,
          toStatus: RoomOperationalStatus.Ready,
          occurredAt: at(8, 0),
          createdByUserId: ctx.admin.id
        },
        {
          roomId: ctx.clinicRoomA.id,
          clinicId: ctx.clinic.id,
          facilityId: ctx.facility.id,
          eventType: RoomEventType.AssignedToEncounter,
          fromStatus: RoomOperationalStatus.Ready,
          toStatus: RoomOperationalStatus.Occupied,
          occurredAt: at(9, 0),
          createdByUserId: ctx.ma.id
        },
        {
          roomId: ctx.clinicRoomA.id,
          clinicId: ctx.clinic.id,
          facilityId: ctx.facility.id,
          eventType: RoomEventType.PatientLeftForCheckout,
          fromStatus: RoomOperationalStatus.Occupied,
          toStatus: RoomOperationalStatus.NeedsTurnover,
          occurredAt: at(9, 20),
          createdByUserId: ctx.clinician.id
        },
        {
          roomId: ctx.clinicRoomA.id,
          clinicId: ctx.clinic.id,
          facilityId: ctx.facility.id,
          eventType: RoomEventType.MarkedReady,
          fromStatus: RoomOperationalStatus.NeedsTurnover,
          toStatus: RoomOperationalStatus.Ready,
          occurredAt: at(9, 30),
          createdByUserId: ctx.ma.id
        }
      ]
    });

    await prisma.roomIssue.create({
      data: {
        roomId: ctx.clinicRoomA.id,
        clinicId: ctx.clinic.id,
        facilityId: ctx.facility.id,
        issueType: RoomIssueType.Equipment,
        status: RoomIssueStatus.Resolved,
        severity: 2,
        title: "BP cuff replacement",
        createdAt: at(8, 15),
        createdByUserId: ctx.ma.id,
        resolvedAt: at(8, 45),
        resolvedByUserId: ctx.officeManager.id,
        resolutionNote: "Replaced cuff."
      }
    });

    const history = await app.inject({
      method: "GET",
      url: `/dashboard/rooms/history?clinicId=${ctx.clinic.id}&from=${date}&to=${date}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });

    expect(history.statusCode).toBe(200);
    const payload = history.json();
    expect(payload.daily).toHaveLength(1);
    expect(payload.daily[0].roomCount).toBe(1);
    expect(payload.daily[0].dayStartCompletedCount).toBe(1);
    expect(payload.daily[0].turnoverCount).toBeGreaterThanOrEqual(1);
    expect(payload.daily[0].issueCount).toBe(1);
    expect(payload.daily[0].statusMinutes.Occupied).toBeGreaterThanOrEqual(20);
    expect(payload.daily[0].statusMinutes.NeedsTurnover).toBeGreaterThanOrEqual(10);

    const persisted = await prisma.roomDailyRollup.findFirst({
      where: { clinicId: ctx.clinic.id, dateKey: date }
    });
    expect(persisted).toBeTruthy();
  });

  it("enforces MA pre-rooming availability and room Ready state before assignment", async () => {
    const ctx = await bootstrapCore();
    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-ROOM-GATE-1",
        clinicId: ctx.clinic.id,
        reasonForVisitId: ctx.reason.id,
        walkIn: true
      }
    });
    expect(created.statusCode).toBe(200);
    const encounter = created.json();

    await prisma.roomOperationalState.update({
      where: { roomId: ctx.clinicRoomA.id },
      data: { currentStatus: "NeedsTurnover", statusSinceAt: new Date() }
    });

    const blocked = await app.inject({
      method: "POST",
      url: "/rooms/pre-rooming-check",
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: { encounterId: encounter.id }
    });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json()).toMatchObject({ blocked: true, readyCount: 0 });

    const rejectedAssignment = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/rooming`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: { roomId: ctx.clinicRoomA.id, data: { vitals: "done" } }
    });
    expect(rejectedAssignment.statusCode).toBe(409);

    await prisma.roomOperationalState.update({
      where: { roomId: ctx.clinicRoomA.id },
      data: { currentStatus: "Ready", statusSinceAt: new Date(), lastReadyAt: new Date() }
    });

    const oneReady = await app.inject({
      method: "POST",
      url: "/rooms/pre-rooming-check",
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: { encounterId: encounter.id }
    });
    expect(oneReady.statusCode).toBe(200);
    expect(oneReady.json()).toMatchObject({
      blocked: false,
      readyCount: 1,
      preferredRoomId: ctx.clinicRoomA.id,
      lastReadyRoom: true
    });

    const assigned = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/rooming`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: { roomId: ctx.clinicRoomA.id, data: { vitals: "done" } }
    });
    expect(assigned.statusCode).toBe(200);

    const roomState = await prisma.roomOperationalState.findUnique({ where: { roomId: ctx.clinicRoomA.id } });
    expect(roomState?.currentStatus).toBe("Occupied");
    expect(roomState?.occupiedEncounterId).toBe(encounter.id);
  });

  it("treats rooms without today's Day Start checklist as NotReady and blocks rooming", async () => {
    const ctx = await bootstrapCore();
    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-DAYSTART-GATE-1",
        clinicId: ctx.clinic.id,
        reasonForVisitId: ctx.reason.id,
        walkIn: true
      }
    });
    expect(created.statusCode).toBe(200);
    const encounter = created.json();

    await prisma.roomChecklistRun.deleteMany({
      where: { roomId: ctx.clinicRoomA.id, kind: "DayStart" }
    });
    await prisma.roomOperationalState.update({
      where: { roomId: ctx.clinicRoomA.id },
      data: { currentStatus: "Ready", statusSinceAt: new Date(), lastReadyAt: new Date() }
    });

    const live = await app.inject({
      method: "GET",
      url: "/rooms/live?mine=true",
      headers: authHeaders(ctx.ma.id, RoleName.MA)
    });
    expect(live.statusCode).toBe(200);
    const room = live.json().find((entry: { roomId: string }) => entry.roomId === ctx.clinicRoomA.id);
    expect(room).toMatchObject({
      operationalStatus: "NotReady",
      actualOperationalStatus: "Ready",
      assignable: false
    });

    const blocked = await app.inject({
      method: "POST",
      url: "/rooms/pre-rooming-check",
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: { encounterId: encounter.id }
    });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json()).toMatchObject({ blocked: true, readyCount: 0 });

    const rejectedAssignment = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/rooming`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: { roomId: ctx.clinicRoomA.id, data: { vitals: "done" } }
    });
    expect(rejectedAssignment.statusCode).toBe(409);
    expect(rejectedAssignment.json().message).toContain("Day Start");

    const dayStart = await app.inject({
      method: "POST",
      url: "/rooms/checklists/day-start",
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: {
        roomId: ctx.clinicRoomA.id,
        clinicId: ctx.clinic.id,
        completed: true,
        items: [{ key: "visual-ready", label: "Room visually ready", completed: true }]
      }
    });
    expect(dayStart.statusCode).toBe(200);

    const allowed = await app.inject({
      method: "POST",
      url: "/rooms/pre-rooming-check",
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: { encounterId: encounter.id }
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ blocked: false, readyCount: 1 });
  });

  it("grants and revokes time-bounded temporary MA clinic coverage", async () => {
    const ctx = await bootstrapCore();
    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-TEMP-COVERAGE-1",
        clinicId: ctx.maRunClinic.id,
        reasonForVisitId: ctx.reasonMaRun.id,
        walkIn: true
      }
    });
    expect(created.statusCode).toBe(200);
    const encounter = created.json();

    const deniedBefore = await app.inject({
      method: "GET",
      url: `/encounters/${encounter.id}`,
      headers: authHeaders(ctx.ma.id, RoleName.MA)
    });
    expect(deniedBefore.statusCode).toBe(403);

    const startsAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const endsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const override = await app.inject({
      method: "POST",
      url: "/admin/assignment-overrides",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        userId: ctx.ma.id,
        role: RoleName.MA,
        clinicId: ctx.maRunClinic.id,
        facilityId: ctx.facility.id,
        startsAt,
        endsAt,
        reason: "Lunch coverage"
      }
    });
    expect(override.statusCode).toBe(200);

    const visible = await app.inject({
      method: "GET",
      url: "/encounters?legacyArray=1",
      headers: authHeaders(ctx.ma.id, RoleName.MA)
    });
    expect(visible.statusCode).toBe(200);
    expect(visible.json().some((row: { id: string }) => row.id === encounter.id)).toBe(true);

    const allowedAfter = await app.inject({
      method: "GET",
      url: `/encounters/${encounter.id}`,
      headers: authHeaders(ctx.ma.id, RoleName.MA)
    });
    expect(allowedAfter.statusCode).toBe(200);

    const revoked = await app.inject({
      method: "POST",
      url: `/admin/assignment-overrides/${override.json().id}/revoke`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(revoked.statusCode).toBe(200);

    const deniedAfter = await app.inject({
      method: "GET",
      url: `/encounters/${encounter.id}`,
      headers: authHeaders(ctx.ma.id, RoleName.MA)
    });
    expect(deniedAfter.statusCode).toBe(403);
  });

  it("lists prior-day encounters for admin recovery and keeps optimized rows optional", async () => {
    const ctx = await bootstrapCore();
    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-ARCHIVE-RECOVERY-1",
        clinicId: ctx.clinic.id,
        reasonForVisitId: ctx.reason.id,
        walkIn: true
      }
    });
    expect(created.statusCode).toBe(200);
    const unresolvedEncounterId = created.json().id as string;
    const archivedDate = DateTime.now().setZone("America/New_York").minus({ days: 1 }).startOf("day").toUTC().toJSDate();

    await prisma.encounter.update({
      where: { id: unresolvedEncounterId },
      data: {
        dateOfService: archivedDate,
        currentStatus: "ReadyForProvider",
        version: { increment: 1 }
      }
    });

    const optimized = await prisma.encounter.create({
      data: {
        patientId: "PT-ARCHIVE-RECOVERY-2",
        clinicId: ctx.clinic.id,
        providerId: ctx.provider.id,
        reasonForVisitId: ctx.reason.id,
        currentStatus: "Optimized",
        dateOfService: archivedDate,
        closedAt: new Date(),
        version: 1,
      }
    });

    const defaultList = await app.inject({
      method: "GET",
      url: `/admin/encounters?facilityId=${ctx.facility.id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(defaultList.statusCode).toBe(200);
    const defaultRows = defaultList.json() as Array<{ id: string; needsRecovery: boolean; archivedForOperations: boolean }>;
    expect(defaultRows.some((row) => row.id === unresolvedEncounterId && row.needsRecovery && row.archivedForOperations)).toBe(true);
    expect(defaultRows.some((row) => row.id === optimized.id)).toBe(false);

    const allRows = await app.inject({
      method: "GET",
      url: `/admin/encounters?facilityId=${ctx.facility.id}&unresolvedOnly=false`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(allRows.statusCode).toBe(200);
    expect((allRows.json() as Array<{ id: string }>).some((row) => row.id === optimized.id)).toBe(true);
  });

  it("reassigns or clears archived encounter rooms and releases stale occupancy", async () => {
    const ctx = await bootstrapCore();
    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-ARCHIVE-ROOM-1",
        clinicId: ctx.clinic.id,
        reasonForVisitId: ctx.reason.id,
        walkIn: true
      }
    });
    expect(created.statusCode).toBe(200);
    const encounter = created.json();

    const initialAssignment = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/rooming`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: { roomId: ctx.clinicRoomA.id, data: { vitals: "done" } }
    });
    expect(initialAssignment.statusCode).toBe(200);

    const clinicRoomC = await prisma.clinicRoom.create({
      data: {
        facilityId: ctx.facility.id,
        name: "Room 3",
        roomNumber: 3,
        roomType: "exam",
        status: "active",
        sortOrder: 3
      }
    });
    await prisma.clinicRoomAssignment.create({
      data: {
        clinicId: ctx.clinic.id,
        roomId: clinicRoomC.id,
        active: true
      }
    });
    await prisma.roomOperationalState.create({
      data: {
        roomId: clinicRoomC.id,
        currentStatus: "Ready",
        lastReadyAt: new Date()
      }
    });
    await prisma.roomChecklistRun.create({
      data: {
        roomId: clinicRoomC.id,
        clinicId: ctx.clinic.id,
        facilityId: ctx.facility.id,
        kind: "DayStart",
        dateKey: DateTime.now().setZone("America/New_York").toISODate()!,
        itemsJson: [{ key: "visual-ready", label: "Room visually ready", completed: true }],
        completed: true,
        completedAt: new Date(),
        completedByUserId: ctx.admin.id
      }
    });

    const reassigned = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/rooming`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: { roomId: clinicRoomC.id }
    });
    expect(reassigned.statusCode).toBe(200);

    const roomAStateAfterReassign = await prisma.roomOperationalState.findUnique({
      where: { roomId: ctx.clinicRoomA.id }
    });
    const roomCStateAfterReassign = await prisma.roomOperationalState.findUnique({
      where: { roomId: clinicRoomC.id }
    });
    expect(roomAStateAfterReassign?.currentStatus).toBe("NeedsTurnover");
    expect(roomCStateAfterReassign?.currentStatus).toBe("Occupied");
    expect(roomCStateAfterReassign?.occupiedEncounterId).toBe(encounter.id);

    const cleared = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/rooming`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: { roomId: null }
    });
    expect(cleared.statusCode).toBe(200);

    const clearedEncounter = await prisma.encounter.findUnique({
      where: { id: encounter.id }
    });
    const roomCStateAfterClear = await prisma.roomOperationalState.findUnique({
      where: { roomId: clinicRoomC.id }
    });
    expect(clearedEncounter?.roomId).toBeNull();
    expect(roomCStateAfterClear?.currentStatus).toBe("NeedsTurnover");
    expect(roomCStateAfterClear?.occupiedEncounterId).toBeNull();
  });

  it("moves an occupied room to NeedsTurnover when the encounter enters CheckOut", async () => {
    const ctx = await bootstrapCore();
    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-ROOM-DIRTY-1",
        clinicId: ctx.clinic.id,
        reasonForVisitId: ctx.reason.id,
        walkIn: true
      }
    });
    expect(created.statusCode).toBe(200);
    let encounter = created.json();

    const roomed = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/rooming`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: {
        roomId: ctx.clinicRoomA.id,
        data: {
          vitals: "done",
          allergiesChanged: "No",
          medicationReconciliationChanged: "No",
          labChanged: "No",
          pharmacyChanged: "No",
          "service.capture_items": [
            {
              id: "svc-turnover-1",
              catalogItemId: "svc-venipuncture",
              label: "Venipuncture",
              sourceRole: "MA",
              quantity: 1,
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
      }
    });
    expect(roomed.statusCode).toBe(200);
    encounter = roomed.json();

    let advanced = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/status`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: { toStatus: "Rooming", version: encounter.version }
    });
    expect(advanced.statusCode).toBe(200);
    encounter = advanced.json();

    advanced = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/status`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: { toStatus: "ReadyForProvider", version: encounter.version }
    });
    expect(advanced.statusCode).toBe(200);
    encounter = advanced.json();

    advanced = await app.inject({
      method: "POST",
      url: `/encounters/${encounter.id}/visit/start`,
      headers: authHeaders(ctx.clinician.id, RoleName.Clinician),
      payload: { version: encounter.version }
    });
    expect(advanced.statusCode).toBe(200);
    encounter = advanced.json();

    advanced = await app.inject({
      method: "POST",
      url: `/encounters/${encounter.id}/visit/end`,
      headers: authHeaders(ctx.clinician.id, RoleName.Clinician),
      payload: {
        version: encounter.version,
        data: {
          assessment: "stable",
          "coding.working_diagnosis_codes_text": "J01.90",
          "coding.working_procedure_codes_text": "99213",
        },
      }
    });
    expect(advanced.statusCode).toBe(200);

    const roomState = await prisma.roomOperationalState.findUnique({ where: { roomId: ctx.clinicRoomA.id } });
    expect(roomState?.currentStatus).toBe("NeedsTurnover");
    expect(roomState?.occupiedEncounterId).toBeNull();
  });

  it("creates OfficeManager room tasks and inbox alerts from room issues", async () => {
    const ctx = await bootstrapCore();

    const response = await app.inject({
      method: "POST",
      url: `/rooms/${ctx.clinicRoomA.id}/issues`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: {
        clinicId: ctx.clinic.id,
        issueType: "Equipment",
        severity: 3,
        title: "Exam light is flickering",
        description: "Room should be held until the light is repaired.",
        placesRoomOnHold: true
      }
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.issue.taskId).toBe(payload.task.id);
    expect(payload.task.assignedToRole).toBe(RoleName.OfficeManager);
    expect(payload.task.roomId).toBe(ctx.clinicRoomA.id);

    const state = await prisma.roomOperationalState.findUnique({ where: { roomId: ctx.clinicRoomA.id } });
    expect(state?.currentStatus).toBe("Hold");

    const alert = await prisma.userAlertInbox.findFirst({
      where: {
        userId: ctx.officeManager.id,
        sourceId: payload.task.id,
        kind: "task"
      }
    });
    expect(alert).toBeTruthy();

    const auditRow = await prisma.auditLog.findFirst({
      where: { route: "/rooms/:id/issues", entityType: "RoomIssue", entityId: payload.issue.id },
    });
    expect(auditRow).toBeTruthy();

    const outboxRow = await prisma.eventOutbox.findFirst({
      where: { aggregateType: "RoomIssue", aggregateId: payload.issue.id, status: "dispatched" },
    });
    expect(outboxRow).toBeTruthy();
  });

  it("persists committed audit and outbox rows for room actions and checklists", async () => {
    const ctx = await bootstrapCore();

    const dayStart = await app.inject({
      method: "POST",
      url: "/rooms/checklists/day-start",
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: {
        roomId: ctx.clinicRoomA.id,
        clinicId: ctx.clinic.id,
        completed: true,
        items: [{ key: "visual-ready", label: "Room visually ready", completed: true }]
      }
    });
    expect(dayStart.statusCode).toBe(200);

    const markedReady = await app.inject({
      method: "POST",
      url: `/rooms/${ctx.clinicRoomA.id}/actions/mark-ready`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: { clinicId: ctx.clinic.id, note: "Turnover complete" }
    });
    expect(markedReady.statusCode).toBe(200);

    const placedHold = await app.inject({
      method: "POST",
      url: `/rooms/${ctx.clinicRoomA.id}/actions/place-hold`,
      headers: authHeaders(ctx.officeManager.id, RoleName.OfficeManager),
      payload: { clinicId: ctx.clinic.id, reason: "Manual", note: "Cleaning inspection" }
    });
    expect(placedHold.statusCode).toBe(200);

    const clearedHold = await app.inject({
      method: "POST",
      url: `/rooms/${ctx.clinicRoomA.id}/actions/clear-hold`,
      headers: authHeaders(ctx.officeManager.id, RoleName.OfficeManager),
      payload: { clinicId: ctx.clinic.id, targetStatus: "Ready", note: "Inspection complete" }
    });
    expect(clearedHold.statusCode).toBe(200);

    const checklistAudit = await prisma.auditLog.findFirst({
      where: { route: "/rooms/checklists/day-start", entityType: "RoomChecklistRun", entityId: dayStart.json().id },
    });
    expect(checklistAudit).toBeTruthy();

    const roomAudits = await prisma.auditLog.findMany({
      where: {
        entityType: "Room",
        entityId: ctx.clinicRoomA.id,
        route: { in: ["/rooms/:id/actions/mark-ready", "/rooms/:id/actions/place-hold", "/rooms/:id/actions/clear-hold"] },
      },
    });
    expect(roomAudits).toHaveLength(3);

    const checklistOutbox = await prisma.eventOutbox.findFirst({
      where: { aggregateType: "RoomChecklistRun", aggregateId: dayStart.json().id, status: "dispatched" },
    });
    expect(checklistOutbox).toBeTruthy();

    const roomOutboxRows = await prisma.eventOutbox.findMany({
      where: {
        aggregateType: "Room",
        aggregateId: ctx.clinicRoomA.id,
        status: "dispatched",
        eventType: {
          in: [
            "post.api.rooms.id.actions.mark-ready",
            "post.api.rooms.id.actions.place-hold",
            "post.api.rooms.id.actions.clear-hold",
          ],
        },
      },
    });
    expect(roomOutboxRows).toHaveLength(3);
  });

  it("returns revenue-cycle dashboard aggregates", async () => {
    const ctx = await bootstrapCore();
    const date = ctx.day.toISOString().slice(0, 10);

    const disposition = await app.inject({
      method: "POST",
      url: `/incoming/${ctx.incoming.id}/disposition`,
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        reason: "no_show",
        note: "No show"
      }
    });
    expect(disposition.statusCode).toBe(200);

    const dashboard = await app.inject({
      method: "GET",
      url: `/dashboard/revenue-cycle?clinicId=${ctx.clinic.id}&from=${date}&to=${date}`,
      headers: authHeaders(ctx.revenue.id, RoleName.RevenueCycle)
    });

    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json()).toEqual(
      expect.objectContaining({
        kpis: expect.objectContaining({
          sameDayCollectionExpectedVisitCount: expect.any(Number),
          sameDayCollectionCapturedVisitCount: expect.any(Number),
          sameDayCollectionExpectedCents: expect.any(Number),
          sameDayCollectionCapturedCents: expect.any(Number),
          sameDayCollectionVisitRate: expect.any(Number),
          sameDayCollectionDollarRate: expect.any(Number),
          expectedGrossChargeCents: expect.any(Number),
          expectedNetReimbursementCents: expect.any(Number),
          averageFlowHandoffLagHours: expect.any(Number),
          athenaDaysToSubmit: null,
          athenaDaysInAR: null
        }),
        settings: expect.objectContaining({
          missedCollectionReasons: expect.any(Array),
          providerQueryTemplates: expect.any(Array),
          athenaLinkTemplate: expect.any(String),
          estimateDefaults: expect.any(Object),
          reimbursementRules: expect.any(Array),
        }),
        queueCounts: expect.any(Object),
      })
    );
    expect(dashboard.json().cases).toBeUndefined();
  });

  it("allows admin to assign a facility room to another clinic", async () => {
    const ctx = await bootstrapCore();

    const anotherClinic = await prisma.clinic.create({
      data: {
        facilityId: ctx.facility.id,
        name: "Room Move Clinic",
        shortCode: "RMC",
        timezone: ctx.clinic.timezone
      }
    });

    const room = await prisma.clinicRoom.create({
      data: {
        facilityId: ctx.facility.id,
        name: "Moveable Room",
        roomNumber: 11,
        roomType: "exam",
        status: "active",
        sortOrder: 11
      }
    });

    const response = await app.inject({
      method: "POST",
      url: `/admin/clinics/${anotherClinic.id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        roomIds: [room.id]
      }
    });

    expect(response.statusCode).toBe(200);
    const assignment = await prisma.clinicRoomAssignment.findFirst({
      where: { clinicId: anotherClinic.id, roomId: room.id, active: true }
    });
    expect(assignment).toBeTruthy();
  });

  it("returns clinic assignment impact when suspending a user", async () => {
    const ctx = await bootstrapCore();

    const response = await app.inject({
      method: "POST",
      url: `/admin/users/${ctx.clinician.id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        status: "suspended"
      }
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.status).toBe("suspended");
    expect(payload.impact.impactedClinicCount).toBeGreaterThanOrEqual(1);
    expect(payload.impact.clinics.some((clinic: { clinicId: string }) => clinic.clinicId === ctx.clinic.id)).toBe(true);
    expect(payload.impact.clinics.some((clinic: { clinicId: string; isOperational: boolean }) => clinic.clinicId === ctx.clinic.id && clinic.isOperational === false)).toBe(true);
  });

  it("archives provider attribution when deleting a suspended clinician user", async () => {
    const ctx = await bootstrapCore();
    const date = ctx.day.toISOString().slice(0, 10);

    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-ARCHIVE-PROVIDER-1",
        clinicId: ctx.clinic.id,
        incomingId: ctx.incoming.id
      }
    });
    expect(created.statusCode).toBe(200);

    const suspended = await app.inject({
      method: "POST",
      url: `/admin/users/${ctx.clinician.id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        status: "suspended"
      }
    });
    expect(suspended.statusCode).toBe(200);

    const archived = await app.inject({
      method: "DELETE",
      url: `/admin/users/${ctx.clinician.id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().status).toBe("archived");

    const provider = await prisma.provider.findUnique({ where: { id: ctx.provider.id } });
    expect(provider?.active).toBe(false);
    expect(provider?.name).toContain("(Archived)");

    const list = await app.inject({
      method: "GET",
      url: `/encounters?legacyArray=1&clinicId=${ctx.clinic.id}&date=${date}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(list.statusCode).toBe(200);
    const row = list.json().find((encounter: { id: string }) => encounter.id === created.json().id);
    expect(row.providerName).toContain("(Archived)");
  });

  it("returns encounter view-model aliases for frontend contract compatibility", async () => {
    const ctx = await bootstrapCore();
    const date = ctx.day.toISOString().slice(0, 10);

    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-ALIAS-1",
        clinicId: ctx.clinic.id,
        incomingId: ctx.incoming.id
      }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().status).toBe("Lobby");

    const list = await app.inject({
      method: "GET",
      url: `/encounters?legacyArray=1&clinicId=${ctx.clinic.id}&date=${date}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });

    expect(list.statusCode).toBe(200);
    const first = list.json()[0];
    expect(first.status).toBe(first.currentStatus);
    expect(first.providerName).toBeTruthy();
    expect(first.reasonForVisit).toBeTruthy();
  });

  it("returns paginated encounter envelopes when requested", async () => {
    const ctx = await bootstrapCore();
    const date = ctx.day.toISOString().slice(0, 10);

    for (const patientId of ["PT-PAGE-ENCOUNTER-1", "PT-PAGE-ENCOUNTER-2", "PT-PAGE-ENCOUNTER-3"]) {
      const created = await app.inject({
        method: "POST",
        url: "/encounters",
        headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
        payload: {
          patientId,
          clinicId: ctx.clinic.id,
          providerId: ctx.provider.id,
          reasonForVisitId: ctx.reason.id,
          walkIn: true,
        },
      });
      expect(created.statusCode).toBe(200);
    }

    const firstPage = await app.inject({
      method: "GET",
      url: `/encounters?clinicId=${ctx.clinic.id}&date=${date}&pageSize=2`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
    });

    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json()).toEqual(
      expect.objectContaining({
        items: expect.any(Array),
        nextCursor: expect.any(String),
        pageSize: 2,
      }),
    );
    expect(firstPage.json().items).toHaveLength(2);

    const secondPage = await app.inject({
      method: "GET",
      url: `/encounters?clinicId=${ctx.clinic.id}&date=${date}&pageSize=2&cursor=${encodeURIComponent(firstPage.json().nextCursor)}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
    });

    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json().items).toHaveLength(1);
    expect(secondPage.json().nextCursor).toBeNull();
    expect(new Set([...firstPage.json().items, ...secondPage.json().items].map((row: { id: string }) => row.id)).size).toBe(3);
  });

  it("accepts cancel DTO aliases closureType and closureNotes", async () => {
    const ctx = await bootstrapCore();

    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-CANCEL-ALIAS-1",
        clinicId: ctx.clinic.id,
        providerId: ctx.provider.id,
        reasonForVisitId: ctx.reason.id,
        walkIn: true
      }
    });
    expect(created.statusCode).toBe(200);

    const cancel = await app.inject({
      method: "POST",
      url: `/encounters/${created.json().id}/cancel`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        version: created.json().version,
        closureType: "no_show",
        closureNotes: "Mapped from alias payload"
      }
    });

    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe("Optimized");
    expect(cancel.json().closureType).toBe("no_show");
    expect(cancel.json().closureNotes).toContain("alias");
  });

  it("handles multi-clinic date scoping across clinic timezones", async () => {
    const ctx = await bootstrapCore();
    const reportDate = "2026-01-15";

    const westClinic = await prisma.clinic.create({
      data: {
        facilityId: ctx.facility.id,
        name: "West Coast Clinic",
        shortCode: "WC",
        timezone: "America/Los_Angeles",
        maRun: false
      }
    });

    await prisma.provider.create({
      data: {
        clinicId: westClinic.id,
        name: "Dr. West",
        active: true
      }
    });

    const westRoom = await prisma.clinicRoom.create({
      data: {
        facilityId: ctx.facility.id,
        name: "Room A",
        roomNumber: 21,
        roomType: "exam",
        status: "active",
        sortOrder: 1
      }
    });
    await prisma.clinicRoomAssignment.create({
      data: {
        clinicId: westClinic.id,
        roomId: westRoom.id,
        active: true
      }
    });

    await prisma.encounter.createMany({
      data: [
        {
          patientId: "TZ-EAST-1",
          clinicId: ctx.clinic.id,
          currentStatus: "Lobby",
          dateOfService: new Date("2026-01-15T05:00:00.000Z")
        },
        {
          patientId: "TZ-WEST-1",
          clinicId: westClinic.id,
          currentStatus: "Lobby",
          dateOfService: new Date("2026-01-15T08:00:00.000Z")
        }
      ]
    });

    const dashboard = await app.inject({
      method: "GET",
      url: `/dashboard/office-manager?date=${reportDate}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });

    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().queueByStatus.Lobby).toBeGreaterThanOrEqual(2);
  });

  it(
    "imports high-volume incoming rows without relation drift",
    async () => {
      const ctx = await bootstrapCore();
      const rowCount = 250;
      const importDay = new Date(ctx.day.getTime() + 24 * 60 * 60 * 1000);
      const date = importDay.toISOString().slice(0, 10);
      const header = "patientId,appointmentTime,providerLastName,reasonForVisit";
      const rows = Array.from({ length: rowCount }, (_, index) => {
        const minutes = String((index % 12) * 5).padStart(2, "0");
        return `HV-${index + 1},09:${minutes},A,Follow-up`;
      });
      const csvText = `${header}\n${rows.join("\n")}`;

      const imported = await app.inject({
        method: "POST",
        url: "/incoming/import",
        headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
        payload: {
          clinicId: ctx.clinic.id,
          dateOfService: date,
          csvText,
          source: "csv",
          fileName: "high-volume.csv"
        }
      });

      expect(imported.statusCode).toBe(200);
      expect(imported.json().acceptedCount).toBe(rowCount);
      expect(imported.json().pendingCount).toBe(0);

      const totalRows = await prisma.incomingSchedule.count({
        where: { clinicId: ctx.clinic.id, patientId: { startsWith: "HV-" } }
      });

      expect(totalRows).toBe(rowCount);
    },
    20000
  );

  it("imports CSV rows with spaced headers and clinic short-name values into accepted + pending buckets", async () => {
    const ctx = await bootstrapCore();
    const importDay = new Date(ctx.day.getTime() + 24 * 60 * 60 * 1000);
    const date = importDay.toISOString().slice(0, 10);
    const csvText = [
      "Clinic Short Name,Patient ID,Appointment Time,Provider Last Name,Reason",
      `${ctx.clinic.shortCode},PT-CSV-OK-1,09:00,A,Follow-up`,
      `${ctx.clinic.shortCode},PT-CSV-MISSING-TIME,,A,Follow-up`,
      `${ctx.clinic.shortCode},PT-CSV-BAD-REASON,09:15,A,NotAConfiguredReason`
    ].join("\n");

    const imported = await app.inject({
      method: "POST",
      url: "/incoming/import",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        dateOfService: date,
        csvText,
        source: "csv",
        fileName: "spaced-headers.csv"
      }
    });

    expect(imported.statusCode).toBe(200);
    expect(imported.json().acceptedCount).toBe(1);
    expect(imported.json().pendingCount).toBe(2);

    const accepted = await prisma.incomingSchedule.findMany({
      where: {
        clinicId: ctx.clinic.id,
        patientId: "PT-CSV-OK-1"
      }
    });
    expect(accepted.length).toBeGreaterThan(0);

    const pendingIssues = await prisma.incomingImportIssue.findMany({
      where: {
        facilityId: ctx.facility.id
      }
    });
    expect(pendingIssues.length).toBeGreaterThanOrEqual(2);
  });

  it("returns stripped clinician surnames and clinic aliases in incoming reference data", async () => {
    const ctx = await bootstrapCore();
    await prisma.user.update({
      where: { id: ctx.clinician.id },
      data: { name: "Jordan Smith, NP" }
    });

    const response = await app.inject({
      method: "GET",
      url: `/incoming/reference?facilityId=${ctx.facility.id}&clinicId=${ctx.clinic.id}`,
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn)
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.samples.providerLastNames).toContain("smith");
    expect(payload.samples.providerLastNames).not.toContain("np");
    expect(
      payload.samples.clinics.some((clinic: any) =>
        Array.isArray(clinic.aliases) && clinic.aliases.includes(`${ctx.clinic.name} (${ctx.clinic.shortCode})`)
      )
    ).toBe(true);
  });

  it("accepts row-level future appointment dates and moves past-dated rows into pending review", async () => {
    const ctx = await bootstrapCore();
    await prisma.user.update({
      where: { id: ctx.clinician.id },
      data: { name: "Jordan Smith, NP" }
    });

    const tomorrow = new Date(ctx.day.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const yesterday = new Date(ctx.day.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const today = DateTime.now().setZone("America/New_York").toISODate();
    const csvText = [
      "clinic,patientId,appointmentDate,appointmentTime,providerLastName,reasonForVisit",
      `${ctx.clinic.name} (${ctx.clinic.shortCode}),PT-FUTURE-1,${tomorrow},09:00,"Smith, NP",Follow-up`,
      `${ctx.clinic.shortCode},PT-PAST-1,${yesterday},09:15,Smith,Follow-up`,
      `${ctx.clinic.shortCode},PT-SAME-DAY-PAST,${today},00:00,Smith,Follow-up`,
    ].join("\n");

    const imported = await app.inject({
      method: "POST",
      url: "/incoming/import",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        facilityId: ctx.facility.id,
        csvText,
        source: "csv",
        fileName: "dated-import.csv"
      }
    });

    expect(imported.statusCode).toBe(200);
    expect(imported.json().acceptedCount).toBe(1);
    expect(imported.json().pendingCount).toBe(2);

    const accepted = await prisma.incomingSchedule.findFirst({
      where: { patientId: "PT-FUTURE-1" }
    });
    expect(accepted).toBeTruthy();
    expect(accepted?.dateOfService.toISOString().slice(0, 10)).toBe(tomorrow);
    expect(accepted?.providerLastName).toBe("Smith");

    const pendingRows = await prisma.incomingImportIssue.findMany({
      where: { facilityId: ctx.facility.id, rawPayloadJson: { not: null } },
      orderBy: { createdAt: "desc" }
    });
    expect(pendingRows.length).toBeGreaterThanOrEqual(2);
    expect(
      pendingRows.some(
        (pending) =>
          Array.isArray(pending.validationErrors) &&
          (pending.validationErrors as string[]).some((entry) => entry.toLowerCase().includes("future")),
      ),
    ).toBe(true);
  });

  it("paginates pending review rows by default and preserves legacy array access", async () => {
    const ctx = await bootstrapCore();
    const created = await Promise.all(
      Array.from({ length: 3 }).map((_, index) =>
        prisma.incomingImportIssue.create({
          data: {
            batchId: ctx.incoming.importBatchId!,
            facilityId: ctx.facility.id,
            clinicId: ctx.clinic.id,
            dateOfService: ctx.day,
            rawPayloadJson: {
              patientId: `PT-PENDING-${index + 1}`,
            } as Prisma.InputJsonValue,
            normalizedJson: {
              patientId: `PT-PENDING-${index + 1}`,
              clinicId: ctx.clinic.id,
              dateOfService: ctx.day.toISOString().slice(0, 10),
            } as Prisma.InputJsonValue,
            validationErrors: ["Provider is required"],
            status: "pending",
          },
        }),
      ),
    );

    const firstPage = await app.inject({
      method: "GET",
      url: `/incoming/pending?facilityId=${ctx.facility.id}&clinicId=${ctx.clinic.id}&date=${ctx.day.toISOString().slice(0, 10)}&pageSize=2`,
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().items).toHaveLength(2);
    expect(firstPage.json().nextCursor).toEqual(expect.any(String));

    const secondPage = await app.inject({
      method: "GET",
      url: `/incoming/pending?facilityId=${ctx.facility.id}&clinicId=${ctx.clinic.id}&date=${ctx.day.toISOString().slice(0, 10)}&pageSize=2&cursor=${encodeURIComponent(firstPage.json().nextCursor)}`,
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
    });
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json().items).toHaveLength(1);
    expect(created.map((issue) => issue.id)).toContain(secondPage.json().items[0].id);

    const legacy = await app.inject({
      method: "GET",
      url: `/incoming/pending?facilityId=${ctx.facility.id}&clinicId=${ctx.clinic.id}&date=${ctx.day.toISOString().slice(0, 10)}&legacyArray=1`,
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
    });
    expect(legacy.statusCode).toBe(200);
    expect(Array.isArray(legacy.json())).toBe(true);
    expect(legacy.json().length).toBeGreaterThanOrEqual(3);
  });

  it("rejects incoming imports with no data rows instead of reporting zero accepted rows", async () => {
    const ctx = await bootstrapCore();
    const importDay = new Date(ctx.day.getTime() + 24 * 60 * 60 * 1000);
    const date = importDay.toISOString().slice(0, 10);

    const imported = await app.inject({
      method: "POST",
      url: "/incoming/import",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        clinicId: ctx.clinic.id,
        dateOfService: date,
        csvText: "patientId,appointmentTime,providerLastName,reasonForVisit\n",
        source: "csv",
        fileName: "headers-only.csv"
      }
    });

    expect(imported.statusCode).toBe(400);
    expect(imported.json().message).toContain("No schedule data rows");
  });

  it("enforces required template fields before status transitions", async () => {
    const ctx = await bootstrapCore();
    const clinicRoomAssignment = await prisma.clinicRoomAssignment.findFirst({
      where: { clinicId: ctx.clinic.id, active: true },
      select: { roomId: true },
      orderBy: { createdAt: "asc" },
    });
    expect(clinicRoomAssignment?.roomId).toBeTruthy();

    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-REQ-1",
        clinicId: ctx.clinic.id,
        providerId: ctx.provider.id,
        reasonForVisitId: ctx.reason.id,
        walkIn: true
      }
    });

    const encounter = created.json();

    const toRooming = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/status`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: {
        toStatus: "Rooming",
        version: encounter.version
      }
    });
    expect(toRooming.statusCode).toBe(200);

    const toReadyBlocked = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/status`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: {
        toStatus: "ReadyForProvider",
        version: encounter.version + 1
      }
    });
    expect(toReadyBlocked.statusCode).toBe(400);
    expect(toReadyBlocked.json().message).toContain("Required fields missing");

    const roomingDataSaved = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/rooming`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: {
        roomId: clinicRoomAssignment!.roomId,
        data: {
          vitals: "120/80",
          allergiesChanged: "No",
          medicationReconciliationChanged: "No",
          labChanged: "No",
          pharmacyChanged: "No",
          "service.capture_items": [
            {
              id: "svc-rooming-1",
              catalogItemId: "svc-venipuncture",
              label: "Venipuncture",
              sourceRole: "MA",
              quantity: 1,
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
        }
      }
    });
    expect(roomingDataSaved.statusCode).toBe(200);
    const roomingVersion = roomingDataSaved.json().version;
    expect(roomingDataSaved.json()).toEqual(
      expect.objectContaining({
        providerId: ctx.provider.id,
        providerName: ctx.provider.name,
        roomId: clinicRoomAssignment!.roomId,
      }),
    );

    const toReady = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/status`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: {
        toStatus: "ReadyForProvider",
        version: roomingVersion
      }
    });
    expect(toReady.statusCode).toBe(200);
    expect(toReady.json()).toEqual(
      expect.objectContaining({
        currentStatus: "ReadyForProvider",
        providerId: ctx.provider.id,
        providerName: ctx.provider.name,
        roomId: clinicRoomAssignment!.roomId,
      }),
    );

    const syncedRevenueCase = await prisma.revenueCase.findUnique({
      where: { encounterId: encounter.id },
      include: { chargeCaptureRecord: true },
    });
    expect(syncedRevenueCase).toBeTruthy();
    expect(syncedRevenueCase?.chargeCaptureRecord?.serviceCaptureItemsJson).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Venipuncture",
          detailSchemaKey: "specimen_collection",
          detailComplete: true,
        }),
      ]),
    );
  });

  it("blocks rooming completion when standard MA rooming requirements are missing", async () => {
    const ctx = await bootstrapCore();

    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-ROOM-REQ-1",
        clinicId: ctx.clinic.id,
        providerId: ctx.provider.id,
        reasonForVisitId: ctx.reason.id,
        walkIn: true,
      },
    });
    expect(created.statusCode).toBe(200);
    const encounter = created.json();

    const toRooming = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/status`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: {
        toStatus: "Rooming",
        version: encounter.version,
      },
    });
    expect(toRooming.statusCode).toBe(200);

    const roomingDataSaved = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/rooming`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: {
        data: {
          vitals: "120/80",
        },
      },
    });
    expect(roomingDataSaved.statusCode).toBe(200);
    const roomingVersion = roomingDataSaved.json().version;

    const toReadyBlocked = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/status`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: {
        toStatus: "ReadyForProvider",
        version: roomingVersion,
      },
    });
    expect(toReadyBlocked.statusCode).toBe(400);
    expect(toReadyBlocked.json().message).toContain("Rooming requirements missing");
    expect(toReadyBlocked.json().message).toContain("room assignment");
    expect(toReadyBlocked.json().message).toContain("service capture");
    expect(toReadyBlocked.json().message).toContain("allergiesChanged");
  });

  it("blocks clinician checkout when diagnosis and procedure codes are missing or invalid", async () => {
    const ctx = await bootstrapCore();

    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-CODE-GATE-1",
        clinicId: ctx.clinic.id,
        providerId: ctx.provider.id,
        reasonForVisitId: ctx.reason.id,
        walkIn: true,
      },
    });
    expect(created.statusCode).toBe(200);
    let encounter = created.json();

    const toRooming = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/status`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: {
        toStatus: "Rooming",
        version: encounter.version,
      },
    });
    expect(toRooming.statusCode).toBe(200);
    encounter = toRooming.json();

    const saveRooming = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/rooming`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: {
        roomId: ctx.clinicRoomA.id,
        data: {
          vitals: "120/80",
          allergiesChanged: "No",
          medicationReconciliationChanged: "No",
          labChanged: "No",
          pharmacyChanged: "No",
          "service.capture_items": [
            {
              id: "svc-test-2",
              catalogItemId: "svc-venipuncture",
              label: "Venipuncture",
              sourceRole: "MA",
              quantity: 1,
              suggestedProcedureCode: "36415",
              expectedChargeCents: 1800,
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
      },
    });
    expect(saveRooming.statusCode).toBe(200);
    encounter = saveRooming.json();

    const toReady = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/status`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: {
        toStatus: "ReadyForProvider",
        version: encounter.version,
      },
    });
    expect(toReady.statusCode).toBe(200);
    encounter = toReady.json();

    const startVisit = await app.inject({
      method: "POST",
      url: `/encounters/${encounter.id}/visit/start`,
      headers: authHeaders(ctx.clinician.id, RoleName.Clinician),
      payload: {
        version: encounter.version,
      },
    });
    expect(startVisit.statusCode).toBe(200);
    encounter = startVisit.json();

    const missingCodes = await app.inject({
      method: "POST",
      url: `/encounters/${encounter.id}/visit/end`,
      headers: authHeaders(ctx.clinician.id, RoleName.Clinician),
      payload: {
        version: encounter.version,
        data: {
          assessment: "Visit complete",
          "documentation.chief_concern_summary": "Follow-up visit review",
          "documentation.assessment_summary": "Assessment documented for revenue handoff.",
          "documentation.plan_follow_up": "Plan documented and follow-up instructions provided.",
          "documentation.orders_or_procedures": "Orders and performed procedures documented.",
        },
      },
    });
    expect(missingCodes.statusCode).toBe(400);
    expect(missingCodes.json().message).toContain("ICD-10 diagnosis code");

    const invalidCodes = await app.inject({
      method: "POST",
      url: `/encounters/${encounter.id}/visit/end`,
      headers: authHeaders(ctx.clinician.id, RoleName.Clinician),
      payload: {
        version: encounter.version,
        data: {
          assessment: "Visit complete",
          "coding.working_diagnosis_codes_text": "FOLLOW UP",
          "coding.working_procedure_codes_text": "OFFICE VISIT",
          "documentation.chief_concern_summary": "Follow-up visit review",
          "documentation.assessment_summary": "Assessment documented for revenue handoff.",
          "documentation.plan_follow_up": "Plan documented and follow-up instructions provided.",
          "documentation.orders_or_procedures": "Orders and performed procedures documented.",
        },
      },
    });
    expect(invalidCodes.statusCode).toBe(400);
    expect(invalidCodes.json().message).toContain("real ICD-10 format");
  });

  it("persists active facility context and scopes admin data to the selected facility", async () => {
    const ctx = await bootstrapCore();

    const baselineRoom = await prisma.clinicRoom.findFirst({
      where: { facilityId: ctx.facility.id },
      select: { id: true }
    });
    expect(baselineRoom).toBeTruthy();

    const secondFacility = await prisma.facility.create({
      data: {
        name: "Second Facility",
        shortCode: "SF",
        timezone: "America/New_York"
      }
    });
    const secondClinic = await prisma.clinic.create({
      data: {
        facilityId: secondFacility.id,
        name: "Second Clinic",
        shortCode: "SC",
        timezone: "America/New_York",
        maRun: false
      }
    });
    const secondRoom = await prisma.clinicRoom.create({
      data: {
        facilityId: secondFacility.id,
        name: "Second Room",
        roomNumber: 31,
        roomType: "exam",
        status: "active",
        sortOrder: 31
      }
    });
    await prisma.clinicRoomAssignment.create({
      data: {
        clinicId: secondClinic.id,
        roomId: secondRoom.id,
        active: true
      }
    });

    const contextBefore = await app.inject({
      method: "GET",
      url: "/auth/context",
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(contextBefore.statusCode).toBe(200);
    expect(contextBefore.json().activeFacilityId).toBe(ctx.facility.id);

    const switchFacility = await app.inject({
      method: "POST",
      url: "/auth/context/facility",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        facilityId: secondFacility.id
      }
    });
    expect(switchFacility.statusCode).toBe(200);
    expect(switchFacility.json().activeFacilityId).toBe(secondFacility.id);

    const scopedRooms = await app.inject({
      method: "GET",
      url: "/admin/rooms?includeInactive=true&includeArchived=true",
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(scopedRooms.statusCode).toBe(200);
    const roomIds = scopedRooms.json().map((room: { id: string }) => room.id);
    expect(roomIds).toContain(secondRoom.id);
    expect(roomIds).not.toContain(baselineRoom!.id);

    const scopedClinics = await app.inject({
      method: "GET",
      url: "/admin/clinics?includeInactive=true&includeArchived=true",
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(scopedClinics.statusCode).toBe(200);
    const clinicIds = scopedClinics.json().map((clinic: { id: string }) => clinic.id);
    expect(clinicIds).toContain(secondClinic.id);
    expect(clinicIds).not.toContain(ctx.clinic.id);

    const persistedUser = await prisma.user.findUnique({ where: { id: ctx.admin.id } });
    expect(persistedUser?.activeFacilityId).toBe(secondFacility.id);
  });

  it("limits non-admin facility scope and allows switching only within assigned facilities", async () => {
    const ctx = await bootstrapCore();

    const unassignedFacility = await prisma.facility.create({
      data: {
        name: "Unassigned Facility",
        shortCode: "UF",
        timezone: "America/New_York"
      }
    });

    const visibleBefore = await app.inject({
      method: "GET",
      url: "/admin/facilities",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn)
    });
    expect(visibleBefore.statusCode).toBe(200);
    expect(visibleBefore.json().map((row: { id: string }) => row.id)).toEqual([ctx.facility.id]);

    const denied = await app.inject({
      method: "POST",
      url: "/auth/context/facility",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        facilityId: unassignedFacility.id
      }
    });
    expect(denied.statusCode).toBe(403);

    await prisma.userRole.create({
      data: {
        userId: ctx.checkin.id,
        role: RoleName.FrontDeskCheckIn,
        facilityId: unassignedFacility.id
      }
    });

    const visibleAfter = await app.inject({
      method: "GET",
      url: "/admin/facilities",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn)
    });
    expect(visibleAfter.statusCode).toBe(200);
    const visibleIds = visibleAfter.json().map((row: { id: string }) => row.id).sort();
    expect(visibleIds).toEqual([ctx.facility.id, unassignedFacility.id].sort());

    const switched = await app.inject({
      method: "POST",
      url: "/auth/context/facility",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        facilityId: unassignedFacility.id
      }
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json().activeFacilityId).toBe(unassignedFacility.id);
  });

  it("enforces selected-facility scope on encounter list/read/update flows", async () => {
    const ctx = await bootstrapCore();
    const date = ctx.day.toISOString().slice(0, 10);

    const secondFacility = await prisma.facility.create({
      data: {
        name: "Encounter Scope Facility",
        shortCode: "ESF",
        timezone: "America/New_York"
      }
    });
    const secondClinic = await prisma.clinic.create({
      data: {
        facilityId: secondFacility.id,
        name: "Encounter Scope Clinic",
        shortCode: "ESC",
        timezone: "America/New_York",
        maRun: false
      }
    });
    const secondProvider = await prisma.provider.create({
      data: {
        clinicId: secondClinic.id,
        name: "Dr. Scoped",
        active: true
      }
    });
    const secondReason = await prisma.reasonForVisit.create({
      data: {
        clinicId: secondClinic.id,
        facilityId: secondFacility.id,
        name: "Scoped Follow-up",
        active: true
      }
    });
    const secondEncounter = await prisma.encounter.create({
      data: {
        patientId: "PT-SCOPE-ENCOUNTER-1",
        clinicId: secondClinic.id,
        providerId: secondProvider.id,
        reasonForVisitId: secondReason.id,
        currentStatus: "Lobby",
        dateOfService: ctx.day,
        checkInAt: new Date()
      }
    });

    const listPrimaryFacility = await app.inject({
      method: "GET",
      url: `/encounters?legacyArray=1&date=${date}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(listPrimaryFacility.statusCode).toBe(200);
    expect(listPrimaryFacility.json().some((row: { id: string }) => row.id === secondEncounter.id)).toBe(false);

    const readDenied = await app.inject({
      method: "GET",
      url: `/encounters/${secondEncounter.id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(readDenied.statusCode).toBe(403);

    const updateDenied = await app.inject({
      method: "PATCH",
      url: `/encounters/${secondEncounter.id}/status`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        toStatus: "Rooming",
        version: secondEncounter.version
      }
    });
    expect(updateDenied.statusCode).toBe(403);

    const switchFacility = await app.inject({
      method: "POST",
      url: "/auth/context/facility",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        facilityId: secondFacility.id
      }
    });
    expect(switchFacility.statusCode).toBe(200);

    const readAllowed = await app.inject({
      method: "GET",
      url: `/encounters/${secondEncounter.id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(readAllowed.statusCode).toBe(200);
    expect(readAllowed.json().id).toBe(secondEncounter.id);
  });

  it("enforces facility scope on incoming list/import/update and blocks inactive clinic intake associations", async () => {
    const ctx = await bootstrapCore();
    const date = ctx.day.toISOString().slice(0, 10);

    const secondFacility = await prisma.facility.create({
      data: {
        name: "Incoming Scope Facility",
        shortCode: "ISF",
        timezone: "America/New_York"
      }
    });
    const secondClinic = await prisma.clinic.create({
      data: {
        facilityId: secondFacility.id,
        name: "Incoming Scope Clinic",
        shortCode: "ISC",
        timezone: "America/New_York",
        maRun: false
      }
    });
    const secondProvider = await prisma.provider.create({
      data: {
        clinicId: secondClinic.id,
        name: "Dr. Incoming",
        active: true
      }
    });
    const secondReason = await prisma.reasonForVisit.create({
      data: {
        clinicId: secondClinic.id,
        facilityId: secondFacility.id,
        name: "Incoming Follow-up",
        active: true
      }
    });
    const secondBatch = await prisma.incomingImportBatch.create({
      data: {
        facilityId: secondFacility.id,
        clinicId: secondClinic.id,
        date: ctx.day,
        source: "csv",
        rowCount: 1,
        fileName: "scope.csv"
      }
    });
    const secondIncoming = await prisma.incomingSchedule.create({
      data: {
        clinicId: secondClinic.id,
        dateOfService: ctx.day,
        patientId: "PT-INCOMING-SCOPE-1",
        appointmentTime: "10:00",
        appointmentAt: new Date(Date.UTC(ctx.day.getUTCFullYear(), ctx.day.getUTCMonth(), ctx.day.getUTCDate(), 15, 0, 0)),
        providerId: secondProvider.id,
        providerLastName: "Incoming",
        reasonForVisitId: secondReason.id,
        reasonText: secondReason.name,
        source: "csv",
        rawPayloadJson: { source: "scope-test" },
        isValid: true,
        importBatchId: secondBatch.id
      }
    });

    const listPrimaryFacility = await app.inject({
      method: "GET",
      url: `/incoming?legacyArray=1&date=${date}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(listPrimaryFacility.statusCode).toBe(200);
    expect(listPrimaryFacility.json().some((row: { id: string }) => row.id === secondIncoming.id)).toBe(false);

    const intakeDenied = await app.inject({
      method: "POST",
      url: `/incoming/${secondIncoming.id}/intake`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        intakeData: { note: "should fail out of scope" }
      }
    });
    expect(intakeDenied.statusCode).toBe(403);

    const outOfScopeImport = await app.inject({
      method: "POST",
      url: "/incoming/import",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        clinicId: secondClinic.id,
        dateOfService: date,
        csvText: "patientId,appointmentTime,providerLastName,reasonForVisit\nPT-XYZ,09:00,A,Follow-up",
        source: "csv",
        fileName: "out-of-scope.csv"
      }
    });
    expect(outOfScopeImport.statusCode).toBe(403);

    await prisma.clinic.update({
      where: { id: ctx.clinic.id },
      data: { status: "inactive" }
    });

    const inactiveImport = await app.inject({
      method: "POST",
      url: "/incoming/import",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        clinicId: ctx.clinic.id,
        dateOfService: date,
        csvText: "patientId,appointmentTime,providerLastName,reasonForVisit\nPT-INACTIVE,09:00,A,Follow-up",
        source: "csv",
        fileName: "inactive.csv"
      }
    });
    expect(inactiveImport.statusCode).toBe(400);
    expect(inactiveImport.json().message).toContain("inactive");

    const inactiveCheckIn = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-INACTIVE-CHECKIN",
        clinicId: ctx.clinic.id,
        providerId: ctx.provider.id,
        reasonForVisitId: ctx.reason.id,
        walkIn: true
      }
    });
    expect(inactiveCheckIn.statusCode).toBe(400);
    expect(inactiveCheckIn.json().message).toContain("inactive");
  });

  it("archives referenced rooms and restores them with prior clinic links", async () => {
    const ctx = await bootstrapCore();
    const assignment = await prisma.clinicRoomAssignment.findFirst({
      where: { clinicId: ctx.clinic.id, active: true }
    });
    expect(assignment).toBeTruthy();

    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-ROOM-ARCH-1",
        clinicId: ctx.clinic.id,
        providerId: ctx.provider.id,
        reasonForVisitId: ctx.reason.id,
        walkIn: true
      }
    });
    expect(created.statusCode).toBe(200);

    const rooming = await app.inject({
      method: "PATCH",
      url: `/encounters/${created.json().id}/rooming`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        roomId: assignment!.roomId
      }
    });
    expect(rooming.statusCode).toBe(200);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/admin/rooms/${assignment!.roomId}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().status).toBe("archived");

    const archivedRoom = await prisma.clinicRoom.findUnique({ where: { id: assignment!.roomId } });
    expect(archivedRoom?.status).toBe("archived");
    const archivedLink = await prisma.clinicRoomAssignment.findUnique({
      where: {
        clinicId_roomId: {
          clinicId: ctx.clinic.id,
          roomId: assignment!.roomId
        }
      }
    });
    expect(archivedLink?.active).toBe(false);

    const restored = await app.inject({
      method: "POST",
      url: `/admin/rooms/${assignment!.roomId}/restore`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().status).toBe("active");

    const restoredLink = await prisma.clinicRoomAssignment.findUnique({
      where: {
        clinicId_roomId: {
          clinicId: ctx.clinic.id,
          roomId: assignment!.roomId
        }
      }
    });
    expect(restoredLink?.active).toBe(true);
  });

  it("returns paginated incoming envelopes when requested", async () => {
    const ctx = await bootstrapCore();
    const date = ctx.day.toISOString().slice(0, 10);
    const batch = await prisma.incomingImportBatch.findFirstOrThrow({
      where: { clinicId: ctx.clinic.id },
      orderBy: { createdAt: "asc" },
    });

    for (const [patientId, hour] of [
      ["PT-INCOMING-PAGE-1", 15],
      ["PT-INCOMING-PAGE-2", 16],
    ] as const) {
      await prisma.incomingSchedule.create({
        data: {
          clinicId: ctx.clinic.id,
          dateOfService: ctx.day,
          patientId,
          appointmentTime: `${String(hour - 5).padStart(2, "0")}:00`,
          appointmentAt: new Date(Date.UTC(ctx.day.getUTCFullYear(), ctx.day.getUTCMonth(), ctx.day.getUTCDate(), hour, 0, 0)),
          providerId: ctx.provider.id,
          providerLastName: "A",
          reasonForVisitId: ctx.reason.id,
          reasonText: ctx.reason.name,
          source: "csv",
          rawPayloadJson: { source: "pagination-test" },
          isValid: true,
          importBatchId: batch.id,
        },
      });
    }

    const firstPage = await app.inject({
      method: "GET",
      url: `/incoming?clinicId=${ctx.clinic.id}&date=${date}&pageSize=2`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
    });

    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().items).toHaveLength(2);
    expect(firstPage.json().pageSize).toBe(2);
    expect(firstPage.json().nextCursor).toEqual(expect.any(String));

    const secondPage = await app.inject({
      method: "GET",
      url: `/incoming?clinicId=${ctx.clinic.id}&date=${date}&pageSize=2&cursor=${encodeURIComponent(firstPage.json().nextCursor)}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
    });

    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json().items).toHaveLength(1);
    expect(secondPage.json().nextCursor).toBeNull();
  });

  it("paginates deduped incoming envelopes across raw batch boundaries", async () => {
    const ctx = await bootstrapCore();
    const date = ctx.day.toISOString().slice(0, 10);
    const batch = await prisma.incomingImportBatch.findFirstOrThrow({
      where: { clinicId: ctx.clinic.id },
      orderBy: { createdAt: "asc" },
    });

    await prisma.incomingSchedule.createMany({
      data: [
        ...Array.from({ length: 101 }, (_, index) => ({
          clinicId: ctx.clinic.id,
          dateOfService: ctx.day,
          patientId: "PT-INCOMING-DUPE",
          appointmentTime: "09:00",
          appointmentAt: new Date(Date.UTC(ctx.day.getUTCFullYear(), ctx.day.getUTCMonth(), ctx.day.getUTCDate(), 14, 0, index)),
          providerId: ctx.provider.id,
          providerLastName: "A",
          reasonForVisitId: ctx.reason.id,
          reasonText: ctx.reason.name,
          source: ScheduleSource.csv,
          rawPayloadJson: { source: "pagination-dedupe-test", index },
          isValid: true,
          importBatchId: batch.id,
        })),
        {
          clinicId: ctx.clinic.id,
          dateOfService: ctx.day,
          patientId: "PT-INCOMING-NEXT",
          appointmentTime: "10:00",
          appointmentAt: new Date(Date.UTC(ctx.day.getUTCFullYear(), ctx.day.getUTCMonth(), ctx.day.getUTCDate(), 15, 0, 0)),
          providerId: ctx.provider.id,
          providerLastName: "A",
          reasonForVisitId: ctx.reason.id,
          reasonText: ctx.reason.name,
          source: ScheduleSource.csv,
          rawPayloadJson: { source: "pagination-dedupe-test", index: 102 },
          isValid: true,
          importBatchId: batch.id,
        },
        {
          clinicId: ctx.clinic.id,
          dateOfService: ctx.day,
          patientId: "PT-INCOMING-LAST",
          appointmentTime: "11:00",
          appointmentAt: new Date(Date.UTC(ctx.day.getUTCFullYear(), ctx.day.getUTCMonth(), ctx.day.getUTCDate(), 16, 0, 0)),
          providerId: ctx.provider.id,
          providerLastName: "A",
          reasonForVisitId: ctx.reason.id,
          reasonText: ctx.reason.name,
          source: ScheduleSource.csv,
          rawPayloadJson: { source: "pagination-dedupe-test", index: 103 },
          isValid: true,
          importBatchId: batch.id,
        },
      ],
    });

    const firstPage = await app.inject({
      method: "GET",
      url: `/incoming?clinicId=${ctx.clinic.id}&date=${date}&pageSize=3`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
    });

    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().items.map((item: { patientId: string }) => item.patientId)).toEqual([
      "PT-100",
      "PT-INCOMING-DUPE",
      "PT-INCOMING-NEXT",
    ]);
    expect(firstPage.json().nextCursor).toEqual(expect.any(String));

    const secondPage = await app.inject({
      method: "GET",
      url: `/incoming?clinicId=${ctx.clinic.id}&date=${date}&pageSize=3&cursor=${encodeURIComponent(firstPage.json().nextCursor)}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
    });

    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json().items.map((item: { patientId: string }) => item.patientId)).toEqual([
      "PT-INCOMING-LAST",
    ]);
    expect(secondPage.json().nextCursor).toBeNull();
  });

  it("hard deletes unreferenced rooms and removes assignments", async () => {
    const ctx = await bootstrapCore();
    const room = await prisma.clinicRoom.create({
      data: {
        facilityId: ctx.facility.id,
        name: "Disposable Room",
        roomNumber: 44,
        roomType: "exam",
        status: "active",
        sortOrder: 44
      }
    });
    await prisma.clinicRoomAssignment.create({
      data: {
        clinicId: ctx.clinic.id,
        roomId: room.id,
        active: true
      }
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/admin/rooms/${room.id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().status).toBe("deleted");

    const roomAfter = await prisma.clinicRoom.findUnique({ where: { id: room.id } });
    expect(roomAfter).toBeNull();
    const linksAfter = await prisma.clinicRoomAssignment.findMany({
      where: { roomId: room.id }
    });
    expect(linksAfter).toHaveLength(0);
  });

  it("auto-assigns room numbers sequentially and blocks manual room-number edits", async () => {
    const ctx = await bootstrapCore();

    const firstCreate = await app.inject({
      method: "POST",
      url: "/admin/rooms",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        facilityId: ctx.facility.id,
        name: "Unique Room",
        roomType: "Exam"
      }
    });
    expect(firstCreate.statusCode).toBe(200);
    expect(firstCreate.json().roomType).toBe("exam");
    expect(firstCreate.json().roomNumber).toBeGreaterThan(0);

    const secondCreate = await app.inject({
      method: "POST",
      url: "/admin/rooms",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        facilityId: ctx.facility.id,
        name: "Second Room",
        roomType: "exam"
      }
    });
    expect(secondCreate.statusCode).toBe(200);
    expect(secondCreate.json().roomNumber).toBe(firstCreate.json().roomNumber + 1);

    const manualUpdate = await app.inject({
      method: "POST",
      url: `/admin/rooms/${secondCreate.json().id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        roomNumber: firstCreate.json().roomNumber
      }
    });
    expect(manualUpdate.statusCode).toBe(400);
    expect(manualUpdate.json().message).toContain("system-managed");
  });

  it("archives referenced clinics and restores them with prior room links", async () => {
    const ctx = await bootstrapCore();

    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-CLINIC-ARCH-1",
        clinicId: ctx.clinic.id,
        providerId: ctx.provider.id,
        reasonForVisitId: ctx.reason.id,
        walkIn: true
      }
    });
    expect(created.statusCode).toBe(200);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/admin/clinics/${ctx.clinic.id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().status).toBe("archived");

    const archivedClinic = await prisma.clinic.findUnique({ where: { id: ctx.clinic.id } });
    expect(archivedClinic?.status).toBe("archived");
    const archivedLinks = await prisma.clinicRoomAssignment.findMany({
      where: { clinicId: ctx.clinic.id }
    });
    expect(archivedLinks.length).toBeGreaterThan(0);
    expect(archivedLinks.every((row) => row.active === false)).toBe(true);

    const restored = await app.inject({
      method: "POST",
      url: `/admin/clinics/${ctx.clinic.id}/restore`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().status).toBe("active");

    const restoredLinks = await prisma.clinicRoomAssignment.findMany({
      where: { clinicId: ctx.clinic.id }
    });
    expect(restoredLinks.every((row) => row.active === true)).toBe(true);
  });

  it("hard deletes clinics with no encounter history and removes room assignments", async () => {
    const ctx = await bootstrapCore();
    const deletableClinic = await prisma.clinic.create({
      data: {
        facilityId: ctx.facility.id,
        name: "Deletable Clinic",
        shortCode: "DEL",
        timezone: ctx.clinic.timezone,
        maRun: false
      }
    });

    const room = await prisma.clinicRoom.create({
      data: {
        facilityId: ctx.facility.id,
        name: "Deletable Clinic Room",
        roomNumber: 55,
        roomType: "exam",
        status: "active",
        sortOrder: 55
      }
    });

    await prisma.clinicRoomAssignment.create({
      data: {
        clinicId: deletableClinic.id,
        roomId: room.id,
        active: true
      }
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/admin/clinics/${deletableClinic.id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().status).toBe("deleted");

    const clinicAfter = await prisma.clinic.findUnique({
      where: { id: deletableClinic.id }
    });
    expect(clinicAfter).toBeNull();
    const assignmentAfter = await prisma.clinicRoomAssignment.findMany({
      where: { clinicId: deletableClinic.id }
    });
    expect(assignmentAfter).toHaveLength(0);
  });

  it("hard deletes clinics with legacy MA mapping rows", async () => {
    const ctx = await bootstrapCore();
    const deletableClinic = await prisma.clinic.create({
      data: {
        facilityId: ctx.facility.id,
        name: "Legacy Mapping Clinic",
        shortCode: "LMC",
        timezone: ctx.clinic.timezone,
        maRun: false
      }
    });
    const provider = await prisma.provider.create({
      data: {
        clinicId: deletableClinic.id,
        name: "Legacy Provider",
        active: true
      }
    });
    await prisma.maProviderMap.create({
      data: {
        providerId: provider.id,
        maUserId: ctx.ma.id,
        clinicId: deletableClinic.id
      }
    });
    await prisma.maClinicMap.create({
      data: {
        clinicId: deletableClinic.id,
        maUserId: ctx.ma.id
      }
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/admin/clinics/${deletableClinic.id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().status).toBe("deleted");

    const clinicAfter = await prisma.clinic.findUnique({
      where: { id: deletableClinic.id }
    });
    expect(clinicAfter).toBeNull();
  });

  it("requires explicit clinic run model on clinic create", async () => {
    const ctx = await bootstrapCore();

    const missingRunModel = await app.inject({
      method: "POST",
      url: "/admin/clinics",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        facilityId: ctx.facility.id,
        name: "Missing Run Model",
        shortCode: "MRM",
        timezone: ctx.clinic.timezone
      }
    });
    expect(missingRunModel.statusCode).toBe(400);
    expect(missingRunModel.json().message).toContain("run model");
  });

  it("enforces unique role assignment for the same scope", async () => {
    const ctx = await bootstrapCore();

    const duplicateRoleFirst = await app.inject({
      method: "POST",
      url: `/admin/users/${ctx.ma.id}/roles`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        role: "MA",
        clinicId: ctx.clinic.id
      }
    });
    expect(duplicateRoleFirst.statusCode).toBe(200);

    const duplicateRoleSecond = await app.inject({
      method: "POST",
      url: `/admin/users/${ctx.ma.id}/roles`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        role: "MA",
        clinicId: ctx.clinic.id
      }
    });
    expect(duplicateRoleSecond.statusCode).toBe(200);

    const roles = await prisma.userRole.findMany({
      where: { userId: ctx.ma.id, role: RoleName.MA }
    });
    expect(roles).toHaveLength(1);
  });

  it("updates active facility when assigning a new facility-scoped role", async () => {
    const ctx = await bootstrapCore();

    const secondFacility = await prisma.facility.create({
      data: {
        name: "North Facility",
        shortCode: "NF",
        timezone: "America/New_York",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/admin/users/${ctx.ma.id}/roles`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        role: RoleName.MA,
        facilityId: secondFacility.id,
      },
    });

    expect(response.statusCode).toBe(200);

    const updatedUser = await prisma.user.findUniqueOrThrow({
      where: { id: ctx.ma.id },
    });
    expect(updatedUser.activeFacilityId).toBe(secondFacility.id);

    const updatedRole = await prisma.userRole.findFirst({
      where: {
        userId: ctx.ma.id,
        role: RoleName.MA,
        facilityId: secondFacility.id,
      },
    });
    expect(updatedRole).not.toBeNull();
  });

  it("replaces other facility-scoped roles for the same quick-assigned role", async () => {
    const ctx = await bootstrapCore();

    await prisma.userRole.create({
      data: {
        userId: ctx.ma.id,
        role: RoleName.MA,
        facilityId: ctx.facility.id,
      },
    });

    const secondFacility = await prisma.facility.create({
      data: {
        name: "Replacement Facility",
        shortCode: "RF",
        timezone: "America/New_York",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/admin/users/${ctx.ma.id}/roles`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        role: RoleName.MA,
        facilityId: secondFacility.id,
      },
    });

    expect(response.statusCode).toBe(200);

    const facilityScopedRoles = await prisma.userRole.findMany({
      where: {
        userId: ctx.ma.id,
        role: RoleName.MA,
        clinicId: null,
      },
      orderBy: { facilityId: "asc" },
    });

    expect(facilityScopedRoles).toHaveLength(1);
    expect(facilityScopedRoles[0]?.facilityId).toBe(secondFacility.id);

    const clinicScopedRole = await prisma.userRole.findFirst({
      where: {
        userId: ctx.ma.id,
        role: RoleName.MA,
        clinicId: ctx.clinic.id,
      },
    });
    expect(clinicScopedRole).not.toBeNull();
  });

  it("falls back to the remaining facility when a scoped role is removed", async () => {
    const ctx = await bootstrapCore();

    const secondFacility = await prisma.facility.create({
      data: {
        name: "South Facility",
        shortCode: "SF",
        timezone: "America/New_York",
      },
    });

    await prisma.userRole.create({
      data: {
        userId: ctx.ma.id,
        role: RoleName.MA,
        facilityId: secondFacility.id,
      },
    });
    await prisma.user.update({
      where: { id: ctx.ma.id },
      data: { activeFacilityId: secondFacility.id },
    });

    const response = await app.inject({
      method: "POST",
      url: `/admin/users/${ctx.ma.id}/roles/remove`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        role: RoleName.MA,
        facilityId: secondFacility.id,
      },
    });

    expect(response.statusCode).toBe(200);

    const updatedUser = await prisma.user.findUniqueOrThrow({
      where: { id: ctx.ma.id },
    });
    expect(updatedUser.activeFacilityId).toBe(ctx.facility.id);
  });

  it("creates users with one role assigned across multiple facilities", async () => {
    const ctx = await bootstrapCore();

    const secondFacility = await prisma.facility.create({
      data: {
        name: "Second User Facility",
        shortCode: "SUF",
        timezone: "America/New_York"
      }
    });

    const created = await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        name: "Multi Facility User",
        email: "multi.facility@test.local",
        role: "FrontDeskCheckIn",
        facilityIds: [ctx.facility.id, secondFacility.id],
        phone: "555-0101"
      }
    });

    expect(created.statusCode).toBe(200);
    const body = created.json();
    expect(body.email).toBe("multi.facility@test.local");
    expect(body.activeFacilityId).toBe(ctx.facility.id);

    const createdUserRoles = await prisma.userRole.findMany({
      where: {
        userId: body.id,
        role: RoleName.FrontDeskCheckIn
      }
    });
    const assignedFacilityIds = createdUserRoles
      .map((entry) => entry.facilityId)
      .filter((entry): entry is string => Boolean(entry))
      .sort();
    expect(assignedFacilityIds).toEqual([ctx.facility.id, secondFacility.id].sort());
  });

  it("ignores legacy cognito-subject input when creating local users", async () => {
    const ctx = await bootstrapCore();

    const created = await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        name: "Legacy Subject User",
        email: "legacy.subject@test.local",
        role: "FrontDeskCheckIn",
        facilityIds: [ctx.facility.id],
        cognitoSub: "legacy-manual-subject",
      },
    });

    expect(created.statusCode).toBe(200);
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: created.json().id },
    });
    expect(stored.cognitoSub).toBeNull();
  });

  it("blocks suspended user authentication and archives suspended users on delete", async () => {
    const ctx = await bootstrapCore();

    const suspended = await app.inject({
      method: "POST",
      url: `/admin/users/${ctx.ma.id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        status: "suspended"
      }
    });
    expect(suspended.statusCode).toBe(200);

    const authDenied = await app.inject({
      method: "GET",
      url: "/auth/context",
      headers: authHeaders(ctx.ma.id, RoleName.MA)
    });
    expect(authDenied.statusCode).toBe(401);

    const archived = await app.inject({
      method: "DELETE",
      url: `/admin/users/${ctx.ma.id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().status).toBe("archived");

    const archivedUser = await prisma.user.findUnique({
      where: { id: ctx.ma.id }
    });
    expect(archivedUser?.status).toBe("archived");
    expect(archivedUser?.name).toContain("(Archived)");

    const listedUsers = await app.inject({
      method: "GET",
      url: `/admin/users?facilityId=${ctx.facility.id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(listedUsers.statusCode).toBe(200);
    expect(listedUsers.json().some((user: { id: string }) => user.id === ctx.ma.id)).toBe(false);
  });

  it("allows non-admin operational roles to read facility-scoped clinic assignments", async () => {
    const ctx = await bootstrapCore();

    const response = await app.inject({
      method: "GET",
      url: `/admin/assignments?facilityId=${ctx.facility.id}`,
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn)
    });

    expect(response.statusCode).toBe(200);
    const rows = response.json() as Array<{ clinicId: string; maUserId: string | null }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.clinicId === ctx.clinic.id && row.maUserId === ctx.ma.id)).toBe(true);
  });

  it("validates encounter reassignments using clinic assignments", async () => {
    const ctx = await bootstrapCore();
    const date = ctx.day.toISOString().slice(0, 10);

    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-ASSIGN-VALIDATION-1",
        clinicId: ctx.clinic.id,
        incomingId: ctx.incoming.id
      }
    });
    expect(created.statusCode).toBe(200);
    const encounter = created.json() as { id: string; version: number };

    const alternateProvider = await prisma.provider.create({
      data: {
        clinicId: ctx.clinic.id,
        name: "Dr. Alternate",
        active: true
      }
    });

    const invalidProvider = await app.inject({
      method: "POST",
      url: `/encounters/${encounter.id}/assign`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        providerId: alternateProvider.id,
        version: encounter.version
      }
    });
    expect(invalidProvider.statusCode).toBe(400);
    expect(invalidProvider.json().message).toContain("assigned provider");

    const invalidMa = await app.inject({
      method: "POST",
      url: `/encounters/${encounter.id}/assign`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        assignedMaUserId: ctx.maTwo.id,
        version: encounter.version
      }
    });
    expect(invalidMa.statusCode).toBe(400);
    expect(invalidMa.json().message).toContain("not assigned to this clinic");

    const validMa = await app.inject({
      method: "POST",
      url: `/encounters/${encounter.id}/assign`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        assignedMaUserId: ctx.ma.id,
        version: encounter.version
      }
    });
    expect(validMa.statusCode).toBe(200);
    expect(validMa.json().assignedMaUserId).toBe(ctx.ma.id);

    const list = await app.inject({
      method: "GET",
      url: `/encounters?legacyArray=1&clinicId=${ctx.clinic.id}&date=${date}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().some((row: { id: string; assignedMaUserId?: string }) => row.id === encounter.id && row.assignedMaUserId === ctx.ma.id)).toBe(true);
  });

  it("adds archived labels to encounter-facing clinic/provider/room names", async () => {
    const ctx = await bootstrapCore();
    const date = ctx.day.toISOString().slice(0, 10);

    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-ARCHIVE-LABEL-1",
        clinicId: ctx.clinic.id,
        providerId: ctx.provider.id,
        reasonForVisitId: ctx.reason.id,
        walkIn: true
      }
    });
    expect(created.statusCode).toBe(200);
    const encounterId = (created.json() as { id: string }).id;

    const assignment = await prisma.clinicRoomAssignment.findFirst({
      where: { clinicId: ctx.clinic.id, active: true },
      select: { roomId: true }
    });
    expect(assignment).toBeTruthy();

    const rooming = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounterId}/rooming`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        roomId: assignment!.roomId
      }
    });
    expect(rooming.statusCode).toBe(200);

    await prisma.provider.update({
      where: { id: ctx.provider.id },
      data: { active: false }
    });
    await prisma.clinic.update({
      where: { id: ctx.clinic.id },
      data: { status: "archived" }
    });
    await prisma.clinicRoom.update({
      where: { id: assignment!.roomId },
      data: { status: "archived" }
    });
    await prisma.reasonForVisit.update({
      where: { id: ctx.reason.id },
      data: { status: "archived", active: false }
    });

    const list = await app.inject({
      method: "GET",
      url: `/encounters?legacyArray=1&clinicId=${ctx.clinic.id}&date=${date}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(list.statusCode).toBe(200);
    const row = (list.json() as Array<any>).find((entry) => entry.id === encounterId);
    expect(row).toBeTruthy();
    expect(row.clinicName).toContain("(Archived)");
    expect(row.providerName).toContain("(Archived)");
    expect(row.roomName).toContain("(Archived)");
    expect(row.reasonForVisit).toContain("(Archived)");
  });

  it("adds archived provider labels to office-manager history rollups", async () => {
    const ctx = await bootstrapCore();
    const date = ctx.day.toISOString().slice(0, 10);

    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-HISTORY-ARCHIVED-PROVIDER",
        clinicId: ctx.clinic.id,
        providerId: ctx.provider.id,
        reasonForVisitId: ctx.reason.id,
        walkIn: true
      }
    });
    expect(created.statusCode).toBe(200);

    await prisma.provider.update({
      where: { id: ctx.provider.id },
      data: { active: false }
    });

    const history = await app.inject({
      method: "GET",
      url: `/dashboard/office-manager/history?clinicId=${ctx.clinic.id}&from=${date}&to=${date}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(history.statusCode).toBe(200);

    const daily = history.json().daily as Array<{
      providerRollups: Array<{ providerName: string }>;
    }>;
    expect(daily.length).toBeGreaterThan(0);
    const providerNames = daily[0]?.providerRollups?.map((row) => row.providerName) || [];
    expect(providerNames.some((name) => name.includes("(Archived)"))).toBe(true);
  });

  it("validates visit reason clinic assignments against facility scope", async () => {
    const ctx = await bootstrapCore();

    const emptyClinicSelection = await app.inject({
      method: "POST",
      url: "/admin/reasons",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        facilityId: ctx.facility.id,
        name: "Invalid Empty Clinics",
        appointmentLengthMinutes: 20,
        clinicIds: []
      }
    });
    expect(emptyClinicSelection.statusCode).toBe(400);

    const secondFacility = await prisma.facility.create({
      data: {
        name: "Other Reason Facility",
        shortCode: "ORF",
        timezone: "America/New_York"
      }
    });
    const foreignClinic = await prisma.clinic.create({
      data: {
        facilityId: secondFacility.id,
        name: "Foreign Reason Clinic",
        shortCode: "FRC",
        timezone: "America/New_York",
        maRun: true
      }
    });

    const crossFacilityCreate = await app.inject({
      method: "POST",
      url: "/admin/reasons",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        facilityId: ctx.facility.id,
        name: "Cross Facility Create",
        appointmentLengthMinutes: 30,
        clinicIds: [foreignClinic.id]
      }
    });
    expect(crossFacilityCreate.statusCode).toBe(400);
    expect(crossFacilityCreate.json().message).toContain("selected facility");

    const validReason = await app.inject({
      method: "POST",
      url: "/admin/reasons",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        facilityId: ctx.facility.id,
        name: "Valid Scoped Reason",
        appointmentLengthMinutes: 30,
        clinicIds: [ctx.clinic.id]
      }
    });
    expect(validReason.statusCode).toBe(200);

    const crossFacilityUpdate = await app.inject({
      method: "POST",
      url: `/admin/reasons/${validReason.json().id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        clinicIds: [foreignClinic.id]
      }
    });
    expect(crossFacilityUpdate.statusCode).toBe(400);
    expect(crossFacilityUpdate.json().message).toContain("selected facility");
  });

  it("keeps only one active template per facility reason and type", async () => {
    const ctx = await bootstrapCore();

    const createReplacement = await app.inject({
      method: "POST",
      url: "/admin/templates",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        facilityId: ctx.facility.id,
        name: "Rooming Replacement",
        type: "rooming",
        status: "active",
        reasonIds: [ctx.reason.id],
        fields: [
          {
            key: "temp",
            label: "Temperature",
            type: "text",
            required: true
          }
        ]
      }
    });
    expect(createReplacement.statusCode).toBe(200);
    const replacementTemplateId = createReplacement.json().id as string;

    const templates = await app.inject({
      method: "GET",
      url: `/admin/templates?facilityId=${ctx.facility.id}&type=rooming&includeInactive=true`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(templates.statusCode).toBe(200);

    const roomingForReason = (templates.json() as Array<{
      id: string;
      status: string;
      reasonIds?: string[];
    }>).filter((entry) => (entry.reasonIds || []).includes(ctx.reason.id));
    const activeRooming = roomingForReason.filter((entry) => entry.status === "active");
    expect(activeRooming).toHaveLength(1);
    expect(activeRooming[0]?.id).toBe(replacementTemplateId);

    const legacyTemplate = await prisma.template.findFirst({
      where: {
        id: { not: replacementTemplateId },
        facilityId: ctx.facility.id,
        type: "rooming",
        reasonAssignments: { some: { reasonId: ctx.reason.id } }
      }
    });
    expect(legacyTemplate).toBeTruthy();
    expect(legacyTemplate?.status).toBe("inactive");
    expect(legacyTemplate?.active).toBe(false);
  });

  it("surfaces integrity warnings for malformed template field definitions", async () => {
    const ctx = await bootstrapCore();
    const template = await prisma.template.findFirstOrThrow({
      where: {
        facilityId: ctx.facility.id,
        type: TemplateType.rooming,
      },
      orderBy: { createdAt: "asc" },
    });

    await prisma.template.update({
      where: { id: template.id },
      data: {
        fieldsJson: { broken: true } as unknown as Prisma.InputJsonValue,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/admin/templates?facilityId=${ctx.facility.id}&type=rooming`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
    });

    expect(response.statusCode).toBe(200);
    const rows = response.json() as Array<{
      id: string;
      fields: unknown[];
      integrityWarnings?: Array<{ field: string }>;
    }>;
    const malformed = rows.find((row) => row.id === template.id);
    expect(malformed?.fields).toEqual([]);
    expect(malformed?.integrityWarnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "fieldsJson" })]),
    );

    const alert = await prisma.userAlertInbox.findFirst({
      where: {
        facilityId: ctx.facility.id,
        sourceId: `template:${template.id}:fieldsJson`,
      },
    });
    expect(alert).toBeTruthy();
  });

  it("filters reasons and templates by includeInactive and includeArchived flags", async () => {
    const ctx = await bootstrapCore();

    const inactiveReasonRes = await app.inject({
      method: "POST",
      url: "/admin/reasons",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        facilityId: ctx.facility.id,
        name: "Reason Inactive",
        appointmentLengthMinutes: 25,
        clinicIds: [ctx.clinic.id],
        status: "inactive"
      }
    });
    expect(inactiveReasonRes.statusCode).toBe(200);

    const archivedReasonCreate = await app.inject({
      method: "POST",
      url: "/admin/reasons",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        facilityId: ctx.facility.id,
        name: "Reason Archived",
        appointmentLengthMinutes: 30,
        clinicIds: [ctx.clinic.id]
      }
    });
    expect(archivedReasonCreate.statusCode).toBe(200);
    const archivedReasonId = archivedReasonCreate.json().id as string;

    const archivedReasonDelete = await app.inject({
      method: "DELETE",
      url: `/admin/reasons/${archivedReasonId}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(archivedReasonDelete.statusCode).toBe(200);

    const reasonDefault = await app.inject({
      method: "GET",
      url: `/admin/reasons?facilityId=${ctx.facility.id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(reasonDefault.statusCode).toBe(200);
    const reasonDefaultStatuses = new Set((reasonDefault.json() as Array<{ status: string }>).map((entry) => entry.status));
    expect(reasonDefaultStatuses.has("inactive")).toBe(false);
    expect(reasonDefaultStatuses.has("archived")).toBe(false);

    const reasonWithInactive = await app.inject({
      method: "GET",
      url: `/admin/reasons?facilityId=${ctx.facility.id}&includeInactive=true`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(reasonWithInactive.statusCode).toBe(200);
    const reasonWithInactiveStatuses = new Set((reasonWithInactive.json() as Array<{ status: string }>).map((entry) => entry.status));
    expect(reasonWithInactiveStatuses.has("inactive")).toBe(true);
    expect(reasonWithInactiveStatuses.has("archived")).toBe(false);

    const reasonWithArchived = await app.inject({
      method: "GET",
      url: `/admin/reasons?facilityId=${ctx.facility.id}&includeArchived=true`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(reasonWithArchived.statusCode).toBe(200);
    const reasonWithArchivedStatuses = new Set((reasonWithArchived.json() as Array<{ status: string }>).map((entry) => entry.status));
    expect(reasonWithArchivedStatuses.has("inactive")).toBe(false);
    expect(reasonWithArchivedStatuses.has("archived")).toBe(true);

    const reasonAll = await app.inject({
      method: "GET",
      url: `/admin/reasons?facilityId=${ctx.facility.id}&includeInactive=true&includeArchived=true`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(reasonAll.statusCode).toBe(200);
    const reasonAllStatuses = new Set((reasonAll.json() as Array<{ status: string }>).map((entry) => entry.status));
    expect(reasonAllStatuses.has("inactive")).toBe(true);
    expect(reasonAllStatuses.has("archived")).toBe(true);

    const inactiveTemplate = await app.inject({
      method: "POST",
      url: "/admin/templates",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        facilityId: ctx.facility.id,
        name: "Check-In Inactive",
        type: "checkin",
        status: "inactive",
        reasonIds: [ctx.reason.id],
        fields: [{ key: "inactive_note", label: "Inactive Note", type: "text", required: false }]
      }
    });
    expect(inactiveTemplate.statusCode).toBe(200);

    const archivedTemplateCreate = await app.inject({
      method: "POST",
      url: "/admin/templates",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        facilityId: ctx.facility.id,
        name: "Check-In Archived",
        type: "checkin",
        status: "active",
        reasonIds: [ctx.reason.id],
        fields: [{ key: "archived_note", label: "Archived Note", type: "text", required: false }]
      }
    });
    expect(archivedTemplateCreate.statusCode).toBe(200);
    const archivedTemplateId = archivedTemplateCreate.json().id as string;

    const archivedTemplateDelete = await app.inject({
      method: "DELETE",
      url: `/admin/templates/${archivedTemplateId}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(archivedTemplateDelete.statusCode).toBe(200);

    const templateDefault = await app.inject({
      method: "GET",
      url: `/admin/templates?facilityId=${ctx.facility.id}&type=checkin`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(templateDefault.statusCode).toBe(200);
    const templateDefaultStatuses = new Set((templateDefault.json() as Array<{ status: string }>).map((entry) => entry.status));
    expect(templateDefaultStatuses.has("inactive")).toBe(false);
    expect(templateDefaultStatuses.has("archived")).toBe(false);

    const templateWithInactive = await app.inject({
      method: "GET",
      url: `/admin/templates?facilityId=${ctx.facility.id}&type=checkin&includeInactive=true`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(templateWithInactive.statusCode).toBe(200);
    const templateWithInactiveStatuses = new Set((templateWithInactive.json() as Array<{ status: string }>).map((entry) => entry.status));
    expect(templateWithInactiveStatuses.has("inactive")).toBe(true);
    expect(templateWithInactiveStatuses.has("archived")).toBe(false);

    const templateWithArchived = await app.inject({
      method: "GET",
      url: `/admin/templates?facilityId=${ctx.facility.id}&type=checkin&includeArchived=true`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(templateWithArchived.statusCode).toBe(200);
    const templateWithArchivedStatuses = new Set((templateWithArchived.json() as Array<{ status: string }>).map((entry) => entry.status));
    expect(templateWithArchivedStatuses.has("inactive")).toBe(false);
    expect(templateWithArchivedStatuses.has("archived")).toBe(true);

    const templateAll = await app.inject({
      method: "GET",
      url: `/admin/templates?facilityId=${ctx.facility.id}&type=checkin&includeInactive=true&includeArchived=true`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(templateAll.statusCode).toBe(200);
    const templateAllStatuses = new Set((templateAll.json() as Array<{ status: string }>).map((entry) => entry.status));
    expect(templateAllStatuses.has("inactive")).toBe(true);
    expect(templateAllStatuses.has("archived")).toBe(true);
  });

  it("removes legacy provider and mapping admin endpoints", async () => {
    const ctx = await bootstrapCore();

    const providerList = await app.inject({
      method: "GET",
      url: "/admin/providers",
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(providerList.statusCode).toBe(404);

    const maMappings = await app.inject({
      method: "GET",
      url: "/admin/ma-mappings",
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(maMappings.statusCode).toBe(404);

    const maClinicMappings = await app.inject({
      method: "GET",
      url: "/admin/ma-clinic-mappings",
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(maClinicMappings.statusCode).toBe(404);
  });

  it("requires operational assignments for encounter creation and blocks suspended assignment users", async () => {
    const ctx = await bootstrapCore();

    const invalidAssignment = await app.inject({
      method: "POST",
      url: `/admin/assignments/${ctx.clinic.id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        maUserId: ctx.ma.id
      }
    });
    expect(invalidAssignment.statusCode).toBe(400);

    const validAssignment = await app.inject({
      method: "POST",
      url: `/admin/assignments/${ctx.clinic.id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        providerUserId: ctx.clinician.id,
        maUserId: ctx.ma.id
      }
    });
    expect(validAssignment.statusCode).toBe(200);

    await app.inject({
      method: "POST",
      url: `/admin/users/${ctx.ma.id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        status: "suspended"
      }
    });

    const blockedCheckIn = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-REASSIGN-1",
        clinicId: ctx.clinic.id,
        incomingId: ctx.incoming.id
      }
    });
    expect(blockedCheckIn.statusCode).toBe(400);
    expect(blockedCheckIn.json().message).toContain("Clinic is not ready");
  });

  it("recalculates encounter alert levels from threshold matrix rules", async () => {
    const ctx = await bootstrapCore();

    await prisma.alertThreshold.create({
      data: {
        facilityId: ctx.facility.id,
        clinicId: ctx.clinic.id,
        metric: "stage",
        status: "Lobby",
        yellowAtMin: 1,
        redAtMin: 2
      }
    });

    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-ALERT-STAGE",
        clinicId: ctx.clinic.id,
        reasonForVisitId: ctx.reason.id,
        walkIn: true
      }
    });
    expect(created.statusCode).toBe(200);
    const encounterId = created.json().id as string;

    const older = new Date(Date.now() - 3 * 60 * 1000);
    await prisma.encounter.update({
      where: { id: encounterId },
      data: {
        checkInAt: older,
        version: { increment: 1 }
      }
    });
    await prisma.alertState.update({
      where: { encounterId },
      data: {
        enteredStatusAt: older,
        currentAlertLevel: "Green",
        yellowTriggeredAt: null,
        redTriggeredAt: null,
        escalationTriggeredAt: null
      }
    });

    const listed = await app.inject({
      method: "GET",
      url: `/encounters?legacyArray=1&clinicId=${ctx.clinic.id}&date=${ctx.day.toISOString().slice(0, 10)}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(listed.statusCode).toBe(200);
    const row = (listed.json() as Array<{ id: string; alertState?: { currentAlertLevel?: string } }>).find(
      (entry) => entry.id === encounterId
    );
    expect(row?.alertState?.currentAlertLevel).toBe("Red");

    const state = await prisma.alertState.findUnique({ where: { encounterId } });
    expect(state?.currentAlertLevel).toBe("Red");
    expect(state?.yellowTriggeredAt).not.toBeNull();
    expect(state?.redTriggeredAt).not.toBeNull();
  });

  it("applies overall-visit thresholds and records escalation timestamp", async () => {
    const ctx = await bootstrapCore();

    await prisma.alertThreshold.create({
      data: {
        facilityId: ctx.facility.id,
        clinicId: ctx.clinic.id,
        metric: "stage",
        status: "Lobby",
        yellowAtMin: 100,
        redAtMin: 120
      }
    });
    await prisma.alertThreshold.create({
      data: {
        facilityId: ctx.facility.id,
        clinicId: ctx.clinic.id,
        metric: "overall_visit",
        status: null,
        yellowAtMin: 30,
        redAtMin: 45,
        escalation2Min: 60
      }
    });

    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-ALERT-OVERALL",
        clinicId: ctx.clinic.id,
        reasonForVisitId: ctx.reason.id,
        walkIn: true
      }
    });
    expect(created.statusCode).toBe(200);
    const encounterId = created.json().id as string;

    const oldCheckIn = new Date(Date.now() - 65 * 60 * 1000);
    const recentStage = new Date(Date.now() - 1 * 60 * 1000);
    await prisma.encounter.update({
      where: { id: encounterId },
      data: {
        checkInAt: oldCheckIn,
        version: { increment: 1 }
      }
    });
    await prisma.alertState.update({
      where: { encounterId },
      data: {
        enteredStatusAt: recentStage,
        currentAlertLevel: "Green",
        yellowTriggeredAt: null,
        redTriggeredAt: null,
        escalationTriggeredAt: null
      }
    });

    const listed = await app.inject({
      method: "GET",
      url: `/encounters?legacyArray=1&clinicId=${ctx.clinic.id}&date=${ctx.day.toISOString().slice(0, 10)}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(listed.statusCode).toBe(200);
    const row = (listed.json() as Array<{ id: string; alertState?: { currentAlertLevel?: string } }>).find(
      (entry) => entry.id === encounterId
    );
    expect(row?.alertState?.currentAlertLevel).toBe("Red");

    const state = await prisma.alertState.findUnique({ where: { encounterId } });
    expect(state?.currentAlertLevel).toBe("Red");
    expect(state?.escalationTriggeredAt).not.toBeNull();
  });

  it("stores threshold alerts in the per-user inbox and supports acknowledge/archive flow", async () => {
    const ctx = await bootstrapCore();

    await prisma.alertThreshold.create({
      data: {
        facilityId: ctx.facility.id,
        clinicId: ctx.clinic.id,
        metric: "stage",
        status: "Lobby",
        yellowAtMin: 1,
        redAtMin: 2
      }
    });

    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-INBOX-THRESHOLD-1",
        clinicId: ctx.clinic.id,
        reasonForVisitId: ctx.reason.id,
        walkIn: true
      }
    });
    expect(created.statusCode).toBe(200);
    const encounterId = created.json().id as string;

    const older = new Date(Date.now() - 3 * 60 * 1000);
    await prisma.encounter.update({
      where: { id: encounterId },
      data: {
        checkInAt: older,
        version: { increment: 1 }
      }
    });
    await prisma.alertState.update({
      where: { encounterId },
      data: {
        enteredStatusAt: older,
        currentAlertLevel: "Green",
        yellowTriggeredAt: null,
        redTriggeredAt: null,
        escalationTriggeredAt: null
      }
    });

    const trigger = await app.inject({
      method: "GET",
      url: `/encounters?legacyArray=1&clinicId=${ctx.clinic.id}&date=${ctx.day.toISOString().slice(0, 10)}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(trigger.statusCode).toBe(200);

    const activeAlerts = await app.inject({
      method: "GET",
      url: "/alerts?tab=active",
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(activeAlerts.statusCode).toBe(200);
    const activeItems = activeAlerts.json().items as Array<{ id: string; kind: string; payload?: { encounterId?: string } }>;
    const thresholdAlert = activeItems.find((item) => item.kind === "threshold" && item.payload?.encounterId === encounterId);
    expect(thresholdAlert).toBeTruthy();

    const archived = await app.inject({
      method: "POST",
      url: `/alerts/${thresholdAlert!.id}/acknowledge`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().status).toBe("archived");

    const archivedAlerts = await app.inject({
      method: "GET",
      url: "/alerts?tab=archived",
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(archivedAlerts.statusCode).toBe(200);
    const archivedItems = archivedAlerts.json().items as Array<{ id: string }>;
    expect(archivedItems.some((item) => item.id === thresholdAlert!.id)).toBe(true);
  });

  it("stores threshold alerts for admins whose active facility matches even when their admin role is scoped elsewhere", async () => {
    const ctx = await bootstrapCore();

    const otherFacility = await prisma.facility.create({
      data: {
        name: "Other Admin Scope",
        shortCode: "OAS",
        timezone: "America/New_York"
      }
    });

    await prisma.userRole.deleteMany({
      where: {
        userId: ctx.admin.id,
        role: RoleName.Admin,
        facilityId: ctx.facility.id
      }
    });
    await prisma.userRole.create({
      data: {
        userId: ctx.admin.id,
        role: RoleName.Admin,
        facilityId: otherFacility.id
      }
    });
    await prisma.user.update({
      where: { id: ctx.admin.id },
      data: { activeFacilityId: ctx.facility.id }
    });

    await prisma.alertThreshold.create({
      data: {
        facilityId: ctx.facility.id,
        clinicId: ctx.clinic.id,
        metric: "stage",
        status: "Lobby",
        yellowAtMin: 1,
        redAtMin: 2
      }
    });

    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-INBOX-THRESHOLD-ADMIN-FACILITY",
        clinicId: ctx.clinic.id,
        reasonForVisitId: ctx.reason.id,
        walkIn: true
      }
    });
    expect(created.statusCode).toBe(200);
    const encounterId = created.json().id as string;

    const older = new Date(Date.now() - 3 * 60 * 1000);
    await prisma.encounter.update({
      where: { id: encounterId },
      data: {
        checkInAt: older,
        version: { increment: 1 }
      }
    });
    await prisma.alertState.update({
      where: { encounterId },
      data: {
        enteredStatusAt: older,
        currentAlertLevel: "Green",
        yellowTriggeredAt: null,
        redTriggeredAt: null,
        escalationTriggeredAt: null
      }
    });

    const scopedHeaders = {
      ...authHeaders(ctx.admin.id, RoleName.Admin),
      "x-facility-id": ctx.facility.id
    };

    const trigger = await app.inject({
      method: "GET",
      url: `/encounters?legacyArray=1&clinicId=${ctx.clinic.id}&date=${ctx.day.toISOString().slice(0, 10)}`,
      headers: scopedHeaders
    });
    expect(trigger.statusCode).toBe(200);

    const activeAlerts = await app.inject({
      method: "GET",
      url: "/alerts?tab=active",
      headers: scopedHeaders
    });
    expect(activeAlerts.statusCode).toBe(200);
    const activeItems = activeAlerts.json().items as Array<{ id: string; kind: string; payload?: { encounterId?: string } }>;
    const thresholdAlert = activeItems.find((item) => item.kind === "threshold" && item.payload?.encounterId === encounterId);
    expect(thresholdAlert).toBeTruthy();
  });

  it("creates safety and task inbox alerts for scoped users", async () => {
    const ctx = await bootstrapCore();

    const created = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-INBOX-SAFETY-TASK-1",
        clinicId: ctx.clinic.id,
        incomingId: ctx.incoming.id
      }
    });
    expect(created.statusCode).toBe(200);
    const encounterId = created.json().id as string;

    const safetyWord = await app.inject({
      method: "GET",
      url: "/safety/word",
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(safetyWord.statusCode).toBe(200);

    const activated = await app.inject({
      method: "POST",
      url: `/safety/${encounterId}/activate`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        confirmationWord: safetyWord.json().word
      }
    });
    expect(activated.statusCode).toBe(200);

    const createdTask = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        encounterId,
        taskType: "follow_up",
        description: "Call patient before check-out",
        assignedToUserId: ctx.ma.id
      }
    });
    expect(createdTask.statusCode).toBe(200);

    const maAlerts = await app.inject({
      method: "GET",
      url: "/alerts?tab=active",
      headers: authHeaders(ctx.ma.id, RoleName.MA)
    });
    expect(maAlerts.statusCode).toBe(200);
    const maItems = maAlerts.json().items as Array<{ kind: string }>;
    expect(maItems.some((item) => item.kind === "task")).toBe(true);
    expect(maItems.some((item) => item.kind === "safety")).toBe(true);
  });

  it("records task acknowledged/completed timestamps and notes", async () => {
    const ctx = await bootstrapCore();

    const createdEncounter = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-TASK-LIFECYCLE-1",
        clinicId: ctx.clinic.id,
        incomingId: ctx.incoming.id
      }
    });
    expect(createdEncounter.statusCode).toBe(200);
    const encounterId = createdEncounter.json().id as string;

    const createdTask = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        encounterId,
        taskType: "rooming_follow_up",
        description: "Collect missing vitals",
        assignedToRole: RoleName.MA
      }
    });
    expect(createdTask.statusCode).toBe(200);
    const taskId = createdTask.json().id as string;

    const claimed = await app.inject({
      method: "PATCH",
      url: `/tasks/${taskId}`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: {
        assignedToUserId: ctx.ma.id,
        acknowledged: true,
        notes: "Will complete before handoff"
      }
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().assignedToUserId).toBe(ctx.ma.id);
    expect(claimed.json().acknowledgedAt).toBeTruthy();
    expect(claimed.json().acknowledgedBy).toBe(ctx.ma.id);

    const completed = await app.inject({
      method: "PATCH",
      url: `/tasks/${taskId}`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: {
        completed: true,
        status: "completed",
        notes: "Completed and documented"
      }
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().completedAt).toBeTruthy();
    expect(completed.json().completedBy).toBe(ctx.ma.id);
    expect(completed.json().notes).toContain("Completed");
  });

  it("persists committed audit and outbox rows for safety and task mutations", async () => {
    const ctx = await bootstrapCore();

    const createdEncounter = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-OPS-AUDIT-1",
        clinicId: ctx.clinic.id,
        incomingId: ctx.incoming.id
      }
    });
    expect(createdEncounter.statusCode).toBe(200);
    const encounterId = createdEncounter.json().id as string;

    const safetyWord = await app.inject({
      method: "GET",
      url: "/safety/word",
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    const activated = await app.inject({
      method: "POST",
      url: `/safety/${encounterId}/activate`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        confirmationWord: safetyWord.json().word
      }
    });
    expect(activated.statusCode).toBe(200);
    const safetyEventId = activated.json().id as string;

    const createdTask = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        encounterId,
        taskType: "follow_up",
        description: "Confirm discharge instructions",
        assignedToRole: RoleName.MA
      }
    });
    expect(createdTask.statusCode).toBe(200);
    const taskId = createdTask.json().id as string;

    const [safetyAudit, taskAudit, safetyOutbox, taskOutbox] = await Promise.all([
      prisma.auditLog.findFirst({
        where: { route: "/safety/:encounterId/activate", entityId: safetyEventId },
        orderBy: { occurredAt: "desc" },
      }),
      prisma.auditLog.findFirst({
        where: { route: "/tasks", entityId: taskId },
        orderBy: { occurredAt: "desc" },
      }),
      prisma.eventOutbox.findFirst({
        where: { aggregateType: "safety", aggregateId: safetyEventId },
        orderBy: { createdAt: "desc" },
      }),
      prisma.eventOutbox.findFirst({
        where: { aggregateType: "tasks", aggregateId: taskId },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    expect(safetyAudit?.statusCode).toBe(200);
    expect(taskAudit?.statusCode).toBe(200);
    expect(safetyOutbox?.status).toBe("dispatched");
    expect(taskOutbox?.status).toBe("dispatched");
  });

  it("archives tasks instead of hard deleting historical task records", async () => {
    const ctx = await bootstrapCore();

    const createdEncounter = await app.inject({
      method: "POST",
      url: "/encounters",
      headers: authHeaders(ctx.checkin.id, RoleName.FrontDeskCheckIn),
      payload: {
        patientId: "PT-TASK-ARCHIVE-1",
        clinicId: ctx.clinic.id,
        incomingId: ctx.incoming.id,
      },
    });
    expect(createdEncounter.statusCode).toBe(200);
    const encounterId = createdEncounter.json().id as string;

    const createdTask = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        encounterId,
        taskType: "rooming_follow_up",
        description: "Archive instead of delete",
        assignedToRole: RoleName.MA,
      },
    });
    expect(createdTask.statusCode).toBe(200);
    const taskId = createdTask.json().id as string;

    const deleted = await app.inject({
      method: "DELETE",
      url: `/tasks/${taskId}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual(
      expect.objectContaining({
        status: "archived",
      }),
    );

    const archivedTask = await prisma.task.findUnique({ where: { id: taskId } });
    expect(archivedTask?.archivedAt).toBeTruthy();
    expect(archivedTask?.status).toBe("archived");

    const defaultList = await app.inject({
      method: "GET",
      url: "/tasks?mine=true&includeCompleted=true",
      headers: authHeaders(ctx.ma.id, RoleName.MA),
    });
    expect(defaultList.statusCode).toBe(200);
    expect((defaultList.json() as Array<{ id: string }>).some((task) => task.id === taskId)).toBe(false);

    const archivedList = await app.inject({
      method: "GET",
      url: "/tasks?mine=true&includeCompleted=true&includeArchived=true",
      headers: authHeaders(ctx.ma.id, RoleName.MA),
    });
    expect(archivedList.statusCode).toBe(200);
    expect((archivedList.json() as Array<{ id: string }>).some((task) => task.id === taskId)).toBe(true);

    const patchArchived = await app.inject({
      method: "PATCH",
      url: `/tasks/${taskId}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        notes: "should fail",
      },
    });
    expect(patchArchived.statusCode).toBe(400);
    expect(patchArchived.json()).toEqual(
      expect.objectContaining({
        code: "TASK_ARCHIVED",
      }),
    );
  });

  it("returns deterministic non-500 delete outcomes for notification and threshold rows", async () => {
    const ctx = await bootstrapCore();

    const threshold = await app.inject({
      method: "POST",
      url: "/admin/thresholds",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        facilityId: ctx.facility.id,
        clinicId: ctx.clinic.id,
        metric: "stage",
        status: "Lobby",
        yellowAtMin: 3,
        redAtMin: 6
      }
    });
    expect(threshold.statusCode).toBe(200);

    const deletedThreshold = await app.inject({
      method: "DELETE",
      url: `/admin/thresholds/${threshold.json().id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(deletedThreshold.statusCode).toBe(200);

    const missingThreshold = await app.inject({
      method: "DELETE",
      url: `/admin/thresholds/${threshold.json().id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(missingThreshold.statusCode).toBe(404);

    const notification = await app.inject({
      method: "POST",
      url: "/admin/notifications",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        clinicId: ctx.clinic.id,
        status: "Lobby",
        severity: "Yellow",
        recipients: ["MA"],
        channels: ["in_app"],
        cooldownMinutes: 5,
        ackRequired: false
      }
    });
    expect(notification.statusCode).toBe(200);

    const deletedNotification = await app.inject({
      method: "DELETE",
      url: `/admin/notifications/${notification.json().id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(deletedNotification.statusCode).toBe(200);

    const missingNotification = await app.inject({
      method: "DELETE",
      url: `/admin/notifications/${notification.json().id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(missingNotification.statusCode).toBe(404);
  });

  it("redacts athena secrets in API responses while preserving stored credentials", async () => {
    const ctx = await bootstrapCore();

    const saved = await app.inject({
      method: "POST",
      url: "/admin/integrations/athenaone",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        facilityId: ctx.facility.id,
        enabled: true,
        config: {
          baseUrl: "https://example-athena.test",
          practiceId: "practice-1",
          authType: "basic",
          username: "athena-user",
          password: "secret-pass",
          apiKey: "secret-key",
          clientSecret: "secret-client"
        }
      }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().config.password).toBe("");
    expect(saved.json().config.apiKey).toBe("");
    expect(saved.json().config.clientSecret).toBe("");
    expect(saved.json().config.secretsConfigured.password).toBe(true);
    expect(saved.json().config.secretsConfigured.apiKey).toBe(true);
    expect(saved.json().config.secretsConfigured.clientSecret).toBe(true);

    const partialUpdate = await app.inject({
      method: "POST",
      url: "/admin/integrations/athenaone",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        facilityId: ctx.facility.id,
        enabled: true,
        config: {
          baseUrl: "https://example-athena-two.test",
          practiceId: "practice-1",
          authType: "basic",
          username: "athena-user"
        }
      }
    });
    expect(partialUpdate.statusCode).toBe(200);

    const stored = await prisma.integrationConnector.findUnique({
      where: {
        facilityId_vendor: {
          facilityId: ctx.facility.id,
          vendor: "athenaone"
        }
      }
    });
    const storedConfig = (stored?.configJson || {}) as Record<string, unknown>;
    expect(storedConfig.password).toBe("secret-pass");
    expect(storedConfig.apiKey).toBe("secret-key");
    expect(storedConfig.clientSecret).toBe("secret-client");
  });

  it("previews and imports Athena revenue monitoring rows and exposes Athena metrics in revenue dashboards", async () => {
    const ctx = await bootstrapCore();
    const finishedEncounter = await createRevenueWorkflowEncounter({
      clinicId: ctx.clinic.id,
      providerId: ctx.provider.id,
      reasonForVisitId: ctx.reason.id,
      checkinUserId: ctx.checkin.id,
      checkoutUserId: ctx.admin.id,
      maUserId: ctx.ma.id,
      clinicianUserId: ctx.clinician.id,
      patientId: "PT-ATHENA-REV",
      clinicianData: {
        "coding.working_diagnosis_codes_text": "M54.5",
        "coding.working_procedure_codes_text": "99214",
        "coding.documentation_complete": true,
      },
      checkoutData: {
        "billing.collection_expected": true,
        "billing.amount_due_cents": 2500,
        "billing.amount_collected_cents": 2500,
        "billing.collection_outcome": "CollectedInFull",
        disposition: "Discharged",
      },
    });
    const revenueCase = await prisma.revenueCase.findUnique({ where: { encounterId: finishedEncounter.id } });
    expect(revenueCase).toBeTruthy();
    const dateOfService = DateTime.fromJSDate(revenueCase!.dateOfService).toISODate();

    const savedConnector = await app.inject({
      method: "POST",
      url: "/admin/integrations/athenaone",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        facilityId: ctx.facility.id,
        enabled: true,
        config: {
          baseUrl: "https://example-athena.test",
          practiceId: "practice-1",
          revenuePath: "/billing/monitoring",
        },
      },
    });
    expect(savedConnector.statusCode).toBe(200);

    const athenaPayload = JSON.stringify({
      appointments: [
        {
          patient_id: "PT-ATHENA-REV",
          date_of_service: dateOfService,
          claim_status: "submitted",
          days_to_submit: 2,
          days_in_ar: 14,
          patient_balance: "15.25",
          charge_entered_at: `${dateOfService}T09:30:00Z`,
          claim_submitted_at: `${dateOfService}T12:00:00Z`,
        },
      ],
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(athenaPayload, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const preview = await app.inject({
      method: "POST",
      url: "/admin/integrations/athenaone/revenue-preview",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        facilityId: ctx.facility.id,
        clinicId: ctx.clinic.id,
        dateOfService,
      },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual(
      expect.objectContaining({
        ok: true,
        matchedCount: 1,
        rowCount: 1,
      }),
    );

    const imported = await app.inject({
      method: "POST",
      url: "/admin/integrations/athenaone/revenue-import",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        facilityId: ctx.facility.id,
        clinicId: ctx.clinic.id,
        dateOfService,
      },
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toEqual(
      expect.objectContaining({
        ok: true,
        importedCount: 1,
        skippedCount: 0,
      }),
    );

    const scopedRevenueCase = await app.inject({
      method: "GET",
      url: `/revenue-cases?legacyArray=1&encounterId=${finishedEncounter.id}`,
      headers: authHeaders(ctx.revenue.id, RoleName.RevenueCycle),
    });
    expect(scopedRevenueCase.statusCode).toBe(200);
    expect(scopedRevenueCase.json()).toHaveLength(1);

    const refreshedCase = await prisma.revenueCase.findUnique({ where: { id: revenueCase!.id } });
    expect(refreshedCase?.athenaDaysToSubmit).toBe(2);
    expect(refreshedCase?.athenaDaysInAR).toBe(14);
    expect(refreshedCase?.athenaClaimStatus).toBe("submitted");
    expect(refreshedCase?.athenaPatientBalanceCents).toBe(1525);

    const dashboard = await app.inject({
      method: "GET",
      url: `/dashboard/revenue-cycle?clinicId=${ctx.clinic.id}&from=${dateOfService}&to=${dateOfService}`,
      headers: authHeaders(ctx.revenue.id, RoleName.RevenueCycle),
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().kpis).toEqual(
      expect.objectContaining({
        athenaDaysToSubmit: 2,
        athenaDaysInAR: 14,
      }),
    );

    const history = await app.inject({
      method: "GET",
      url: `/dashboard/revenue-cycle/history?clinicId=${ctx.clinic.id}&from=${dateOfService}&to=${dateOfService}`,
      headers: authHeaders(ctx.revenue.id, RoleName.RevenueCycle),
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toEqual(
      expect.objectContaining({
        summary: expect.objectContaining({
          averageAthenaDaysToSubmit: 2,
          averageAthenaDaysInAR: 14,
        }),
      }),
    );
    expect(history.json().daily[0]).toEqual(
      expect.objectContaining({
        clinicId: ctx.clinic.id,
        clinicName: expect.any(String),
        dateKey: dateOfService,
        avgAthenaDaysToSubmit: 2,
        avgAthenaDaysInAR: 14,
        unfinishedQueueCountsJson: expect.any(Object),
      }),
    );

    fetchSpy.mockRestore();
  });

  it("dispatches real in-app notification test alerts to matching scoped users", async () => {
    const ctx = await bootstrapCore();

    const notification = await app.inject({
      method: "POST",
      url: "/admin/notifications",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        clinicId: ctx.clinic.id,
        status: "Lobby",
        severity: "Yellow",
        recipients: ["Admin"],
        channels: ["in_app"],
        cooldownMinutes: 5,
        ackRequired: false
      }
    });
    expect(notification.statusCode).toBe(200);

    const tested = await app.inject({
      method: "POST",
      url: `/admin/notifications/${notification.json().id}/test`,
      headers: {
        ...authHeaders(ctx.admin.id, RoleName.Admin),
        "x-facility-id": ctx.facility.id
      }
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json().results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "in_app",
          status: "sent",
          recipientCount: 1
        })
      ])
    );

    const alerts = await app.inject({
      method: "GET",
      url: "/alerts?tab=active&limit=50",
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(alerts.statusCode).toBe(200);
    expect(alerts.json().items.some((item: any) => item.title === "Notification policy test")).toBe(true);
  });

  it("dispatches in-app notification test alerts to admins using the active facility even when their admin role is scoped elsewhere", async () => {
    const ctx = await bootstrapCore();

    const otherFacility = await prisma.facility.create({
      data: {
        name: "Notification Admin Scope",
        shortCode: "NAS",
        timezone: "America/New_York"
      }
    });

    await prisma.userRole.deleteMany({
      where: {
        userId: ctx.admin.id,
        role: RoleName.Admin,
        facilityId: ctx.facility.id
      }
    });
    await prisma.userRole.create({
      data: {
        userId: ctx.admin.id,
        role: RoleName.Admin,
        facilityId: otherFacility.id
      }
    });
    await prisma.user.update({
      where: { id: ctx.admin.id },
      data: { activeFacilityId: ctx.facility.id }
    });

    const notification = await app.inject({
      method: "POST",
      url: "/admin/notifications",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        clinicId: ctx.clinic.id,
        status: "Lobby",
        severity: "Yellow",
        recipients: ["Admin"],
        channels: ["in_app"],
        cooldownMinutes: 5,
        ackRequired: false
      }
    });
    expect(notification.statusCode).toBe(200);

    const scopedHeaders = {
      ...authHeaders(ctx.admin.id, RoleName.Admin),
      "x-facility-id": ctx.facility.id
    };

    const tested = await app.inject({
      method: "POST",
      url: `/admin/notifications/${notification.json().id}/test`,
      headers: scopedHeaders
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json().results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "in_app",
          status: "sent",
          recipientCount: 1
        })
      ])
    );

    const alerts = await app.inject({
      method: "GET",
      url: "/alerts?tab=active&limit=50",
      headers: scopedHeaders
    });
    expect(alerts.statusCode).toBe(200);
    expect(
      alerts.json().items.some(
        (item: any) => item.title === "Notification policy test" && item.payload?.policyId === notification.json().id
      )
    ).toBe(true);
  });

  it("creates revenue cases from encounter workflow state and allows RevenueCycle read-only encounter access", async () => {
    const ctx = await bootstrapCore();
    const finishedEncounter = await createRevenueWorkflowEncounter({
      clinicId: ctx.clinic.id,
      providerId: ctx.provider.id,
      reasonForVisitId: ctx.reason.id,
      checkinUserId: ctx.checkin.id,
      checkoutUserId: ctx.admin.id,
      maUserId: ctx.ma.id,
      clinicianUserId: ctx.clinician.id,
      patientId: "PT-REV-READONLY",
      clinicianData: {
        "coding.working_diagnosis_codes_text": "I10",
        "coding.working_procedure_codes_text": "99213",
        "coding.documentation_complete": true,
        "coding.note": "Clinician coding handoff complete",
      },
    });

    const revenueList = await app.inject({
      method: "GET",
      url: "/revenue-cases?legacyArray=1&dayBucket=Today&workQueue=CheckoutTracking",
      headers: authHeaders(ctx.revenue.id, RoleName.RevenueCycle),
    });
    expect(revenueList.statusCode).toBe(200);
    expect(revenueList.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          encounterId: finishedEncounter.id,
          patientId: "PT-REV-READONLY",
          currentRevenueStatus: "CheckoutTrackingNeeded",
          currentWorkQueue: "CheckoutTracking",
          encounter: expect.objectContaining({
            roomingData: null,
            clinicianData: null,
            checkoutData: null,
          }),
        }),
      ]),
    );

    const readEncounter = await app.inject({
      method: "GET",
      url: `/encounters/${finishedEncounter.id}`,
      headers: authHeaders(ctx.revenue.id, RoleName.RevenueCycle),
    });
    expect(readEncounter.statusCode).toBe(200);
    expect(readEncounter.json().id).toBe(finishedEncounter.id);

    const mutateEncounter = await app.inject({
      method: "PATCH",
      url: `/encounters/${finishedEncounter.id}/status`,
      headers: authHeaders(ctx.revenue.id, RoleName.RevenueCycle),
      payload: {
        toStatus: "Optimized",
        version: finishedEncounter.version,
      },
    });
    expect(mutateEncounter.statusCode).toBe(403);
  });

  it("returns paginated revenue case envelopes when requested", async () => {
    const ctx = await bootstrapCore();
    const date = ctx.day.toISOString().slice(0, 10);
    const extraRooms = await Promise.all(
      [3, 4].map(async (roomNumber) => {
        const room = await prisma.clinicRoom.create({
          data: {
            facilityId: ctx.facility.id,
            name: `Revenue Room ${roomNumber}`,
            roomNumber,
            roomType: "exam",
            status: "active",
            sortOrder: roomNumber,
          },
        });
        await prisma.clinicRoomAssignment.create({
          data: {
            clinicId: ctx.clinic.id,
            roomId: room.id,
            active: true,
          },
        });
        await prisma.roomOperationalState.create({
          data: {
            roomId: room.id,
            currentStatus: "Ready",
            lastReadyAt: new Date(),
          },
        });
        await prisma.roomChecklistRun.create({
          data: {
            roomId: room.id,
            clinicId: ctx.clinic.id,
            facilityId: ctx.facility.id,
            kind: "DayStart",
            dateKey: date,
            itemsJson: [{ key: "test", label: `Room ${roomNumber} ready`, completed: true }],
            completed: true,
            completedAt: new Date(),
            completedByUserId: ctx.admin.id,
          },
        });
        return room;
      }),
    );
    const roomIds = [ctx.clinicRoomA.id, ...extraRooms.map((room) => room.id)];

    for (const [index, patientId] of ["PT-REV-PAGE-1", "PT-REV-PAGE-2", "PT-REV-PAGE-3"].entries()) {
      await createRevenueWorkflowEncounter({
        clinicId: ctx.clinic.id,
        providerId: ctx.provider.id,
        reasonForVisitId: ctx.reason.id,
        checkinUserId: ctx.checkin.id,
        checkoutUserId: ctx.admin.id,
        maUserId: ctx.ma.id,
        clinicianUserId: ctx.clinician.id,
        roomId: roomIds[index],
        patientId,
        clinicianData: {
          "coding.working_diagnosis_codes_text": "I10",
          "coding.working_procedure_codes_text": "99213",
          "coding.documentation_complete": true,
        },
      });
    }

    const firstPage = await app.inject({
      method: "GET",
      url: `/revenue-cases?clinicId=${ctx.clinic.id}&from=${date}&to=${date}&pageSize=2`,
      headers: authHeaders(ctx.revenue.id, RoleName.RevenueCycle),
    });

    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().items).toHaveLength(2);
    expect(firstPage.json().pageSize).toBe(2);
    expect(firstPage.json().nextCursor).toEqual(expect.any(String));

    const secondPage = await app.inject({
      method: "GET",
      url: `/revenue-cases?clinicId=${ctx.clinic.id}&from=${date}&to=${date}&pageSize=2&cursor=${encodeURIComponent(firstPage.json().nextCursor)}`,
      headers: authHeaders(ctx.revenue.id, RoleName.RevenueCycle),
    });

    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json().items).toHaveLength(1);
    expect(secondPage.json().nextCursor).toBeNull();
  });

  it("allows Revenue Cycle staff to list in-scope users for revenue assignment and closeout ownership", async () => {
    const ctx = await bootstrapCore();

    const response = await app.inject({
      method: "GET",
      url: `/admin/users?facilityId=${ctx.facility.id}`,
      headers: authHeaders(ctx.revenue.id, RoleName.RevenueCycle),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ctx.revenue.id }),
        expect.objectContaining({ id: ctx.officeManager.id }),
        expect.objectContaining({ id: ctx.clinician.id }),
      ]),
    );
  });

  it("normalizes legacy malformed charge-capture JSON in revenue case responses", async () => {
    const ctx = await bootstrapCore();
    const finishedEncounter = await createRevenueWorkflowEncounter({
      clinicId: ctx.clinic.id,
      providerId: ctx.provider.id,
      reasonForVisitId: ctx.reason.id,
      checkinUserId: ctx.checkin.id,
      checkoutUserId: ctx.admin.id,
      maUserId: ctx.ma.id,
      clinicianUserId: ctx.clinician.id,
      patientId: "PT-REV-LEGACY-NORMALIZE",
      clinicianData: {
        "coding.working_diagnosis_codes_text": "J01.90",
        "coding.working_procedure_codes_text": "99213",
        "coding.documentation_complete": true,
      },
      checkoutData: {
        "billing.collection_expected": true,
        "billing.amount_due_cents": 2500,
        "billing.amount_collected_cents": 2500,
        "billing.collection_outcome": "CollectedInFull",
        disposition: "Discharged",
      },
    });

    const revenueCase = await prisma.revenueCase.findUnique({
      where: { encounterId: finishedEncounter.id },
      include: { chargeCaptureRecord: true },
    });
    expect(revenueCase?.chargeCaptureRecord).toBeTruthy();

    await prisma.chargeCaptureRecord.update({
      where: { revenueCaseId: revenueCase!.id },
      data: {
        icd10CodesJson: { legacy: true } as any,
        procedureLinesJson: { legacy: true } as any,
        serviceCaptureItemsJson: { legacy: true } as any,
        cptCodesJson: { legacy: true } as any,
        modifiersJson: { legacy: true } as any,
        unitsJson: { legacy: true } as any,
        documentationSummaryJson: ["legacy"] as any,
      },
    });

    const detailResponse = await app.inject({
      method: "GET",
      url: `/revenue-cases/${revenueCase!.id}`,
      headers: authHeaders(ctx.revenue.id, RoleName.RevenueCycle),
    });
    expect(detailResponse.statusCode).toBe(200);
    const detailPayload = detailResponse.json();
    expect(detailPayload).toEqual(
      expect.objectContaining({
        id: revenueCase!.id,
        chargeCaptureRecord: expect.any(Object),
      }),
    );
    expect(Array.isArray(detailPayload.chargeCaptureRecord?.cptCodesJson)).toBe(true);
    expect(Array.isArray(detailPayload.chargeCaptureRecord?.modifiersJson)).toBe(true);
    expect(Array.isArray(detailPayload.chargeCaptureRecord?.unitsJson)).toBe(true);
    expect(Array.isArray(detailPayload.chargeCaptureRecord?.icd10CodesJson)).toBe(true);
    expect(Array.isArray(detailPayload.chargeCaptureRecord?.procedureLinesJson)).toBe(true);
    expect(Array.isArray(detailPayload.chargeCaptureRecord?.serviceCaptureItemsJson)).toBe(true);
    expect(
      detailPayload.chargeCaptureRecord?.documentationSummaryJson === null ||
        typeof detailPayload.chargeCaptureRecord?.documentationSummaryJson === "object",
    ).toBe(true);

    const dashboardResponse = await app.inject({
      method: "GET",
      url: `/dashboard/revenue-cycle?clinicId=${ctx.clinic.id}&from=${DateTime.now().toISODate()}&to=${DateTime.now().toISODate()}`,
      headers: authHeaders(ctx.revenue.id, RoleName.RevenueCycle),
    });
    expect(dashboardResponse.statusCode).toBe(200);
    expect(dashboardResponse.json().cases).toBeUndefined();

    const dashboardWithCases = await app.inject({
      method: "GET",
      url: `/dashboard/revenue-cycle?clinicId=${ctx.clinic.id}&from=${DateTime.now().toISODate()}&to=${DateTime.now().toISODate()}&includeCases=true`,
      headers: authHeaders(ctx.revenue.id, RoleName.RevenueCycle),
    });
    expect(dashboardWithCases.statusCode).toBe(200);
    expect(dashboardWithCases.json().cases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          encounterId: finishedEncounter.id,
          encounter: expect.objectContaining({
            roomingData: null,
            clinicianData: null,
            checkoutData: null,
          }),
        }),
      ]),
    );
  });

  it("normalizes checkout collection tracking into the revenue case", async () => {
    const ctx = await bootstrapCore();
    const finishedEncounter = await createRevenueWorkflowEncounter({
      clinicId: ctx.clinic.id,
      providerId: ctx.provider.id,
      reasonForVisitId: ctx.reason.id,
      checkinUserId: ctx.checkin.id,
      checkoutUserId: ctx.admin.id,
      maUserId: ctx.ma.id,
      clinicianUserId: ctx.clinician.id,
      patientId: "PT-REV-COLLECT",
      clinicianData: {
        "coding.working_diagnosis_codes_text": "E11.9",
        "coding.working_procedure_codes_text": "99214",
        "coding.documentation_complete": true,
      },
      checkoutData: {
        "billing.collection_expected": true,
        "billing.amount_due_cents": 5000,
        "billing.amount_collected_cents": 2500,
        "billing.collection_outcome": "CollectedPartial",
        "billing.missed_reason": "Patient requested payment plan",
        "billing.collection_note": "Collected partial before leaving checkout",
        disposition: "Discharged",
      },
    });

    const revenueCase = await prisma.revenueCase.findUnique({
      where: { encounterId: finishedEncounter.id },
      include: { checkoutCollectionTracking: true, chargeCaptureRecord: true },
    });
    expect(revenueCase).toBeTruthy();
    expect(revenueCase?.checkoutCollectionTracking).toMatchObject({
      collectionExpected: true,
      amountDueCents: 5000,
      amountCollectedCents: 2500,
      collectionOutcome: "CollectedPartial",
      missedCollectionReason: "Patient requested payment plan",
      trackingNote: "Collected partial before leaving checkout",
    });
    expect(revenueCase?.chargeCaptureRecord?.codingStage).toBe("ReadyForAthena");
    expect(revenueCase?.chargeCaptureRecord?.serviceCaptureItemsJson).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Venipuncture",
          suggestedProcedureCode: "36415",
        }),
      ]),
    );
  });

  it("allows checkout with documentation incomplete and flags the revenue case for documentation follow-up", async () => {
    const ctx = await bootstrapCore();
    const finishedEncounter = await createRevenueWorkflowEncounter({
      clinicId: ctx.clinic.id,
      providerId: ctx.provider.id,
      reasonForVisitId: ctx.reason.id,
      checkinUserId: ctx.checkin.id,
      checkoutUserId: ctx.admin.id,
      maUserId: ctx.ma.id,
      clinicianUserId: ctx.clinician.id,
      patientId: "PT-REV-DOC-INCOMPLETE",
      clinicianData: {
        "coding.working_diagnosis_codes_text": "J01.90",
        "coding.working_procedure_codes_text": "99213",
        "coding.documentation_complete": false,
        "coding.note": "Visit closed before final documentation was complete.",
      },
      checkoutData: {
        "billing.collection_expected": true,
        "billing.amount_due_cents": 2200,
        "billing.amount_collected_cents": 2200,
        "billing.collection_outcome": "CollectedInFull",
        disposition: "Discharged",
      },
    });

    expect(finishedEncounter.currentStatus).toBe("Optimized");

    const revenueCase = await prisma.revenueCase.findUnique({
      where: { encounterId: finishedEncounter.id },
      include: { chargeCaptureRecord: true },
    });
    expect(revenueCase).toBeTruthy();
    expect(revenueCase?.chargeCaptureRecord?.documentationComplete).toBe(false);
    expect(revenueCase?.currentRevenueStatus).toBe("CodingReviewInProgress");
    expect(revenueCase?.currentWorkQueue).toBe("ChargeCapture");
    expect(revenueCase?.currentBlockerCategory).toBe("documentation_incomplete");
    expect(revenueCase?.currentBlockerText).toContain("documentation incomplete");
    expect(revenueCase?.readyForAthenaAt).toBeNull();
  });

  it("builds expected gross charge visibility from MA service capture without Athena data", async () => {
    const ctx = await bootstrapCore();
    await createRevenueWorkflowEncounter({
      clinicId: ctx.clinic.id,
      providerId: ctx.provider.id,
      reasonForVisitId: ctx.reason.id,
      checkinUserId: ctx.checkin.id,
      checkoutUserId: ctx.admin.id,
      maUserId: ctx.ma.id,
      clinicianUserId: ctx.clinician.id,
      patientId: "PT-REV-EXPECT",
      clinicianData: {
        "coding.note": "Working note only; revenue will finalize codes later.",
      },
      checkoutData: {
        "billing.collection_expected": true,
        "billing.amount_due_cents": 2000,
        "billing.amount_collected_cents": 2000,
        "billing.collection_outcome": "CollectedInFull",
        disposition: "Discharged",
      },
    });

    const dashboard = await app.inject({
      method: "GET",
      url: `/dashboard/revenue-cycle?clinicId=${ctx.clinic.id}&from=${DateTime.now().toISODate()}&to=${DateTime.now().toISODate()}`,
      headers: authHeaders(ctx.revenue.id, RoleName.RevenueCycle),
    });

    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().kpis).toEqual(
      expect.objectContaining({
        expectedGrossChargeCents: expect.any(Number),
        expectedNetReimbursementCents: expect.any(Number),
        serviceCaptureCompletedVisitCount: expect.any(Number),
        clinicianCodingEnteredVisitCount: expect.any(Number),
        chargeCaptureReadyVisitCount: expect.any(Number),
      }),
    );
    expect(dashboard.json().kpis.expectedGrossChargeCents).toBeGreaterThanOrEqual(1800);
    expect(dashboard.json().kpis.serviceCaptureCompletedVisitCount).toBeGreaterThanOrEqual(1);
  });

  it("returns owner analytics from a single aggregate endpoint", async () => {
    const ctx = await bootstrapCore();
    await createRevenueWorkflowEncounter({
      clinicId: ctx.clinic.id,
      providerId: ctx.provider.id,
      reasonForVisitId: ctx.reason.id,
      checkinUserId: ctx.checkin.id,
      checkoutUserId: ctx.admin.id,
      maUserId: ctx.ma.id,
      clinicianUserId: ctx.clinician.id,
      patientId: "PT-OWNER-ANALYTICS",
      clinicianData: {
        "coding.working_diagnosis_codes_text": "J01.90",
        "coding.working_procedure_codes_text": "99213",
        "coding.documentation_complete": false,
      },
      checkoutData: {
        "billing.collection_expected": true,
        "billing.amount_due_cents": 3200,
        "billing.amount_collected_cents": 1600,
        "billing.collection_outcome": "CollectedPartial",
        "billing.missed_reason": "Patient requested payment plan",
        disposition: "Discharged",
      },
    });

    const ownerAnalytics = await app.inject({
      method: "GET",
      url: `/dashboard/owner-analytics?clinicId=${ctx.clinic.id}&from=${DateTime.now().minus({ days: 1 }).toISODate()}&to=${DateTime.now().toISODate()}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
    });

    expect(ownerAnalytics.statusCode).toBe(200);
    expect(ownerAnalytics.json()).toEqual(
      expect.objectContaining({
        scope: expect.objectContaining({
          clinicId: ctx.clinic.id,
        }),
        overview: expect.objectContaining({
          expectedGrossChargeCents: expect.any(Number),
          expectedNetReimbursementCents: expect.any(Number),
        }),
        throughput: expect.objectContaining({
          daily: expect.any(Array),
          stageCounts: expect.any(Object),
        }),
        revenue: expect.objectContaining({
          daily: expect.any(Array),
          collectionOutcomes: expect.any(Array),
          mappingGaps: expect.any(Object),
        }),
        providersAndStaff: expect.objectContaining({
          providers: expect.any(Array),
          staff: expect.any(Array),
        }),
        roomsAndCapacity: expect.objectContaining({
          daily: expect.any(Array),
        }),
        exceptionsAndRisk: expect.objectContaining({
          documentationIncompleteCount: expect.any(Number),
          rolloverReasons: expect.any(Array),
        }),
      }),
    );
    expect(ownerAnalytics.json().exceptionsAndRisk.documentationIncompleteCount).toBeGreaterThanOrEqual(1);
  });

  it("supports provider clarification and returns the case to Athena handoff once resolved", async () => {
    const ctx = await bootstrapCore();
    const finishedEncounter = await createRevenueWorkflowEncounter({
      clinicId: ctx.clinic.id,
      providerId: ctx.provider.id,
      reasonForVisitId: ctx.reason.id,
      checkinUserId: ctx.checkin.id,
      checkoutUserId: ctx.admin.id,
      maUserId: ctx.ma.id,
      clinicianUserId: ctx.clinician.id,
      patientId: "PT-REV-QUERY",
      clinicianData: {
        "coding.working_diagnosis_codes_text": "J01.90",
        "coding.working_procedure_codes_text": "99213",
        "coding.documentation_complete": true,
      },
      checkoutData: {
        "billing.collection_expected": true,
        "billing.amount_due_cents": 3000,
        "billing.amount_collected_cents": 3000,
        "billing.collection_outcome": "CollectedInFull",
        disposition: "Discharged",
      },
    });

    const revenueCase = await prisma.revenueCase.findUnique({ where: { encounterId: finishedEncounter.id } });
    expect(revenueCase).toBeTruthy();

    const createQuery = await app.inject({
      method: "POST",
      url: `/revenue-cases/${revenueCase!.id}/provider-clarifications`,
      headers: authHeaders(ctx.revenue.id, RoleName.RevenueCycle),
      payload: {
        questionText: "Please confirm whether the working diagnosis should be acute sinusitis or chronic sinusitis.",
      },
    });
    expect(createQuery.statusCode).toBe(200);

    const afterCreate = await prisma.revenueCase.findUnique({ where: { id: revenueCase!.id } });
    expect(afterCreate?.currentRevenueStatus).toBe("ProviderClarificationNeeded");

    const clarificationId = createQuery.json().id as string;
    const respond = await app.inject({
      method: "PATCH",
      url: `/provider-clarifications/${clarificationId}`,
      headers: authHeaders(ctx.clinician.id, RoleName.Clinician),
      payload: {
        responseText: "Use acute sinusitis.",
        status: "Responded",
      },
    });
    expect(respond.statusCode).toBe(200);

    const confirmHandoff = await app.inject({
      method: "POST",
      url: `/revenue-cases/${revenueCase!.id}/athena-handoff-confirm`,
      headers: authHeaders(ctx.revenue.id, RoleName.RevenueCycle),
      payload: {
        athenaHandoffNote: "Confirmed manually in Athena for test coverage.",
      },
    });
    expect(confirmHandoff.statusCode).toBe(200);

    const afterRespond = await prisma.revenueCase.findUnique({ where: { id: revenueCase!.id } });
    expect(afterRespond?.currentRevenueStatus).toBe("ProviderClarificationNeeded");

    const resolve = await app.inject({
      method: "PATCH",
      url: `/provider-clarifications/${clarificationId}`,
      headers: authHeaders(ctx.revenue.id, RoleName.RevenueCycle),
      payload: {
        status: "Resolved",
        resolve: true,
      },
    });
    expect(resolve.statusCode).toBe(200);

    const afterResolve = await prisma.revenueCase.findUnique({ where: { id: revenueCase!.id } });
    expect(afterResolve?.athenaHandoffConfirmedAt).toBeTruthy();
    expect(afterResolve?.currentRevenueStatus).toBe("MonitoringOnly");
    expect(afterResolve?.currentWorkQueue).toBe("Monitoring");
  });

  it("blocks revenue closeout until unresolved cases are rolled and persists history rollups", async () => {
    const ctx = await bootstrapCore();
    const finishedEncounter = await createRevenueWorkflowEncounter({
      clinicId: ctx.clinic.id,
      providerId: ctx.provider.id,
      reasonForVisitId: ctx.reason.id,
      checkinUserId: ctx.checkin.id,
      checkoutUserId: ctx.admin.id,
      maUserId: ctx.ma.id,
      clinicianUserId: ctx.clinician.id,
      patientId: "PT-REV-CLOSE",
      clinicianData: {
        "coding.working_diagnosis_codes_text": "M54.5",
        "coding.working_procedure_codes_text": "99214",
        "coding.documentation_complete": true,
      },
    });

    const revenueCase = await prisma.revenueCase.findUnique({ where: { encounterId: finishedEncounter.id } });
    expect(revenueCase).toBeTruthy();

    const blockedClose = await app.inject({
      method: "POST",
      url: "/revenue-closeout",
      headers: authHeaders(ctx.revenue.id, RoleName.RevenueCycle),
      payload: {
        clinicId: ctx.clinic.id,
        date: DateTime.now().toISODate(),
      },
    });
    expect(blockedClose.statusCode).toBe(400);
    expect(blockedClose.json().message).toContain("closeout metadata");

    const closed = await app.inject({
      method: "POST",
      url: "/revenue-closeout",
      headers: authHeaders(ctx.revenue.id, RoleName.RevenueCycle),
      payload: {
        clinicId: ctx.clinic.id,
        date: DateTime.now().toISODate(),
        items: [
          {
            revenueCaseId: revenueCase!.id,
            ownerUserId: ctx.revenue.id,
            ownerRole: RoleName.RevenueCycle,
            reasonNotCompleted: "Coding will finish first thing tomorrow morning.",
            nextAction: "Finish coding review and confirm Athena handoff.",
            dueAt: DateTime.now().plus({ days: 1 }).toISO(),
            rollover: true,
          },
        ],
      },
    });
    expect(closed.statusCode).toBe(200);

    const reloadedCase = await prisma.revenueCase.findUnique({ where: { id: revenueCase!.id } });
    expect(reloadedCase?.currentDayBucket).toBe("Rolled");

    const history = await app.inject({
      method: "GET",
      url: `/dashboard/revenue-cycle/history?clinicId=${ctx.clinic.id}&from=${DateTime.now().minus({ days: 1 }).toISODate()}&to=${DateTime.now().toISODate()}`,
      headers: authHeaders(ctx.revenue.id, RoleName.RevenueCycle),
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().daily.length).toBeGreaterThan(0);
    expect(history.json().daily[history.json().daily.length - 1]).toEqual(
      expect.objectContaining({
        clinicId: ctx.clinic.id,
        unfinishedQueueCountsJson: expect.any(Object),
      }),
    );
  });

  it("reads and updates facility-scoped revenue settings", async () => {
    const ctx = await bootstrapCore();

    const readSettings = await app.inject({
      method: "GET",
      url: `/admin/revenue-settings?facilityId=${ctx.facility.id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
    });
    expect(readSettings.statusCode).toBe(200);
    expect(readSettings.json()).toEqual(
      expect.objectContaining({
        facilityId: ctx.facility.id,
        missedCollectionReasons: expect.any(Array),
        providerQueryTemplates: expect.any(Array),
        estimateDefaults: expect.any(Object),
        reimbursementRules: expect.any(Array),
        serviceCatalog: expect.any(Array),
        chargeSchedule: expect.any(Array),
        checklistDefaults: expect.any(Object),
      }),
    );

    const readSettingsAsMa = await app.inject({
      method: "GET",
      url: `/admin/revenue-settings?facilityId=${ctx.facility.id}`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
    });
    expect(readSettingsAsMa.statusCode).toBe(200);
    expect(readSettingsAsMa.json()).toEqual(
      expect.objectContaining({
        facilityId: ctx.facility.id,
        serviceCatalog: expect.any(Array),
      }),
    );

    const updateSettings = await app.inject({
      method: "POST",
      url: "/admin/revenue-settings",
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
      payload: {
        facilityId: ctx.facility.id,
        missedCollectionReasons: ["patient declined", "eligibility/coverage issue", "other"],
        providerQueryTemplates: ["Please confirm the diagnosis selection."],
        athenaLinkTemplate: "https://athena.example.com/encounters/{encounterId}",
        estimateDefaults: {
          defaultPatientEstimateCents: 4200,
          defaultPosCollectionPercent: 40,
          explainEstimateByDefault: false,
        },
        serviceCatalog: [
          {
            id: "svc-custom",
            label: "Custom MA service",
            suggestedProcedureCode: "99000",
            expectedChargeCents: 5600,
            detailSchemaKey: "generic_service",
            active: true,
          },
        ],
        chargeSchedule: [
          {
            code: "99000",
            amountCents: 5600,
            description: "Handling and conveyance",
            active: true,
          },
        ],
        reimbursementRules: [
          {
            id: "rule-aetna-commercial",
            payerName: "Aetna",
            financialClass: "Commercial",
            expectedPercent: 72,
            active: true,
          },
        ],
      },
    });
    expect(updateSettings.statusCode).toBe(200);
    expect(updateSettings.json()).toEqual(
      expect.objectContaining({
        facilityId: ctx.facility.id,
        athenaLinkTemplate: "https://athena.example.com/encounters/{encounterId}",
        providerQueryTemplates: ["Please confirm the diagnosis selection."],
        estimateDefaults: expect.objectContaining({
          defaultPatientEstimateCents: 4200,
          defaultPosCollectionPercent: 40,
          explainEstimateByDefault: false,
        }),
        serviceCatalog: expect.arrayContaining([
          expect.objectContaining({
            id: "svc-custom",
            detailSchemaKey: "generic_service",
          }),
          expect.objectContaining({
            id: "svc-custom",
            label: "Custom MA service",
          }),
        ]),
        reimbursementRules: expect.arrayContaining([
          expect.objectContaining({
            payerName: "Aetna",
            financialClass: "Commercial",
            expectedPercent: 72,
          }),
        ]),
        chargeSchedule: expect.arrayContaining([
          expect.objectContaining({
            code: "99213",
            amountCents: 14600,
          }),
          expect.objectContaining({
            code: "99000",
            amountCents: 5600,
          }),
        ]),
      }),
    );
  });

  it("surfaces integrity warnings for malformed revenue settings JSON", async () => {
    const ctx = await bootstrapCore();

    await prisma.revenueCycleSettings.upsert({
      where: { facilityId: ctx.facility.id },
      create: {
        facilityId: ctx.facility.id,
        missedCollectionReasonsJson: ["other"],
        queueSlaJson: ["bad"] as unknown as Prisma.InputJsonValue,
        dayCloseDefaultsJson: { defaultDueHours: 24, requireNextAction: true },
        estimateDefaultsJson: ["bad"] as unknown as Prisma.InputJsonValue,
        providerQueryTemplatesJson: ["Confirm diagnosis"],
        athenaChecklistDefaultsJson: { bad: true } as unknown as Prisma.InputJsonValue,
        checklistDefaultsJson: [] as unknown as Prisma.InputJsonValue,
        serviceCatalogJson: { bad: true } as unknown as Prisma.InputJsonValue,
        chargeScheduleJson: { bad: true } as unknown as Prisma.InputJsonValue,
        reimbursementRulesJson: { bad: true } as unknown as Prisma.InputJsonValue,
      },
      update: {
        queueSlaJson: ["bad"] as unknown as Prisma.InputJsonValue,
        estimateDefaultsJson: ["bad"] as unknown as Prisma.InputJsonValue,
        athenaChecklistDefaultsJson: { bad: true } as unknown as Prisma.InputJsonValue,
        checklistDefaultsJson: [] as unknown as Prisma.InputJsonValue,
        serviceCatalogJson: { bad: true } as unknown as Prisma.InputJsonValue,
        chargeScheduleJson: { bad: true } as unknown as Prisma.InputJsonValue,
        reimbursementRulesJson: { bad: true } as unknown as Prisma.InputJsonValue,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/admin/revenue-settings?facilityId=${ctx.facility.id}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        integrityWarnings: expect.arrayContaining([
          expect.objectContaining({ field: "queueSlaJson" }),
          expect.objectContaining({ field: "estimateDefaultsJson" }),
          expect.objectContaining({ field: "athenaChecklistDefaultsJson" }),
          expect.objectContaining({ field: "checklistDefaultsJson" }),
          expect.objectContaining({ field: "serviceCatalogJson" }),
          expect.objectContaining({ field: "chargeScheduleJson" }),
          expect.objectContaining({ field: "reimbursementRulesJson" }),
        ]),
      }),
    );

    const alert = await prisma.userAlertInbox.findFirst({
      where: {
        facilityId: ctx.facility.id,
        sourceId: `revenueCycleSettings:${ctx.facility.id}:serviceCatalogJson`,
      },
    });
    expect(alert).toBeTruthy();
  });
});
