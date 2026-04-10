import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { RoleName } from "@prisma/client";
import { buildApp } from "../src/app.js";
import { authHeaders, bootstrapCore, jwtHeaders, prisma, resetDb } from "./helpers.js";

const app = buildApp();

describe("Flow backend core relationships", () => {
  beforeEach(async () => {
    await resetDb();
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
    expect(outbox?.status).toBe("pending");

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
      url: `/dashboard/revenue-cycle?clinicId=${ctx.clinic.id}&date=${date}`,
      headers: authHeaders(ctx.revenue.id, RoleName.RevenueCycle)
    });

    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().optimizedCount).toBeGreaterThanOrEqual(1);
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
      url: `/encounters?clinicId=${ctx.clinic.id}&date=${date}`,
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
      url: `/encounters?clinicId=${ctx.clinic.id}&date=${date}`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });

    expect(list.statusCode).toBe(200);
    const first = list.json()[0];
    expect(first.status).toBe(first.currentStatus);
    expect(first.providerName).toBeTruthy();
    expect(first.reasonForVisit).toBeTruthy();
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
      const date = ctx.day.toISOString().slice(0, 10);
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
        where: { clinicId: ctx.clinic.id, dateOfService: ctx.day }
      });

      // Includes one seed incoming row plus imported rows.
      expect(totalRows).toBeGreaterThanOrEqual(rowCount + 1);
    },
    20000
  );

  it("imports CSV rows with spaced headers and clinic short-name values into accepted + pending buckets", async () => {
    const ctx = await bootstrapCore();
    const date = ctx.day.toISOString().slice(0, 10);
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
        dateOfService: ctx.day,
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
      data: { name: "Jordan Smith NP" }
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
      data: { name: "Jordan Smith NP" }
    });

    const tomorrow = new Date(ctx.day.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const yesterday = new Date(ctx.day.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const csvText = [
      "clinic,patientId,appointmentDate,appointmentTime,providerLastName,reasonForVisit",
      `${ctx.clinic.name} (${ctx.clinic.shortCode}),PT-FUTURE-1,${tomorrow},09:00,Smith,Follow-up`,
      `${ctx.clinic.shortCode},PT-PAST-1,${yesterday},09:15,Smith,Follow-up`,
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
    expect(imported.json().pendingCount).toBe(1);

    const accepted = await prisma.incomingSchedule.findFirst({
      where: { patientId: "PT-FUTURE-1" }
    });
    expect(accepted).toBeTruthy();
    expect(accepted?.dateOfService.toISOString().slice(0, 10)).toBe(tomorrow);

    const pending = await prisma.incomingImportIssue.findFirst({
      where: { facilityId: ctx.facility.id, rawPayloadJson: { not: null } },
      orderBy: { createdAt: "desc" }
    });
    expect(pending).toBeTruthy();
    expect(Array.isArray(pending?.validationErrors)).toBe(true);
    expect((pending?.validationErrors as string[]).some((entry) => entry.toLowerCase().includes("past"))).toBe(true);
  });

  it("enforces required template fields before status transitions", async () => {
    const ctx = await bootstrapCore();

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
        data: { vitals: "120/80" }
      }
    });
    expect(roomingDataSaved.statusCode).toBe(200);

    const toReady = await app.inject({
      method: "PATCH",
      url: `/encounters/${encounter.id}/status`,
      headers: authHeaders(ctx.ma.id, RoleName.MA),
      payload: {
        toStatus: "ReadyForProvider",
        version: encounter.version + 1
      }
    });
    expect(toReady.statusCode).toBe(200);
    expect(toReady.json().currentStatus).toBe("ReadyForProvider");
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
      url: `/encounters?date=${date}`,
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
      url: `/incoming?date=${date}`,
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

    const resetPassword = await app.inject({
      method: "POST",
      url: `/admin/users/${ctx.ma.id}/reset-password`,
      headers: authHeaders(ctx.admin.id, RoleName.Admin)
    });
    expect(resetPassword.statusCode).toBe(200);
    expect(resetPassword.json().status).toBe("queued");

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
      url: `/encounters?clinicId=${ctx.clinic.id}&date=${date}`,
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
      url: `/encounters?clinicId=${ctx.clinic.id}&date=${date}`,
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
        checkInAt: older
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
      url: `/encounters?clinicId=${ctx.clinic.id}&date=${ctx.day.toISOString().slice(0, 10)}`,
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
        checkInAt: oldCheckIn
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
      url: `/encounters?clinicId=${ctx.clinic.id}&date=${ctx.day.toISOString().slice(0, 10)}`,
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
        checkInAt: older
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
      url: `/encounters?clinicId=${ctx.clinic.id}&date=${ctx.day.toISOString().slice(0, 10)}`,
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
});
