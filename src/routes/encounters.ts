import type { FastifyInstance } from "fastify";
import { EncounterStatus, RoleName, TemplateType } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { DateTime } from "luxon";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ApiError, assert } from "../lib/errors.js";
import { dateRangeForDay, normalizeDate } from "../lib/dates.js";
import { requireRoles, type RequestUser } from "../lib/auth.js";
import { refreshEncounterAlertStates } from "../lib/alert-engine.js";
import {
  assertRoomAssignableForEncounter,
  markEncounterRoomNeedsTurnover,
  markEncounterRoomOccupiedInTx
} from "../lib/room-operations.js";
import {
  formatClinicDisplayName,
  formatProviderDisplayName,
  formatReasonDisplayName,
  formatRoomDisplayName,
  formatUserDisplayName
} from "../lib/display-names.js";

const allowedTransitions: Record<EncounterStatus, EncounterStatus[]> = {
  Incoming: ["Lobby"],
  Lobby: ["Rooming"],
  Rooming: ["ReadyForProvider"],
  ReadyForProvider: ["Optimizing"],
  Optimizing: ["CheckOut"],
  CheckOut: ["Optimized"],
  Optimized: []
};

const cancelReasons = [
  "no_show",
  "left_without_being_seen",
  "arrived_late",
  "telehealth_fail",
  "late_cancel",
  "provider_out",
  "emergency",
  "scheduling_error",
  "administrative_block",
  "other"
] as const;

const createEncounterSchema = z.object({
  patientId: z.string().min(1),
  clinicId: z.string().uuid(),
  incomingId: z.string().uuid().optional(),
  providerId: z.string().uuid().optional(),
  providerName: z.string().optional(),
  reasonForVisitId: z.string().uuid().optional(),
  reasonForVisit: z.string().optional(),
  walkIn: z.boolean().optional(),
  insuranceVerified: z.boolean().optional(),
  arrivalNotes: z.string().optional(),
  intakeData: z.record(z.string(), z.unknown()).optional()
});

const updateStatusSchema = z.object({
  toStatus: z.nativeEnum(EncounterStatus),
  version: z.number().int().nonnegative(),
  reasonCode: z.string().optional()
});

const updateRoomingSchema = z.object({
  roomId: z.string().uuid().optional(),
  data: z.record(z.string(), z.unknown()).optional()
});

const assignSchema = z.object({
  assignedMaUserId: z.string().uuid().optional(),
  providerId: z.string().uuid().optional(),
  version: z.number().int().nonnegative(),
  reasonCode: z.string().optional()
});

const startVisitSchema = z.object({
  version: z.number().int().nonnegative()
});

const endVisitSchema = z.object({
  version: z.number().int().nonnegative(),
  data: z.record(z.string(), z.unknown()).optional()
});

const completeCheckoutSchema = z.object({
  version: z.number().int().nonnegative(),
  checkoutData: z.record(z.string(), z.unknown()).optional()
});

const cancelSchema = z
  .object({
    version: z.number().int().nonnegative(),
    reason: z.enum(cancelReasons).optional(),
    note: z.string().optional(),
    closureType: z.string().optional(),
    closureNotes: z.string().optional()
  })
  .transform((value) => ({
    version: value.version,
    reason: (value.reason || value.closureType || "") as (typeof cancelReasons)[number],
    note: value.note || value.closureNotes
  }));

function withStatusAlias<T extends { currentStatus: EncounterStatus }>(encounter: T) {
  return {
    ...encounter,
    status: encounter.currentStatus
  };
}

function withEncounterViewAliases<
  T extends {
    currentStatus: EncounterStatus;
    clinic?: { name: string; status?: string | null } | null;
    provider?: { name: string; active?: boolean | null } | null;
    reason?: { name: string } | null;
    room?: { name: string; status?: string | null } | null;
    assignedMaName?: string | null;
    assignedMaStatus?: string | null;
    appointmentTime?: string | null;
  }
>(encounter: T) {
  return {
    ...withStatusAlias(encounter),
    clinicName: formatClinicDisplayName(encounter.clinic),
    providerName: formatProviderDisplayName(encounter.provider),
    reasonForVisit: formatReasonDisplayName(encounter.reason) || null,
    roomName: formatRoomDisplayName(encounter.room),
    appointmentTime: encounter.appointmentTime || null,
    maName: formatUserDisplayName({
      name: encounter.assignedMaName || null,
      status: encounter.assignedMaStatus || null
    })
  };
}

function formatAppointmentTime(value?: Date | null) {
  if (!value) return null;
  const dt = DateTime.fromJSDate(value);
  if (!dt.isValid) return null;
  return dt.toFormat("HH:mm");
}

async function lookupEncounterAppointmentMap(encounterIds: string[]) {
  if (encounterIds.length === 0) return new Map<string, string | null>();
  const rows = await prisma.incomingSchedule.findMany({
    where: {
      OR: [
        { checkedInEncounterId: { in: encounterIds } },
        { dispositionEncounterId: { in: encounterIds } }
      ]
    },
    select: {
      checkedInEncounterId: true,
      dispositionEncounterId: true,
      appointmentTime: true,
      appointmentAt: true
    },
    orderBy: [{ appointmentAt: "asc" }, { appointmentTime: "asc" }]
  });

  const byEncounterId = new Map<string, string | null>();
  for (const row of rows) {
    const encounterId = row.checkedInEncounterId || row.dispositionEncounterId;
    if (!encounterId || byEncounterId.has(encounterId)) continue;
    byEncounterId.set(encounterId, row.appointmentTime || formatAppointmentTime(row.appointmentAt));
  }
  return byEncounterId;
}

async function getClinicTimezone(clinicId: string) {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { timezone: true }
  });
  assert(clinic, 404, "Clinic not found");
  return clinic.timezone;
}

async function getFacilityTimezone(facilityId?: string | null) {
  const facility = facilityId
    ? await prisma.facility.findUnique({
        where: { id: facilityId },
        select: { timezone: true }
      })
    : await prisma.facility.findFirst({
        where: { status: "active" },
        orderBy: { createdAt: "asc" },
        select: { timezone: true }
      });
  return facility?.timezone || "America/New_York";
}

async function getClinicianProviderIds(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true }
  });
  const name = user?.name?.trim();
  if (!name) return [];

  const providers = await prisma.provider.findMany({
    where: {
      active: true,
      name: {
        equals: name
      }
    },
    select: { id: true }
  });

  return providers.map((provider) => provider.id);
}

type ScopedRequestUser = Pick<RequestUser, "clinicId" | "facilityId">;

function assertClinicInUserScope(user: ScopedRequestUser, clinic: { id: string; facilityId: string | null }) {
  if (user.clinicId && clinic.id !== user.clinicId) {
    throw new ApiError(403, "Clinic is outside your assigned scope");
  }
  if (user.facilityId && clinic.facilityId !== user.facilityId) {
    throw new ApiError(403, "Clinic is outside your assigned scope");
  }
}

async function resolveScopedClinic(user: ScopedRequestUser, clinicId: string) {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { id: true, facilityId: true, timezone: true, status: true, maRun: true }
  });
  assert(clinic, 404, "Clinic not found");
  assertClinicInUserScope(user, clinic);
  return clinic;
}

async function assertEncounterInScope(encounter: { clinicId: string }, user: ScopedRequestUser) {
  const clinic = await prisma.clinic.findUnique({
    where: { id: encounter.clinicId },
    select: { id: true, facilityId: true }
  });
  assert(clinic, 404, "Clinic not found");
  assertClinicInUserScope(user, clinic);
}

async function assertEncounterAccess(
  encounter: { assignedMaUserId: string | null; providerId: string | null },
  userId: string,
  role: RoleName
) {
  if (role === RoleName.Admin || role === RoleName.OfficeManager || role === RoleName.FrontDeskCheckIn || role === RoleName.FrontDeskCheckOut) {
    return;
  }

  if (role === RoleName.MA) {
    if (!encounter.assignedMaUserId || encounter.assignedMaUserId !== userId) {
      throw new ApiError(403, "Access denied: encounter is assigned to another MA.");
    }
    return;
  }

  if (role === RoleName.Clinician) {
    if (!encounter.providerId) {
      throw new ApiError(403, "Access denied: encounter has no provider assignment.");
    }
    const providerIds = await getClinicianProviderIds(userId);
    if (!providerIds.includes(encounter.providerId)) {
      throw new ApiError(403, "Access denied: encounter is assigned to another provider.");
    }
  }
}

async function findActiveTemplateForReason(params: {
  clinicId: string;
  reasonForVisitId: string;
  type: TemplateType;
}) {
  const { clinicId, reasonForVisitId, type } = params;
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { facilityId: true }
  });
  if (!clinic?.facilityId) return null;

  const templates = await prisma.template.findMany({
    where: {
      facilityId: clinic.facilityId,
      type,
      status: "active",
      OR: [
        { reasonForVisitId },
        { reasonAssignments: { some: { reasonId: reasonForVisitId } } }
      ]
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }]
  });

  return templates[0] || null;
}

async function resolveActiveReasonForClinic(params: {
  clinicId: string;
  reasonForVisitId?: string | null;
  reasonName?: string | null;
}) {
  const { clinicId, reasonForVisitId, reasonName } = params;
  const where: Prisma.ReasonForVisitWhereInput = {
    status: "active",
    OR: [{ clinicAssignments: { some: { clinicId } } }, { clinicId }]
  };

  if (reasonForVisitId) {
    return prisma.reasonForVisit.findFirst({
      where: { ...where, id: reasonForVisitId },
      select: { id: true, name: true }
    });
  }
  if (reasonName?.trim()) {
    return prisma.reasonForVisit.findFirst({
      where: {
        ...where,
        name: {
          equals: reasonName.trim()
        }
      },
      orderBy: { name: "asc" },
      select: { id: true, name: true }
    });
  }
  return null;
}

async function ensureRequiredFields(
  encounter: {
    clinicId: string;
    reasonForVisitId: string | null;
    roomingData: unknown;
    clinicianData: unknown;
    checkoutData: unknown;
  },
  toStatus: EncounterStatus,
  overrideData?: Record<string, unknown>
) {
  const templateType: TemplateType | null =
    toStatus === "ReadyForProvider"
      ? TemplateType.rooming
      : toStatus === "CheckOut"
        ? TemplateType.clinician
        : toStatus === "Optimized"
          ? TemplateType.checkout
          : null;

  if (!templateType || !encounter.reasonForVisitId) {
    return;
  }

  const template = await findActiveTemplateForReason({
    clinicId: encounter.clinicId,
    reasonForVisitId: encounter.reasonForVisitId,
    type: templateType
  });
  if (!template) {
    return;
  }

  const required = Array.isArray(template.requiredFields) ? (template.requiredFields as string[]) : [];

  const dataMap =
    overrideData ||
    (templateType === "rooming"
      ? (encounter.roomingData as Record<string, unknown> | null)
      : templateType === "clinician"
        ? (encounter.clinicianData as Record<string, unknown> | null)
        : (encounter.checkoutData as Record<string, unknown> | null));

  const missing = required.filter((field) => !dataMap || !dataMap[field]);
  if (missing.length > 0) {
    throw new ApiError(400, `Required fields missing: ${missing.join(", ")}`);
  }
}

async function listEncountersForRole(filters: {
  clinicId?: string;
  status?: EncounterStatus;
  assignedMaUserId?: string;
  date?: string;
  facilityId?: string | null;
  userId: string;
  role: RoleName;
}) {
  let dateOfService: Date | undefined;
  let dateRange: { start: Date; end: Date } | undefined;

  if (filters.date) {
    if (filters.clinicId) {
      const timezone = await getClinicTimezone(filters.clinicId);
      dateOfService = normalizeDate(filters.date, timezone);
    } else {
      const timezone = await getFacilityTimezone(filters.facilityId);
      dateRange = dateRangeForDay(filters.date, timezone);
    }
  }

  if (filters.role === RoleName.MA) {
    filters.assignedMaUserId = filters.userId;
  }

  let clinicianProviderIds: string[] | undefined;
  if (filters.role === RoleName.Clinician) {
    clinicianProviderIds = await getClinicianProviderIds(filters.userId);
    if (clinicianProviderIds.length === 0) {
      return [];
    }
  }

  const encounters = await prisma.encounter.findMany({
    where: {
      clinicId: filters.clinicId,
      clinic: filters.facilityId ? { facilityId: filters.facilityId } : undefined,
      currentStatus: filters.status,
      assignedMaUserId: filters.assignedMaUserId,
      ...(filters.role === RoleName.Clinician ? { providerId: { in: clinicianProviderIds } } : {}),
      ...(dateRange ? { dateOfService: { gte: dateRange.start, lt: dateRange.end } } : { dateOfService })
    },
    include: {
      clinic: {
        select: {
          id: true,
          name: true,
          status: true,
          shortCode: true,
          cardTags: true,
          cardColor: true
        }
      },
      provider: { select: { id: true, name: true, active: true } },
      reason: { select: { id: true, name: true, status: true } },
      room: { select: { id: true, name: true, status: true } },
      tasks: true,
      alertState: true,
      safetyEvents: {
        where: { resolvedAt: null },
        orderBy: { activatedAt: "desc" },
        take: 1
      }
    },
    orderBy: { checkInAt: "asc" }
  });

  const maUserIds = Array.from(
    new Set(encounters.map((encounter) => encounter.assignedMaUserId).filter((item): item is string => Boolean(item)))
  );

  const maUsers =
    maUserIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: maUserIds } },
          select: { id: true, name: true, status: true }
        })
      : [];

  const maById = new Map(maUsers.map((user) => [user.id, user]));
  const appointmentByEncounterId = await lookupEncounterAppointmentMap(encounters.map((encounter) => encounter.id));

  return encounters.map((encounter) =>
    withEncounterViewAliases({
      ...encounter,
      appointmentTime: appointmentByEncounterId.get(encounter.id) || null,
      assignedMaName: encounter.assignedMaUserId ? maById.get(encounter.assignedMaUserId)?.name || null : null,
      assignedMaStatus: encounter.assignedMaUserId ? maById.get(encounter.assignedMaUserId)?.status || null : null
    })
  );
}

export async function registerEncounterRoutes(app: FastifyInstance) {
  app.post("/encounters", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.Admin) }, async (request) => {
    const dto = createEncounterSchema.parse(request.body);
    const userId = request.user!.id;

    const clinic = await resolveScopedClinic(request.user!, dto.clinicId);
    assert(clinic.status === "active", 400, "Clinic is inactive and cannot be associated with new encounters");

    const now = DateTime.now().setZone(clinic.timezone);
    const startOfDay = now.startOf("day").toUTC();
    const dateIso = now.toISODate() ?? now.toFormat("yyyy-MM-dd");
    const isWalkIn = dto.walkIn === true;

    let incomingRecord: {
      id: string;
      clinicId: string;
      dateOfService: Date;
      patientId: string;
      providerId: string | null;
      providerLastName: string | null;
      reasonForVisitId: string | null;
      appointmentAt: Date | null;
      appointmentTime: string | null;
      isValid: boolean;
      intakeData: Prisma.JsonValue | null;
      checkedInAt: Date | null;
      checkedInEncounterId: string | null;
      dispositionAt: Date | null;
      dispositionEncounterId: string | null;
    } | null = null;

    if (!isWalkIn) {
      if (!dto.incomingId) {
        throw new ApiError(400, "Incoming schedule selection required");
      }
      incomingRecord = await prisma.incomingSchedule.findUnique({ where: { id: dto.incomingId } });
      assert(incomingRecord, 400, "Incoming schedule not found");
      assert(incomingRecord.clinicId === dto.clinicId, 400, "Incoming schedule clinic mismatch");

      const incomingDate = DateTime.fromJSDate(incomingRecord.dateOfService).setZone(clinic.timezone).toISODate();
      assert(incomingDate === dateIso, 400, "Incoming schedule is not for today");
      assert(!incomingRecord.checkedInAt && !incomingRecord.checkedInEncounterId, 400, "Incoming schedule is already checked in for today");
      assert(!incomingRecord.dispositionAt && !incomingRecord.dispositionEncounterId, 400, "Incoming schedule was dispositioned and cannot be checked in");

      if (!incomingRecord.isValid || !incomingRecord.reasonForVisitId || !incomingRecord.providerLastName || !incomingRecord.appointmentAt) {
        throw new ApiError(400, "Incoming row has validation errors. Fix it in Incoming Ops before check-in.");
      }
    }

    const existing = await prisma.encounter.findFirst({
      where: {
        patientId: incomingRecord?.patientId ?? dto.patientId,
        clinicId: dto.clinicId,
        dateOfService: startOfDay.toJSDate()
      }
    });
    if (existing) {
      throw new ApiError(400, "Already checked in today");
    }

    let providerId = incomingRecord?.providerId ?? dto.providerId ?? null;
    if (!providerId) {
      const providerSearch = (dto.providerName || "").trim() || (incomingRecord?.providerLastName || "").trim();
      if (providerSearch) {
        const provider = await prisma.provider.findFirst({
          where: {
            clinicId: dto.clinicId,
            active: true,
            OR: [
              { name: { contains: providerSearch } },
              { name: { endsWith: ` ${providerSearch}` } },
              { name: { equals: providerSearch } }
            ]
          },
          orderBy: { name: "asc" }
        });
        providerId = provider?.id || null;
      }
    }

    let reasonForVisitId = incomingRecord?.reasonForVisitId ?? dto.reasonForVisitId ?? null;
    if (reasonForVisitId) {
      const scopedReason = await resolveActiveReasonForClinic({
        clinicId: dto.clinicId,
        reasonForVisitId
      });
      assert(scopedReason, 400, "Visit reason is inactive or not assigned to this clinic");
      reasonForVisitId = scopedReason.id;
    } else if (dto.reasonForVisit?.trim()) {
      const scopedReason = await resolveActiveReasonForClinic({
        clinicId: dto.clinicId,
        reasonName: dto.reasonForVisit
      });
      reasonForVisitId = scopedReason?.id || null;
    }

    const [roomCount, clinicAssignment] = await Promise.all([
      prisma.clinicRoomAssignment.count({
        where: {
          clinicId: dto.clinicId,
          active: true,
          room: { status: "active" }
        }
      }),
      prisma.clinicAssignment.findUnique({
        where: { clinicId: dto.clinicId },
        include: {
          providerUser: { select: { id: true, status: true } },
          maUser: { select: { id: true, status: true } },
          provider: { select: { id: true, clinicId: true, active: true } }
        }
      })
    ]);

    const maAssignedAndActive = !!clinicAssignment?.maUserId && clinicAssignment.maUser?.status === "active";
    const providerAssignedAndActive =
      clinic.maRun ||
      (!!clinicAssignment?.providerUserId &&
        clinicAssignment.providerUser?.status === "active" &&
        !!clinicAssignment?.providerId &&
        clinicAssignment.provider?.active === true);
    const clinicReady = roomCount > 0 && maAssignedAndActive && providerAssignedAndActive;
    if (!clinicReady) {
      throw new ApiError(
        400,
        clinic.maRun
          ? "Clinic is not ready: assign an active MA and active room before check-in."
          : "Clinic is not ready: assign an active provider, active MA, and active room before check-in."
      );
    }

    if (!providerId && !clinic.maRun) {
      providerId = clinicAssignment?.providerId ?? null;
    }
    if (!clinic.maRun && !providerId) {
      throw new ApiError(400, "Provider is required for non MA-run clinics.");
    }

    if (providerId) {
      const scopedProvider = await prisma.provider.findFirst({
        where: {
          id: providerId,
          clinicId: dto.clinicId,
          active: true
        }
      });
      assert(scopedProvider, 400, "Provider not found for clinic");
      providerId = scopedProvider.id;
    }

    let assignedMaUserId: string | undefined = clinicAssignment?.maUserId || undefined;
    const intakeData =
      (incomingRecord?.intakeData as Prisma.InputJsonValue | null) ??
      (dto.intakeData ? (dto.intakeData as Prisma.InputJsonValue) : null);

    if (reasonForVisitId && intakeData && typeof intakeData === "object") {
      const intakeTemplate = await findActiveTemplateForReason({
        clinicId: dto.clinicId,
        reasonForVisitId,
        type: TemplateType.intake
      });
      if (intakeTemplate) {
        const required = Array.isArray(intakeTemplate.requiredFields)
          ? (intakeTemplate.requiredFields as string[])
          : [];
        const missing = required.filter((field) => !(intakeData as Record<string, unknown>)[field]);
        if (missing.length > 0) {
          throw new ApiError(400, `Required intake fields missing: ${missing.join(", ")}`);
        }
      }
    }

    const encounter = await prisma.$transaction(async (tx) => {
      const created = await tx.encounter.create({
        data: {
          patientId: incomingRecord?.patientId ?? dto.patientId,
          clinicId: dto.clinicId,
          providerId: providerId || undefined,
          reasonForVisitId: reasonForVisitId || undefined,
          currentStatus: "Lobby",
          checkInAt: new Date(),
          dateOfService: startOfDay.toJSDate(),
          walkIn: dto.walkIn ?? false,
          insuranceVerified: dto.insuranceVerified ?? false,
          arrivalNotes: dto.arrivalNotes,
          assignedMaUserId,
          intakeData: intakeData ?? undefined,
          statusEvents: {
            create: {
              fromStatus: null,
              toStatus: "Lobby",
              changedByUserId: userId
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

      if (incomingRecord?.id) {
        const checkedInAt = new Date();
        const siblingWhere: Prisma.IncomingScheduleWhereInput = {
          clinicId: incomingRecord.clinicId,
          dateOfService: incomingRecord.dateOfService,
          patientId: incomingRecord.patientId,
          checkedInAt: null,
          dispositionAt: null
        };

        if (incomingRecord.appointmentTime) {
          siblingWhere.appointmentTime = incomingRecord.appointmentTime;
        } else {
          siblingWhere.appointmentAt = incomingRecord.appointmentAt;
        }

        await tx.incomingSchedule.updateMany({
          where: siblingWhere,
          data: {
            checkedInAt,
            checkedInByUserId: userId,
            checkedInEncounterId: created.id
          }
        });
      }

      return created;
    });

    return withStatusAlias(encounter);
  });

  app.get("/encounters", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.MA, RoleName.Clinician, RoleName.FrontDeskCheckOut, RoleName.OfficeManager, RoleName.Admin) }, async (request) => {
    const query = request.query as {
      clinicId?: string;
      status?: EncounterStatus;
      assignedMaUserId?: string;
      date?: string;
    };
    const user = request.user!;
    const requestedClinicId = query.clinicId?.trim() || undefined;
    const scopedClinicId = user.clinicId || requestedClinicId;
    if (user.clinicId && requestedClinicId && requestedClinicId !== user.clinicId) {
      throw new ApiError(403, "Clinic is outside your assigned scope");
    }
    if (scopedClinicId) {
      await resolveScopedClinic(user, scopedClinicId);
    }

    await refreshEncounterAlertStates(prisma, {
      facilityId: user.facilityId,
      clinicIds: scopedClinicId ? [scopedClinicId] : undefined
    });

    return listEncountersForRole({
      clinicId: scopedClinicId,
      status: query.status,
      assignedMaUserId: query.assignedMaUserId,
      date: query.date,
      facilityId: user.facilityId,
      userId: user.id,
      role: user.role
    });
  });

  app.get("/encounters/:id", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.MA, RoleName.Clinician, RoleName.FrontDeskCheckOut, RoleName.OfficeManager, RoleName.Admin) }, async (request) => {
    const encounterId = (request.params as { id: string }).id;

    await refreshEncounterAlertStates(prisma, {
      encounterIds: [encounterId]
    });

    const encounter = await prisma.encounter.findUnique({
      where: { id: encounterId },
      include: {
        clinic: {
          select: {
            id: true,
            facilityId: true,
            name: true,
            status: true,
            shortCode: true,
            cardTags: true,
            cardColor: true
          }
        },
        provider: { select: { id: true, name: true, active: true } },
        reason: { select: { id: true, name: true, status: true } },
        room: { select: { id: true, name: true, status: true } },
        tasks: true,
        alertState: true,
        safetyEvents: {
          orderBy: { activatedAt: "desc" },
          take: 1
        }
      }
    });

    assert(encounter, 404, "Encounter not found");
    assertClinicInUserScope(request.user!, {
      id: encounter.clinicId,
      facilityId: encounter.clinic?.facilityId || null
    });
    await assertEncounterAccess(encounter, request.user!.id, request.user!.role);

    const assignedMaName = encounter.assignedMaUserId
      ? (
          await prisma.user.findUnique({
            where: { id: encounter.assignedMaUserId },
            select: { name: true, status: true }
          })
        ) || null
      : null;
    const appointmentByEncounterId = await lookupEncounterAppointmentMap([encounter.id]);

    return withEncounterViewAliases({
      ...encounter,
      appointmentTime: appointmentByEncounterId.get(encounter.id) || null,
      assignedMaName: assignedMaName?.name || null,
      assignedMaStatus: assignedMaName?.status || null
    });
  });

  app.patch("/encounters/:id/status", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.MA, RoleName.Clinician, RoleName.FrontDeskCheckOut, RoleName.Admin) }, async (request) => {
    const encounterId = (request.params as { id: string }).id;
    const dto = updateStatusSchema.parse(request.body);

    const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
    assert(encounter, 404, "Encounter not found");
    await assertEncounterInScope(encounter, request.user!);

    await assertEncounterAccess(encounter, request.user!.id, request.user!.role);

    if (dto.version !== encounter.version) {
      throw new ApiError(400, "Version mismatch");
    }

    const allowedNext = allowedTransitions[encounter.currentStatus] || [];
    const isSkip = !allowedNext.includes(dto.toStatus);
    const isAdmin = request.user!.role === RoleName.Admin;

    if (isSkip && !isAdmin) {
      throw new ApiError(400, "Invalid transition");
    }

    if (isSkip && isAdmin && !dto.reasonCode) {
      throw new ApiError(400, "Reason code required for override");
    }

    await ensureRequiredFields(encounter, dto.toStatus);

    const updates: Prisma.EncounterUpdateInput = {
      currentStatus: dto.toStatus,
      version: encounter.version + 1
    };

    if (dto.toStatus === "Rooming") updates.roomingStartAt = encounter.roomingStartAt ?? new Date();
    if (dto.toStatus === "ReadyForProvider") updates.roomingCompleteAt = encounter.roomingCompleteAt ?? new Date();
    if (dto.toStatus === "Optimizing") updates.providerStartAt = encounter.providerStartAt ?? new Date();
    if (dto.toStatus === "CheckOut") updates.providerEndAt = encounter.providerEndAt ?? new Date();

    const updated = await prisma.encounter.update({
      where: { id: encounterId },
      data: {
        ...updates,
        statusEvents: {
          create: {
            fromStatus: encounter.currentStatus,
            toStatus: dto.toStatus,
            changedByUserId: request.user!.id,
            reasonCode: dto.reasonCode
          }
        },
        alertState: {
          update: {
            enteredStatusAt: new Date(),
            currentAlertLevel: "Green"
          }
        }
      }
    });
    if (dto.toStatus === "CheckOut") {
      await markEncounterRoomNeedsTurnover({
        encounter: { id: updated.id, clinicId: updated.clinicId, roomId: updated.roomId },
        userId: request.user!.id
      });
    }
    return withStatusAlias(updated);
  });

  app.patch("/encounters/:id/rooming", { preHandler: requireRoles(RoleName.MA, RoleName.Admin) }, async (request) => {
    const encounterId = (request.params as { id: string }).id;
    const dto = updateRoomingSchema.parse(request.body);

    const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
    assert(encounter, 404, "Encounter not found");
    await assertEncounterInScope(encounter, request.user!);

    await assertEncounterAccess(encounter, request.user!.id, request.user!.role);

    const roomContext = dto.roomId
      ? await assertRoomAssignableForEncounter({
          encounter: { id: encounter.id, clinicId: encounter.clinicId, roomId: encounter.roomId },
          roomId: dto.roomId,
          user: request.user!
        })
      : null;

    const data: Prisma.EncounterUncheckedUpdateInput = {
      roomId: dto.roomId ?? encounter.roomId
    };

    if (dto.data !== undefined) {
      data.roomingData = dto.data as Prisma.InputJsonValue;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.encounter.update({
        where: { id: encounterId },
        data
      });
      if (dto.roomId && roomContext) {
        await markEncounterRoomOccupiedInTx(tx, {
          encounter: { id: row.id, clinicId: row.clinicId, roomId: row.roomId },
          roomId: dto.roomId,
          userId: request.user!.id,
          facilityId: roomContext.facilityId
        });
      }
      return row;
    });
    return withStatusAlias(updated);
  });

  app.post("/encounters/:id/assign", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const encounterId = (request.params as { id: string }).id;
    const dto = assignSchema.parse(request.body);

    const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
    assert(encounter, 404, "Encounter not found");
    await assertEncounterInScope(encounter, request.user!);

    if (dto.version !== encounter.version) {
      throw new ApiError(400, "Version mismatch");
    }

    if (!dto.assignedMaUserId && !dto.providerId) {
      throw new ApiError(400, "Provide at least one reassignment target (MA or provider)");
    }

    const clinic = await prisma.clinic.findUnique({
      where: { id: encounter.clinicId },
      select: { id: true, maRun: true, facilityId: true, status: true }
    });
    assert(clinic, 404, "Clinic not found");
    assert(clinic.status !== "archived", 400, "Cannot reassign encounters for archived clinics");

    const clinicAssignment = await prisma.clinicAssignment.findUnique({
      where: { clinicId: encounter.clinicId },
      include: {
        providerUser: { select: { id: true, status: true } },
        provider: { select: { id: true, active: true } },
        maUser: { select: { id: true, status: true } }
      }
    });

    let nextProviderId = encounter.providerId || null;
    if (dto.providerId) {
      const provider = await prisma.provider.findFirst({
        where: {
          id: dto.providerId,
          clinicId: encounter.clinicId,
          active: true
        }
      });
      assert(provider, 400, "Provider not found for clinic");
      nextProviderId = provider.id;
    }

    if (!nextProviderId && !clinic.maRun) {
      nextProviderId = clinicAssignment?.providerId ?? null;
    }

    if (!clinic.maRun && clinicAssignment?.providerId && nextProviderId !== clinicAssignment.providerId) {
      throw new ApiError(400, "Selected provider is not the clinic's assigned provider");
    }

    if (!clinic.maRun && !nextProviderId) {
      throw new ApiError(400, "Provider is required for non MA-run clinics");
    }

    if (nextProviderId) {
      const activeProvider = await prisma.provider.findFirst({
        where: {
          id: nextProviderId,
          clinicId: encounter.clinicId,
          active: true
        }
      });
      assert(activeProvider, 400, "Provider not found for clinic");
      nextProviderId = activeProvider.id;
    }

    let nextAssignedMaUserId = encounter.assignedMaUserId || null;
    if (dto.assignedMaUserId) {
      const maUser = await prisma.user.findUnique({
        where: { id: dto.assignedMaUserId },
        include: {
          roles: {
            include: {
              clinic: { select: { facilityId: true } }
            }
          }
        }
      });
      assert(maUser, 404, "MA user not found");
      assert(maUser.status === "active", 400, "Selected MA user is not active");
      const hasScopedMaRole = maUser.roles.some((entry) => {
        if (entry.role !== RoleName.MA) return false;
        if (!clinic.facilityId) return true;
        if (entry.facilityId) return entry.facilityId === clinic.facilityId;
        return entry.clinic?.facilityId === clinic.facilityId;
      });
      assert(hasScopedMaRole, 400, "Selected user is not an MA in this facility");
      assert(clinicAssignment?.maUserId, 400, "Clinic does not have an MA assignment");
      assert(clinicAssignment.maUser?.status === "active", 400, "Clinic MA assignment is inactive");
      assert(clinicAssignment.maUserId === dto.assignedMaUserId, 400, "Selected MA is not assigned to this clinic");

      nextAssignedMaUserId = dto.assignedMaUserId;
    } else if (!nextAssignedMaUserId && clinicAssignment?.maUserId && clinicAssignment.maUser?.status === "active") {
      nextAssignedMaUserId = clinicAssignment.maUserId;
    }

    const updated = await prisma.encounter.update({
      where: { id: encounterId },
      data: {
        assignedMaUserId: nextAssignedMaUserId,
        providerId: nextProviderId,
        version: encounter.version + 1
      }
    });
    return withStatusAlias(updated);
  });

  app.post("/encounters/:id/visit/start", { preHandler: requireRoles(RoleName.Clinician, RoleName.Admin) }, async (request) => {
    const encounterId = (request.params as { id: string }).id;
    const dto = startVisitSchema.parse(request.body);

    const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
    assert(encounter, 404, "Encounter not found");
    await assertEncounterInScope(encounter, request.user!);

    await assertEncounterAccess(encounter, request.user!.id, request.user!.role);

    if (dto.version !== encounter.version) {
      throw new ApiError(400, "Version mismatch");
    }

    if (encounter.currentStatus !== "ReadyForProvider") {
      throw new ApiError(400, "Start Visit is only allowed from ReadyForProvider");
    }

    const updated = await prisma.encounter.update({
      where: { id: encounterId },
      data: {
        providerStartAt: encounter.providerStartAt ?? new Date(),
        currentStatus: "Optimizing",
        version: encounter.version + 1,
        statusEvents: {
          create: {
            fromStatus: encounter.currentStatus,
            toStatus: "Optimizing",
            changedByUserId: request.user!.id
          }
        },
        alertState: {
          update: {
            enteredStatusAt: new Date(),
            currentAlertLevel: "Green"
          }
        }
      }
    });
    return withStatusAlias(updated);
  });

  app.post("/encounters/:id/visit/end", { preHandler: requireRoles(RoleName.Clinician, RoleName.Admin) }, async (request) => {
    const encounterId = (request.params as { id: string }).id;
    const dto = endVisitSchema.parse(request.body);

    const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
    assert(encounter, 404, "Encounter not found");
    await assertEncounterInScope(encounter, request.user!);

    await assertEncounterAccess(encounter, request.user!.id, request.user!.role);

    if (dto.version !== encounter.version) {
      throw new ApiError(400, "Version mismatch");
    }

    if (encounter.currentStatus !== "Optimizing") {
      throw new ApiError(400, "Visit must be started before ending");
    }

    await ensureRequiredFields(encounter, "CheckOut", dto.data);

    const data: Prisma.EncounterUpdateInput = {
      providerEndAt: new Date(),
      currentStatus: "CheckOut",
      version: encounter.version + 1,
      statusEvents: {
        create: {
          fromStatus: encounter.currentStatus,
          toStatus: "CheckOut",
          changedByUserId: request.user!.id
        }
      },
      alertState: {
        update: {
          enteredStatusAt: new Date(),
          currentAlertLevel: "Green"
        }
      }
    };

    if (dto.data !== undefined) {
      data.clinicianData = dto.data as Prisma.InputJsonValue;
    }

    const updated = await prisma.encounter.update({
      where: { id: encounterId },
      data
    });
    await markEncounterRoomNeedsTurnover({
      encounter: { id: updated.id, clinicId: updated.clinicId, roomId: updated.roomId },
      userId: request.user!.id
    });
    return withStatusAlias(updated);
  });

  app.post("/encounters/:id/checkout/complete", { preHandler: requireRoles(RoleName.FrontDeskCheckOut, RoleName.Admin) }, async (request) => {
    const encounterId = (request.params as { id: string }).id;
    const dto = completeCheckoutSchema.parse(request.body);

    const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
    assert(encounter, 404, "Encounter not found");
    await assertEncounterInScope(encounter, request.user!);

    await assertEncounterAccess(encounter, request.user!.id, request.user!.role);

    if (dto.version !== encounter.version) {
      throw new ApiError(400, "Version mismatch");
    }

    const blockingTasks = await prisma.task.findMany({
      where: {
        encounterId,
        blocking: true,
        OR: [{ completedAt: null }, { status: { not: "completed" } }]
      }
    });

    if (blockingTasks.length > 0) {
      throw new ApiError(400, "Blocking tasks must be completed");
    }

    await ensureRequiredFields(encounter, "Optimized", dto.checkoutData);

    const data: Prisma.EncounterUpdateInput = {
      checkoutCompleteAt: new Date(),
      currentStatus: "Optimized",
      version: encounter.version + 1,
      statusEvents: {
        create: {
          fromStatus: encounter.currentStatus,
          toStatus: "Optimized",
          changedByUserId: request.user!.id
        }
      },
      alertState: {
        update: {
          enteredStatusAt: new Date(),
          currentAlertLevel: "Green"
        }
      }
    };

    if (dto.checkoutData !== undefined) {
      data.checkoutData = dto.checkoutData as Prisma.InputJsonValue;
    }

    const updated = await prisma.encounter.update({
      where: { id: encounterId },
      data
    });
    return withStatusAlias(updated);
  });

  app.post("/encounters/:id/cancel", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.MA, RoleName.Clinician, RoleName.FrontDeskCheckOut, RoleName.Admin) }, async (request) => {
    const encounterId = (request.params as { id: string }).id;
    const dto = cancelSchema.parse(request.body);

    if (!cancelReasons.includes(dto.reason)) {
      throw new ApiError(400, "Invalid cancellation reason");
    }

    if (dto.reason === "other" && !(dto.note || "").trim()) {
      throw new ApiError(400, "A note is required when reason is other");
    }

    const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
    assert(encounter, 404, "Encounter not found");
    await assertEncounterInScope(encounter, request.user!);

    await assertEncounterAccess(encounter, request.user!.id, request.user!.role);

    if (encounter.currentStatus === "Optimized") {
      throw new ApiError(400, "Encounter is already optimized");
    }

    if (dto.version !== encounter.version) {
      throw new ApiError(400, "Version mismatch");
    }

    const now = new Date();

    const updated = await prisma.encounter.update({
      where: { id: encounterId },
      data: {
        currentStatus: "Optimized",
        checkoutCompleteAt: encounter.checkoutCompleteAt ?? now,
        closedAt: now,
        closureType: dto.reason,
        closureNotes: (dto.note || "").trim() || null,
        version: encounter.version + 1,
        statusEvents: {
          create: {
            fromStatus: encounter.currentStatus,
            toStatus: "Optimized",
            changedByUserId: request.user!.id,
            reasonCode: dto.reason
          }
        },
        alertState: {
          update: {
            enteredStatusAt: now,
            currentAlertLevel: "Green"
          }
        }
      }
    });
    return withStatusAlias(updated);
  });
}
