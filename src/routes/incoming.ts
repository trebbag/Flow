import type { FastifyInstance } from "fastify";
import { Prisma, RoleName, ScheduleSource } from "@prisma/client";
import { parse as parseCsv } from "csv-parse/sync";
import { DateTime } from "luxon";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ApiError, requireCondition } from "../lib/errors.js";
import { normalizeDate, parseAppointmentAt, dateRangeForDay } from "../lib/dates.js";
import { requireRoles, type RequestUser } from "../lib/auth.js";
import { enterFacilityScope } from "../lib/facility-scope.js";
import { paginateItems, paginationQuerySchema, resolveOptionalPagination } from "../lib/pagination.js";
import { ensurePatientRecord, extractPatientIdentityHints } from "../lib/patients.js";
import {
  normalizeIncomingIssueNormalizedJson,
  parseIncomingIntakeDataInput,
  parseIncomingIssueNormalizedJsonInput,
} from "../lib/persisted-json.js";
import { flushOperationalOutbox, persistMutationOperationalEventTx } from "../lib/operational-events.js";
import { withIdempotentMutation } from "../lib/idempotency.js";
import {
  formatClinicDisplayName,
  formatProviderDisplayName,
  formatReasonDisplayName
} from "../lib/display-names.js";

const incomingDispositionReasons = [
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

const importSchema = z.object({
  clinicId: z.string().uuid().optional(),
  dateOfService: z.string().optional(),
  csvText: z.string().min(1),
  fileName: z.string().optional(),
  source: z.nativeEnum(ScheduleSource).optional(),
  facilityId: z.string().uuid().optional()
});

const intakeSchema = z.object({
  intakeData: z.record(z.string(), z.unknown()).default({})
});

const updateIncomingSchema = z.object({
  patientId: z.string().optional(),
  dateOfService: z.string().optional(),
  appointmentTime: z.string().nullable().optional(),
  providerLastName: z.string().nullable().optional(),
  reasonText: z.string().nullable().optional()
});

const incomingRetrySchema = z.object({
  clinicId: z.string().uuid().optional(),
  patientId: z.string().optional(),
  dateOfService: z.string().optional(),
  appointmentTime: z.string().nullable().optional(),
  providerLastName: z.string().nullable().optional(),
  reasonText: z.string().nullable().optional()
});

const dispositionSchema = z.object({
  reason: z.enum(incomingDispositionReasons),
  note: z.string().optional()
});

const listIncomingSchema = z
  .object({
    clinicId: z.string().uuid().optional(),
    date: z.string().optional(),
    includeCheckedIn: z.string().optional(),
    includeInvalid: z.string().optional(),
  })
  .merge(paginationQuerySchema);

const listIncomingPendingSchema = z
  .object({
    facilityId: z.string().uuid().optional(),
    clinicId: z.string().uuid().optional(),
    date: z.string().optional(),
  })
  .merge(paginationQuerySchema);

function readIncomingIssueNormalizedJson(value: unknown) {
  return normalizeIncomingIssueNormalizedJson(value as Prisma.JsonValue | null | undefined);
}

function readIncomingIssueRawPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {} as Record<string, unknown>;
  }
  return value as Record<string, unknown>;
}

type IncomingImportRow = {
  clinic?: string | null;
  clinicId?: string | null;
  patientId: string;
  dateOfService?: string | null;
  appointmentTime?: string | null;
  providerId?: string | null;
  providerName?: string | null;
  providerLastName?: string | null;
  reasonForVisitId?: string | null;
  reasonForVisit?: string | null;
  reason?: string | null;
  intakeData?: Record<string, unknown>;
  rawPayload?: Record<string, unknown>;
};

function isUuid(value?: string | null) {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));
}

function normalizeName(value?: string | null) {
  return (value || "").trim().toLowerCase();
}

function normalizeAlias(value?: string | null) {
  return normalizeName(value).replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
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
  "pac"
]);

function stripProviderCredentials(value?: string | null) {
  const parts = String(value || "")
    .trim()
    .replace(/[,/]+/g, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  while (parts.length > 1) {
    const suffix = parts[parts.length - 1]?.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (!suffix || !providerCredentialSuffixes.has(suffix)) break;
    parts.pop();
  }
  return parts.join(" ").replace(/[,\s]+$/g, "").trim();
}

function normalizeCsvHeaderKey(value?: string | null) {
  return normalizeName(value).replace(/[^a-z0-9]/g, "");
}

function normalizeCsvRow(rawRow: Record<string, string>) {
  const normalized = new Map<string, string>();
  Object.entries(rawRow || {}).forEach(([key, rawValue]) => {
    const normalizedKey = normalizeCsvHeaderKey(key);
    if (!normalizedKey) return;
    const value = typeof rawValue === "string" ? rawValue.trim() : String(rawValue ?? "").trim();
    if (!value) return;
    if (!normalized.has(normalizedKey)) {
      normalized.set(normalizedKey, value);
    }
  });
  return normalized;
}

function csvValue(row: Map<string, string>, ...aliases: string[]) {
  for (const alias of aliases) {
    const key = normalizeCsvHeaderKey(alias);
    const value = row.get(key);
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function providerLastName(value?: string | null) {
  const raw = stripProviderCredentials(value);
  if (!raw) return "";
  const parts = raw.split(/\s+/).filter(Boolean);
  return normalizeName((parts[parts.length - 1] || raw).replace(/[,\s]+$/g, ""));
}

function providerFullName(value?: string | null) {
  return normalizeName(stripProviderCredentials(value));
}

function providerDisplayLastName(value?: string | null) {
  const raw = stripProviderCredentials(value);
  if (!raw) return "";
  const parts = raw.split(/\s+/).filter(Boolean);
  return (parts[parts.length - 1] || raw).replace(/[,\s]+$/g, "").trim();
}

function clinicAliasVariants(input: { name?: string | null; shortCode?: string | null; id?: string | null }) {
  const name = (input.name || "").trim();
  const shortCode = (input.shortCode || "").trim();
  const id = (input.id || "").trim();
  const aliases = new Set<string>();
  [id, name, shortCode].forEach((value) => {
    if (value) aliases.add(value);
  });
  if (name && shortCode) {
    [
      `${name} (${shortCode})`,
      `${shortCode} - ${name}`,
      `${shortCode} ${name}`,
      `${name} ${shortCode}`
    ].forEach((value) => {
      if (value) aliases.add(value);
    });
  }
  return Array.from(aliases);
}

function clinicAliasForms(input: { name?: string | null; shortCode?: string | null; id?: string | null }) {
  return Array.from(new Set(clinicAliasVariants(input).map((value) => normalizeAlias(value)).filter(Boolean)));
}

function resolveDateOfServiceInput(rawDate: string | null | undefined, fallbackDate: string | null | undefined, timezone: string) {
  const value = String(rawDate || fallbackDate || "").trim();
  if (!value) {
    return { date: null, isoDate: null, error: "Missing appointment date" };
  }

  try {
    const normalized = normalizeDate(value, timezone);
    const normalizedIso =
      DateTime.fromJSDate(normalized, { zone: "utc" }).setZone(timezone).toISODate() ||
      DateTime.now().setZone(timezone).toISODate();
    const today = DateTime.now().setZone(timezone).startOf("day");
    const candidate = DateTime.fromJSDate(normalized, { zone: "utc" }).setZone(timezone).startOf("day");
    if (candidate < today) {
      return { date: normalized, isoDate: normalizedIso, error: "Appointment date cannot be in the past" };
    }
    return { date: normalized, isoDate: normalizedIso, error: null };
  } catch {
    return { date: null, isoDate: null, error: `Invalid appointment date '${value}'. Expected YYYY-MM-DD format` };
  }
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
  if (user.facilityId) {
    enterFacilityScope(user.facilityId);
  }

  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { id: true, facilityId: true, timezone: true, status: true, maRun: true }
  });
  requireCondition(clinic, 404, "Clinic not found");
  assertClinicInUserScope(user, clinic);
  enterFacilityScope(clinic.facilityId || user.facilityId || null);
  return clinic;
}

async function resolveScopedFacility(user: ScopedRequestUser, requestedFacilityId?: string | null) {
  const requested = requestedFacilityId?.trim() || user.facilityId || null;
  if (requested) {
    enterFacilityScope(requested);
  }

  if (requested) {
    const facility = await prisma.facility.findUnique({
      where: { id: requested },
      select: { id: true, timezone: true, status: true }
    });
    requireCondition(facility, 404, "Facility not found");
    if (user.facilityId && facility.id !== user.facilityId) {
      throw new ApiError(403, "Facility is outside your assigned scope");
    }
    enterFacilityScope(facility.id);
    return facility;
  }

  const facility = await prisma.facility.findFirst({
    where: { status: { not: "archived" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, timezone: true, status: true }
  });
  requireCondition(facility, 404, "Facility not found");
  if (user.facilityId && facility.id !== user.facilityId) {
    throw new ApiError(403, "Facility is outside your assigned scope");
  }
  enterFacilityScope(facility.id);
  return facility;
}

async function getProviderReasonMaps(clinicId: string) {
  const [clinic, providers, reasons, assignment] = await Promise.all([
    prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { id: true, timezone: true, maRun: true, facilityId: true }
    }),
    prisma.provider.findMany({
      where: { clinicId, active: true },
      select: { id: true, name: true }
    }),
    prisma.reasonForVisit.findMany({
      where: {
        status: "active",
        OR: [{ clinicAssignments: { some: { clinicId } } }, { clinicId }]
      },
      select: { id: true, name: true }
    }),
    prisma.clinicAssignment.findUnique({
      where: { clinicId },
      include: {
        providerUser: { select: { id: true, name: true, status: true } },
        maUser: { select: { id: true, name: true, status: true } }
      }
    })
  ]);

  requireCondition(clinic, 404, "Clinic not found");

  const clinics = await prisma.clinic.findMany({
    where: {
      status: "active",
      facilityId: clinic.facilityId || undefined
    },
    select: { id: true, name: true, shortCode: true }
  });

  const providerByLastName = new Map(providers.map((provider) => [providerLastName(provider.name), provider.id]));
  const providerByName = new Map(providers.map((provider) => [providerFullName(provider.name), provider.id]));

  if (assignment?.providerUser && assignment.providerUser.status === "active" && assignment.providerId) {
    const assignedProviderLastName = providerLastName(assignment.providerUser.name);
    const assignedProviderName = providerFullName(assignment.providerUser.name);
    if (assignedProviderLastName) {
      providerByLastName.set(assignedProviderLastName, providerByLastName.get(assignedProviderLastName) || assignment.providerId);
    }
    if (assignedProviderName) {
      providerByName.set(assignedProviderName, providerByName.get(assignedProviderName) || assignment.providerId);
    }
  }

  const maLastNames = new Set<string>();
  if (assignment?.maUser && assignment.maUser.status === "active") {
    const maLastName = providerLastName(assignment.maUser.name);
    if (maLastName) maLastNames.add(maLastName);
  }

  return {
    clinicTimezone: clinic.timezone,
    maRun: clinic.maRun,
    providerById: new Set(providers.map((provider) => provider.id)),
    providerByLastName,
    providerByName,
    reasonById: new Set(reasons.map((reason) => reason.id)),
    reasonByName: new Map(reasons.map((reason) => [normalizeName(reason.name), reason.id])),
    clinicNames: new Set(clinics.flatMap((entry) => clinicAliasForms(entry))),
    maLastNames
  };
}

function validateIncomingRow(
  row: IncomingImportRow,
  defaultDateOfService: string | undefined,
  maps: {
    clinicTimezone: string;
    maRun: boolean;
    providerById: Set<string>;
    providerByLastName: Map<string, string>;
    providerByName: Map<string, string>;
    reasonById: Set<string>;
    reasonByName: Map<string, string>;
    clinicNames: Set<string>;
    maLastNames: Set<string>;
  },
  facilityTimezone: string
) {
  const patientId = (row.patientId || "").trim();
  const dateOfService = resolveDateOfServiceInput(row.dateOfService, defaultDateOfService, facilityTimezone);
  const appointmentTimeRaw = (row.appointmentTime || "").trim();
  const providerLastNameRaw = (row.providerLastName || row.providerName || "").trim();
  const reasonTextRaw = (row.reasonForVisit || row.reason || "").trim();

  const errors: string[] = [];
  if (!patientId) errors.push("Missing patient ID");
  if (dateOfService.error) errors.push(dateOfService.error);
  if (!appointmentTimeRaw) errors.push("Missing appointment time");
  if (!providerLastNameRaw) errors.push("Missing provider last name");
  if (!reasonTextRaw) errors.push("Missing reason for visit");

  const appointment = dateOfService.date
    ? parseAppointmentAt(appointmentTimeRaw, dateOfService.date, maps.clinicTimezone)
    : { appointmentTime: appointmentTimeRaw || null, appointmentAt: null, error: null };
  if (appointment.error) errors.push(appointment.error);
  if (appointment.appointmentAt) {
    const appointmentAt = DateTime.fromJSDate(appointment.appointmentAt).setZone(maps.clinicTimezone);
    const now = DateTime.now().setZone(maps.clinicTimezone);
    if (appointmentAt <= now) {
      errors.push("Appointment date and time must be in the future");
    }
  }

  const normalizedProviderLastName = providerLastName(providerLastNameRaw);
  const normalizedProviderName = providerFullName(providerLastNameRaw);
  const providerIdFromLastName = normalizedProviderLastName
    ? maps.providerByLastName.get(normalizedProviderLastName) || null
    : null;
  const providerIdFromName = normalizedProviderName ? maps.providerByName.get(normalizedProviderName) || null : null;
  const providerIdFromUuid = isUuid(row.providerId) && maps.providerById.has(row.providerId!) ? row.providerId! : null;

  const providerId = providerIdFromLastName || providerIdFromName || providerIdFromUuid;

  const clinicNameMatch = maps.maRun && maps.clinicNames.has(normalizeAlias(providerLastNameRaw));
  const maLastNameMatch = maps.maRun && maps.maLastNames.has(providerLastName(providerLastNameRaw));

  if (providerLastNameRaw && !providerId && !clinicNameMatch && !maLastNameMatch) {
    errors.push(
      maps.maRun
        ? "Provider must match an active provider, assigned MA last name, or valid clinic name for MA-run clinics"
        : `Provider not found for '${providerLastNameRaw}' in selected clinic`
    );
  }

  const normalizedReason = normalizeName(reasonTextRaw);
  const reasonIdFromName = normalizedReason ? maps.reasonByName.get(normalizedReason) || null : null;
  const reasonIdFromUuid = isUuid(row.reasonForVisitId) && maps.reasonById.has(row.reasonForVisitId!) ? row.reasonForVisitId! : null;
  const reasonForVisitId = reasonIdFromName || reasonIdFromUuid;

  if (reasonTextRaw && !reasonForVisitId) {
    errors.push(`Reason '${reasonTextRaw}' is not configured`);
  }

  return {
    dateOfService: dateOfService.date,
    dateOfServiceIso: dateOfService.isoDate,
    patientId,
    providerLastName: providerDisplayLastName(providerLastNameRaw) || providerLastNameRaw || null,
    reasonText: reasonTextRaw || null,
    providerId: providerId || null,
    reasonForVisitId: reasonForVisitId || null,
    appointmentTime: appointment.appointmentTime,
    appointmentAt: appointment.appointmentAt,
    validationErrors: errors,
    isValid: errors.length === 0
  };
}

function dedupeKey(row: {
  patientId: string;
  dateOfService: Date;
  appointmentTime?: string | null;
  appointmentAt?: Date | null;
}) {
  const date = DateTime.fromJSDate(row.dateOfService).toUTC().toISODate();
  const appointment =
    (row.appointmentTime || "").trim() || (row.appointmentAt ? DateTime.fromJSDate(row.appointmentAt).toUTC().toISO() : "");
  return `${row.patientId.trim().toLowerCase()}|${date || ""}|${appointment}`;
}

function scoreIncomingRow(row: {
  isValid: boolean;
  providerId: string | null;
  reasonForVisitId: string | null;
  appointmentAt: Date | null;
  importBatch: { createdAt: Date } | null;
}) {
  return (
    (row.isValid ? 4 : 0) +
    (row.providerId ? 2 : 0) +
    (row.reasonForVisitId ? 2 : 0) +
    (row.appointmentAt ? 1 : 0) +
    (row.importBatch?.createdAt?.getTime() || 0) / 1e15
  );
}

function projectIncomingRows(rows: Array<any>) {
  return rows.map((row) => {
    const providerLabel = formatProviderDisplayName({
      name: row.provider?.name || row.providerLastName || null,
      active: row.provider?.active
    });
    const reasonLabel =
      formatReasonDisplayName({
        name: row.reason?.name || row.reasonText || null,
        status: row.reason?.status || null
      }) ||
      null;
    const clinicLabel = formatClinicDisplayName({
      name: row.clinic?.name || null,
      status: row.clinic?.status || null
    });

    return {
      ...row,
      clinicName: clinicLabel,
      providerLastName: providerLabel === "Unassigned" ? null : providerLabel,
      reasonText: reasonLabel,
      isValid: row.isValid && Boolean(providerLabel !== "Unassigned" && reasonLabel && row.reasonForVisitId && row.appointmentAt)
    };
  });
}

function dedupeIncomingRows(rows: Array<any>) {
  const deduped = new Map<string, any>();
  for (const row of rows) {
    const key = dedupeKey(row);
    const existing = deduped.get(key);
    if (!existing || scoreIncomingRow(row) >= scoreIncomingRow(existing)) {
      deduped.set(key, row);
    }
  }
  return Array.from(deduped.values());
}

async function importRows(
  tx: Prisma.TransactionClient,
  facilityId: string,
  clinicId: string,
  dateOfService: string | undefined,
  rows: IncomingImportRow[],
  source: ScheduleSource,
  fileName?: string
) {
  const [clinic, facility] = await Promise.all([
    tx.clinic.findUnique({
      where: { id: clinicId },
      select: { timezone: true, status: true }
    }),
    tx.facility.findUnique({
      where: { id: facilityId },
      select: { timezone: true }
    })
  ]);
  requireCondition(clinic, 404, "Clinic not found");
  requireCondition(clinic.status === "active", 400, "Clinic is inactive and cannot be associated with new encounters");

  const facilityTimezone = facility?.timezone || "America/New_York";
  const normalizedDate =
    resolveDateOfServiceInput(undefined, dateOfService, facilityTimezone).date ||
    DateTime.now().setZone(facilityTimezone).startOf("day").toUTC().toJSDate();
  const maps = await getProviderReasonMaps(clinicId);

  const batch = await tx.incomingImportBatch.create({
    data: {
      facilityId,
      clinicId,
      date: normalizedDate,
      source,
      fileName,
      rowCount: 0,
      acceptedRowCount: 0,
      pendingRowCount: 0,
      status: "processed"
    }
  });

  const acceptedRows: Record<string, unknown>[] = [];
  const pendingIssues: Record<string, unknown>[] = [];
  for (const row of rows) {
    const validated = validateIncomingRow(row, dateOfService, maps, facilityTimezone);
    if (!validated.patientId && !validated.providerLastName && !validated.reasonText && !validated.appointmentTime) {
      continue;
    }

      if (validated.isValid) {
      const identityHints = extractPatientIdentityHints(row.rawPayload || row, row.intakeData);
      const patientRecord = await ensurePatientRecord(tx, {
        facilityId,
        sourcePatientId: validated.patientId,
        displayName: identityHints.displayName,
        dateOfBirth: identityHints.dateOfBirth,
      });
      const entry = await tx.incomingSchedule.create({
        data: {
          clinicId,
          dateOfService: validated.dateOfService || normalizedDate,
          patientId: validated.patientId,
          patientRecordId: patientRecord.id,
          appointmentTime: validated.appointmentTime,
          appointmentAt: validated.appointmentAt,
          providerId: validated.providerId,
          providerLastName: validated.providerLastName,
          reasonForVisitId: validated.reasonForVisitId,
          reasonText: validated.reasonText,
          intakeData: parseIncomingIntakeDataInput(row.intakeData || {}) as Prisma.InputJsonValue,
          source,
          rawPayloadJson: (row.rawPayload || row) as Prisma.InputJsonValue,
          isValid: true,
          validationErrors: null,
          importBatchId: batch.id
        }
      });

      acceptedRows.push(entry);
      continue;
    }

    const issue = await tx.incomingImportIssue.create({
      data: {
        batchId: batch.id,
        facilityId,
        clinicId,
        dateOfService: validated.dateOfService || normalizedDate,
        rawPayloadJson: (row.rawPayload || row) as Prisma.InputJsonValue,
        normalizedJson: parseIncomingIssueNormalizedJsonInput({
          clinicId,
          dateOfService: validated.dateOfServiceIso,
          patientId: validated.patientId,
          appointmentTime: validated.appointmentTime,
          providerLastName: validated.providerLastName,
          reasonText: validated.reasonText
        }) as Prisma.InputJsonValue,
        validationErrors: validated.validationErrors as Prisma.InputJsonValue,
        status: "pending",
        retryCount: 0
      }
    });
    pendingIssues.push(issue);
  }

  await tx.incomingImportBatch.update({
    where: { id: batch.id },
    data: {
      rowCount: acceptedRows.length + pendingIssues.length,
      acceptedRowCount: acceptedRows.length,
      pendingRowCount: pendingIssues.length,
      status: pendingIssues.length > 0 ? "pending_review" : "processed"
    }
  });
  const batchStatus = pendingIssues.length > 0 ? "pending_review" : "processed";

  return {
    batch,
    batchStatus,
    acceptedRows,
    pendingIssues
  };
}

export async function registerIncomingRoutes(app: FastifyInstance) {
  app.get("/incoming/reference", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.Admin) }, async (request) => {
    const query = request.query as { facilityId?: string; clinicId?: string };
    const user = request.user!;
    const facility = await resolveScopedFacility(user, query.facilityId);

    if (query.clinicId) {
      const scopedClinic = await resolveScopedClinic(user, query.clinicId);
      requireCondition(scopedClinic.facilityId === facility.id, 400, "Clinic is outside selected facility");
    }

    const clinicWhere = {
      facilityId: facility.id,
      status: { in: ["active", "inactive"] as string[] },
      ...(query.clinicId ? { id: query.clinicId } : {})
    };

    const clinics = await prisma.clinic.findMany({
      where: clinicWhere,
      select: { id: true, name: true, shortCode: true },
      orderBy: { name: "asc" }
    });

    const providers = await prisma.provider.findMany({
      where: {
        active: true,
        clinic: clinicWhere
      },
      select: { id: true, name: true },
      orderBy: { name: "asc" }
    });

    const assignments = await prisma.clinicAssignment.findMany({
      where: {
        clinic: clinicWhere,
        providerUser: { status: "active" }
      },
      select: {
        clinicId: true,
        providerUser: { select: { name: true } }
      }
    });

    const reasons = await prisma.reasonForVisit.findMany({
      where: {
        facilityId: facility.id,
        status: "active",
        ...(query.clinicId
          ? {
              OR: [{ clinicAssignments: { some: { clinicId: query.clinicId } } }, { clinicId: query.clinicId }]
            }
          : {})
      },
      select: { id: true, name: true },
      orderBy: { name: "asc" }
    });

    const providerLastNames = Array.from(
      new Set(
        [...providers.map((provider) => provider.name), ...assignments.map((assignment) => assignment.providerUser?.name || "")]
          .map((providerName) => providerLastName(providerName))
          .filter(Boolean)
      )
    ).slice(0, 20);

    return {
      facilityId: facility.id,
      clinicId: query.clinicId || null,
      requiredHeaders: [
        {
          key: "clinic",
          label: "Clinic",
          required: !query.clinicId,
          format: "Clinic name, short code, combined alias, or UUID",
          aliases: ["clinicName", "clinicShortCode", "clinicShortName", "clinicCode", "team", "careTeam"]
        },
        {
          key: "patientId",
          label: "Patient ID",
          required: true,
          format: "String identifier from schedule/EHR",
          aliases: ["patient_id", "mrn"]
        },
        {
          key: "appointmentDate",
          label: "Appointment Date",
          required: false,
          format: "YYYY-MM-DD (required if batch date is not provided)",
          aliases: ["date", "apptDate", "serviceDate", "dos"],
        },
        {
          key: "appointmentTime",
          label: "Appointment Time",
          required: true,
          format: "HH:mm or HH:mm:ss",
          aliases: ["apptTime", "time"]
        },
        {
          key: "providerLastName",
          label: "Provider Last Name",
          required: true,
          format: "Provider last name in selected clinic scope",
          aliases: ["provider", "providerName"]
        },
        {
          key: "reasonForVisit",
          label: "Visit Reason",
          required: true,
          format: "Reason name or reason UUID",
          aliases: ["reason", "reasonForVisitId"]
        }
      ],
      samples: {
        clinics: clinics.map((clinic) => ({
          id: clinic.id,
          name: clinic.name,
          shortCode: clinic.shortCode || null,
          aliases: clinicAliasVariants(clinic)
        })),
        providerLastNames,
        reasonNames: reasons.map((reason) => reason.name).slice(0, 20)
      }
    };
  });

  app.get("/incoming/pending", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.Admin) }, async (request) => {
    const query = listIncomingPendingSchema.parse(request.query);
    const user = request.user!;
    const facility = await resolveScopedFacility(user, query.facilityId);
    const pagination = resolveOptionalPagination(
      {
        cursor: query.cursor,
        pageSize: query.pageSize ?? 50,
      },
      { pageSize: 50 },
    )!;

    if (query.clinicId) {
      const scopedClinic = await resolveScopedClinic(user, query.clinicId);
      requireCondition(scopedClinic.facilityId === facility.id, 400, "Clinic is outside selected facility");
    }

    const timezone = (await getFacilityTimezone(facility.id)) || facility.timezone;
    const normalizedDate = query.date ? normalizeDate(query.date, timezone) : undefined;

    const issues = await prisma.incomingImportIssue.findMany({
      where: {
        facilityId: facility.id,
        status: { in: ["pending", "error"] },
        ...(query.clinicId ? { clinicId: query.clinicId } : {}),
        ...(normalizedDate ? { dateOfService: normalizedDate } : {})
      },
      include: {
        clinic: { select: { id: true, name: true, shortCode: true } },
        batch: { select: { id: true, source: true, fileName: true, createdAt: true, status: true } }
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pagination.pageSize + 1,
      skip: pagination.offset,
    });

    return paginateItems(issues, pagination);
  });

  app.post("/incoming/pending/:id/retry", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.Admin) }, async (request) => {
    const issueId = (request.params as { id: string }).id;
    const dto = incomingRetrySchema.parse(request.body);
    const user = request.user!;

    if (user.facilityId) {
      enterFacilityScope(user.facilityId);
    }

    const issue = await prisma.incomingImportIssue.findUnique({
      where: { id: issueId },
      include: {
        batch: true
      }
    });
    requireCondition(issue, 404, "Pending issue not found");

    const facility = await resolveScopedFacility(user, issue.facilityId);
    requireCondition(issue.facilityId === facility.id, 403, "Pending issue is outside your assigned scope");

    const normalizedIssue = readIncomingIssueNormalizedJson(issue.normalizedJson);
    const rawPayload = readIncomingIssueRawPayload(issue.rawPayloadJson);
    const clinicId = dto.clinicId || issue.clinicId || normalizedIssue.clinicId;
    requireCondition(clinicId, 400, "Clinic is required to retry this pending row");
    const clinic = await resolveScopedClinic(user, clinicId);
    requireCondition(clinic.facilityId === facility.id, 400, "Clinic is outside selected facility");
    requireCondition(clinic.status === "active", 400, "Clinic is inactive and cannot be associated with new encounters");

    const facilityTimezone = facility.timezone || "America/New_York";
    const candidate: IncomingImportRow = {
      clinicId,
      patientId: (dto.patientId ?? String(normalizedIssue.patientId || rawPayload.patientId || "")).trim(),
      dateOfService:
        dto.dateOfService ??
        normalizedIssue.dateOfService ??
        (rawPayload.appointmentDate as string | null) ??
        (rawPayload.apptDate as string | null) ??
        (rawPayload.date as string | null) ??
        (rawPayload.serviceDate as string | null) ??
        (rawPayload.dos as string | null) ??
        null,
      appointmentTime: dto.appointmentTime ?? normalizedIssue.appointmentTime ?? (rawPayload.appointmentTime as string | null) ?? null,
      providerLastName:
        dto.providerLastName ??
        normalizedIssue.providerLastName ??
        (rawPayload.providerLastName as string | null) ??
        (rawPayload.providerName as string | null) ??
        null,
      reasonForVisit:
        dto.reasonText ??
        normalizedIssue.reasonText ??
        (rawPayload.reasonForVisit as string | null) ??
        (rawPayload.reason as string | null) ??
        null,
      reasonForVisitId: (rawPayload.reasonForVisitId as string | null) ?? null,
      providerId: (rawPayload.providerId as string | null) ?? null,
      intakeData:
        rawPayload.intakeData && typeof rawPayload.intakeData === "object" && !Array.isArray(rawPayload.intakeData)
          ? (rawPayload.intakeData as Record<string, unknown>)
          : {},
      rawPayload
    };

    const maps = await getProviderReasonMaps(clinicId);
    const validated = validateIncomingRow(
      candidate,
      DateTime.fromJSDate(issue.dateOfService, { zone: "utc" }).setZone(facilityTimezone).toISODate() || undefined,
      maps,
      facilityTimezone
    );
    const retryCount = issue.retryCount + 1;

    if (!validated.isValid) {
      const updated = await prisma.incomingImportIssue.update({
        where: { id: issue.id },
        data: {
          clinicId,
          dateOfService: validated.dateOfService || issue.dateOfService,
          normalizedJson: parseIncomingIssueNormalizedJsonInput({
            clinicId,
            dateOfService: validated.dateOfServiceIso,
            patientId: validated.patientId,
            appointmentTime: validated.appointmentTime,
            providerLastName: validated.providerLastName,
            reasonText: validated.reasonText
          }) as Prisma.InputJsonValue,
          validationErrors: validated.validationErrors as Prisma.InputJsonValue,
          status: "pending",
          retryCount
        }
      });
      return {
        status: "pending",
        issue: updated
      };
    }

    const created = await prisma.$transaction(async (tx) => {
      const identityHints = extractPatientIdentityHints(rawPayload, candidate.intakeData);
      const patientRecord = await ensurePatientRecord(tx, {
        facilityId: facility.id,
        sourcePatientId: validated.patientId,
        displayName: identityHints.displayName,
        dateOfBirth: identityHints.dateOfBirth,
      });
      const incoming = await tx.incomingSchedule.create({
        data: {
          clinicId,
          dateOfService: validated.dateOfService || issue.dateOfService,
          patientId: validated.patientId,
          patientRecordId: patientRecord.id,
          appointmentTime: validated.appointmentTime,
          appointmentAt: validated.appointmentAt,
          providerId: validated.providerId,
          providerLastName: validated.providerLastName,
          reasonForVisitId: validated.reasonForVisitId,
          reasonText: validated.reasonText,
          intakeData: parseIncomingIntakeDataInput(candidate.intakeData || {}) as Prisma.InputJsonValue,
          source: issue.batch.source,
          rawPayloadJson: rawPayload as Prisma.InputJsonValue,
          isValid: true,
          validationErrors: null,
          importBatchId: issue.batchId
        }
      });

      const updatedIssue = await tx.incomingImportIssue.update({
        where: { id: issue.id },
        data: {
          clinicId,
          dateOfService: validated.dateOfService || issue.dateOfService,
          normalizedJson: parseIncomingIssueNormalizedJsonInput({
            clinicId,
            dateOfService: validated.dateOfServiceIso,
            patientId: validated.patientId,
            appointmentTime: validated.appointmentTime,
            providerLastName: validated.providerLastName,
            reasonText: validated.reasonText
          }) as Prisma.InputJsonValue,
          validationErrors: Prisma.JsonNull,
          status: "resolved",
          retryCount,
          resolvedIncomingId: incoming.id
        }
      });

      await tx.incomingImportBatch.update({
        where: { id: issue.batchId },
        data: {
          acceptedRowCount: { increment: 1 },
          pendingRowCount: { decrement: 1 }
        }
      });

      const pendingLeft = await tx.incomingImportIssue.count({
        where: { batchId: issue.batchId, status: { in: ["pending", "error"] } }
      });
      await tx.incomingImportBatch.update({
        where: { id: issue.batchId },
        data: {
          status: pendingLeft > 0 ? "pending_review" : "processed"
        }
      });

      return { incoming, issue: updatedIssue };
    });

    return {
      status: "accepted",
      row: created.incoming,
      issue: created.issue
    };
  });

  app.post("/incoming/import", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.Admin) }, async (request) => {
    const dto = importSchema.parse(request.body);
    const user = request.user!;
    const facility = await resolveScopedFacility(user, dto.facilityId);
    if (dto.clinicId) {
      const scopedClinic = await resolveScopedClinic(user, dto.clinicId);
      requireCondition(scopedClinic.facilityId === facility.id, 400, "Clinic is outside selected facility");
      requireCondition(scopedClinic.status === "active", 400, "Clinic is inactive and cannot be associated with new encounters");
    }
    const records = parseCsv(dto.csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    }) as Array<Record<string, string>>;
    if (records.length === 0) {
      throw new ApiError(400, "No schedule data rows were found. Include the header row and at least one appointment row.");
    }

    const clinics = await prisma.clinic.findMany({
      where: {
        status: "active",
        facilityId: facility.id,
        ...(user.clinicId ? { id: user.clinicId } : {})
      },
      select: { id: true, name: true, shortCode: true }
    });
    if (clinics.length === 0) {
      throw new ApiError(403, "No active clinics are available in your assigned scope");
    }

    const clinicLookup = new Map<string, Set<string>>();
    for (const clinic of clinics) {
      for (const alias of clinicAliasForms(clinic)) {
        if (!clinicLookup.has(alias)) clinicLookup.set(alias, new Set());
        clinicLookup.get(alias)!.add(clinic.id);
      }
    }

    const facilityTimezone = facility.timezone || "America/New_York";
    const groupedRows = new Map<string, { clinicId: string; dateOfService: string; rows: IncomingImportRow[] }>();
    const unresolvedClinicRows: Array<{
      row: Record<string, string>;
      message: string;
      normalized: Record<string, unknown>;
      clinicId?: string | null;
      dateOfService?: Date | null;
    }> = [];

    records.forEach((row, index) => {
      const normalizedRow = normalizeCsvRow(row);
      const clinicValue = csvValue(
        normalizedRow,
        "clinic",
        "clinicName",
        "clinicShortCode",
        "clinicShortName",
        "clinicCode",
        "team",
        "careTeam"
      );
      const matches = clinicLookup.get(normalizeAlias(clinicValue));
      const resolvedClinicId = matches && matches.size === 1 ? Array.from(matches)[0] : dto.clinicId || null;
      const patientId = csvValue(normalizedRow, "patientId", "patient_id", "mrn");
      const appointmentDate = csvValue(normalizedRow, "appointmentDate", "apptDate", "date", "serviceDate", "dos") || dto.dateOfService || "";
      const appointmentTime = csvValue(normalizedRow, "appointmentTime", "apptTime", "time") || null;
      const providerId = csvValue(normalizedRow, "providerId") || null;
      const providerName = csvValue(normalizedRow, "providerName") || null;
      const providerLastName = csvValue(normalizedRow, "providerLastName", "provider") || null;
      const reasonForVisitId = csvValue(normalizedRow, "reasonForVisitId") || null;
      const reasonForVisit = csvValue(normalizedRow, "reasonForVisit", "reason") || null;
      const normalizedDraft = {
        clinicId: resolvedClinicId,
        dateOfService: appointmentDate || null,
        patientId,
        appointmentTime,
        providerLastName: providerLastName || providerName || null,
        reasonText: reasonForVisit || null
      };

      if (matches && matches.size > 1) {
        unresolvedClinicRows.push({
          row,
          message: `Row ${index + 2}: clinic '${clinicValue}' matches multiple clinics`,
          normalized: normalizedDraft,
          clinicId: null,
          dateOfService: resolveDateOfServiceInput(appointmentDate, undefined, facilityTimezone).date
        });
        return;
      }

      if (!resolvedClinicId) {
        unresolvedClinicRows.push({
          row,
          message: `Row ${index + 2}: missing or invalid clinic value`,
          normalized: normalizedDraft,
          clinicId: null,
          dateOfService: resolveDateOfServiceInput(appointmentDate, undefined, facilityTimezone).date
        });
        return;
      }

      const resolvedDate = resolveDateOfServiceInput(appointmentDate, undefined, facilityTimezone);
      if (resolvedDate.error) {
        unresolvedClinicRows.push({
          row,
          message: `Row ${index + 2}: ${resolvedDate.error}`,
          normalized: {
            ...normalizedDraft,
            clinicId: resolvedClinicId,
            dateOfService: appointmentDate || null
          },
          clinicId: resolvedClinicId,
          dateOfService: resolvedDate.date
        });
        return;
      }

      const groupKey = `${resolvedClinicId}:${resolvedDate.isoDate}`;
      const currentGroup = groupedRows.get(groupKey) || {
        clinicId: resolvedClinicId,
        dateOfService: resolvedDate.isoDate || appointmentDate,
        rows: []
      };
      currentGroup.rows.push({
        clinic: clinicValue || null,
        clinicId: resolvedClinicId,
        patientId,
        dateOfService: resolvedDate.isoDate,
        appointmentTime,
        providerId,
        providerName,
        providerLastName,
        reasonForVisitId,
        reasonForVisit,
        rawPayload: row
      });
      groupedRows.set(groupKey, currentGroup);
    });

    for (const group of groupedRows.values()) {
      await resolveScopedClinic(user, group.clinicId);
    }

    return withIdempotentMutation({
      db: prisma,
      request,
      payload: {
        facilityId: facility.id,
        clinicId: dto.clinicId ?? null,
        source: dto.source ?? null,
        fileName: dto.fileName ?? null,
        groupKeys: Array.from(groupedRows.keys()).sort(),
        unresolvedCount: unresolvedClinicRows.length,
        rowCount: records.length,
      },
      execute: async () => {
        const { createdRows, pendingIssues, batchIds, batchStatus } = await prisma.$transaction(async (tx) => {
          const acceptedRows: Array<Record<string, unknown>> = [];
          const pendingRows: Array<Record<string, unknown>> = [];
          const batchIds = new Set<string>();
          let batchStatus: "processed" | "pending_review" = "processed";
          for (const group of groupedRows.values()) {
            const created = await importRows(
              tx,
              facility.id,
              group.clinicId,
              group.dateOfService,
              group.rows,
              dto.source || ScheduleSource.csv,
              dto.fileName
            );
            acceptedRows.push(...created.acceptedRows);
            pendingRows.push(...created.pendingIssues);
            batchIds.add(created.batch.id);
            if (created.batchStatus === "pending_review") {
              batchStatus = "pending_review";
            }
          }

          if (unresolvedClinicRows.length > 0) {
            const normalizedDate =
              resolveDateOfServiceInput(undefined, dto.dateOfService, facilityTimezone).date ||
              DateTime.now().setZone(facilityTimezone).startOf("day").toUTC().toJSDate();
            const unresolvedBatch = await tx.incomingImportBatch.create({
              data: {
                facilityId: facility.id,
                clinicId: null,
                date: normalizedDate,
                source: dto.source || ScheduleSource.csv,
                fileName: dto.fileName,
                rowCount: unresolvedClinicRows.length,
                acceptedRowCount: 0,
                pendingRowCount: unresolvedClinicRows.length,
                status: "pending_review"
              }
            });

            for (const issue of unresolvedClinicRows) {
              const createdIssue = await tx.incomingImportIssue.create({
                data: {
                  batchId: unresolvedBatch.id,
                  facilityId: facility.id,
                  clinicId: issue.clinicId || null,
                  dateOfService: issue.dateOfService || normalizedDate,
                  rawPayloadJson: issue.row as Prisma.InputJsonValue,
                  normalizedJson: parseIncomingIssueNormalizedJsonInput(issue.normalized) as Prisma.InputJsonValue,
                  validationErrors: [issue.message] as Prisma.InputJsonValue,
                  status: "pending",
                  retryCount: 0
                }
              });
              pendingRows.push(createdIssue);
            }
            batchIds.add(unresolvedBatch.id);
            batchStatus = "pending_review";
          }

          return { createdRows: acceptedRows, pendingIssues: pendingRows, batchIds: Array.from(batchIds.values()), batchStatus };
        });

        if (createdRows.length === 0 && pendingIssues.length === 0) {
          throw new ApiError(400, "No importable schedule rows were found. Check the expected column order and row values.");
        }

        return {
          acceptedRows: createdRows,
          pendingIssues,
          acceptedCount: createdRows.length,
          pendingCount: pendingIssues.length,
          batchId: batchIds.length === 1 ? batchIds[0] : null,
          batchIds,
          batchStatus,
        };
      },
    });
  });

  app.post("/incoming/:id/intake", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.MA, RoleName.Clinician, RoleName.Admin) }, async (request) => {
    const incomingId = (request.params as { id: string }).id;
    const dto = intakeSchema.parse(request.body);
    const existing = await prisma.incomingSchedule.findUnique({
      where: { id: incomingId },
      include: {
        clinic: {
          select: { id: true, facilityId: true }
        }
      }
    });
    requireCondition(existing, 404, "Incoming row not found");
    assertClinicInUserScope(request.user!, {
      id: existing.clinicId,
      facilityId: existing.clinic?.facilityId || null
    });

    return prisma.incomingSchedule.update({
      where: { id: incomingId },
      data: {
        intakeData: parseIncomingIntakeDataInput(dto.intakeData) as Prisma.InputJsonValue
      }
    });
  });

  app.post("/incoming/:id", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.Admin) }, async (request) => {
    const incomingId = (request.params as { id: string }).id;
    const dto = updateIncomingSchema.parse(request.body);

    const existing = await prisma.incomingSchedule.findUnique({
      where: { id: incomingId },
      include: {
        clinic: {
          select: { facilityId: true }
        },
        provider: { select: { name: true } },
        reason: { select: { name: true } }
      }
    });
    requireCondition(existing, 404, "Incoming row not found");
    assertClinicInUserScope(request.user!, {
      id: existing.clinicId,
      facilityId: existing.clinic?.facilityId || null
    });
    requireCondition(!existing.checkedInAt, 400, "Checked-in rows cannot be edited");
    requireCondition(!existing.dispositionAt, 400, "Dispositioned rows cannot be edited");

    const maps = await getProviderReasonMaps(existing.clinicId);
    const facilityTimezone = existing.clinic?.facilityId
      ? (await getFacilityTimezone(existing.clinic.facilityId)) || "America/New_York"
      : "America/New_York";
    requireCondition(existing.clinic?.facilityId, 400, "Incoming row is missing a facility association");
    const validated = validateIncomingRow(
      {
        patientId: dto.patientId ?? existing.patientId,
        dateOfService:
          dto.dateOfService ??
          (DateTime.fromJSDate(existing.dateOfService, { zone: "utc" }).setZone(facilityTimezone).toISODate() || null),
        appointmentTime: dto.appointmentTime ?? existing.appointmentTime ?? null,
        providerLastName: dto.providerLastName ?? existing.providerLastName ?? existing.provider?.name ?? null,
        reasonForVisit: dto.reasonText ?? existing.reasonText ?? existing.reason?.name ?? null,
        providerId: existing.providerId,
        reasonForVisitId: existing.reasonForVisitId
      },
      DateTime.fromJSDate(existing.dateOfService, { zone: "utc" }).setZone(facilityTimezone).toISODate() || undefined,
      maps,
      facilityTimezone
    );
    requireCondition(validated.isValid, 400, validated.validationErrors.join("; "));

    const patientRecord =
      existing.patientRecordId && validated.patientId === existing.patientId
        ? { id: existing.patientRecordId }
        : await ensurePatientRecord(prisma, {
            facilityId: existing.clinic.facilityId,
            sourcePatientId: validated.patientId,
            ...extractPatientIdentityHints(existing.rawPayloadJson, existing.intakeData),
          });

    return prisma.incomingSchedule.update({
      where: { id: incomingId },
      data: {
        dateOfService: validated.dateOfService || existing.dateOfService,
        patientId: validated.patientId,
        patientRecordId: patientRecord.id,
        appointmentTime: validated.appointmentTime,
        appointmentAt: validated.appointmentAt,
        providerLastName: validated.providerLastName,
        reasonText: validated.reasonText,
        providerId: validated.providerId,
        reasonForVisitId: validated.reasonForVisitId,
        isValid: validated.isValid,
        validationErrors: validated.validationErrors.length > 0 ? (validated.validationErrors as Prisma.InputJsonValue) : null
      },
      include: {
        clinic: { select: { id: true, name: true, shortCode: true, cardColor: true, status: true } },
        provider: { select: { id: true, name: true, active: true } },
        reason: { select: { id: true, name: true, status: true } }
      }
    });
  });

  app.post("/incoming/:id/disposition", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.Admin) }, async (request) => {
    const incomingId = (request.params as { id: string }).id;
    const dto = dispositionSchema.parse(request.body);
    const userId = request.user!.id;

    const incoming = await prisma.incomingSchedule.findUnique({
      where: { id: incomingId },
      include: {
        clinic: {
          select: { id: true, facilityId: true, timezone: true, status: true }
        }
      }
    });
    requireCondition(incoming, 404, "Incoming row not found");
    assertClinicInUserScope(request.user!, {
      id: incoming.clinicId,
      facilityId: incoming.clinic?.facilityId || null
    });
	    requireCondition(!incoming.checkedInAt && !incoming.checkedInEncounterId, 400, "Incoming row already checked in");
	    requireCondition(!incoming.dispositionAt && !incoming.dispositionEncounterId, 400, "Incoming row already dispositioned");
	    requireCondition(incoming.clinic.status === "active", 400, "Clinic is inactive and cannot be associated with new encounters");
	    requireCondition(incoming.clinic?.facilityId, 400, "Incoming row is missing a facility association");

	    const result = await prisma.$transaction(async (tx) => {
        const identityHints = extractPatientIdentityHints(incoming.rawPayloadJson, incoming.intakeData);
	      const patientRecord =
	        incoming.patientRecordId ||
	        (
	          await ensurePatientRecord(tx, {
	            facilityId: incoming.clinic.facilityId,
	            sourcePatientId: incoming.patientId,
                displayName: identityHints.displayName,
                dateOfBirth: identityHints.dateOfBirth,
	          })
	        ).id;
	      const existing = await tx.encounter.findFirst({
	        where: {
	          patientId: incoming.patientId,
	          clinicId: incoming.clinicId,
	          dateOfService: incoming.dateOfService
	        }
	      });

	      const now = new Date();
	      let encounterId = existing?.id || null;

	      if (!existing) {
	        const encounter = await tx.encounter.create({
	          data: {
	            patientId: incoming.patientId,
	            patientRecordId: patientRecord,
	            clinicId: incoming.clinicId,
	            providerId: incoming.providerId || undefined,
	            reasonForVisitId: incoming.reasonForVisitId || undefined,
	            currentStatus: "Optimized",
	            dateOfService: incoming.dateOfService,
	            checkoutCompleteAt: now,
	            closedAt: now,
	            closureType: dto.reason,
	            closureNotes: (dto.note || "").trim() || null,
	            walkIn: false,
	            intakeData: parseIncomingIntakeDataInput(incoming.intakeData || {}) as Prisma.InputJsonValue,
	            statusEvents: {
	              create: {
	                fromStatus: null,
                toStatus: "Optimized",
                changedByUserId: userId,
                reasonCode: dto.reason
              }
            },
            alertState: {
              create: {
                enteredStatusAt: now,
                currentAlertLevel: "Green"
              }
	            }
	          }
	        });
	        encounterId = encounter.id;
	      } else if (!existing.patientRecordId) {
	        await tx.encounter.update({
	          where: { id: existing.id },
	          data: { patientRecordId: patientRecord },
	        });
	      } else if (existing.currentStatus !== "Optimized") {
	        throw new ApiError(400, "Patient already has an active encounter for this clinic day.");
	      }

	      await tx.incomingSchedule.update({
	        where: { id: incomingId },
	        data: {
	          patientRecordId: patientRecord,
	          dispositionType: dto.reason,
	          dispositionNote: (dto.note || "").trim() || null,
	          dispositionAt: now,
          dispositionByUserId: userId,
          dispositionEncounterId: encounterId!
        }
      });

      await persistMutationOperationalEventTx({
        db: tx,
        request,
        entityType: "IncomingSchedule",
        entityId: incomingId,
      });

      return { encounterId: encounterId! };
    });

    await flushOperationalOutbox(prisma);

    return {
      encounterId: result.encounterId,
      status: "Optimized",
      closureType: dto.reason,
      resolvedIncomingId: incomingId
    };
  });

  app.get("/incoming", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.MA, RoleName.Clinician, RoleName.FrontDeskCheckOut, RoleName.Admin) }, async (request) => {
    const query = listIncomingSchema.parse(request.query);
    const user = request.user!;
    const requestedClinicId = query.clinicId?.trim() || undefined;
    const pagination = resolveOptionalPagination(
      {
        cursor: query.cursor,
        pageSize: query.pageSize ?? 100,
      },
      { pageSize: 100 },
    )!;
    if (user.clinicId && requestedClinicId && requestedClinicId !== user.clinicId) {
      throw new ApiError(403, "Clinic is outside your assigned scope");
    }
    const scopedClinicId = user.clinicId || requestedClinicId;
    if (scopedClinicId) {
      await resolveScopedClinic(user, scopedClinicId);
    }

    const includeCheckedIn = query.includeCheckedIn === "true";
    const includeInvalid = query.includeInvalid === "true";

    let dateOfService: Date | undefined;
    let dateRange: { start: Date; end: Date } | undefined;

    if (query.date) {
      if (scopedClinicId) {
        const timezone = await getClinicTimezone(scopedClinicId);
        dateOfService = normalizeDate(query.date, timezone);
      } else {
        const timezone = await getFacilityTimezone(user.facilityId);
        dateRange = dateRangeForDay(query.date, timezone);
      }
    }

    const incomingWhere: Prisma.IncomingScheduleWhereInput = {
      clinicId: scopedClinicId || undefined,
      clinic: user.facilityId ? { facilityId: user.facilityId } : undefined,
      ...(scopedClinicId
        ? { dateOfService }
        : dateRange
          ? {
              dateOfService: {
                gte: dateRange.start,
                lt: dateRange.end,
              },
            }
          : {}),
      checkedInAt: includeCheckedIn ? undefined : null,
      dispositionAt: includeCheckedIn ? undefined : null,
      isValid: includeInvalid ? undefined : true,
      ...(includeInvalid
        ? {}
        : {
            providerLastName: { not: null },
            reasonText: { not: null },
            reasonForVisitId: { not: null },
            appointmentAt: { not: null },
          }),
    };

    const incomingInclude = {
      clinic: { select: { id: true, name: true, shortCode: true, cardColor: true, status: true } },
      provider: { select: { id: true, name: true, active: true } },
      reason: { select: { id: true, name: true, status: true } },
      importBatch: { select: { createdAt: true } },
    } satisfies Prisma.IncomingScheduleInclude;

    const incomingOrderBy: Prisma.IncomingScheduleOrderByWithRelationInput[] = [
      { appointmentAt: "asc" },
      { patientId: "asc" },
      { id: "asc" },
    ];

    const projectedRows = await (async () => {
      if (includeCheckedIn || includeInvalid) {
        const rows = await prisma.incomingSchedule.findMany({
          where: incomingWhere,
          include: incomingInclude,
          orderBy: incomingOrderBy,
          take: pagination.pageSize + 1,
          skip: pagination.offset,
        });
        return projectIncomingRows(rows);
      }

      const targetCount = pagination.offset + pagination.pageSize + 1;
      const batchSize = Math.max(pagination.pageSize * 3, 100);
      let rawOffset = 0;
      const deduped = new Map<string, any>();

      while (deduped.size < targetCount) {
        const batch = await prisma.incomingSchedule.findMany({
          where: incomingWhere,
          include: incomingInclude,
          orderBy: incomingOrderBy,
          take: batchSize,
          skip: rawOffset,
        });

        if (batch.length === 0) {
          break;
        }

        for (const row of batch) {
          const key = dedupeKey(row);
          const existing = deduped.get(key);
          if (!existing || scoreIncomingRow(row) >= scoreIncomingRow(existing)) {
            deduped.set(key, row);
          }
        }

        rawOffset += batch.length;
        if (batch.length < batchSize) {
          break;
        }
      }

      return projectIncomingRows(
        Array.from(deduped.values()).slice(pagination.offset, pagination.offset + pagination.pageSize + 1),
      );
    })();

    return paginateItems(projectedRows, pagination);
  });

  app.get("/incoming/batches", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.Admin) }, async (request) => {
    const query = request.query as { clinicId?: string; date?: string };
    const user = request.user!;
    const requestedClinicId = query.clinicId?.trim() || undefined;
    if (user.clinicId && requestedClinicId && requestedClinicId !== user.clinicId) {
      throw new ApiError(403, "Clinic is outside your assigned scope");
    }
    const scopedClinicId = user.clinicId || requestedClinicId;
    if (scopedClinicId) {
      await resolveScopedClinic(user, scopedClinicId);
    }

    if (!query.date) {
      return prisma.incomingImportBatch.findMany({
        where: scopedClinicId
          ? { clinicId: scopedClinicId }
          : user.facilityId
            ? { facilityId: user.facilityId }
            : undefined,
        orderBy: { createdAt: "desc" }
      });
    }

    if (scopedClinicId) {
      const timezone = await getClinicTimezone(scopedClinicId);
      const normalizedDate = normalizeDate(query.date, timezone);
      return prisma.incomingImportBatch.findMany({
        where: {
          clinicId: scopedClinicId,
          date: normalizedDate
        },
        orderBy: { createdAt: "desc" }
      });
    }

    const timezone = await getFacilityTimezone(user.facilityId);
    const range = dateRangeForDay(query.date, timezone);
    return prisma.incomingImportBatch.findMany({
      where: {
        facilityId: user.facilityId || undefined,
        date: { gte: range.start, lt: range.end }
      },
      orderBy: { createdAt: "desc" }
    });
  });
}
