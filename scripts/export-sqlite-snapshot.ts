import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/prisma.js";

async function main() {
  const outputArg = process.argv[2] || "artifacts/sqlite-snapshot.json";
  const outputPath = path.resolve(process.cwd(), outputArg);

  const snapshot = {
    metadata: {
      exportedAt: new Date().toISOString(),
      sourceDatabaseUrl: process.env.DATABASE_URL || "file:./prisma/dev.db"
    },
    tables: {
      Facility: await prisma.facility.findMany(),
      Clinic: await prisma.clinic.findMany(),
      User: await prisma.user.findMany(),
      UserRole: await prisma.userRole.findMany(),
      Provider: await prisma.provider.findMany(),
      MaProviderMap: await prisma.maProviderMap.findMany(),
      MaClinicMap: await prisma.maClinicMap.findMany(),
      ClinicAssignment: await prisma.clinicAssignment.findMany(),
      ClinicRoom: await prisma.clinicRoom.findMany(),
      ClinicRoomAssignment: await prisma.clinicRoomAssignment.findMany(),
      ReasonForVisit: await prisma.reasonForVisit.findMany(),
      Template: await prisma.template.findMany(),
      IncomingImportBatch: await prisma.incomingImportBatch.findMany(),
      IncomingImportIssue: await prisma.incomingImportIssue.findMany(),
      IncomingSchedule: await prisma.incomingSchedule.findMany(),
      Encounter: await prisma.encounter.findMany(),
      StatusChangeEvent: await prisma.statusChangeEvent.findMany(),
      AlertState: await prisma.alertState.findMany(),
      Task: await prisma.task.findMany(),
      RoomOperationalState: await prisma.roomOperationalState.findMany(),
      RoomOperationalEvent: await prisma.roomOperationalEvent.findMany(),
      RoomIssue: await prisma.roomIssue.findMany(),
      RoomChecklistRun: await prisma.roomChecklistRun.findMany(),
      SafetyEvent: await prisma.safetyEvent.findMany(),
      AlertThreshold: await prisma.alertThreshold.findMany(),
      NotificationPolicy: await prisma.notificationPolicy.findMany(),
      OfficeManagerDailyRollup: await prisma.officeManagerDailyRollup.findMany(),
      AuditLog: await prisma.auditLog.findMany(),
      EventOutbox: await prisma.eventOutbox.findMany(),
      IntegrationConnector: await prisma.integrationConnector.findMany()
    }
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(snapshot, null, 2), "utf8");

  console.info(`SQLite snapshot exported to ${outputPath}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
