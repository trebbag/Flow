import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient, RoleName, TemplateType } from "@prisma/client";
import { SignJWT } from "jose";
import { DateTime } from "luxon";
import { normalizeDate } from "../src/lib/dates.js";

export const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({
    url: process.env.DATABASE_URL || "file:./prisma/dev.db"
  })
});

export async function resetDb() {
  await prisma.auditLog.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.eventOutbox.deleteMany();
  await prisma.workerLease.deleteMany();
  await prisma.revenueCycleDailyRollup.deleteMany();
  await prisma.roomDailyRollup.deleteMany();
  await prisma.officeManagerDailyRollup.deleteMany();
  await prisma.revenueCaseEvent.deleteMany();
  await prisma.revenueChecklistItem.deleteMany();
  await prisma.providerClarification.deleteMany();
  await prisma.chargeCaptureRecord.deleteMany();
  await prisma.checkoutCollectionTracking.deleteMany();
  await prisma.financialReadiness.deleteMany();
  await prisma.revenueCase.deleteMany();
  await prisma.safetyEvent.deleteMany();
  await prisma.roomChecklistRun.deleteMany();
  await prisma.roomIssue.deleteMany();
  await prisma.roomOperationalEvent.deleteMany();
  await prisma.roomOperationalState.deleteMany();
  await prisma.task.deleteMany();
  await prisma.alertState.deleteMany();
  await prisma.statusChangeEvent.deleteMany();
  await prisma.encounter.deleteMany();
  await prisma.incomingSchedule.deleteMany();
  await prisma.incomingImportIssue.deleteMany();
  await prisma.incomingImportBatch.deleteMany();
  await prisma.templateReasonAssignment.deleteMany();
  await prisma.template.deleteMany();
  await prisma.reasonClinicAssignment.deleteMany();
  await prisma.reasonForVisit.deleteMany();
  await prisma.clinicRoomAssignment.deleteMany();
  await prisma.clinicRoom.deleteMany();
  await prisma.clinicAssignment.deleteMany();
  await prisma.maProviderMap.deleteMany();
  await prisma.maClinicMap.deleteMany();
  await prisma.temporaryClinicAssignmentOverride.deleteMany();
  await prisma.provider.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.user.deleteMany();
  await prisma.clinic.deleteMany();
  await prisma.integrationConnector.deleteMany();
  await prisma.patientIdentityReview.deleteMany();
  await prisma.patientAlias.deleteMany();
  await prisma.patient.deleteMany();
  await prisma.facility.deleteMany();
  await prisma.alertThreshold.deleteMany();
  await prisma.notificationPolicy.deleteMany();
}

export async function bootstrapCore() {
  const facility = await prisma.facility.create({
    data: {
      name: "Test Facility",
      shortCode: "TF",
      timezone: "America/New_York"
    }
  });

  const clinic = await prisma.clinic.create({
    data: {
      facilityId: facility.id,
      name: "Clinic A",
      shortCode: "A",
      timezone: "America/New_York",
      maRun: false
    }
  });

  const maRunClinic = await prisma.clinic.create({
    data: {
      facilityId: facility.id,
      name: "Clinic B",
      shortCode: "B",
      timezone: "America/New_York",
      maRun: true
    }
  });

  const admin = await prisma.user.create({
    data: { email: "admin@test.local", name: "Admin", cognitoSub: "sub-admin-test", activeFacilityId: facility.id }
  });
  const checkin = await prisma.user.create({
    data: { email: "checkin@test.local", name: "Checkin", cognitoSub: "sub-checkin-test", activeFacilityId: facility.id }
  });
  const ma = await prisma.user.create({
    data: { email: "ma@test.local", name: "MA One", cognitoSub: "sub-ma1-test", activeFacilityId: facility.id }
  });
  const maTwo = await prisma.user.create({
    data: { email: "ma2@test.local", name: "MA Two", cognitoSub: "sub-ma2-test", activeFacilityId: facility.id }
  });
  const clinician = await prisma.user.create({
    data: { email: "clin@test.local", name: "Dr. A", cognitoSub: "sub-clinician-test", activeFacilityId: facility.id }
  });
  const revenue = await prisma.user.create({
    data: { email: "rev@test.local", name: "Revenue User", cognitoSub: "sub-revenue-test", activeFacilityId: facility.id }
  });
  const officeManager = await prisma.user.create({
    data: { email: "office@test.local", name: "Office Manager", cognitoSub: "sub-office-test", activeFacilityId: facility.id }
  });

  await prisma.userRole.createMany({
    data: [
      { userId: admin.id, role: RoleName.Admin, facilityId: facility.id },
      { userId: checkin.id, role: RoleName.FrontDeskCheckIn, facilityId: facility.id },
      { userId: ma.id, role: RoleName.MA, clinicId: clinic.id, facilityId: facility.id },
      { userId: maTwo.id, role: RoleName.MA, clinicId: maRunClinic.id, facilityId: facility.id },
      { userId: clinician.id, role: RoleName.Clinician, clinicId: clinic.id, facilityId: facility.id },
      { userId: officeManager.id, role: RoleName.OfficeManager, facilityId: facility.id },
      { userId: revenue.id, role: RoleName.RevenueCycle, facilityId: facility.id }
    ]
  });

  const provider = await prisma.provider.create({
    data: {
      clinicId: clinic.id,
      name: "Dr. A",
      active: true
    }
  });

  const maRunProvider = await prisma.provider.create({
    data: {
      clinicId: maRunClinic.id,
      name: "Dr. B",
      active: true
    }
  });

  await prisma.maProviderMap.create({
    data: {
      clinicId: clinic.id,
      providerId: provider.id,
      maUserId: ma.id
    }
  });

  await prisma.maClinicMap.create({
    data: {
      clinicId: maRunClinic.id,
      maUserId: maTwo.id
    }
  });

  await prisma.clinicAssignment.create({
    data: {
      clinicId: clinic.id,
      providerUserId: clinician.id,
      providerId: provider.id,
      maUserId: ma.id
    }
  });

  await prisma.clinicAssignment.create({
    data: {
      clinicId: maRunClinic.id,
      providerUserId: null,
      providerId: null,
      maUserId: maTwo.id
    }
  });

  const clinicRoomA = await prisma.clinicRoom.create({
    data: {
      facilityId: facility.id,
      name: "Room 1",
      roomNumber: 1,
      roomType: "exam",
      status: "active",
      sortOrder: 1
    }
  });
  const clinicRoomB = await prisma.clinicRoom.create({
    data: {
      facilityId: facility.id,
      name: "Room 2",
      roomNumber: 2,
      roomType: "exam",
      status: "active",
      sortOrder: 2
    }
  });
  await prisma.clinicRoomAssignment.createMany({
    data: [
      { clinicId: clinic.id, roomId: clinicRoomA.id, active: true },
      { clinicId: maRunClinic.id, roomId: clinicRoomB.id, active: true }
    ]
  });
  await prisma.roomOperationalState.createMany({
    data: [
      { roomId: clinicRoomA.id, currentStatus: "Ready", lastReadyAt: new Date() },
      { roomId: clinicRoomB.id, currentStatus: "Ready", lastReadyAt: new Date() }
    ]
  });

  const reason = await prisma.reasonForVisit.create({
    data: {
      clinicId: clinic.id,
      facilityId: facility.id,
      appointmentLengthMinutes: 20,
      status: "active",
      name: "Follow-up",
      active: true
    }
  });

  const reasonMaRun = await prisma.reasonForVisit.create({
    data: {
      clinicId: maRunClinic.id,
      facilityId: facility.id,
      appointmentLengthMinutes: 15,
      status: "active",
      name: "Sick Visit",
      active: true
    }
  });

  await prisma.reasonClinicAssignment.createMany({
    data: [
      { reasonId: reason.id, clinicId: clinic.id },
      { reasonId: reasonMaRun.id, clinicId: maRunClinic.id }
    ]
  });

  const roomingTemplate = await prisma.template.create({
    data: {
      facilityId: facility.id,
      name: "Rooming Default",
      status: "active",
      active: true,
      clinicId: null,
      reasonForVisitId: reason.id,
      type: TemplateType.rooming,
      fieldsJson: [{ key: "vitals", label: "Vitals", type: "text", required: true }],
      jsonSchema: { type: "object" },
      uiSchema: {},
      requiredFields: ["vitals"]
    }
  });
  const clinicianTemplate = await prisma.template.create({
    data: {
      facilityId: facility.id,
      name: "Clinician Default",
      status: "active",
      active: true,
      clinicId: null,
      reasonForVisitId: reason.id,
      type: TemplateType.clinician,
      fieldsJson: [{ key: "assessment", label: "Assessment", type: "textarea", required: true }],
      jsonSchema: { type: "object" },
      uiSchema: {},
      requiredFields: ["assessment"]
    }
  });
  const checkoutTemplate = await prisma.template.create({
    data: {
      facilityId: facility.id,
      name: "Checkout Default",
      status: "active",
      active: true,
      clinicId: null,
      reasonForVisitId: reason.id,
      type: TemplateType.checkout,
      fieldsJson: [{ key: "disposition", label: "Disposition", type: "text", required: true }],
      jsonSchema: { type: "object" },
      uiSchema: {},
      requiredFields: ["disposition"]
    }
  });
  await prisma.templateReasonAssignment.createMany({
    data: [
      { templateId: roomingTemplate.id, reasonId: reason.id },
      { templateId: clinicianTemplate.id, reasonId: reason.id },
      { templateId: checkoutTemplate.id, reasonId: reason.id }
    ]
  });

  const day = normalizeDate(DateTime.now().setZone("America/New_York").toISODate()!, "America/New_York");
  const dateKey = DateTime.now().setZone("America/New_York").toISODate()!;

  await prisma.roomChecklistRun.createMany({
    data: [
      {
        roomId: clinicRoomA.id,
        clinicId: clinic.id,
        facilityId: facility.id,
        kind: "DayStart",
        dateKey,
        itemsJson: [{ key: "test", label: "Test Day Start", completed: true }],
        completed: true,
        completedAt: new Date(),
        completedByUserId: admin.id
      },
      {
        roomId: clinicRoomB.id,
        clinicId: maRunClinic.id,
        facilityId: facility.id,
        kind: "DayStart",
        dateKey,
        itemsJson: [{ key: "test", label: "Test Day Start", completed: true }],
        completed: true,
        completedAt: new Date(),
        completedByUserId: admin.id
      }
    ]
  });

  const incomingBatch = await prisma.incomingImportBatch.create({
    data: {
      facilityId: facility.id,
      clinicId: clinic.id,
      date: day,
      source: "csv",
      rowCount: 1,
      fileName: "test.csv"
    }
  });

  const incoming = await prisma.incomingSchedule.create({
    data: {
      clinicId: clinic.id,
      dateOfService: day,
      patientId: "PT-100",
      appointmentTime: "09:00",
      appointmentAt: new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 14, 0, 0)),
      providerId: provider.id,
      providerLastName: "A",
      reasonForVisitId: reason.id,
      reasonText: reason.name,
      source: "csv",
      rawPayloadJson: { source: "test" },
      isValid: true,
      importBatchId: incomingBatch.id
    }
  });

  return {
    facility,
    clinic,
    maRunClinic,
    admin,
    checkin,
    ma,
    maTwo,
    clinician,
    officeManager,
    revenue,
    clinicRoomA,
    clinicRoomB,
    provider,
    maRunProvider,
    reason,
    reasonMaRun,
    incoming,
    day
  };
}

let idempotencyHeaderCounter = 0;

export function authHeaders(userId: string, role: RoleName) {
  idempotencyHeaderCounter += 1;
  return {
    "x-dev-user-id": userId,
    "x-dev-role": role,
    "Idempotency-Key": `test-${userId}-${role}-${idempotencyHeaderCounter}`
  };
}

export async function jwtHeaders(params: {
  sub?: string;
  email?: string;
  role?: RoleName;
  clinicId?: string;
  facilityId?: string;
  subjectClaim?: { key: string; value: string };
  extraClaims?: Record<string, unknown>;
}) {
  const secret = process.env.JWT_SECRET || "dev-local-secret-change-before-pilot";
  const issuer = process.env.JWT_ISSUER || "flow.local";
  const audience = process.env.JWT_AUDIENCE || "flow-web";

  const claims: Record<string, unknown> = { ...(params.extraClaims || {}) };
  if (params.email) claims.email = params.email;
  if (params.role) claims.roles = [params.role];
  if (params.clinicId) claims.clinic_id = params.clinicId;
  if (params.facilityId) claims.facility_id = params.facilityId;
  if (params.subjectClaim?.key && params.subjectClaim.value) {
    claims[params.subjectClaim.key] = params.subjectClaim.value;
  }

  let signer = new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("30m");

  if (params.sub) {
    signer = signer.setSubject(params.sub);
  }

  const token = await signer.sign(new TextEncoder().encode(secret));

  return {
    authorization: `Bearer ${token}`
  };
}
