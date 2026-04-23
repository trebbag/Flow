import type { FastifyInstance, FastifyRequest } from "fastify";
import { EncounterStatus, RoleName, TemplateType } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { DateTime } from "luxon";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ApiError, requireCondition } from "../lib/errors.js";
import { dateRangeForDay, normalizeDate } from "../lib/dates.js";
import { clinicNow } from "../lib/clinic-time.js";
import { booleanish } from "../lib/zod-helpers.js";
import { requireRoles, type RequestUser } from "../lib/auth.js";
import { withIdempotentMutation } from "../lib/idempotency.js";
import { paginateItems, paginationQuerySchema, resolveOptionalPagination } from "../lib/pagination.js";
import { refreshEncounterAlertStates } from "../lib/alert-engine.js";
import {
  assertRoomAssignableForEncounter,
  markEncounterRoomNeedsTurnover,
  markEncounterRoomNeedsTurnoverInTx,
  markEncounterRoomOccupiedInTx
} from "../lib/room-operations.js";
import { CLINICIAN_CODING_KEYS, ROOMING_SERVICE_CAPTURE_KEY, serviceCaptureItemsAreComplete } from "../lib/revenue-cycle.js";
import { queueRevenueEncounterSync } from "../lib/revenue-sync-queue.js";
import { hasActiveTemporaryClinicOverride, listActiveTemporaryClinicOverrideIds } from "../lib/assignment-overrides.js";
import {
  formatClinicDisplayName,
  formatProviderDisplayName,
  formatReasonDisplayName,
  formatRoomDisplayName,
  formatUserDisplayName
} from "../lib/display-names.js";
import { ensurePatientRecord, extractPatientIdentityHints } from "../lib/patients.js";
import {
  asInputJson,
  normalizeEncounterJsonRead,
  normalizeTemplateFieldsJson,
  parseEncounterJsonInput,
} from "../lib/persisted-json.js";
import { flushOperationalOutbox, persistMutationOperationalEventTx } from "../lib/operational-events.js";
import { buildIntegrityWarning, recordPersistedJsonAlert } from "../lib/persisted-json-alerts.js";
import { applyVersionedUpdateTx } from "../lib/versioned-updates.js";
import { enterFacilityScope } from "../lib/facility-scope.js";

const defaultAllowedTransitions: Record<EncounterStatus, EncounterStatus[]> = {
  Incoming: ["Lobby"],
  Lobby: ["Rooming"],
  Rooming: ["ReadyForProvider"],
  ReadyForProvider: ["Optimizing"],
  Optimizing: ["CheckOut"],
  CheckOut: ["Optimized"],
  Optimized: []
};

function getAllowedTransitionsForEncounter(
  currentStatus: EncounterStatus,
  options?: { maRun?: boolean | null },
) {
  if (options?.maRun && currentStatus === "Rooming") {
    return ["CheckOut"] as EncounterStatus[];
  }
  return defaultAllowedTransitions[currentStatus] || [];
}

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
  version: z.number().int().nonnegative().optional(),
  roomId: z.string().uuid().nullable().optional(),
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

const listEncountersSchema = z
  .object({
    clinicId: z.string().uuid().optional(),
    status: z.nativeEnum(EncounterStatus).optional(),
    assignedMaUserId: z.string().uuid().optional(),
    date: z.string().optional(),
    legacyArray: booleanish.optional(),
  })
  .merge(paginationQuerySchema);

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
  requireCondition(clinic, 404, "Clinic not found");
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

async function recordEncounterMutationTx(params: {
  tx: Prisma.TransactionClient;
  request: FastifyRequest;
  encounterId: string;
}) {
  await persistMutationOperationalEventTx({
    db: params.tx,
    request: params.request,
    entityType: "Encounter",
    entityId: params.encounterId,
  });
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

type ScopedRequestUser = Pick<RequestUser, "id" | "role" | "clinicId" | "facilityId">;

async function assertClinicInUserScope(user: ScopedRequestUser, clinic: { id: string; facilityId: string | null }) {
  if (user.clinicId && clinic.id !== user.clinicId) {
    const hasOverride = await hasActiveTemporaryClinicOverride({
      userId: user.id,
      role: user.role,
      clinicId: clinic.id,
      facilityId: user.facilityId || clinic.facilityId
    });
    if (!hasOverride) {
      throw new ApiError(403, "Clinic is outside your assigned scope");
    }
  }
  if (user.facilityId && clinic.facilityId !== user.facilityId) {
    throw new ApiError(403, "Clinic is outside your assigned scope");
  }
}

async function resolveScopedClinic(user: ScopedRequestUser, clinicId: string) {
  if (user.facilityId) {
    enterFacilityScope(user.facilityId);
  }

  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { id: true, facilityId: true, timezone: true, status: true, maRun: true }
  });
  requireCondition(clinic, 404, "Clinic not found");
  await assertClinicInUserScope(user, clinic);
  return clinic;
}

async function assertEncounterInScope(encounter: { clinicId: string }, user: ScopedRequestUser) {
  if (user.facilityId) {
    enterFacilityScope(user.facilityId);
  }

  const clinic = await prisma.clinic.findUnique({
    where: { id: encounter.clinicId },
    select: { id: true, facilityId: true }
  });
  requireCondition(clinic, 404, "Clinic not found");
  await assertClinicInUserScope(user, clinic);
}

async function assertEncounterAccess(
  encounter: { clinicId: string; assignedMaUserId: string | null; providerId: string | null },
  userId: string,
  role: RoleName
) {
  if (
    role === RoleName.Admin ||
    role === RoleName.OfficeManager ||
    role === RoleName.FrontDeskCheckIn ||
    role === RoleName.FrontDeskCheckOut ||
    role === RoleName.RevenueCycle
  ) {
    return;
  }

  if (role === RoleName.MA) {
    const hasClinicOverride = await hasActiveTemporaryClinicOverride({
      userId,
      role,
      clinicId: encounter.clinicId
    });
    if (!hasClinicOverride && (!encounter.assignedMaUserId || encounter.assignedMaUserId !== userId)) {
      throw new ApiError(403, "Access denied: encounter is assigned to another MA.");
    }
    return;
  }

  if (role === RoleName.Clinician) {
    const hasClinicOverride = await hasActiveTemporaryClinicOverride({
      userId,
      role,
      clinicId: encounter.clinicId
    });
    if (hasClinicOverride) return;
    if (!encounter.providerId) throw new ApiError(403, "Access denied: encounter has no provider assignment.");
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

const STANDARD_ROOMING_REQUIRED_FIELDS = [
  "allergiesChanged",
  "medicationReconciliationChanged",
  "labChanged",
  "pharmacyChanged",
] as const;
const ICD10_CODE_PATTERN = /^[A-TV-Z][0-9][0-9A-Z](?:\.[0-9A-Z]{1,4})?$/i;
const CPT_HCPCS_CODE_PATTERN = /^(?:\d{5}|[A-Z]\d{4})$/i;

type TemplateFieldDefinition = {
  key?: string;
  name?: string;
  label?: string;
  type?: string;
};

function getTemplateFieldDefinitions(fieldsJson: Prisma.JsonValue | null | undefined) {
  return normalizeTemplateFieldsJson(fieldsJson).map((field) => {
    const raw = field as Record<string, unknown>;
    return {
      key: typeof raw.key === "string" ? raw.key : undefined,
      name: typeof raw.name === "string" ? raw.name : undefined,
      label: typeof raw.label === "string" ? raw.label : undefined,
      type: typeof raw.type === "string" ? raw.type : undefined,
    };
  }) as TemplateFieldDefinition[];
}

function isTemplateFieldValueMissing(fieldType: string | undefined, value: unknown) {
  const normalizedType = String(fieldType || "").trim().toLowerCase();
  if (normalizedType === "checkbox") {
    return value !== true;
  }
  if (normalizedType === "yesno") {
    if (value === undefined || value === null) return true;
    if (typeof value === "string") return value.trim().length === 0;
    return false;
  }
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "number") return Number.isNaN(value);
  return value === undefined || value === null;
}

function getRoomingDataMap(value: unknown) {
  return (normalizeEncounterJsonRead("roomingData", value as Prisma.JsonValue | null | undefined) || {}) as Record<
    string,
    unknown
  >;
}

function getDataMap(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function mergeTemplateData(
  existing: unknown,
  override?: Record<string, unknown>
) {
  if (!override) return getDataMap(existing);
  return {
    ...getDataMap(existing),
    ...override,
  };
}

function splitDelimitedCodes(value: unknown) {
  if (typeof value !== "string") return [] as string[];
  return value
    .split(/[\n,;]+/)
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);
}

function ensureClinicianCheckoutRequirements(
  encounter: {
    clinicianData: unknown;
  },
  overrideData?: Record<string, unknown>
) {
  const clinicianData = mergeTemplateData(encounter.clinicianData, overrideData);
  const diagnoses = splitDelimitedCodes(clinicianData[CLINICIAN_CODING_KEYS.diagnosisText]);
  const procedures = splitDelimitedCodes(clinicianData[CLINICIAN_CODING_KEYS.procedureText]);

  if (diagnoses.length === 0) {
    throw new ApiError(400, "Clinician checkout requires at least one ICD-10 diagnosis code.");
  }

  const invalidDiagnoses = diagnoses.filter((code) => !ICD10_CODE_PATTERN.test(code));
  if (invalidDiagnoses.length > 0) {
    throw new ApiError(400, `Diagnosis codes must use real ICD-10 format: ${invalidDiagnoses.join(", ")}`);
  }

  if (procedures.length === 0) {
    throw new ApiError(400, "Clinician checkout requires at least one CPT / HCPCS procedure code.");
  }

  const invalidProcedures = procedures.filter((code) => !CPT_HCPCS_CODE_PATTERN.test(code));
  if (invalidProcedures.length > 0) {
    throw new ApiError(400, `Procedure codes must use real CPT / HCPCS format: ${invalidProcedures.join(", ")}`);
  }
}

function ensureStandardRoomingRequirements(encounter: {
  roomId: string | null;
  roomingData: unknown;
}) {
  const roomingData = getRoomingDataMap(encounter.roomingData);
  const missing: string[] = [];

  if (!encounter.roomId) {
    missing.push("room assignment");
  }

  for (const fieldKey of STANDARD_ROOMING_REQUIRED_FIELDS) {
    if (isTemplateFieldValueMissing("yesNo", roomingData[fieldKey])) {
      missing.push(fieldKey);
    }
  }

  const serviceCaptureValue = roomingData[ROOMING_SERVICE_CAPTURE_KEY];
  if (!Array.isArray(serviceCaptureValue) || serviceCaptureValue.length === 0) {
    missing.push("service capture");
  } else if (!serviceCaptureItemsAreComplete(serviceCaptureValue)) {
    missing.push("service capture details");
  }

  if (missing.length > 0) {
    throw new ApiError(400, `Rooming requirements missing: ${missing.join(", ")}`);
  }
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
  const fieldDefinitions = getTemplateFieldDefinitions(template.fieldsJson);
  const fieldDefinitionsByKey = new Map<string, TemplateFieldDefinition>();
  fieldDefinitions.forEach((field) => {
    const key = field.key || field.name;
    if (key) {
      fieldDefinitionsByKey.set(key, field);
    }
  });

  const baseData =
    templateType === "rooming"
      ? encounter.roomingData
      : templateType === "clinician"
        ? encounter.clinicianData
        : encounter.checkoutData;
  const dataMap = mergeTemplateData(baseData, overrideData);

  const missing = required.filter((field) => {
    const fieldType = fieldDefinitionsByKey.get(field)?.type;
    const value = dataMap ? dataMap[field] : undefined;
    return isTemplateFieldValueMissing(fieldType, value);
  });
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
  pagination?: {
    offset: number;
    pageSize: number;
  } | null;
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

  const temporaryOverrideClinicIds = await listActiveTemporaryClinicOverrideIds({
    userId: filters.userId,
    role: filters.role,
    facilityId: filters.facilityId
  });
  const filteredOverrideClinicIds = filters.clinicId
    ? temporaryOverrideClinicIds.filter((clinicId) => clinicId === filters.clinicId)
    : temporaryOverrideClinicIds;

  let clinicianProviderIds: string[] | undefined;
  if (filters.role === RoleName.Clinician) {
    clinicianProviderIds = await getClinicianProviderIds(filters.userId);
    if (clinicianProviderIds.length === 0 && filteredOverrideClinicIds.length === 0) {
      return [];
    }
  }

  const encounters = await prisma.encounter.findMany({
    where: {
      clinicId: filters.clinicId,
      clinic: filters.facilityId ? { facilityId: filters.facilityId } : undefined,
      currentStatus: filters.status,
      ...(filters.role === RoleName.MA
        ? {
            OR: [
              { assignedMaUserId: filters.userId },
              ...(filteredOverrideClinicIds.length > 0 ? [{ clinicId: { in: filteredOverrideClinicIds } }] : [])
            ]
          }
        : {
            assignedMaUserId: filters.assignedMaUserId
          }),
      ...(filters.role === RoleName.Clinician
        ? {
            OR: [
              ...(clinicianProviderIds && clinicianProviderIds.length > 0 ? [{ providerId: { in: clinicianProviderIds } }] : []),
              ...(filteredOverrideClinicIds.length > 0 ? [{ clinicId: { in: filteredOverrideClinicIds } }] : [])
            ]
          }
        : {}),
      ...(dateRange ? { dateOfService: { gte: dateRange.start, lt: dateRange.end } } : { dateOfService })
    },
    include: {
      clinic: {
        select: {
          id: true,
          name: true,
          status: true,
          shortCode: true,
          maRun: true,
          cardTags: true,
          cardColor: true
        }
      },
      provider: { select: { id: true, name: true, active: true } },
      reason: { select: { id: true, name: true, status: true } },
      room: { select: { id: true, name: true, status: true } },
      tasks: true,
      alertState: true,
      statusEvents: {
        orderBy: { changedAt: "asc" },
        select: {
          fromStatus: true,
          toStatus: true,
          changedAt: true,
          reasonCode: true
        }
      },
      safetyEvents: {
        where: { resolvedAt: null },
        orderBy: { activatedAt: "desc" },
        take: 1
      }
    },
    orderBy: [{ checkInAt: "asc" }, { id: "asc" }],
    take: filters.pagination ? filters.pagination.pageSize + 1 : undefined,
    skip: filters.pagination ? filters.pagination.offset : undefined,
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
      roomingData: normalizeEncounterJsonRead("roomingData", encounter.roomingData) || null,
      clinicianData: normalizeEncounterJsonRead("clinicianData", encounter.clinicianData) || null,
      checkoutData: normalizeEncounterJsonRead("checkoutData", encounter.checkoutData) || null,
      intakeData: normalizeEncounterJsonRead("intakeData", encounter.intakeData) || null,
      appointmentTime: appointmentByEncounterId.get(encounter.id) || null,
      assignedMaName: encounter.assignedMaUserId ? maById.get(encounter.assignedMaUserId)?.name || null : null,
      assignedMaStatus: encounter.assignedMaUserId ? maById.get(encounter.assignedMaUserId)?.status || null : null
    })
  );
}

async function getHydratedEncounterView(encounterId: string) {
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
          maRun: true,
          cardTags: true,
          cardColor: true
        }
      },
      provider: { select: { id: true, name: true, active: true } },
      reason: { select: { id: true, name: true, status: true } },
      room: { select: { id: true, name: true, status: true } },
      tasks: true,
      alertState: true,
      statusEvents: {
        orderBy: { changedAt: "asc" },
        select: {
          fromStatus: true,
          toStatus: true,
          changedAt: true,
          reasonCode: true
        }
      },
      safetyEvents: {
        orderBy: { activatedAt: "desc" },
        take: 1
      }
    }
  });

  requireCondition(encounter, 404, "Encounter not found");

  const assignedMa = encounter.assignedMaUserId
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
    roomingData: normalizeEncounterJsonRead("roomingData", encounter.roomingData) || null,
    clinicianData: normalizeEncounterJsonRead("clinicianData", encounter.clinicianData) || null,
    checkoutData: normalizeEncounterJsonRead("checkoutData", encounter.checkoutData) || null,
    intakeData: normalizeEncounterJsonRead("intakeData", encounter.intakeData) || null,
    appointmentTime: appointmentByEncounterId.get(encounter.id) || null,
    assignedMaName: assignedMa?.name || null,
    assignedMaStatus: assignedMa?.status || null
  });
}

async function updateEncounterWithVersionTx(params: {
  tx: Prisma.TransactionClient;
  encounterId: string;
  expectedVersion: number;
  data: Prisma.EncounterUncheckedUpdateManyInput;
  statusEvent?: {
    fromStatus: EncounterStatus | null;
    toStatus: EncounterStatus;
    changedByUserId: string;
    reasonCode?: string;
  };
  resetAlertStateAt?: Date;
}) {
  await applyVersionedUpdateTx({
    update: () =>
      params.tx.encounter.updateMany({
        where: {
          id: params.encounterId,
          version: params.expectedVersion,
        },
        data: {
          ...params.data,
          version: { increment: 1 },
        },
      }),
    findLatest: () =>
      params.tx.encounter.findUnique({
        where: { id: params.encounterId },
        select: { id: true },
      }),
    read: () => Promise.resolve(null),
    notFoundCode: "ENCOUNTER_NOT_FOUND",
    notFoundMessage: "Encounter not found",
    conflictMessage: "Version mismatch",
  });

  if (params.statusEvent) {
    await params.tx.statusChangeEvent.create({
      data: {
        encounterId: params.encounterId,
        ...params.statusEvent,
      },
    });
  }

  if (params.resetAlertStateAt) {
    await params.tx.alertState.upsert({
      where: { encounterId: params.encounterId },
      create: {
        encounterId: params.encounterId,
        enteredStatusAt: params.resetAlertStateAt,
        currentAlertLevel: "Green",
      },
      update: {
        enteredStatusAt: params.resetAlertStateAt,
        currentAlertLevel: "Green",
        yellowTriggeredAt: null,
        redTriggeredAt: null,
        escalationTriggeredAt: null,
      },
    });
  }

  const row = await params.tx.encounter.findUnique({
    where: { id: params.encounterId },
  });
  requireCondition(row, 404, "Encounter not found", "ENCOUNTER_NOT_FOUND");
  return row;
}

export async function registerEncounterRoutes(app: FastifyInstance) {
  app.post("/encounters", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.Admin) }, async (request) => {
    const dto = createEncounterSchema.parse(request.body);
    const userId = request.user!.id;
    return withIdempotentMutation({
      db: prisma,
      request,
      payload: dto,
      execute: async () => {
        const clinic = await resolveScopedClinic(request.user!, dto.clinicId);
        requireCondition(clinic.status === "active", 400, "Clinic is inactive and cannot be associated with new encounters");

        const now = clinicNow(clinic.timezone);
        const startOfDay = now.startOf("day").toUTC();
        const dateIso = now.toISODate() ?? now.toFormat("yyyy-MM-dd");
        const isWalkIn = dto.walkIn === true;

        let incomingRecord: {
          id: string;
          clinicId: string;
          patientRecordId: string | null;
          dateOfService: Date;
          patientId: string;
          providerId: string | null;
          providerLastName: string | null;
          reasonForVisitId: string | null;
          appointmentAt: Date | null;
          appointmentTime: string | null;
          isValid: boolean;
          rawPayloadJson: Prisma.JsonValue;
          intakeData: Prisma.JsonValue | null;
          checkedInAt: Date | null;
          checkedInEncounterId: string | null;
          dispositionAt: Date | null;
          dispositionEncounterId: string | null;
        } | null = null;

        if (!isWalkIn) {
          if (!dto.incomingId) {
            throw new ApiError({ statusCode: 400, code: "INCOMING_SCHEDULE_REQUIRED", message: "Incoming schedule selection required" });
          }
          incomingRecord = await prisma.incomingSchedule.findUnique({ where: { id: dto.incomingId } });
          requireCondition(incomingRecord, 400, "Incoming schedule not found", "INCOMING_SCHEDULE_NOT_FOUND");
          requireCondition(incomingRecord.clinicId === dto.clinicId, 400, "Incoming schedule clinic mismatch", "INCOMING_SCHEDULE_CLINIC_MISMATCH");

          const incomingDate = DateTime.fromJSDate(incomingRecord.dateOfService).setZone(clinic.timezone).toISODate();
          requireCondition(incomingDate === dateIso, 400, "Incoming schedule is not for today", "INCOMING_SCHEDULE_WRONG_DATE");
          requireCondition(
            !incomingRecord.checkedInAt && !incomingRecord.checkedInEncounterId,
            400,
            "Incoming schedule is already checked in for today",
            "INCOMING_SCHEDULE_ALREADY_CHECKED_IN",
          );
          requireCondition(
            !incomingRecord.dispositionAt && !incomingRecord.dispositionEncounterId,
            400,
            "Incoming schedule was dispositioned and cannot be checked in",
            "INCOMING_SCHEDULE_DISPOSITIONED",
          );

          if (!incomingRecord.isValid || !incomingRecord.reasonForVisitId || !incomingRecord.providerLastName || !incomingRecord.appointmentAt) {
            throw new ApiError({
              statusCode: 400,
              code: "INCOMING_SCHEDULE_INVALID",
              message: "Incoming row has validation errors. Fix it in Incoming Ops before check-in.",
            });
          }
        }

        const existing = await prisma.encounter.findFirst({
          where: {
            patientId: incomingRecord?.patientId ?? dto.patientId,
            clinicId: dto.clinicId,
            dateOfService: startOfDay.toJSDate(),
          },
        });
        if (existing) {
          throw new ApiError({ statusCode: 400, code: "DUPLICATE_DAILY_ENCOUNTER", message: "Already checked in today" });
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
                  { name: { equals: providerSearch } },
                ],
              },
              orderBy: { name: "asc" },
            });
            providerId = provider?.id || null;
          }
        }

        let reasonForVisitId = incomingRecord?.reasonForVisitId ?? dto.reasonForVisitId ?? null;
        if (reasonForVisitId) {
          const scopedReason = await resolveActiveReasonForClinic({
            clinicId: dto.clinicId,
            reasonForVisitId,
          });
          requireCondition(scopedReason, 400, "Visit reason is inactive or not assigned to this clinic", "REASON_NOT_ACTIVE_FOR_CLINIC");
          reasonForVisitId = scopedReason.id;
        } else if (dto.reasonForVisit?.trim()) {
          const scopedReason = await resolveActiveReasonForClinic({
            clinicId: dto.clinicId,
            reasonName: dto.reasonForVisit,
          });
          reasonForVisitId = scopedReason?.id || null;
        }

        const [roomCount, clinicAssignment] = await Promise.all([
          prisma.clinicRoomAssignment.count({
            where: {
              clinicId: dto.clinicId,
              active: true,
              room: { status: "active" },
            },
          }),
          prisma.clinicAssignment.findUnique({
            where: { clinicId: dto.clinicId },
            include: {
              providerUser: { select: { id: true, status: true } },
              maUser: { select: { id: true, status: true } },
              provider: { select: { id: true, clinicId: true, active: true } },
            },
          }),
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
          throw new ApiError({
            statusCode: 400,
            code: "CLINIC_NOT_READY",
            message: clinic.maRun
              ? "Clinic is not ready: assign an active MA and active room before check-in."
              : "Clinic is not ready: assign an active provider, active MA, and active room before check-in.",
          });
        }

        if (!providerId && !clinic.maRun) {
          providerId = clinicAssignment?.providerId ?? null;
        }
        if (!clinic.maRun && !providerId) {
          throw new ApiError({ statusCode: 400, code: "PROVIDER_REQUIRED", message: "Provider is required for non MA-run clinics." });
        }

        if (providerId) {
          const scopedProvider = await prisma.provider.findFirst({
            where: {
              id: providerId,
              clinicId: dto.clinicId,
              active: true,
            },
          });
          requireCondition(scopedProvider, 400, "Provider not found for clinic", "PROVIDER_NOT_FOUND_FOR_CLINIC");
          providerId = scopedProvider.id;
        }

        const assignedMaUserId: string | undefined = clinicAssignment?.maUserId || undefined;
        const intakeDataValue =
          incomingRecord?.intakeData ??
          (dto.intakeData !== undefined ? asInputJson(parseEncounterJsonInput("intakeData", dto.intakeData)) : null);

        if (reasonForVisitId && intakeDataValue && typeof intakeDataValue === "object") {
          const intakeTemplate = await findActiveTemplateForReason({
            clinicId: dto.clinicId,
            reasonForVisitId,
            type: TemplateType.intake,
          });
          if (intakeTemplate) {
            const required = Array.isArray(intakeTemplate.requiredFields) ? (intakeTemplate.requiredFields as string[]) : [];
            const fieldDefinitions = getTemplateFieldDefinitions(intakeTemplate.fieldsJson);
            const fieldDefinitionsByKey = new Map<string, TemplateFieldDefinition>();
            fieldDefinitions.forEach((field) => {
              const key = field.key || field.name;
              if (key) {
                fieldDefinitionsByKey.set(key, field);
              }
            });
            const intakeDataMap = getDataMap(intakeDataValue);
            const missing = required.filter((field) => {
              const fieldType = fieldDefinitionsByKey.get(field)?.type;
              return isTemplateFieldValueMissing(fieldType, intakeDataMap[field]);
            });
            if (missing.length > 0) {
              throw new ApiError({
                statusCode: 400,
                code: "REQUIRED_INTAKE_FIELDS_MISSING",
                message: `Required intake fields missing: ${missing.join(", ")}`,
              });
            }
          }
        }

        const encounter = await prisma.$transaction(async (tx) => {
          const identityHints = extractPatientIdentityHints(incomingRecord?.rawPayloadJson, intakeDataValue);
          const patientRecordId =
            incomingRecord?.patientRecordId ||
            (
              await ensurePatientRecord(tx, {
                facilityId: clinic.facilityId || request.user!.facilityId || "",
                sourcePatientId: incomingRecord?.patientId ?? dto.patientId,
                displayName: identityHints.displayName,
                dateOfBirth: identityHints.dateOfBirth,
              })
            ).id;

          const created = await tx.encounter.create({
            data: {
              patientId: incomingRecord?.patientId ?? dto.patientId,
              patientRecordId,
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
              intakeData: intakeDataValue ?? undefined,
              statusEvents: {
                create: {
                  fromStatus: null,
                  toStatus: "Lobby",
                  changedByUserId: userId,
                },
              },
              alertState: {
                create: {
                  enteredStatusAt: new Date(),
                  currentAlertLevel: "Green",
                },
              },
            },
          });

          if (incomingRecord?.id) {
            const checkedInAt = new Date();
            const siblingWhere: Prisma.IncomingScheduleWhereInput = {
              clinicId: incomingRecord.clinicId,
              dateOfService: incomingRecord.dateOfService,
              patientId: incomingRecord.patientId,
              checkedInAt: null,
              dispositionAt: null,
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
                checkedInEncounterId: created.id,
                patientRecordId,
              },
            });
          }

          await queueRevenueEncounterSync(tx, created.id, request.correlationId || request.id);
          await recordEncounterMutationTx({
            tx,
            request,
            encounterId: created.id,
          });
          return created;
        });

        await flushOperationalOutbox(prisma);
        return getHydratedEncounterView(encounter.id);
      },
    });
  });

  app.get("/encounters", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.MA, RoleName.Clinician, RoleName.FrontDeskCheckOut, RoleName.OfficeManager, RoleName.Admin, RoleName.RevenueCycle) }, async (request) => {
    const query = listEncountersSchema.parse(request.query);
    const user = request.user!;
    const requestedClinicId = query.clinicId?.trim() || undefined;
    const scopedClinicId =
      requestedClinicId ||
      (user.role === RoleName.MA || user.role === RoleName.Clinician ? undefined : user.clinicId || undefined);
    const pagination = query.legacyArray
      ? null
      : resolveOptionalPagination(
          {
            cursor: query.cursor,
            pageSize: query.pageSize ?? 100,
          },
          { pageSize: 100 },
        );
    if (scopedClinicId) {
      await resolveScopedClinic(user, scopedClinicId);
    }

    await refreshEncounterAlertStates(prisma, {
      facilityId: user.facilityId,
      clinicIds: scopedClinicId ? [scopedClinicId] : undefined
    });

    const rows = await listEncountersForRole({
      clinicId: scopedClinicId,
      status: query.status,
      assignedMaUserId: query.assignedMaUserId,
      date: query.date,
      facilityId: user.facilityId,
      userId: user.id,
      role: user.role,
      pagination,
    });

    if (query.legacyArray) {
      return rows;
    }

    return paginateItems(rows, pagination);
  });

  app.get("/encounters/:id", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.MA, RoleName.Clinician, RoleName.FrontDeskCheckOut, RoleName.OfficeManager, RoleName.Admin, RoleName.RevenueCycle) }, async (request) => {
    const encounterId = (request.params as { id: string }).id;

    await refreshEncounterAlertStates(prisma, {
      encounterIds: [encounterId]
    });

    const callerFacilityId = request.user!.facilityId;
    const encounter = await prisma.encounter.findFirst({
      where: {
        id: encounterId,
        ...(callerFacilityId ? { clinic: { facilityId: callerFacilityId } } : {})
      },
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
        statusEvents: {
          orderBy: { changedAt: "asc" },
          select: {
            fromStatus: true,
            toStatus: true,
            changedAt: true,
            reasonCode: true
          }
        },
        safetyEvents: {
          orderBy: { activatedAt: "desc" },
          take: 1
        }
      }
    });

    requireCondition(encounter, 404, "Encounter not found");
    await assertClinicInUserScope(request.user!, {
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

    const roomingData = normalizeEncounterJsonRead("roomingData", encounter.roomingData, request.log);
    const clinicianData = normalizeEncounterJsonRead("clinicianData", encounter.clinicianData, request.log);
    const checkoutData = normalizeEncounterJsonRead("checkoutData", encounter.checkoutData, request.log);
    const intakeData = normalizeEncounterJsonRead("intakeData", encounter.intakeData, request.log);
    const integrityWarnings = [
      encounter.roomingData !== null && roomingData === null ? buildIntegrityWarning("roomingData") : null,
      encounter.clinicianData !== null && clinicianData === null ? buildIntegrityWarning("clinicianData") : null,
      encounter.checkoutData !== null && checkoutData === null ? buildIntegrityWarning("checkoutData") : null,
      encounter.intakeData !== null && intakeData === null ? buildIntegrityWarning("intakeData") : null,
    ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

    if (integrityWarnings.length > 0 && encounter.clinic?.facilityId) {
      await Promise.all(
        integrityWarnings.map((warning) =>
          recordPersistedJsonAlert({
            facilityId: encounter.clinic!.facilityId!,
            clinicId: encounter.clinicId,
            entityType: "Encounter",
            entityId: encounter.id,
            field: warning.field,
            requestId: request.correlationId || request.id,
          }),
        ),
      );
    }

    return withEncounterViewAliases({
      ...encounter,
      roomingData,
      clinicianData,
      checkoutData,
      intakeData,
      appointmentTime: appointmentByEncounterId.get(encounter.id) || null,
      assignedMaName: assignedMaName?.name || null,
      assignedMaStatus: assignedMaName?.status || null,
      integrityWarnings,
    });
  });

  app.patch("/encounters/:id/status", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.MA, RoleName.Clinician, RoleName.FrontDeskCheckOut, RoleName.Admin) }, async (request) => {
    const encounterId = (request.params as { id: string }).id;
    const dto = updateStatusSchema.parse(request.body);
    return withIdempotentMutation({
      db: prisma,
      request,
      payload: dto,
      execute: async () => {
        const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
        requireCondition(encounter, 404, "Encounter not found", "ENCOUNTER_NOT_FOUND");
        await assertEncounterInScope(encounter, request.user!);
        const clinic = await prisma.clinic.findUnique({
          where: { id: encounter.clinicId },
          select: { maRun: true },
        });
        requireCondition(clinic, 404, "Clinic not found", "CLINIC_NOT_FOUND");

        await assertEncounterAccess(encounter, request.user!.id, request.user!.role);

        const allowedNext = getAllowedTransitionsForEncounter(encounter.currentStatus, { maRun: clinic.maRun });
        const isSkip = !allowedNext.includes(dto.toStatus);
        const isAdmin = request.user!.role === RoleName.Admin;
        const isMaRunRoomingToCheckout =
          clinic.maRun &&
          encounter.currentStatus === EncounterStatus.Rooming &&
          dto.toStatus === EncounterStatus.CheckOut;

        if (isSkip && !isAdmin) {
          throw new ApiError({ statusCode: 400, code: "INVALID_STATUS_TRANSITION", message: "Invalid transition" });
        }

        if (isSkip && isAdmin && !dto.reasonCode) {
          throw new ApiError({ statusCode: 400, code: "OVERRIDE_REASON_REQUIRED", message: "Reason code required for override" });
        }

        await ensureRequiredFields(encounter, isMaRunRoomingToCheckout ? EncounterStatus.ReadyForProvider : dto.toStatus);
        if (dto.toStatus === "ReadyForProvider" || isMaRunRoomingToCheckout) {
          ensureStandardRoomingRequirements(encounter);
        }

        const updated = await prisma.$transaction(async (tx) => {
          const updates: Prisma.EncounterUncheckedUpdateManyInput = {
            currentStatus: dto.toStatus,
          };

          if (dto.toStatus === "Rooming") updates.roomingStartAt = encounter.roomingStartAt ?? new Date();
          if (dto.toStatus === "ReadyForProvider") updates.roomingCompleteAt = encounter.roomingCompleteAt ?? new Date();
          if (dto.toStatus === "Optimizing") updates.providerStartAt = encounter.providerStartAt ?? new Date();
          if (dto.toStatus === "CheckOut") updates.providerEndAt = encounter.providerEndAt ?? new Date();
          if (isMaRunRoomingToCheckout) updates.roomingCompleteAt = encounter.roomingCompleteAt ?? new Date();

          const statusChangedAt = new Date();
          const row = await updateEncounterWithVersionTx({
            tx,
            encounterId,
            expectedVersion: dto.version,
            data: updates,
            statusEvent: {
              fromStatus: encounter.currentStatus,
              toStatus: dto.toStatus,
              changedByUserId: request.user!.id,
              reasonCode: dto.reasonCode,
            },
            resetAlertStateAt: statusChangedAt,
          });
          if (dto.toStatus === "CheckOut") {
            await markEncounterRoomNeedsTurnoverInTx(tx, {
              encounter: { id: row.id, clinicId: row.clinicId, roomId: row.roomId },
              userId: request.user!.id,
            });
          }
          await queueRevenueEncounterSync(tx, row.id, request.correlationId || request.id);
          await recordEncounterMutationTx({
            tx,
            request,
            encounterId: row.id,
          });
          return row;
        });

        await flushOperationalOutbox(prisma);
        return getHydratedEncounterView(updated.id);
      },
    });
  });

  app.patch("/encounters/:id/rooming", { preHandler: requireRoles(RoleName.MA, RoleName.Admin) }, async (request) => {
    const encounterId = (request.params as { id: string }).id;
    const dto = updateRoomingSchema.parse(request.body);
    return withIdempotentMutation({
      db: prisma,
      request,
      payload: dto,
      execute: async () => {
        const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
        requireCondition(encounter, 404, "Encounter not found", "ENCOUNTER_NOT_FOUND");
        await assertEncounterInScope(encounter, request.user!);

        await assertEncounterAccess(encounter, request.user!.id, request.user!.role);

        const hasRoomUpdate = Object.prototype.hasOwnProperty.call(dto, "roomId");
        const nextRoomId = hasRoomUpdate ? dto.roomId ?? null : encounter.roomId;
        const isChangingRooms = hasRoomUpdate && nextRoomId !== encounter.roomId;

        const roomContext = isChangingRooms && dto.roomId
          ? await assertRoomAssignableForEncounter({
              encounter: { id: encounter.id, clinicId: encounter.clinicId, roomId: encounter.roomId },
              roomId: dto.roomId,
              user: request.user!,
            })
          : null;

        const data: Prisma.EncounterUncheckedUpdateManyInput = {
          roomId: nextRoomId,
        };

        if (dto.data !== undefined) {
          data.roomingData = asInputJson(parseEncounterJsonInput("roomingData", dto.data));
        }

        const updated = await prisma.$transaction(async (tx) => {
          const row = await updateEncounterWithVersionTx({
            tx,
            encounterId,
            expectedVersion: dto.version ?? encounter.version,
            data,
          });
          if (isChangingRooms && encounter.roomId) {
            await markEncounterRoomNeedsTurnoverInTx(tx, {
              encounter: { id: row.id, clinicId: row.clinicId, roomId: encounter.roomId },
              userId: request.user!.id,
            });
          }
          if (isChangingRooms && dto.roomId && roomContext) {
            await markEncounterRoomOccupiedInTx(tx, {
              encounter: { id: row.id, clinicId: row.clinicId, roomId: row.roomId },
              roomId: dto.roomId,
              userId: request.user!.id,
              facilityId: roomContext.facilityId,
            });
          }
          await queueRevenueEncounterSync(tx, row.id, request.correlationId || request.id);
          await recordEncounterMutationTx({
            tx,
            request,
            encounterId: row.id,
          });
          return row;
        });
        await flushOperationalOutbox(prisma);
        return getHydratedEncounterView(updated.id);
      },
    });
  });

  app.post("/encounters/:id/assign", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const encounterId = (request.params as { id: string }).id;
    const dto = assignSchema.parse(request.body);
    return withIdempotentMutation({
      db: prisma,
      request,
      payload: dto,
      execute: async () => {
        const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
        requireCondition(encounter, 404, "Encounter not found", "ENCOUNTER_NOT_FOUND");
        await assertEncounterInScope(encounter, request.user!);

        if (!dto.assignedMaUserId && !dto.providerId) {
          throw new ApiError({
            statusCode: 400,
            code: "REASSIGNMENT_TARGET_REQUIRED",
            message: "Provide at least one reassignment target (MA or provider)",
          });
        }

        const clinic = await prisma.clinic.findUnique({
          where: { id: encounter.clinicId },
          select: { id: true, maRun: true, facilityId: true, status: true },
        });
        requireCondition(clinic, 404, "Clinic not found", "CLINIC_NOT_FOUND");
        requireCondition(clinic.status !== "archived", 400, "Cannot reassign encounters for archived clinics", "CLINIC_ARCHIVED");

        const clinicAssignment = await prisma.clinicAssignment.findUnique({
          where: { clinicId: encounter.clinicId },
          include: {
            providerUser: { select: { id: true, status: true } },
            provider: { select: { id: true, active: true } },
            maUser: { select: { id: true, status: true } },
          },
        });

        let nextProviderId = encounter.providerId || null;
        if (dto.providerId) {
          const provider = await prisma.provider.findFirst({
            where: {
              id: dto.providerId,
              clinicId: encounter.clinicId,
              active: true,
            },
          });
          requireCondition(provider, 400, "Provider not found for clinic", "PROVIDER_NOT_FOUND_FOR_CLINIC");
          nextProviderId = provider.id;
        }

        if (!nextProviderId && !clinic.maRun) {
          nextProviderId = clinicAssignment?.providerId ?? null;
        }

        if (!clinic.maRun && clinicAssignment?.providerId && nextProviderId !== clinicAssignment.providerId) {
          throw new ApiError({
            statusCode: 400,
            code: "PROVIDER_OUTSIDE_CLINIC_ASSIGNMENT",
            message: "Selected provider is not the clinic's assigned provider",
          });
        }

        if (!clinic.maRun && !nextProviderId) {
          throw new ApiError({ statusCode: 400, code: "PROVIDER_REQUIRED", message: "Provider is required for non MA-run clinics" });
        }

        if (nextProviderId) {
          const activeProvider = await prisma.provider.findFirst({
            where: {
              id: nextProviderId,
              clinicId: encounter.clinicId,
              active: true,
            },
          });
          requireCondition(activeProvider, 400, "Provider not found for clinic", "PROVIDER_NOT_FOUND_FOR_CLINIC");
          nextProviderId = activeProvider.id;
        }

        let nextAssignedMaUserId = encounter.assignedMaUserId || null;
        if (dto.assignedMaUserId) {
          const maUser = await prisma.user.findUnique({
            where: { id: dto.assignedMaUserId },
            include: {
              roles: {
                include: {
                  clinic: { select: { facilityId: true } },
                },
              },
            },
          });
          requireCondition(maUser, 404, "MA user not found", "MA_USER_NOT_FOUND");
          requireCondition(maUser.status === "active", 400, "Selected MA user is not active", "MA_USER_INACTIVE");
          const hasScopedMaRole = maUser.roles.some((entry) => {
            if (entry.role !== RoleName.MA) return false;
            if (!clinic.facilityId) return true;
            if (entry.facilityId) return entry.facilityId === clinic.facilityId;
            return entry.clinic?.facilityId === clinic.facilityId;
          });
          requireCondition(hasScopedMaRole, 400, "Selected user is not an MA in this facility", "MA_USER_OUTSIDE_SCOPE");
          requireCondition(clinicAssignment?.maUserId, 400, "Clinic does not have an MA assignment", "CLINIC_MA_ASSIGNMENT_MISSING");
          requireCondition(clinicAssignment.maUser?.status === "active", 400, "Clinic MA assignment is inactive", "CLINIC_MA_ASSIGNMENT_INACTIVE");
          requireCondition(clinicAssignment.maUserId === dto.assignedMaUserId, 400, "Selected MA is not assigned to this clinic", "MA_USER_NOT_ASSIGNED_TO_CLINIC");

          nextAssignedMaUserId = dto.assignedMaUserId;
        } else if (!nextAssignedMaUserId && clinicAssignment?.maUserId && clinicAssignment.maUser?.status === "active") {
          nextAssignedMaUserId = clinicAssignment.maUserId;
        }

        const updated = await prisma.$transaction(async (tx) => {
          const row = await updateEncounterWithVersionTx({
            tx,
            encounterId,
            expectedVersion: dto.version,
            data: {
              assignedMaUserId: nextAssignedMaUserId,
              providerId: nextProviderId,
            },
          });
          await queueRevenueEncounterSync(tx, row.id, request.correlationId || request.id);
          await recordEncounterMutationTx({
            tx,
            request,
            encounterId: row.id,
          });
          return row;
        });
        await flushOperationalOutbox(prisma);
        return getHydratedEncounterView(updated.id);
      },
    });
  });

  app.post("/encounters/:id/visit/start", { preHandler: requireRoles(RoleName.Clinician, RoleName.Admin) }, async (request) => {
    const encounterId = (request.params as { id: string }).id;
    const dto = startVisitSchema.parse(request.body);
    return withIdempotentMutation({
      db: prisma,
      request,
      payload: dto,
      execute: async () => {
        const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
        requireCondition(encounter, 404, "Encounter not found", "ENCOUNTER_NOT_FOUND");
        await assertEncounterInScope(encounter, request.user!);

        await assertEncounterAccess(encounter, request.user!.id, request.user!.role);

        if (encounter.currentStatus !== "ReadyForProvider") {
          throw new ApiError({
            statusCode: 400,
            code: "VISIT_START_INVALID_STATUS",
            message: "Start Visit is only allowed from ReadyForProvider",
          });
        }

        const updated = await prisma.$transaction(async (tx) =>
          {
            const row = await updateEncounterWithVersionTx({
              tx,
              encounterId,
              expectedVersion: dto.version,
              data: {
                providerStartAt: encounter.providerStartAt ?? new Date(),
                currentStatus: "Optimizing",
              },
              statusEvent: {
                fromStatus: encounter.currentStatus,
                toStatus: "Optimizing",
                changedByUserId: request.user!.id,
              },
              resetAlertStateAt: new Date(),
            });
            await recordEncounterMutationTx({
              tx,
              request,
              encounterId: row.id,
            });
            return row;
          },
        );
        await flushOperationalOutbox(prisma);
        return getHydratedEncounterView(updated.id);
      },
    });
  });

  app.post("/encounters/:id/visit/end", { preHandler: requireRoles(RoleName.Clinician, RoleName.Admin) }, async (request) => {
    const encounterId = (request.params as { id: string }).id;
    const dto = endVisitSchema.parse(request.body);
    return withIdempotentMutation({
      db: prisma,
      request,
      payload: dto,
      execute: async () => {
        const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
        requireCondition(encounter, 404, "Encounter not found", "ENCOUNTER_NOT_FOUND");
        await assertEncounterInScope(encounter, request.user!);

        await assertEncounterAccess(encounter, request.user!.id, request.user!.role);

        if (encounter.currentStatus !== "Optimizing") {
          throw new ApiError({ statusCode: 400, code: "VISIT_END_INVALID_STATUS", message: "Visit must be started before ending" });
        }

        const clinicianData = dto.data !== undefined ? parseEncounterJsonInput("clinicianData", dto.data) : undefined;
        await ensureRequiredFields(encounter, "CheckOut", clinicianData);
        ensureClinicianCheckoutRequirements(encounter, clinicianData);

        const updated = await prisma.$transaction(async (tx) => {
          const data: Prisma.EncounterUncheckedUpdateManyInput = {
            providerEndAt: new Date(),
            currentStatus: "CheckOut",
          };

          if (clinicianData !== undefined) {
            data.clinicianData = asInputJson(clinicianData);
          }

          const statusChangedAt = new Date();
          const row = await updateEncounterWithVersionTx({
            tx,
            encounterId,
            expectedVersion: dto.version,
            data,
            statusEvent: {
              fromStatus: encounter.currentStatus,
              toStatus: "CheckOut",
              changedByUserId: request.user!.id,
            },
            resetAlertStateAt: statusChangedAt,
          });
          await markEncounterRoomNeedsTurnoverInTx(tx, {
            encounter: { id: row.id, clinicId: row.clinicId, roomId: row.roomId },
            userId: request.user!.id,
          });
          await queueRevenueEncounterSync(tx, row.id, request.correlationId || request.id);
          await recordEncounterMutationTx({
            tx,
            request,
            encounterId: row.id,
          });
          return row;
        });
        await flushOperationalOutbox(prisma);
        return getHydratedEncounterView(updated.id);
      },
    });
  });

  app.post("/encounters/:id/checkout/complete", { preHandler: requireRoles(RoleName.FrontDeskCheckOut, RoleName.Admin) }, async (request) => {
    const encounterId = (request.params as { id: string }).id;
    const dto = completeCheckoutSchema.parse(request.body);
    return withIdempotentMutation({
      db: prisma,
      request,
      payload: dto,
      execute: async () => {
        const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
        requireCondition(encounter, 404, "Encounter not found", "ENCOUNTER_NOT_FOUND");
        await assertEncounterInScope(encounter, request.user!);

        await assertEncounterAccess(encounter, request.user!.id, request.user!.role);

        const blockingTasks = await prisma.task.findMany({
          where: {
            encounterId,
            blocking: true,
            OR: [{ completedAt: null }, { status: { not: "completed" } }],
          },
        });

        if (blockingTasks.length > 0) {
          throw new ApiError({ statusCode: 400, code: "BLOCKING_TASKS_INCOMPLETE", message: "Blocking tasks must be completed" });
        }

        const checkoutData = dto.checkoutData !== undefined ? parseEncounterJsonInput("checkoutData", dto.checkoutData) : undefined;
        await ensureRequiredFields(encounter, "Optimized", checkoutData);

        const updated = await prisma.$transaction(async (tx) => {
          const data: Prisma.EncounterUncheckedUpdateManyInput = {
            checkoutCompleteAt: new Date(),
            currentStatus: "Optimized",
          };

          if (checkoutData !== undefined) {
            data.checkoutData = asInputJson(checkoutData);
          }

          const statusChangedAt = new Date();
          const row = await updateEncounterWithVersionTx({
            tx,
            encounterId,
            expectedVersion: dto.version,
            data,
            statusEvent: {
              fromStatus: encounter.currentStatus,
              toStatus: "Optimized",
              changedByUserId: request.user!.id,
            },
            resetAlertStateAt: statusChangedAt,
          });
          await queueRevenueEncounterSync(tx, row.id, request.correlationId || request.id);
          await recordEncounterMutationTx({
            tx,
            request,
            encounterId: row.id,
          });
          return row;
        });
        await flushOperationalOutbox(prisma);
        return getHydratedEncounterView(updated.id);
      },
    });
  });

  app.post("/encounters/:id/cancel", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.MA, RoleName.Clinician, RoleName.FrontDeskCheckOut, RoleName.Admin) }, async (request) => {
    const encounterId = (request.params as { id: string }).id;
    const dto = cancelSchema.parse(request.body);
    return withIdempotentMutation({
      db: prisma,
      request,
      payload: dto,
      execute: async () => {
        if (!cancelReasons.includes(dto.reason)) {
          throw new ApiError({ statusCode: 400, code: "INVALID_CANCELLATION_REASON", message: "Invalid cancellation reason" });
        }

        if (dto.reason === "other" && !(dto.note || "").trim()) {
          throw new ApiError({ statusCode: 400, code: "CANCELLATION_NOTE_REQUIRED", message: "A note is required when reason is other" });
        }

        const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
        requireCondition(encounter, 404, "Encounter not found", "ENCOUNTER_NOT_FOUND");
        await assertEncounterInScope(encounter, request.user!);

        await assertEncounterAccess(encounter, request.user!.id, request.user!.role);

        if (encounter.currentStatus === "Optimized") {
          throw new ApiError({ statusCode: 400, code: "ENCOUNTER_ALREADY_OPTIMIZED", message: "Encounter is already optimized" });
        }

        const now = new Date();

        const updated = await prisma.$transaction(async (tx) => {
          const row = await updateEncounterWithVersionTx({
            tx,
            encounterId,
            expectedVersion: dto.version,
            data: {
              currentStatus: "Optimized",
              checkoutCompleteAt: encounter.checkoutCompleteAt ?? now,
              closedAt: now,
              closureType: dto.reason,
              closureNotes: (dto.note || "").trim() || null,
            },
            statusEvent: {
              fromStatus: encounter.currentStatus,
              toStatus: "Optimized",
              changedByUserId: request.user!.id,
              reasonCode: dto.reason,
            },
            resetAlertStateAt: now,
          });
          await queueRevenueEncounterSync(tx, row.id, request.correlationId || request.id);
          await recordEncounterMutationTx({
            tx,
            request,
            encounterId: row.id,
          });
          return row;
        });
        await flushOperationalOutbox(prisma);
        return getHydratedEncounterView(updated.id);
      },
    });
  });
}
