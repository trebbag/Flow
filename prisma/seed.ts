import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient, RoleName, TemplateType } from "@prisma/client";
import { DateTime } from "luxon";
import { normalizeDate } from "../src/lib/dates.js";

const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({
    url: process.env.DATABASE_URL || "file:./prisma/dev.db"
  })
});

async function main() {
  await prisma.auditLog.deleteMany();
  await prisma.eventOutbox.deleteMany();
  await prisma.officeManagerDailyRollup.deleteMany();
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
  await prisma.maProviderMap.deleteMany();
  await prisma.maClinicMap.deleteMany();
  await prisma.temporaryClinicAssignmentOverride.deleteMany();
  await prisma.provider.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.user.deleteMany();
  await prisma.clinic.deleteMany();
  await prisma.integrationConnector.deleteMany();
  await prisma.facility.deleteMany();
  await prisma.alertThreshold.deleteMany();
  await prisma.notificationPolicy.deleteMany();

  const facility = await prisma.facility.create({
    data: {
      name: "Primary Facility",
      shortCode: "PF",
      timezone: "America/New_York"
    }
  });

  const downtown = await prisma.clinic.create({
    data: {
      facilityId: facility.id,
      name: "Downtown Clinic",
      shortCode: "DT",
      timezone: "America/New_York",
      maRun: false,
      cardColor: "#6366f1",
      cardTags: ["family", "urgent"]
    }
  });

  const eastside = await prisma.clinic.create({
    data: {
      facilityId: facility.id,
      name: "Eastside Family Care",
      shortCode: "ES",
      timezone: "America/New_York",
      maRun: true,
      cardColor: "#10b981"
    }
  });

  const admin = await prisma.user.create({
    data: {
      email: "admin@flow.local",
      name: "Flow Admin",
      activeFacilityId: facility.id
    }
  });

  const frontDesk = await prisma.user.create({
    data: {
      email: "checkin@flow.local",
      name: "Check In",
      activeFacilityId: facility.id
    }
  });

  const maOne = await prisma.user.create({
    data: {
      email: "ma1@flow.local",
      name: "Sarah K",
      activeFacilityId: facility.id
    }
  });

  const maTwo = await prisma.user.create({
    data: {
      email: "ma2@flow.local",
      name: "Lisa R",
      activeFacilityId: facility.id
    }
  });

  const clinicianOne = await prisma.user.create({
    data: {
      email: "lchen@flow.local",
      name: "Dr. Lisa Chen",
      activeFacilityId: facility.id
    }
  });

  const officeManager = await prisma.user.create({
    data: {
      email: "office@flow.local",
      name: "Office Manager",
      activeFacilityId: facility.id
    }
  });

  await prisma.userRole.createMany({
    data: [
      { userId: admin.id, role: RoleName.Admin, facilityId: facility.id },
      { userId: frontDesk.id, role: RoleName.FrontDeskCheckIn, facilityId: facility.id },
      { userId: maOne.id, role: RoleName.MA, clinicId: downtown.id, facilityId: facility.id },
      { userId: maTwo.id, role: RoleName.MA, clinicId: eastside.id, facilityId: facility.id },
      { userId: clinicianOne.id, role: RoleName.Clinician, clinicId: downtown.id, facilityId: facility.id },
      { userId: officeManager.id, role: RoleName.OfficeManager, facilityId: facility.id }
    ]
  });

  const providerChen = await prisma.provider.create({
    data: {
      clinicId: downtown.id,
      name: "Dr. Lisa Chen",
      active: true
    }
  });

  const providerPatel = await prisma.provider.create({
    data: {
      clinicId: eastside.id,
      name: "Dr. Sanjay Patel",
      active: true
    }
  });

  await prisma.maProviderMap.create({
    data: {
      clinicId: downtown.id,
      providerId: providerChen.id,
      maUserId: maOne.id
    }
  });

  await prisma.maClinicMap.create({
    data: {
      clinicId: eastside.id,
      maUserId: maTwo.id
    }
  });

  await prisma.clinicAssignment.createMany({
    data: [
      {
        clinicId: downtown.id,
        providerUserId: clinicianOne.id,
        providerId: providerChen.id,
        maUserId: maOne.id
      },
      {
        clinicId: eastside.id,
        providerUserId: null,
        providerId: null,
        maUserId: maTwo.id
      }
    ]
  });

  const reasonFollowUp = await prisma.reasonForVisit.create({
    data: {
      clinicId: downtown.id,
      facilityId: facility.id,
      name: "Follow-up",
      appointmentLengthMinutes: 20,
      status: "active",
      active: true
    }
  });

  const reasonSick = await prisma.reasonForVisit.create({
    data: {
      clinicId: eastside.id,
      facilityId: facility.id,
      name: "Sick Visit",
      appointmentLengthMinutes: 15,
      status: "active",
      active: true
    }
  });

  await prisma.reasonClinicAssignment.createMany({
    data: [
      { reasonId: reasonFollowUp.id, clinicId: downtown.id },
      { reasonId: reasonSick.id, clinicId: eastside.id }
    ]
  });

  const checkinTemplate = await prisma.template.create({
    data: {
      facilityId: facility.id,
      name: "Default Check-In Template",
      status: "active",
      active: true,
      clinicId: null,
      reasonForVisitId: reasonFollowUp.id,
      type: TemplateType.intake,
      fieldsJson: [
        { id: "chiefComplaint", key: "chiefComplaint", label: "Chief Complaint", type: "text", required: true },
        { id: "arrivalNotes", key: "arrivalNotes", label: "Arrival Notes", type: "textarea", required: false }
      ],
      jsonSchema: {
        type: "object",
        properties: {
          chiefComplaint: { type: "string", title: "Chief Complaint" },
          arrivalNotes: { type: "string", title: "Arrival Notes" }
        }
      },
      uiSchema: {},
      requiredFields: ["chiefComplaint"]
    }
  });
  const roomingTemplate = await prisma.template.create({
    data: {
      facilityId: facility.id,
      name: "Default Rooming Template",
      status: "active",
      active: true,
      clinicId: null,
      reasonForVisitId: reasonFollowUp.id,
      type: TemplateType.rooming,
      fieldsJson: [
        { id: "vitals", key: "vitals", label: "Vitals", type: "text", required: true }
      ],
      jsonSchema: {
        type: "object",
        properties: {
          vitals: { type: "string", title: "Vitals" }
        }
      },
      uiSchema: {},
      requiredFields: ["vitals"]
    }
  });
  const clinicianTemplate = await prisma.template.create({
    data: {
      facilityId: facility.id,
      name: "Default Clinician Template",
      status: "active",
      active: true,
      clinicId: null,
      reasonForVisitId: reasonFollowUp.id,
      type: TemplateType.clinician,
      fieldsJson: [
        { id: "assessment", key: "assessment", label: "Assessment", type: "textarea", required: true }
      ],
      jsonSchema: {
        type: "object",
        properties: {
          assessment: { type: "string", title: "Assessment" }
        }
      },
      uiSchema: {},
      requiredFields: ["assessment"]
    }
  });
  const checkoutTemplate = await prisma.template.create({
    data: {
      facilityId: facility.id,
      name: "Default Check-Out Template",
      status: "active",
      active: true,
      clinicId: null,
      reasonForVisitId: reasonFollowUp.id,
      type: TemplateType.checkout,
      fieldsJson: [
        { id: "disposition", key: "disposition", label: "Disposition", type: "text", required: true }
      ],
      jsonSchema: {
        type: "object",
        properties: {
          disposition: { type: "string", title: "Disposition" }
        }
      },
      uiSchema: {},
      requiredFields: ["disposition"]
    }
  });

  await prisma.templateReasonAssignment.createMany({
    data: [
      { templateId: checkinTemplate.id, reasonId: reasonFollowUp.id },
      { templateId: checkinTemplate.id, reasonId: reasonSick.id },
      { templateId: roomingTemplate.id, reasonId: reasonFollowUp.id },
      { templateId: clinicianTemplate.id, reasonId: reasonFollowUp.id },
      { templateId: checkoutTemplate.id, reasonId: reasonFollowUp.id }
    ]
  });

  const downtownRoom1 = await prisma.clinicRoom.create({
    data: {
      facilityId: facility.id,
      name: "Room 1",
      roomNumber: 1,
      roomType: "exam",
      status: "active",
      sortOrder: 1
    }
  });

  const downtownRoom2 = await prisma.clinicRoom.create({
    data: {
      facilityId: facility.id,
      name: "Room 2",
      roomNumber: 2,
      roomType: "exam",
      status: "active",
      sortOrder: 2
    }
  });

  const eastsideRoom1 = await prisma.clinicRoom.create({
    data: {
      facilityId: facility.id,
      name: "Room 3",
      roomNumber: 3,
      roomType: "exam",
      status: "active",
      sortOrder: 3
    }
  });

  await prisma.clinicRoomAssignment.createMany({
    data: [
      { clinicId: downtown.id, roomId: downtownRoom1.id, active: true },
      { clinicId: downtown.id, roomId: downtownRoom2.id, active: true },
      { clinicId: eastside.id, roomId: eastsideRoom1.id, active: true }
    ]
  });

  await prisma.roomOperationalState.createMany({
    data: [
      { roomId: downtownRoom1.id, currentStatus: "Ready", lastReadyAt: new Date() },
      { roomId: downtownRoom2.id, currentStatus: "Ready", lastReadyAt: new Date() },
      { roomId: eastsideRoom1.id, currentStatus: "Ready", lastReadyAt: new Date() }
    ]
  });

  const today = normalizeDate(new Date().toISOString().slice(0, 10), "America/New_York");
  const todayKey = DateTime.now().setZone("America/New_York").toISODate()!;

  await prisma.roomChecklistRun.createMany({
    data: [
      {
        roomId: downtownRoom1.id,
        clinicId: downtown.id,
        facilityId: facility.id,
        kind: "DayStart",
        dateKey: todayKey,
        itemsJson: [{ key: "seed-ready", label: "Seeded room readiness", completed: true }],
        completed: true,
        completedAt: new Date(),
        completedByUserId: admin.id
      },
      {
        roomId: downtownRoom2.id,
        clinicId: downtown.id,
        facilityId: facility.id,
        kind: "DayStart",
        dateKey: todayKey,
        itemsJson: [{ key: "seed-ready", label: "Seeded room readiness", completed: true }],
        completed: true,
        completedAt: new Date(),
        completedByUserId: admin.id
      },
      {
        roomId: eastsideRoom1.id,
        clinicId: eastside.id,
        facilityId: facility.id,
        kind: "DayStart",
        dateKey: todayKey,
        itemsJson: [{ key: "seed-ready", label: "Seeded room readiness", completed: true }],
        completed: true,
        completedAt: new Date(),
        completedByUserId: admin.id
      }
    ]
  });

  const batch = await prisma.incomingImportBatch.create({
    data: {
      facilityId: facility.id,
      clinicId: downtown.id,
      date: today,
      source: "csv",
      fileName: "seed.csv",
      rowCount: 1
    }
  });

  await prisma.incomingSchedule.create({
    data: {
      clinicId: downtown.id,
      dateOfService: today,
      patientId: "PT-10001",
      appointmentTime: "09:00",
      appointmentAt: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 14, 0, 0)),
      providerId: providerChen.id,
      providerLastName: "Chen",
      reasonForVisitId: reasonFollowUp.id,
      reasonText: "Follow-up",
      source: "csv",
      rawPayloadJson: {
        patientId: "PT-10001",
        providerName: "Dr. Lisa Chen",
        reasonForVisit: "Follow-up"
      },
      isValid: true,
      importBatchId: batch.id
    }
  });

  await prisma.encounter.create({
    data: {
      patientId: "PT-20001",
      clinicId: eastside.id,
      providerId: providerPatel.id,
      reasonForVisitId: reasonSick.id,
      currentStatus: "Lobby",
      assignedMaUserId: maTwo.id,
      checkInAt: new Date(),
      dateOfService: today,
      walkIn: true,
      statusEvents: {
        create: {
          fromStatus: null,
          toStatus: "Lobby",
          changedByUserId: frontDesk.id
        }
      },
      alertState: {
        create: {
          enteredStatusAt: new Date(),
          currentAlertLevel: "Green"
        }
      }
    }
  });

  console.info("Seed complete", {
    facilityId: facility.id,
    downtownClinicId: downtown.id,
    eastsideClinicId: eastside.id,
    adminUserId: admin.id,
    frontDeskUserId: frontDesk.id,
    maUserId: maOne.id,
    officeManagerUserId: officeManager.id
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
