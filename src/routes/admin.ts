import type { FastifyInstance, FastifyRequest } from "fastify";
import { AlertLevel, AlertThresholdMetric, EncounterStatus, Prisma, RoleName, TemplateType } from "@prisma/client";
import { DateTime } from "luxon";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { ApiError, requireCondition } from "../lib/errors.js";
import { requireRoles } from "../lib/auth.js";
import {
  formatClinicDisplayName,
  formatProviderDisplayName,
  formatReasonDisplayName,
  formatRoomDisplayName,
  formatUserDisplayName
} from "../lib/display-names.js";
import { getEntraDirectoryUserByObjectId, searchEntraDirectoryUsers, type EntraDirectoryUser } from "../lib/entra-directory.js";
import { createInboxAlert } from "../lib/user-alert-inbox.js";
import {
  mergeAthenaConnectorConfig,
  normalizeAthenaConnectorConfig,
  previewAthenaRevenueMonitoring,
  previewAthenaSchedule,
  redactAthenaConnectorConfig,
  testAthenaConnectorConfig
} from "../lib/athena-one.js";
import {
  DEFAULT_MISSED_COLLECTION_REASONS,
  DEFAULT_PROVIDER_QUERY_TEMPLATES,
  DEFAULT_REVENUE_SETTINGS,
  getRevenueSettings,
  invalidateRevenueSettingsCache,
} from "../lib/revenue-cycle.js";
import { getRevenueDailyHistoryRollups, listDateKeys } from "../lib/revenue-rollups.js";
import {
  asInputJson,
  normalizeGenericObjectJson,
  normalizeQuietHoursJson,
  normalizeRoleNameArrayJson,
  normalizeStringArrayJson,
  normalizeTemplateFieldsJson,
  parseGenericObjectJsonInput,
  parseQuietHoursJsonInput,
  parseRoleNameArrayJsonInput,
  parseRevenueSettingsJsonInput,
  parseStringArrayJsonInput,
  parseTemplateFieldsJsonInput,
} from "../lib/persisted-json.js";
import { buildIntegrityWarning, recordPersistedJsonAlert } from "../lib/persisted-json-alerts.js";
import { enterFacilityScope } from "../lib/facility-scope.js";
import { persistMutationOperationalEventTx, flushOperationalOutbox } from "../lib/operational-events.js";
import { recordEntityEventTx } from "../lib/entity-events.js";
import { markEncounterRoomNeedsTurnoverInTx } from "../lib/room-operations.js";
import { queueRevenueEncounterSync } from "../lib/revenue-sync-queue.js";
import { withIdempotentMutation } from "../lib/idempotency.js";
import {
  CURRENT_REVENUE_CYCLE_SETTINGS_SCHEMA_VERSION,
  CURRENT_TEMPLATE_SCHEMA_VERSION,
  assertSupportedSchemaVersionOnRead,
} from "../lib/json-schema-version.js";

const facilitySchema = z.object({
  name: z.string().min(1),
  shortCode: z.string().trim().optional(),
  address: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  timezone: z.string().trim().optional()
});

const clinicSchema = z.object({
  facilityId: z.string().uuid().optional(),
  name: z.string().min(1),
  shortCode: z.string().trim().optional(),
  timezone: z.string().trim().optional(),
  maRun: z.boolean().optional(),
  status: z.string().optional(),
  autoCloseEnabled: z.boolean().optional(),
  autoCloseTime: z.string().optional(),
  cardColor: z.string().optional(),
  cardTags: z.array(z.string()).optional(),
  roomIds: z.array(z.string().uuid()).optional()
});

const reasonStatusSchema = z.enum(["active", "inactive", "archived"]);
const templateStatusSchema = z.enum(["active", "inactive", "archived"]);
const templateFieldTypeSchema = z.enum([
  "text",
  "textarea",
  "number",
  "checkbox",
  "select",
  "radio",
  "date",
  "time",
  "bloodPressure",
  "temperature",
  "pulse",
  "respirations",
  "oxygenSaturation",
  "height",
  "weight",
  "painScore",
  "yesNo"
]);
const templateFieldSchema = z.object({
  id: z.string().trim().optional(),
  key: z.string().trim().optional(),
  label: z.string().trim().optional(),
  type: templateFieldTypeSchema,
  required: z.boolean().optional(),
  options: z.array(z.string().trim().min(1)).optional(),
  group: z.string().trim().optional(),
  icon: z.string().trim().optional(),
  color: z.string().trim().optional()
});

const reasonSchema = z.object({
  facilityId: z.string().uuid().optional(),
  name: z.string().min(1),
  appointmentLengthMinutes: z.number().int().positive(),
  clinicIds: z.array(z.string().uuid()).min(1),
  status: reasonStatusSchema.optional(),
  active: z.boolean().optional()
});

const updateReasonSchema = z.object({
  name: z.string().min(1).optional(),
  appointmentLengthMinutes: z.number().int().positive().optional(),
  clinicIds: z.array(z.string().uuid()).min(1).optional(),
  status: reasonStatusSchema.optional(),
  active: z.boolean().optional()
});

const roomSchema = z.object({
  facilityId: z.string().uuid().optional(),
  name: z.string().min(1),
  roomType: z.string().min(1),
  status: z.enum(["active", "inactive", "archived"]).optional()
});

const roomReorderSchema = z.object({
  facilityId: z.string().uuid().optional(),
  roomIds: z.array(z.string().uuid()).min(1)
});

const templateSchema = z.object({
  facilityId: z.string().uuid().optional(),
  name: z.string().trim().min(1),
  type: z.string().trim().min(1),
  status: templateStatusSchema.optional(),
  reasonIds: z.array(z.string().uuid()).min(1),
  fields: z.array(templateFieldSchema).min(1),
  clinicId: z.string().uuid().nullable().optional(),
  reasonForVisitId: z.string().uuid().optional(),
  jsonSchema: z.record(z.string(), z.unknown()).optional(),
  uiSchema: z.record(z.string(), z.unknown()).optional(),
  requiredFields: z.array(z.string()).optional(),
  active: z.boolean().optional()
});

function parseTemplatePayload(body: unknown) {
  const parsed = templateSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const message = parsed.error.issues
    .map((issue) => {
      const path = issue.path.length > 0
        ? issue.path
            .map((segment) => (typeof segment === "number" ? `[${segment}]` : String(segment)))
            .join(".")
            .replace(/\.\[/g, "[")
        : "payload";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  throw new ApiError(400, `Template payload invalid: ${message}`);
}

const thresholdSchema = z.object({
  facilityId: z.string().uuid().optional(),
  clinicId: z.string().uuid().nullable().optional(),
  metric: z.nativeEnum(AlertThresholdMetric).optional(),
  status: z.nativeEnum(EncounterStatus).nullable().optional(),
  reasonForVisitId: z.string().uuid().optional(),
  providerId: z.string().uuid().optional(),
  yellowAtMin: z.number().int().positive(),
  redAtMin: z.number().int().positive(),
  escalation2Min: z.number().int().positive().optional()
});

const thresholdBulkSchema = z.object({
  facilityId: z.string().uuid().optional(),
  rows: z
    .array(
      z.object({
        id: z.string().uuid(),
        clinicId: z.string().uuid().nullable().optional(),
        metric: z.nativeEnum(AlertThresholdMetric).optional(),
        status: z.nativeEnum(EncounterStatus).nullable().optional(),
        yellowAtMin: z.number().int().positive(),
        redAtMin: z.number().int().positive(),
        escalation2Min: z.number().int().positive().nullable().optional()
      })
    )
    .min(1)
});

const athenaConnectorSchema = z.object({
  facilityId: z.string().uuid().optional(),
  enabled: z.boolean().optional(),
  config: z
    .object({
      baseUrl: z.string().trim().optional(),
      practiceId: z.string().trim().optional(),
      departmentIds: z.array(z.string().trim()).optional(),
      authType: z.enum(["none", "api_key", "basic", "oauth2"]).optional(),
      username: z.string().trim().optional(),
      password: z.string().trim().optional(),
      apiKey: z.string().trim().optional(),
      apiKeyHeader: z.string().trim().optional(),
      apiKeyPrefix: z.string().trim().optional(),
      clientId: z.string().trim().optional(),
      clientSecret: z.string().trim().optional(),
      accessToken: z.string().trim().optional(),
      refreshToken: z.string().trim().optional(),
      timeoutMs: z.number().int().positive().optional(),
      retryCount: z.number().int().nonnegative().optional(),
      retryBackoffMs: z.number().int().positive().optional(),
      testPath: z.string().trim().optional(),
      previewPath: z.string().trim().optional(),
      revenuePath: z.string().trim().optional(),
      headers: z.record(z.string(), z.string()).optional()
    })
    .optional(),
  mapping: z.record(z.string(), z.string()).optional()
});

const athenaPreviewSchema = z.object({
  facilityId: z.string().uuid().optional(),
  clinicId: z.string().uuid().optional(),
  dateOfService: z.string().optional()
});

const athenaRevenueMonitoringSchema = z.object({
  facilityId: z.string().uuid().optional(),
  clinicId: z.string().uuid().optional(),
  dateOfService: z.string().optional(),
  maxRows: z.number().int().positive().max(250).optional(),
});

const revenueSettingsSchema = z.object({
  facilityId: z.string().uuid().optional(),
  missedCollectionReasons: z.array(z.string().trim().min(1)).optional(),
  queueSla: z.record(z.string(), z.number().int().positive()).optional(),
  dayCloseDefaults: z
    .object({
      defaultDueHours: z.number().int().positive().optional(),
      requireNextAction: z.boolean().optional()
    })
    .optional(),
  estimateDefaults: z
    .object({
      defaultPatientEstimateCents: z.number().int().min(0).optional(),
      defaultPosCollectionPercent: z.number().int().min(0).max(100).optional(),
      explainEstimateByDefault: z.boolean().optional(),
    })
    .optional(),
  providerQueryTemplates: z.array(z.string().trim().min(1)).optional(),
  athenaLinkTemplate: z.string().trim().nullable().optional(),
  athenaChecklistDefaults: z
    .array(
      z.object({
        label: z.string().trim().min(1),
        sortOrder: z.number().int().nonnegative().optional()
      })
    )
    .optional(),
  checklistDefaults: z.record(
    z.string(),
    z.array(
      z.object({
        label: z.string().trim().min(1),
        sortOrder: z.number().int().nonnegative().optional(),
        required: z.boolean().optional()
      })
    )
  ).optional(),
  serviceCatalog: z.array(
    z.object({
      id: z.string().trim().min(1),
      label: z.string().trim().min(1),
      suggestedProcedureCode: z.string().trim().nullable().optional(),
      expectedChargeCents: z.number().int().nullable().optional(),
      detailSchemaKey: z.string().trim().nullable().optional(),
      active: z.boolean().optional(),
      allowCustomNote: z.boolean().optional()
    })
  ).optional(),
  chargeSchedule: z.array(
    z.object({
      code: z.string().trim().min(1),
      amountCents: z.number().int().nonnegative(),
      description: z.string().trim().nullable().optional(),
      active: z.boolean().optional()
    })
  ).optional(),
  reimbursementRules: z.array(
    z.object({
      id: z.string().trim().min(1),
      payerName: z.string().trim().nullable().optional(),
      financialClass: z.string().trim().nullable().optional(),
      expectedPercent: z.number().int().min(0).max(100),
      active: z.boolean().optional(),
      note: z.string().trim().nullable().optional(),
    }),
  ).optional(),
});

const notificationSchema = z.object({
  clinicId: z.string().uuid(),
  status: z.nativeEnum(EncounterStatus),
  severity: z.nativeEnum(AlertLevel),
  recipients: z.array(z.nativeEnum(RoleName)).min(1),
  channels: z.array(z.enum(["in_app", "sms", "email"])).min(1),
  cooldownMinutes: z.number().int().positive(),
  ackRequired: z.boolean().optional(),
  escalationAfterMin: z.number().int().positive().optional(),
  escalationRecipients: z.array(z.nativeEnum(RoleName)).optional(),
  quietHours: z
    .object({
      start: z.string(),
      end: z.string(),
      timezone: z.string()
    })
    .optional()
});

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).optional(),
  firstName: z.string().trim().min(1).optional(),
  lastName: z.string().trim().min(1).optional(),
  credential: z.string().trim().optional(),
  status: z.string().optional(),
  role: z.nativeEnum(RoleName).optional(),
  facilityIds: z.array(z.string().uuid()).optional(),
  facilityId: z.string().uuid().optional(),
  clinicId: z.string().uuid().optional(),
  phone: z.string().optional()
});

const directorySearchSchema = z.object({
  query: z.string().trim().min(2),
});

const provisionUserSchema = z.object({
  objectId: z.string().trim().min(1),
  role: z.nativeEnum(RoleName),
  facilityIds: z.array(z.string().uuid()).optional(),
  facilityId: z.string().uuid().optional(),
  clinicId: z.string().uuid().optional()
});

const archivedEncounterQuerySchema = z.object({
  facilityId: z.string().uuid().optional(),
  clinicId: z.string().uuid().optional(),
  status: z.nativeEnum(EncounterStatus).optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  unresolvedOnly: z.string().optional(),
  search: z.string().trim().optional()
});

const staleEncounterCleanupSchema = z.object({
  facilityId: z.string().uuid().optional(),
  clinicId: z.string().uuid().optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  encounterIds: z.array(z.string().uuid()).optional(),
  execute: z.boolean().default(false),
  note: z.string().trim().max(1000).optional()
});

const updateUserSchema = z.object({
  email: z.string().email().optional(),
  name: z.string().min(1).optional(),
  firstName: z.string().trim().min(1).optional(),
  lastName: z.string().trim().min(1).optional(),
  credential: z.string().trim().optional(),
  status: z.string().optional(),
  phone: z.string().optional()
});

function composeUserDisplayName(input: {
  name?: string;
  firstName?: string;
  lastName?: string;
  credential?: string;
}) {
  const explicitName = input.name?.trim();
  if (explicitName) return explicitName;
  const first = input.firstName?.trim() || "";
  const last = input.lastName?.trim() || "";
  const fullName = `${first} ${last}`.trim();
  const credential = input.credential?.trim();
  if (fullName && credential) return `${fullName}, ${credential}`;
  if (fullName) return fullName;
  throw new ApiError(400, "First name and last name are required");
}

function isStrictEntraProvisioningMode() {
  return env.ENTRA_STRICT_MODE;
}

function resolveDirectoryEmail(user: EntraDirectoryUser) {
  const email = user.email || user.userPrincipalName;
  if (!email) {
    throw new ApiError(400, "Microsoft Entra user is missing an email or user principal name.");
  }
  return email.toLowerCase();
}

function legacyIdentityAlias(existingCognitoSub: string | null | undefined, objectId: string) {
  return existingCognitoSub || objectId;
}

function resolveUserDirectoryObjectId(user: {
  entraObjectId?: string | null;
  cognitoSub?: string | null;
}) {
  return user.entraObjectId || user.cognitoSub || null;
}

async function syncUserFromDirectory(params: {
  userId: string;
  directoryUser: EntraDirectoryUser | null;
}) {
  const existing = await prisma.user.findUnique({
    where: { id: params.userId },
    include: { roles: true }
  });
  requireCondition(existing, 404, "User not found");

  const syncTimestamp = new Date();
  if (!params.directoryUser) {
    const updated = await prisma.user.update({
      where: { id: params.userId },
      data: {
        directoryStatus: "deleted",
        directoryAccountEnabled: false,
        lastDirectorySyncAt: syncTimestamp,
        status: existing.status === "archived" ? "archived" : "suspended"
      },
      include: { roles: true }
    });
    return updated;
  }

  const directoryUser = params.directoryUser;
  const memberUser = directoryUser.userType.toLowerCase() === "member";
  const accountEnabled = directoryUser.accountEnabled;
  const shouldSuspend = !memberUser || !accountEnabled || directoryUser.directoryStatus !== "active";

  return prisma.user.update({
    where: { id: params.userId },
    data: {
      email: resolveDirectoryEmail(directoryUser),
      name: directoryUser.displayName,
      entraObjectId: directoryUser.objectId,
      entraTenantId: directoryUser.tenantId || env.ENTRA_TENANT_ID || null,
      entraUserPrincipalName: directoryUser.userPrincipalName || null,
      identityProvider: directoryUser.identityProvider,
      directoryStatus: directoryUser.directoryStatus,
      directoryUserType: directoryUser.userType,
      directoryAccountEnabled: directoryUser.accountEnabled,
      lastDirectorySyncAt: syncTimestamp,
      cognitoSub: legacyIdentityAlias(existing.cognitoSub, directoryUser.objectId),
      status:
        existing.status === "archived"
          ? "archived"
          : shouldSuspend
            ? "suspended"
            : existing.status
    },
    include: { roles: true }
  });
}

const roleSchema = z.object({
  role: z.nativeEnum(RoleName),
  clinicId: z.string().uuid().optional(),
  facilityId: z.string().uuid().optional()
});

const clinicAssignmentSchema = z.object({
  providerUserId: z.string().uuid().nullable().optional(),
  maUserId: z.string().uuid().nullable().optional()
});

const assignmentOverrideQuerySchema = z.object({
  facilityId: z.string().uuid().optional(),
  clinicId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  role: z.nativeEnum(RoleName).optional(),
  state: z.enum(["active", "upcoming", "expired", "all"]).optional()
});

const assignmentOverrideSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum([RoleName.MA, RoleName.Clinician]),
  clinicId: z.string().uuid(),
  facilityId: z.string().uuid(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  reason: z.string().trim().min(3).max(500)
});

const patientIdentityReviewQuerySchema = z.object({
  facilityId: z.string().uuid().optional(),
  status: z.enum(["open", "resolved", "ignored"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const patientIdentityReviewUpdateSchema = z.object({
  status: z.enum(["resolved", "ignored"]),
  patientId: z.string().uuid().optional(),
});

async function getFirstActiveFacility() {
  return prisma.facility.findFirst({
    where: { status: { not: "archived" } },
    orderBy: { createdAt: "asc" }
  });
}

function scopedFacilityIds(request: FastifyRequest) {
  const user = request.user!;
  if (user.role === RoleName.Admin) {
    return null;
  }
  return user.availableFacilityIds;
}

async function resolveFacilityForRequest(request: FastifyRequest, requestedFacilityId?: string) {
  const user = request.user!;
  const scopedIds = scopedFacilityIds(request);
  const requested = requestedFacilityId?.trim() || user.activeFacilityId || user.facilityId || undefined;

  if (requested) {
    enterFacilityScope(requested);
    const facility = await prisma.facility.findUnique({ where: { id: requested } });
    requireCondition(facility, 404, "Facility not found");
    if (scopedIds && !scopedIds.includes(facility.id)) {
      throw new ApiError(403, "Facility is outside your assigned scope");
    }
    enterFacilityScope(facility.id);
    return facility;
  }

  if (scopedIds && scopedIds.length > 0) {
    const facility = await prisma.facility.findFirst({
      where: { id: { in: scopedIds } },
      orderBy: { createdAt: "asc" }
    });
    requireCondition(facility, 404, "No facilities available in your scope");
    enterFacilityScope(facility.id);
    return facility;
  }

  const facility = await getFirstActiveFacility();
  requireCondition(facility, 404, "No facility found");
  enterFacilityScope(facility.id);
  return facility;
}

function parseQueryBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  return value === "true";
}

function parseFacilityDateBoundary(
  value: string | undefined,
  timezone: string,
  boundary: "start" | "end",
  fallback: DateTime
) {
  if (!value) {
    return boundary === "start" ? fallback.startOf("day") : fallback.endOf("day");
  }
  const parsed = DateTime.fromISO(value, { zone: timezone });
  if (!parsed.isValid) {
    throw new ApiError(400, `Invalid date '${value}'`);
  }
  return boundary === "start" ? parsed.startOf("day") : parsed.endOf("day");
}

async function resolveClinicForFacility(clinicId: string, facilityId: string) {
  enterFacilityScope(facilityId);
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { id: true, facilityId: true }
  });
  requireCondition(clinic, 404, "Clinic not found");
  requireCondition(clinic.facilityId === facilityId, 400, "Clinic is outside the selected facility scope");
  return clinic;
}

async function assertUserRoleForFacility(params: {
  userId: string;
  role: RoleName;
  facilityId: string;
}) {
  const { userId, role, facilityId } = params;
  const matchedRole = await prisma.userRole.findFirst({
    where: {
      userId,
      role,
      OR: [{ facilityId }, { clinic: { facilityId } }]
    }
  });
  requireCondition(matchedRole, 400, `Selected user is not assigned to role ${role} in this facility`);
}

async function syncUserActiveFacilityToScope(params: {
  userId: string;
  preferredFacilityId?: string | null;
}) {
  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    include: {
      roles: {
        include: {
          clinic: { select: { facilityId: true } }
        }
      }
    }
  });
  requireCondition(user, 404, "User not found");

  const availableFacilityIds = Array.from(
    new Set(
      user.roles
        .map((entry) => entry.facilityId || entry.clinic?.facilityId || null)
        .filter((entry): entry is string => Boolean(entry))
    )
  );

  const preferredFacilityId = params.preferredFacilityId?.trim() || null;
  const nextActiveFacilityId =
    (preferredFacilityId && availableFacilityIds.includes(preferredFacilityId) ? preferredFacilityId : null) ||
    (user.activeFacilityId && availableFacilityIds.includes(user.activeFacilityId) ? user.activeFacilityId : null) ||
    availableFacilityIds[0] ||
    null;

  if (user.activeFacilityId !== nextActiveFacilityId) {
    await prisma.user.update({
      where: { id: user.id },
      data: { activeFacilityId: nextActiveFacilityId }
    });
  }

  return nextActiveFacilityId;
}

async function ensureProviderRecordForClinic(params: {
  tx: Prisma.TransactionClient;
  clinicId: string;
  providerUserId: string;
  providerUserName: string;
}) {
  const { tx, clinicId, providerUserId, providerUserName } = params;
  const byExistingAssignment = await tx.clinicAssignment.findFirst({
    where: {
      clinicId,
      providerUserId,
      providerId: { not: null }
    },
    select: { providerId: true }
  });

  if (byExistingAssignment?.providerId) {
    const existingProvider = await tx.provider.findUnique({
      where: { id: byExistingAssignment.providerId }
    });
    if (existingProvider) {
      if (!existingProvider.active || existingProvider.clinicId !== clinicId || existingProvider.name !== providerUserName) {
        await tx.provider.update({
          where: { id: existingProvider.id },
          data: {
            clinicId,
            name: providerUserName,
            active: true
          }
        });
      }
      return existingProvider.id;
    }
  }

  const providerByName = await tx.provider.findFirst({
    where: {
      clinicId,
      name: providerUserName
    },
    orderBy: { id: "asc" }
  });

  if (providerByName) {
    if (!providerByName.active) {
      await tx.provider.update({
        where: { id: providerByName.id },
        data: { active: true }
      });
    }
    return providerByName.id;
  }

  const createdProvider = await tx.provider.create({
    data: {
      clinicId,
      name: providerUserName,
      active: true
    }
  });
  return createdProvider.id;
}

function jsonOrNull(value: unknown) {
  return value === undefined ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

function normalizeTemplateType(input: string): TemplateType {
  const value = input.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (value === "checkin" || value === "intake") return TemplateType.intake;
  if (value === "rooming") return TemplateType.rooming;
  if (value === "clinician") return TemplateType.clinician;
  if (value === "checkout") return TemplateType.checkout;
  throw new ApiError(400, `Unsupported template type '${input}'`);
}

function uiTemplateType(type: TemplateType) {
  return type === TemplateType.intake ? "checkin" : type;
}

type TemplateFieldInput = z.infer<typeof templateFieldSchema>;

function normalizeTemplateFields(fields: TemplateFieldInput[]) {
  return fields.map((field, index) => {
    const key = String(field.key || "").trim();
    const label = String(field.label || "").trim();
    if (!key) {
      throw new ApiError(400, `fields[${index}].key missing`);
    }
    if (!label) {
      throw new ApiError(400, `fields[${index}].label missing`);
    }
    const options =
      field.type === "select" || field.type === "radio"
        ? (field.options || []).map((entry) => entry.trim()).filter(Boolean)
        : undefined;
    if ((field.type === "select" || field.type === "radio") && (!options || options.length === 0)) {
      throw new ApiError(400, `fields[${index}].options requires at least one option`);
    }

    return {
      id: field.id?.trim() || `field_${index + 1}`,
      key,
      label,
      type: field.type,
      required: Boolean(field.required),
      ...(options ? { options } : {}),
      ...(field.group?.trim() ? { group: field.group.trim() } : {}),
      ...(field.icon?.trim() ? { icon: field.icon.trim() } : {}),
      ...(field.color?.trim() ? { color: field.color.trim() } : {})
    };
  });
}

const defaultThresholdRows: Array<{
  metric: AlertThresholdMetric;
  status: EncounterStatus | null;
  yellowAtMin: number;
  redAtMin: number;
}> = [
  { metric: AlertThresholdMetric.stage, status: EncounterStatus.Lobby, yellowAtMin: 15, redAtMin: 25 },
  { metric: AlertThresholdMetric.stage, status: EncounterStatus.Rooming, yellowAtMin: 12, redAtMin: 20 },
  { metric: AlertThresholdMetric.stage, status: EncounterStatus.ReadyForProvider, yellowAtMin: 10, redAtMin: 18 },
  { metric: AlertThresholdMetric.stage, status: EncounterStatus.Optimizing, yellowAtMin: 25, redAtMin: 40 },
  { metric: AlertThresholdMetric.stage, status: EncounterStatus.CheckOut, yellowAtMin: 8, redAtMin: 15 },
  { metric: AlertThresholdMetric.overall_visit, status: null, yellowAtMin: 60, redAtMin: 90 }
];

async function ensureFacilityThresholdDefaults(facilityId: string) {
  for (const row of defaultThresholdRows) {
    const existing = await prisma.alertThreshold.findFirst({
      where: {
        facilityId,
        clinicId: null,
        metric: row.metric,
        status: row.status
      },
      select: { id: true }
    });
    if (existing) continue;
    await prisma.alertThreshold.create({
      data: {
        facilityId,
        clinicId: null,
        metric: row.metric,
        status: row.status,
        yellowAtMin: row.yellowAtMin,
        redAtMin: row.redAtMin
      }
    });
  }
}

const thresholdStageOrder: EncounterStatus[] = [
  EncounterStatus.Lobby,
  EncounterStatus.Rooming,
  EncounterStatus.ReadyForProvider,
  EncounterStatus.Optimizing,
  EncounterStatus.CheckOut
];

function thresholdSortRank(metric: AlertThresholdMetric, status: EncounterStatus | null) {
  if (metric === AlertThresholdMetric.overall_visit) return 999;
  const idx = thresholdStageOrder.findIndex((entry) => entry === status);
  return idx === -1 ? 500 : idx;
}

function isRoomNumberConstraintError(error: unknown) {
  const prismaCode = typeof (error as { code?: unknown })?.code === "string"
    ? String((error as { code?: unknown }).code)
    : "";
  const message = String((error as { message?: unknown })?.message || "").toLowerCase();
  return prismaCode === "P2002" && message.includes("roomnumber");
}

async function nextRoomNumberForFacility(
  facilityId: string,
  tx: Prisma.TransactionClient = prisma
) {
  const max = await tx.clinicRoom.aggregate({
    where: {
      facilityId,
      status: { in: ["active", "inactive"] }
    },
    _max: { roomNumber: true }
  });
  return Number(max._max.roomNumber || 0) + 1;
}

async function createRoomWithAllocatedNumber(params: {
  facilityId: string;
  name: string;
  roomType: string;
  status: string;
}, db: Prisma.TransactionClient | typeof prisma = prisma) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const createRoom = async (tx: Prisma.TransactionClient) => {
        const roomNumber = await nextRoomNumberForFacility(params.facilityId, tx);
        return tx.clinicRoom.create({
          data: {
            facilityId: params.facilityId,
            name: params.name,
            roomNumber,
            roomType: params.roomType,
            status: params.status,
            sortOrder: roomNumber
          }
        });
      };
      if ("$transaction" in db) {
        return await db.$transaction(async (tx) => createRoom(tx));
      }
      return await createRoom(db);
    } catch (error) {
      if (isRoomNumberConstraintError(error) && attempt < 2) {
        continue;
      }
      throw error;
    }
  }

  throw new ApiError(409, "Room # already exists in the selected facility");
}

async function restoreRoomWithAllocatedNumber(roomId: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const room = await tx.clinicRoom.findUnique({ where: { id: roomId } });
        requireCondition(room, 404, "Room not found");
        const roomNumber = await nextRoomNumberForFacility(room.facilityId, tx);
        const restored = await tx.clinicRoom.update({
          where: { id: roomId },
          data: {
            status: "active",
            roomNumber,
            sortOrder: roomNumber
          }
        });
        await tx.clinicRoomAssignment.updateMany({
          where: { roomId },
          data: { active: true }
        });
        return restored;
      });
    } catch (error) {
      if (isRoomNumberConstraintError(error) && attempt < 2) {
        continue;
      }
      throw error;
    }
  }

  throw new ApiError(409, "Room # already exists in the selected facility");
}

function buildTemplateSchemas(fields: ReturnType<typeof normalizeTemplateFields>) {
  const properties: Record<string, unknown> = {};
  const requiredFields: string[] = [];

  fields.forEach((field) => {
    const definition =
      field.type === "checkbox"
        ? { type: "boolean", title: field.label }
        : field.type === "number"
          ? { type: "number", title: field.label }
          : field.type === "select" || field.type === "radio"
            ? { type: "string", title: field.label, enum: field.options || [] }
            : { type: "string", title: field.label };
    properties[field.key] = definition;
    if (field.required) requiredFields.push(field.key);
  });

  const jsonSchema = {
    type: "object",
    properties
  } as Prisma.InputJsonValue;
  const uiSchema = {} as Prisma.InputJsonValue;

  return {
    jsonSchema,
    uiSchema,
    requiredFields
  };
}

function reasonStatusToActive(status: string) {
  return status === "active";
}

function templateStatusToActive(status: string) {
  return status === "active";
}

function normalizeRoomType(value: string) {
  return value.trim().toLowerCase();
}

function isMissingSchemaError(error: unknown) {
  const code = String((error as { code?: unknown })?.code || "");
  const message = String((error as { message?: unknown })?.message || "").toLowerCase();
  return (
    code === "P2021" ||
    code === "P2022" ||
    message.includes("no such table") ||
    message.includes("no such column")
  );
}

async function ignoreMissingSchema<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return null;
    }
    throw error;
  }
}

async function roomRequiresArchival(roomId: string) {
  const [encounterCount, issueCount, checklistCount, eventCount, occupancyCount, taskCount] = await Promise.all([
    prisma.encounter.count({ where: { roomId } }),
    ignoreMissingSchema(() => prisma.roomIssue.count({ where: { roomId } })).then((value) => value || 0),
    ignoreMissingSchema(() => prisma.roomChecklistRun.count({ where: { roomId } })).then((value) => value || 0),
    ignoreMissingSchema(() => prisma.roomOperationalEvent.count({ where: { roomId } })).then((value) => value || 0),
    ignoreMissingSchema(() => prisma.roomOperationalState.count({ where: { roomId, occupiedEncounterId: { not: null } } })).then((value) => value || 0),
    prisma.task.count({ where: { roomId } }),
  ]);

  return encounterCount > 0 || issueCount > 0 || checklistCount > 0 || eventCount > 0 || occupancyCount > 0 || taskCount > 0;
}

async function upsertPatientAliasInTx(
  tx: Prisma.TransactionClient,
  params: {
    patientId: string;
    facilityId: string;
    aliasType: string;
    aliasValue?: string | null;
    normalizedAliasValue?: string | null;
  },
) {
  const aliasValue = params.aliasValue?.trim() || null;
  const normalizedAliasValue = params.normalizedAliasValue?.trim() || null;
  if (!aliasValue || !normalizedAliasValue) {
    return;
  }

  await tx.patientAlias.upsert({
    where: {
      patientId_aliasType_normalizedAliasValue: {
        patientId: params.patientId,
        aliasType: params.aliasType,
        normalizedAliasValue,
      },
    },
    create: {
      patientId: params.patientId,
      facilityId: params.facilityId,
      aliasType: params.aliasType,
      aliasValue,
      normalizedAliasValue,
    },
    update: {
      aliasValue,
    },
  });
}

function sameIsoBirthDate(left?: Date | null, right?: Date | null) {
  if (!left || !right) return false;
  return left.toISOString().slice(0, 10) === right.toISOString().slice(0, 10);
}

async function migratePatientReferencesToCanonical(
  tx: Prisma.TransactionClient,
  params: {
    sourcePatientId: string;
    targetPatientId: string;
    facilityId: string;
    archivedByUserId?: string | null;
    archivedReason?: string | null;
  },
) {
  if (params.sourcePatientId === params.targetPatientId) {
    return;
  }

  const aliases = await tx.patientAlias.findMany({
    where: { patientId: params.sourcePatientId },
    select: {
      aliasType: true,
      aliasValue: true,
      normalizedAliasValue: true,
    },
  });

  await tx.incomingSchedule.updateMany({
    where: { patientRecordId: params.sourcePatientId },
    data: { patientRecordId: params.targetPatientId },
  });
  await tx.encounter.updateMany({
    where: { patientRecordId: params.sourcePatientId },
    data: { patientRecordId: params.targetPatientId },
  });
  await tx.revenueCase.updateMany({
    where: { patientRecordId: params.sourcePatientId },
    data: { patientRecordId: params.targetPatientId, version: { increment: 1 } },
  });

  for (const alias of aliases) {
    await upsertPatientAliasInTx(tx, {
      patientId: params.targetPatientId,
      facilityId: params.facilityId,
      aliasType: alias.aliasType,
      aliasValue: alias.aliasValue,
      normalizedAliasValue: alias.normalizedAliasValue,
    });
  }

  await tx.patientAlias.deleteMany({
    where: { patientId: params.sourcePatientId },
  });

  const [incomingCount, encounterCount, revenueCount] = await Promise.all([
    tx.incomingSchedule.count({ where: { patientRecordId: params.sourcePatientId } }),
    tx.encounter.count({ where: { patientRecordId: params.sourcePatientId } }),
    tx.revenueCase.count({ where: { patientRecordId: params.sourcePatientId } }),
  ]);

  await tx.patient.update({
    where: { id: params.sourcePatientId },
    data: {
      archivedAt: new Date(),
      archivedByUserId: params.archivedByUserId || null,
      archivedReason:
        params.archivedReason ||
        `merged_into:${params.targetPatientId}` + (incomingCount + encounterCount + revenueCount > 0
          ? ` (refs_moved=${incomingCount + encounterCount + revenueCount})`
          : ""),
    },
  });
}

function mapAthenaConnectorResponse(connector: {
  facilityId: string;
  vendor: string;
  enabled: boolean;
  configJson: Prisma.JsonValue;
  mappingJson: Prisma.JsonValue | null;
  lastTestStatus: string | null;
  lastTestAt: Date | null;
  lastTestMessage: string | null;
  lastSyncStatus: string | null;
  lastSyncAt: Date | null;
  lastSyncMessage: string | null;
}) {
  return {
    facilityId: connector.facilityId,
    vendor: connector.vendor,
    enabled: connector.enabled,
    config: redactAthenaConnectorConfig(connector.configJson),
    mapping: (connector.mappingJson || {}) as Record<string, string>,
    lastTestStatus: connector.lastTestStatus,
    lastTestAt: connector.lastTestAt,
    lastTestMessage: connector.lastTestMessage,
    lastSyncStatus: connector.lastSyncStatus,
    lastSyncAt: connector.lastSyncAt,
    lastSyncMessage: connector.lastSyncMessage
  };
}

type AthenaRevenueImportPreviewRow = {
  index: number;
  encounterId: string;
  patientId: string;
  clinic: string;
  dateOfService: string;
  chargeEnteredAt: string | null;
  claimSubmittedAt: string | null;
  daysToSubmit: number | null;
  daysInAR: number | null;
  claimStatus: string;
  patientBalanceCents: number | null;
  raw: Record<string, unknown>;
};

async function matchRevenueCaseForAthenaRow(
  facilityId: string,
  row: AthenaRevenueImportPreviewRow,
) {
  if (row.encounterId) {
    const byEncounter = await prisma.revenueCase.findFirst({
      where: { facilityId, encounterId: row.encounterId },
      select: {
        id: true,
        encounterId: true,
        patientId: true,
        clinicId: true,
        currentRevenueStatus: true,
        currentWorkQueue: true,
      },
      orderBy: { updatedAt: "desc" },
    });
    if (byEncounter) return byEncounter;
  }

  if (!row.patientId || !row.dateOfService) return null;
  const dateAnchor = DateTime.fromISO(row.dateOfService, { zone: "utc" });
  if (!dateAnchor.isValid) return null;
  const startOfDay = dateAnchor.startOf("day").toJSDate();
  const endOfDay = dateAnchor.plus({ days: 1 }).startOf("day").toJSDate();
  return prisma.revenueCase.findFirst({
    where: {
      facilityId,
      patientId: row.patientId,
      dateOfService: {
        gte: startOfDay,
        lt: endOfDay,
      },
    },
    select: {
      id: true,
      encounterId: true,
      patientId: true,
      clinicId: true,
      currentRevenueStatus: true,
      currentWorkQueue: true,
    },
    orderBy: { updatedAt: "desc" },
  });
}

async function listUserAssignmentImpact(userId: string) {
  const impactedClinics = await prisma.clinic.findMany({
    where: {
      status: { in: ["active", "inactive"] },
      staffAssignment: {
        is: {
          OR: [{ providerUserId: userId }, { maUserId: userId }]
        }
      }
    },
    select: {
      id: true,
      name: true,
      shortCode: true,
      status: true,
      maRun: true,
      staffAssignment: {
        select: {
          providerUserId: true,
          providerUser: { select: { id: true, status: true } },
          maUserId: true,
          maUser: { select: { id: true, status: true } }
        }
      }
    },
    orderBy: { name: "asc" }
  });

  if (impactedClinics.length === 0) {
    return {
      impactedClinicCount: 0,
      operationalClinicCount: 0,
      nonOperationalClinicCount: 0,
      clinics: [] as Array<{
        clinicId: string;
        clinicName: string;
        clinicShortCode: string | null;
        clinicStatus: string;
        maRun: boolean;
        roomCount: number;
        isOperational: boolean;
      }>
    };
  }

  const roomCounts = await prisma.clinicRoomAssignment.groupBy({
    by: ["clinicId"],
    where: {
      clinicId: { in: impactedClinics.map((clinic) => clinic.id) },
      active: true,
      room: { status: "active" }
    },
    _count: { _all: true }
  });
  const roomCountByClinicId = new Map(roomCounts.map((row) => [row.clinicId, row._count._all]));

  const clinics = impactedClinics.map((clinic) => {
    const assignment = clinic.staffAssignment;
    const roomCount = roomCountByClinicId.get(clinic.id) || 0;
    const maReady = !!assignment?.maUserId && assignment.maUser?.status === "active";
    const providerReady =
      clinic.maRun ||
      (!!assignment?.providerUserId && assignment.providerUser?.status === "active");

    return {
      clinicId: clinic.id,
      clinicName: clinic.name,
      clinicShortCode: clinic.shortCode || null,
      clinicStatus: clinic.status,
      maRun: clinic.maRun,
      roomCount,
      isOperational: clinic.status === "active" && roomCount > 0 && maReady && providerReady
    };
  });

  return {
    impactedClinicCount: clinics.length,
    operationalClinicCount: clinics.filter((clinic) => clinic.isOperational).length,
    nonOperationalClinicCount: clinics.filter((clinic) => !clinic.isOperational).length,
    clinics
  };
}

export async function registerAdminRoutes(app: FastifyInstance) {
  app.get(
    "/admin/clinics",
    { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.MA, RoleName.Clinician, RoleName.FrontDeskCheckOut, RoleName.OfficeManager, RoleName.Admin, RoleName.RevenueCycle) },
    async (request) => {
      const query = request.query as {
        facilityId?: string;
        includeInactive?: string;
        includeArchived?: string;
      };
      const includeInactive = query.includeInactive === "true";
      const includeArchived = query.includeArchived === "true";
      const facility = await resolveFacilityForRequest(request, query.facilityId);

      const statuses = includeArchived
        ? includeInactive
          ? undefined
          : (["active", "archived"] as string[])
        : includeInactive
          ? (["active", "inactive"] as string[])
          : (["active"] as string[]);

      const clinics = await prisma.clinic.findMany({
        where: {
          facilityId: facility.id,
          ...(statuses ? { status: { in: statuses } } : {})
        },
        include: { facility: true },
        orderBy: { name: "asc" }
      });

      const clinicIds = clinics.map((row) => row.id);
      const providers = await prisma.provider.groupBy({
        by: ["clinicId"],
        where: { clinicId: { in: clinicIds }, active: true },
        _count: { _all: true }
      });
      const roomAssignments = await prisma.clinicRoomAssignment.findMany({
        where: { clinicId: { in: clinicIds }, active: true },
        include: { room: true }
      });
      const clinicAssignments = await prisma.clinicAssignment.findMany({
        where: { clinicId: { in: clinicIds } },
        include: {
          providerUser: { select: { id: true, name: true, status: true } },
          maUser: { select: { id: true, name: true, status: true } }
        }
      });

      const providerCountByClinic = new Map(providers.map((row) => [row.clinicId, row._count._all]));
      const clinicAssignmentByClinic = new Map(clinicAssignments.map((row) => [row.clinicId, row]));
      const roomIdsByClinic = new Map<string, string[]>();
      const activeRoomCountByClinic = new Map<string, number>();

      roomAssignments.forEach((assignment) => {
        if (!roomIdsByClinic.has(assignment.clinicId)) roomIdsByClinic.set(assignment.clinicId, []);
        roomIdsByClinic.get(assignment.clinicId)!.push(assignment.roomId);
        if (assignment.room.status === "active") {
          activeRoomCountByClinic.set(assignment.clinicId, (activeRoomCountByClinic.get(assignment.clinicId) || 0) + 1);
        }
      });

      return clinics.map((clinic) => {
        const providerCount = providerCountByClinic.get(clinic.id) || 0;
        const assignment = clinicAssignmentByClinic.get(clinic.id);
        const providerAssignedActive =
          !clinic.maRun &&
          !!assignment?.providerUserId &&
          assignment.providerUser?.status === "active";
        const maAssignedActive =
          !!assignment?.maUserId &&
          assignment.maUser?.status === "active";
        const roomCount = activeRoomCountByClinic.get(clinic.id) || 0;
        const ready = clinic.maRun
          ? roomCount > 0 && maAssignedActive
          : roomCount > 0 && providerAssignedActive && maAssignedActive;

        return {
          ...clinic,
          cardTags: normalizeStringArrayJson(clinic.cardTags, request.log, "clinicCardTags"),
          roomIds: roomIdsByClinic.get(clinic.id) || [],
          assignment: assignment
            ? {
                providerUserId: assignment.providerUserId,
                providerUserName: assignment.providerUser?.name || null,
                providerUserStatus: assignment.providerUser?.status || null,
                maUserId: assignment.maUserId,
                maUserName: assignment.maUser?.name || null,
                maUserStatus: assignment.maUser?.status || null
              }
            : null,
          staffing: {
            providerCount,
            providerMaAssignments: providerAssignedActive ? 1 : 0,
            clinicMaAssignments: maAssignedActive ? 1 : 0,
            roomCount,
            ready
          }
        };
      });
    }
  );

  app.get(
    "/admin/facilities",
    { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.MA, RoleName.Clinician, RoleName.FrontDeskCheckOut, RoleName.OfficeManager, RoleName.Admin, RoleName.RevenueCycle) },
    async (request) => {
      const scopedIds = scopedFacilityIds(request);
      return prisma.facility.findMany({
        where: scopedIds ? { id: { in: scopedIds } } : { status: { not: "archived" } },
        orderBy: { name: "asc" }
      });
    }
  );

  app.get(
    "/admin/facility-profile",
    { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.MA, RoleName.Clinician, RoleName.FrontDeskCheckOut, RoleName.OfficeManager, RoleName.Admin, RoleName.RevenueCycle) },
    async (request) => {
      const query = request.query as { facilityId?: string };
      const facility = await resolveFacilityForRequest(request, query.facilityId);
      return facility;
    }
  );

  app.post("/admin/facilities", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const dto = facilitySchema.parse(request.body);
    return prisma.facility.create({
      data: {
        name: dto.name,
        shortCode: dto.shortCode,
        address: dto.address,
        phone: dto.phone,
        timezone: dto.timezone || "America/New_York"
      }
    });
  });

  app.post("/admin/facilities/:id", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const facilityId = (request.params as { id: string }).id;
    const dto = facilitySchema.partial().parse(request.body);

    const existing = await prisma.facility.findUnique({ where: { id: facilityId } });
    requireCondition(existing, 404, "Facility not found");

    return prisma.facility.update({
      where: { id: facilityId },
      data: {
        name: dto.name,
        shortCode: dto.shortCode,
        address: dto.address,
        phone: dto.phone,
        timezone: dto.timezone
      }
    });
  });

  app.post("/admin/clinics", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const dto = clinicSchema.parse(request.body);
    requireCondition(dto.maRun !== undefined, 400, "Clinic run model is required");
    const facility = await resolveFacilityForRequest(request, dto.facilityId);

    const created = await prisma.clinic.create({
      data: {
        facilityId: facility.id,
        name: dto.name,
        shortCode: dto.shortCode,
        timezone: facility.timezone || "America/New_York",
        maRun: dto.maRun ?? false,
        status: dto.status ?? "active",
        autoCloseEnabled: dto.autoCloseEnabled ?? false,
        autoCloseTime: dto.autoCloseTime,
        cardColor: dto.cardColor,
        cardTags: dto.cardTags ? asInputJson(parseStringArrayJsonInput(dto.cardTags, "clinicCardTags")) : Prisma.JsonNull
      }
    });

    if (dto.roomIds && dto.roomIds.length > 0) {
      const rooms = await prisma.clinicRoom.findMany({
        where: {
          id: { in: dto.roomIds },
          facilityId: facility.id
        },
        select: { id: true }
      });
      requireCondition(rooms.length === dto.roomIds.length, 400, "One or more rooms are invalid for this facility");
      await prisma.clinicRoomAssignment.createMany({
        data: dto.roomIds.map((roomId) => ({
          clinicId: created.id,
          roomId,
          active: true
        }))
      });
    }

    return created;
  });

  app.post("/admin/clinics/:id", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const clinicId = (request.params as { id: string }).id;
    const dto = clinicSchema.partial().parse(request.body);

    const existing = await prisma.clinic.findUnique({ where: { id: clinicId } });
    requireCondition(existing, 404, "Clinic not found");
    if (dto.maRun !== undefined && dto.maRun !== existing.maRun) {
      throw new ApiError(400, "MA run model is intrinsic and cannot be changed after clinic creation.");
    }

    const facilityId = dto.facilityId ?? existing.facilityId;
    if (facilityId) {
      const facility = await resolveFacilityForRequest(request, facilityId);
      requireCondition(facility, 404, "Facility not found");
    }

    const updated = await prisma.clinic.update({
      where: { id: clinicId },
      data: {
        facilityId,
        name: dto.name,
        shortCode: dto.shortCode,
        // Clinics follow facility timezone.
        timezone: undefined,
        status: dto.status,
        autoCloseEnabled: dto.autoCloseEnabled,
        autoCloseTime: dto.autoCloseTime,
        cardColor: dto.cardColor,
        cardTags: dto.cardTags ? asInputJson(parseStringArrayJsonInput(dto.cardTags, "clinicCardTags")) : undefined
      }
    });

    if (dto.roomIds) {
      if (!updated.facilityId) {
        throw new ApiError(400, "Clinic must belong to a facility before assigning rooms.");
      }
      const rooms = await prisma.clinicRoom.findMany({
        where: {
          id: { in: dto.roomIds },
          facilityId: updated.facilityId
        },
        select: { id: true }
      });
      requireCondition(rooms.length === dto.roomIds.length, 400, "One or more rooms are invalid for this facility");

      const roomIdSet = new Set(dto.roomIds);
      const existingAssignments = await prisma.clinicRoomAssignment.findMany({
        where: { clinicId },
        select: { id: true, roomId: true }
      });

      const assignmentsToDeactivate = existingAssignments
        .filter((row) => !roomIdSet.has(row.roomId))
        .map((row) => row.id);
      if (assignmentsToDeactivate.length > 0) {
        await prisma.clinicRoomAssignment.updateMany({
          where: { id: { in: assignmentsToDeactivate } },
          data: { active: false }
        });
      }

      for (const roomId of dto.roomIds) {
        const existingAssignment = existingAssignments.find((row) => row.roomId === roomId);
        if (existingAssignment) {
          await prisma.clinicRoomAssignment.update({
            where: { id: existingAssignment.id },
            data: { active: true }
          });
        } else {
          await prisma.clinicRoomAssignment.create({
            data: { clinicId, roomId, active: true }
          });
        }
      }
    }

    return updated;
  });

  app.delete("/admin/clinics/:id", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const clinicId = (request.params as { id: string }).id;
    const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
    requireCondition(clinic, 404, "Clinic not found");
    await resolveFacilityForRequest(request, clinic.facilityId || undefined);

    const archived = await prisma.$transaction(async (tx) => {
      await tx.clinicRoomAssignment.updateMany({
        where: { clinicId },
        data: { active: false }
      });
      const updated = await tx.clinic.update({
        where: { id: clinicId },
        data: { status: "archived" }
      });
      await recordEntityEventTx({
        db: tx,
        request,
        entityType: "Clinic",
        entityId: clinicId,
        eventType: "clinic.archived",
        before: clinic,
        after: updated,
        facilityId: clinic.facilityId,
        clinicId
      });
      await persistMutationOperationalEventTx({
        db: tx,
        request,
        entityType: "Clinic",
        entityId: clinicId,
      });
      return updated;
    });

    await flushOperationalOutbox(prisma);
    return { status: "archived", clinic: archived };
  });

  app.post("/admin/clinics/:id/restore", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const clinicId = (request.params as { id: string }).id;
    const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
    requireCondition(clinic, 404, "Clinic not found");
    await resolveFacilityForRequest(request, clinic.facilityId || undefined);
    const restored = await prisma.$transaction(async (tx) => {
      const updated = await tx.clinic.update({
        where: { id: clinicId },
        data: { status: "active" }
      });
      await tx.clinicRoomAssignment.updateMany({
        where: { clinicId },
        data: { active: true }
      });
      await recordEntityEventTx({
        db: tx,
        request,
        entityType: "Clinic",
        entityId: clinicId,
        eventType: "clinic.restored",
        before: clinic,
        after: updated,
        facilityId: clinic.facilityId,
        clinicId
      });
      await persistMutationOperationalEventTx({
        db: tx,
        request,
        entityType: "Clinic",
        entityId: clinicId,
      });
      return updated;
    });
    await flushOperationalOutbox(prisma);
    return restored;
  });

  function mapReasonRow(reason: {
    id: string;
    facilityId: string | null;
    name: string;
    appointmentLengthMinutes: number;
    status: string;
    active: boolean;
    clinicId: string | null;
    clinicAssignments?: Array<{ clinicId: string }>;
  }) {
    const clinicIds = new Set<string>();
    if (reason.clinicId) clinicIds.add(reason.clinicId);
    (reason.clinicAssignments || []).forEach((entry) => clinicIds.add(entry.clinicId));
    return {
      id: reason.id,
      facilityId: reason.facilityId,
      name: reason.name,
      appointmentLengthMinutes: reason.appointmentLengthMinutes,
      status: reason.status,
      active: reason.active,
      clinicIds: Array.from(clinicIds.values())
    };
  }

  app.get("/admin/reasons", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.MA, RoleName.Clinician, RoleName.FrontDeskCheckOut, RoleName.OfficeManager, RoleName.Admin) }, async (request) => {
    const query = request.query as {
      clinicId?: string;
      facilityId?: string;
      includeInactive?: string;
      includeArchived?: string;
    };
    const includeInactive = query.includeInactive === "true";
    const includeArchived = query.includeArchived === "true";
    const facility = await resolveFacilityForRequest(request, query.facilityId);

    if (query.clinicId) {
      await resolveClinicForFacility(query.clinicId, facility.id);
    }

    const statuses = includeArchived
      ? includeInactive
        ? undefined
        : (["active", "archived"] as string[])
      : includeInactive
        ? (["active", "inactive"] as string[])
        : (["active"] as string[]);

    const reasons = await prisma.reasonForVisit.findMany({
      where: {
        facilityId: facility.id,
        ...(statuses ? { status: { in: statuses } } : {}),
        ...(query.clinicId
          ? {
              OR: [{ clinicAssignments: { some: { clinicId: query.clinicId } } }, { clinicId: query.clinicId }]
            }
          : {})
      },
      include: {
        clinicAssignments: {
          select: { clinicId: true }
        }
      },
      orderBy: { name: "asc" }
    });

    return reasons.map(mapReasonRow);
  });

  app.post("/admin/reasons", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const dto = reasonSchema.parse(request.body);
    const facility = await resolveFacilityForRequest(request, dto.facilityId);
    const clinicIds = Array.from(new Set(dto.clinicIds));
    requireCondition(clinicIds.length > 0, 400, "At least one clinic must be selected");

    const clinics = await prisma.clinic.findMany({
      where: { id: { in: clinicIds } },
      select: { id: true, facilityId: true, status: true }
    });
    requireCondition(clinics.length === clinicIds.length, 400, "One or more clinics are invalid");
    requireCondition(
      clinics.every((clinic) => clinic.facilityId === facility.id && clinic.status !== "archived"),
      400,
      "Visit reasons can only be assigned to non-archived clinics in the selected facility"
    );

    const status =
      dto.status ?? (dto.active === false ? "inactive" : "active");

    const created = await prisma.$transaction(async (tx) => {
      const reason = await tx.reasonForVisit.create({
        data: {
          facilityId: facility.id,
          clinicId: clinicIds[0] || null,
          name: dto.name.trim(),
          appointmentLengthMinutes: dto.appointmentLengthMinutes,
          status,
          active: reasonStatusToActive(status)
        },
        include: { clinicAssignments: { select: { clinicId: true } } }
      });
      await tx.reasonClinicAssignment.createMany({
        data: clinicIds.map((clinicId) => ({ reasonId: reason.id, clinicId }))
      });
      return tx.reasonForVisit.findUnique({
        where: { id: reason.id },
        include: { clinicAssignments: { select: { clinicId: true } } }
      });
    });

    requireCondition(created, 500, "Failed to create visit reason");
    const mapped = mapReasonRow(created);
    requireCondition(mapped.clinicIds.length > 0, 500, "Visit reason clinic assignments were not persisted");
    return mapped;
  });

  app.post("/admin/reasons/:id", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const reasonId = (request.params as { id: string }).id;
    const dto = updateReasonSchema.parse(request.body);

    const reason = await prisma.reasonForVisit.findUnique({
      where: { id: reasonId },
      include: { clinicAssignments: { select: { clinicId: true } } }
    });
    requireCondition(reason, 404, "Visit reason not found");
    const facility = await resolveFacilityForRequest(request, reason.facilityId || undefined);
    requireCondition(reason.facilityId === facility.id, 400, "Visit reason is outside selected facility");

    let clinicIds: string[] | undefined = undefined;
    if (dto.clinicIds) {
      clinicIds = Array.from(new Set(dto.clinicIds));
      const clinics = await prisma.clinic.findMany({
        where: { id: { in: clinicIds } },
        select: { id: true, facilityId: true, status: true }
      });
      requireCondition(clinics.length === clinicIds.length, 400, "One or more clinics are invalid");
      requireCondition(
        clinics.every((clinic) => clinic.facilityId === facility.id && clinic.status !== "archived"),
        400,
        "Visit reasons can only be assigned to non-archived clinics in the selected facility"
      );
    }

    const status =
      dto.status ??
      (dto.active === undefined ? undefined : dto.active ? "active" : "inactive");

    const updated = await prisma.$transaction(async (tx) => {
      await tx.reasonForVisit.update({
        where: { id: reasonId },
        data: {
          name: dto.name?.trim(),
          appointmentLengthMinutes: dto.appointmentLengthMinutes,
          ...(status ? { status, active: reasonStatusToActive(status) } : {})
        }
      });

      if (clinicIds) {
        await tx.reasonClinicAssignment.deleteMany({ where: { reasonId } });
        await tx.reasonClinicAssignment.createMany({
          data: clinicIds.map((clinicId) => ({ reasonId, clinicId }))
        });
        await tx.reasonForVisit.update({
          where: { id: reasonId },
          data: { clinicId: clinicIds[0] || null }
        });
      }

      return tx.reasonForVisit.findUnique({
        where: { id: reasonId },
        include: { clinicAssignments: { select: { clinicId: true } } }
      });
    });

    requireCondition(updated, 500, "Failed to update visit reason");
    const mapped = mapReasonRow(updated);
    requireCondition(mapped.clinicIds.length > 0, 500, "Visit reason clinic assignments were not persisted");
    return mapped;
  });

  app.delete("/admin/reasons/:id", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const reasonId = (request.params as { id: string }).id;
    const reason = await prisma.reasonForVisit.findUnique({ where: { id: reasonId } });
    requireCondition(reason, 404, "Visit reason not found");
    await resolveFacilityForRequest(request, reason.facilityId || undefined);

    const archived = await prisma.reasonForVisit.update({
      where: { id: reasonId },
      data: { status: "archived", active: false },
      include: { clinicAssignments: { select: { clinicId: true } } }
    });

    return { status: "archived", reason: mapReasonRow(archived) };
  });

  app.get("/admin/rooms", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.MA, RoleName.Clinician, RoleName.FrontDeskCheckOut, RoleName.OfficeManager, RoleName.Admin) }, async (request) => {
    const query = request.query as {
      facilityId?: string;
      clinicId?: string;
      includeInactive?: string;
      includeArchived?: string;
    };
    const includeInactive = query.includeInactive === "true";
    const includeArchived = query.includeArchived === "true";
    const facility = await resolveFacilityForRequest(request, query.facilityId);

    const statuses = includeArchived
      ? includeInactive
        ? undefined
        : (["active", "archived"] as string[])
      : includeInactive
        ? (["active", "inactive"] as string[])
        : (["active"] as string[]);

    const assignmentWhere: Prisma.ClinicRoomAssignmentWhereInput = query.clinicId
      ? { clinicId: query.clinicId, active: true }
      : { active: true };
    const assignments = await prisma.clinicRoomAssignment.findMany({
      where: assignmentWhere,
      select: { roomId: true, clinicId: true }
    });
    const scopedRoomIds = query.clinicId ? assignments.map((row) => row.roomId) : null;

    const rooms = await prisma.clinicRoom.findMany({
      where: {
        facilityId: facility.id,
        ...(statuses ? { status: { in: statuses } } : {}),
        ...(scopedRoomIds ? { id: { in: scopedRoomIds } } : {})
      },
      orderBy: [{ status: "asc" }, { roomNumber: "asc" }, { name: "asc" }]
    });

    const roomIds = rooms.map((room) => room.id);
    const encounterCounts =
      roomIds.length > 0
        ? await prisma.encounter.groupBy({
            by: ["roomId"],
            where: { roomId: { in: roomIds } },
            _count: { _all: true }
          })
        : [];
    const countsByRoomId = new Map(
      encounterCounts
        .filter((item) => item.roomId)
        .map((item) => [item.roomId as string, item._count._all])
    );

    const clinicIdsByRoomId = new Map<string, string[]>();
    assignments.forEach((assignment) => {
      if (!clinicIdsByRoomId.has(assignment.roomId)) clinicIdsByRoomId.set(assignment.roomId, []);
      clinicIdsByRoomId.get(assignment.roomId)!.push(assignment.clinicId);
    });

    return rooms.map((room) => ({
      ...room,
      active: room.status === "active",
      encounterCount: countsByRoomId.get(room.id) || 0,
      clinicIds: clinicIdsByRoomId.get(room.id) || []
    }));
  });

  app.post("/admin/rooms", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const dto = roomSchema.parse(request.body);
    const facility = await resolveFacilityForRequest(request, dto.facilityId);
    const roomType = normalizeRoomType(dto.roomType);
    const room = await prisma.$transaction(async (tx) => {
      const created = await createRoomWithAllocatedNumber({
        facilityId: facility.id,
        name: dto.name,
        roomType,
        status: dto.status ?? "active"
      }, tx);
      if (created.status === "active") {
        await tx.roomOperationalState.upsert({
          where: { roomId: created.id },
          create: { roomId: created.id, currentStatus: "Ready", lastReadyAt: new Date() },
          update: {}
        });
      }
      await persistMutationOperationalEventTx({
        db: tx,
        request,
        entityType: "ClinicRoom",
        entityId: created.id,
      });
      return created;
    });
    await flushOperationalOutbox(prisma);
    return room;
  });

  app.post("/admin/rooms/reorder", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const dto = roomReorderSchema.parse(request.body);
    const facility = await resolveFacilityForRequest(request, dto.facilityId);

    const rooms = await prisma.clinicRoom.findMany({
      where: {
        facilityId: facility.id,
        status: { in: ["active", "inactive"] }
      },
      select: { id: true }
    });

    const currentIds = rooms.map((room) => room.id).sort();
    const nextIds = [...dto.roomIds].sort();
    requireCondition(
      currentIds.length === nextIds.length &&
        currentIds.every((entry, index) => entry === nextIds[index]),
      400,
      "Reorder payload must include all active/inactive rooms for the selected facility"
    );

    await prisma.$transaction(async (tx) => {
      for (let idx = 0; idx < dto.roomIds.length; idx += 1) {
        const roomId = dto.roomIds[idx]!;
        const temporaryNumber = -1 * (idx + 1);
        await tx.clinicRoom.update({
          where: { id: roomId },
          data: {
            roomNumber: temporaryNumber,
            sortOrder: temporaryNumber
          }
        });
      }

      for (let idx = 0; idx < dto.roomIds.length; idx += 1) {
        const roomId = dto.roomIds[idx]!;
        const nextNumber = idx + 1;
        await tx.clinicRoom.update({
          where: { id: roomId },
          data: {
            roomNumber: nextNumber,
            sortOrder: nextNumber
          }
        });
      }
    });

    return prisma.clinicRoom.findMany({
      where: {
        facilityId: facility.id
      },
      orderBy: [{ status: "asc" }, { roomNumber: "asc" }, { name: "asc" }]
    });
  });

  app.post("/admin/rooms/:id", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const roomId = (request.params as { id: string }).id;
    const dto = z
      .object({
        name: z.string().optional(),
        roomNumber: z.number().int().nonnegative().optional(),
        roomType: z.string().optional(),
        status: z.enum(["active", "inactive", "archived"]).optional(),
        active: z.boolean().optional()
      })
      .parse(request.body);

    const room = await prisma.clinicRoom.findUnique({ where: { id: roomId } });
    requireCondition(room, 404, "Room not found");
    await resolveFacilityForRequest(request, room.facilityId);

    if (dto.roomNumber !== undefined) {
      throw new ApiError(400, "Room # is system-managed. Reorder rooms to change numbering.");
    }

    const updated = await prisma.clinicRoom.update({
      where: { id: roomId },
      data: {
        name: dto.name,
        roomType: dto.roomType === undefined ? undefined : normalizeRoomType(dto.roomType),
        status: dto.status ?? (dto.active === undefined ? undefined : dto.active ? "active" : "inactive")
      }
    });
    if (updated.status === "active") {
      await prisma.roomOperationalState.upsert({
        where: { roomId: updated.id },
        create: { roomId: updated.id, currentStatus: "Ready", lastReadyAt: new Date() },
        update: {}
      });
    }
    return updated;
  });

  app.delete("/admin/rooms/:id", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const roomId = (request.params as { id: string }).id;
    const room = await prisma.clinicRoom.findUnique({ where: { id: roomId } });
    requireCondition(room, 404, "Room not found");
    await resolveFacilityForRequest(request, room.facilityId);

    const shouldArchive = await roomRequiresArchival(roomId);
    if (shouldArchive) {
      const archived = await prisma.$transaction(async (tx) => {
        await tx.clinicRoomAssignment.updateMany({
          where: { roomId },
          data: { active: false }
        });
        return tx.clinicRoom.update({
          where: { id: roomId },
          data: { status: "archived" }
        });
      });
      return { status: "archived", room: archived };
    }

    await ignoreMissingSchema(() => prisma.clinicRoomAssignment.deleteMany({ where: { roomId } }));
    const deleted = await prisma.clinicRoom.delete({ where: { id: roomId } });
    return { status: "deleted", room: deleted };
  });

  app.post("/admin/rooms/:id/restore", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const roomId = (request.params as { id: string }).id;
    const room = await prisma.clinicRoom.findUnique({ where: { id: roomId } });
    requireCondition(room, 404, "Room not found");
    await resolveFacilityForRequest(request, room.facilityId);
    const restored = await restoreRoomWithAllocatedNumber(roomId);
    await prisma.roomOperationalState.upsert({
      where: { roomId: restored.id },
      create: { roomId: restored.id, currentStatus: "Ready", lastReadyAt: new Date() },
      update: {}
    });
    return restored;
  });

  app.get(
    "/admin/assignments",
    { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.MA, RoleName.Clinician, RoleName.FrontDeskCheckOut, RoleName.OfficeManager, RoleName.Admin) },
    async (request) => {
    const query = request.query as { facilityId?: string };
    const facility = await resolveFacilityForRequest(request, query.facilityId);
    const clinics = await prisma.clinic.findMany({
      where: {
        facilityId: facility.id,
        status: { in: ["active", "inactive"] }
      },
      orderBy: { name: "asc" }
    });

    if (clinics.length === 0) {
      return [];
    }

    const clinicIds = clinics.map((clinic) => clinic.id);
    const assignments = await prisma.clinicAssignment.findMany({
      where: { clinicId: { in: clinicIds } },
      include: {
        providerUser: { select: { id: true, name: true, status: true } },
        maUser: { select: { id: true, name: true, status: true } }
      }
    });
    const activeRoomCounts = await prisma.clinicRoomAssignment.groupBy({
      by: ["clinicId"],
      where: {
        clinicId: { in: clinicIds },
        active: true,
        room: { status: "active" }
      },
      _count: { _all: true }
    });

    const assignmentByClinicId = new Map(assignments.map((assignment) => [assignment.clinicId, assignment]));
    const roomCountByClinicId = new Map(activeRoomCounts.map((row) => [row.clinicId, row._count._all]));

      return clinics.map((clinic) => {
        const assignment = assignmentByClinicId.get(clinic.id) || null;
        const roomCount = roomCountByClinicId.get(clinic.id) || 0;
        const maReady = !!assignment?.maUserId && assignment.maUser?.status === "active";
        const providerReady =
          clinic.maRun ||
          (!!assignment?.providerUserId && assignment.providerUser?.status === "active");
        return {
          id: assignment?.id || null,
          clinicId: clinic.id,
          clinicName: clinic.name,
          clinicShortCode: clinic.shortCode,
          clinicStatus: clinic.status,
          maRun: clinic.maRun,
          providerUserId: assignment?.providerUserId || null,
          providerUserName: formatUserDisplayName(assignment?.providerUser) || null,
          providerUserStatus: assignment?.providerUser?.status || null,
          maUserId: assignment?.maUserId || null,
          maUserName: formatUserDisplayName(assignment?.maUser) || null,
          maUserStatus: assignment?.maUser?.status || null,
          roomCount,
          isOperational: clinic.status === "active" && roomCount > 0 && maReady && providerReady
        };
      });
    }
  );

  app.post("/admin/assignments/:clinicId", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const clinicId = (request.params as { clinicId: string }).clinicId;
    const dto = clinicAssignmentSchema.parse(request.body);
    const normalizedMaUserId = dto.maUserId?.trim() || null;
    const normalizedProviderUserId = dto.providerUserId?.trim() || null;

    const clinic = await prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { id: true, facilityId: true, maRun: true, status: true }
    });
    requireCondition(clinic, 404, "Clinic not found");
    requireCondition(clinic.facilityId, 400, "Clinic must belong to a facility");
    await resolveFacilityForRequest(request, clinic.facilityId || undefined);
    requireCondition(clinic.status !== "archived", 400, "Cannot manage assignments for archived clinics");

    requireCondition(normalizedMaUserId, 400, "An MA assignment is required for this clinic");
    await assertUserRoleForFacility({
      userId: normalizedMaUserId,
      role: RoleName.MA,
      facilityId: clinic.facilityId
    });
    const maUser = await prisma.user.findUnique({
      where: { id: normalizedMaUserId },
      select: { id: true, name: true, status: true }
    });
    requireCondition(maUser, 404, "MA user not found");
    requireCondition(maUser.status === "active", 400, "Selected MA user is not active");

    if (!clinic.maRun) {
      requireCondition(normalizedProviderUserId, 400, "A provider assignment is required for non MA-run clinics");
    }

    let providerUser: { id: string; name: string; status: string } | null = null;
    if (normalizedProviderUserId) {
      await assertUserRoleForFacility({
        userId: normalizedProviderUserId,
        role: RoleName.Clinician,
        facilityId: clinic.facilityId
      });
      providerUser = await prisma.user.findUnique({
        where: { id: normalizedProviderUserId },
        select: { id: true, name: true, status: true }
      });
      requireCondition(providerUser, 404, "Provider user not found");
      requireCondition(providerUser.status === "active", 400, "Selected provider user is not active");
    }

    const assignment = await prisma.$transaction(async (tx) => {
      const providerId = providerUser
        ? await ensureProviderRecordForClinic({
            tx,
            clinicId: clinic.id,
            providerUserId: providerUser.id,
            providerUserName: providerUser.name
          })
        : null;

      if (!clinic.maRun) {
        requireCondition(providerId, 400, "Provider assignment is required for non MA-run clinics");
      }

      return tx.clinicAssignment.upsert({
        where: { clinicId: clinic.id },
        update: {
          providerUserId: providerUser?.id || null,
          providerId: providerId || null,
          maUserId: maUser.id
        },
        create: {
          clinicId: clinic.id,
          providerUserId: providerUser?.id || null,
          providerId: providerId || null,
          maUserId: maUser.id
        },
        include: {
          providerUser: { select: { id: true, name: true, status: true } },
          maUser: { select: { id: true, name: true, status: true } }
        }
      });
    });

    return {
      id: assignment.id,
      clinicId: assignment.clinicId,
      providerUserId: assignment.providerUserId,
      providerUserName: formatUserDisplayName(assignment.providerUser) || null,
      providerUserStatus: assignment.providerUser?.status || null,
      maUserId: assignment.maUserId,
      maUserName: formatUserDisplayName(assignment.maUser) || null,
      maUserStatus: assignment.maUser?.status || null
    };
  });

  app.get("/admin/encounters", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const query = archivedEncounterQuerySchema.parse(request.query);
    const facility = await resolveFacilityForRequest(request, query.facilityId);
    const timezone = facility.timezone || "America/New_York";
    const todayStart = DateTime.now().setZone(timezone).startOf("day");
    const defaultFrom = todayStart.minus({ days: 14 });
    const defaultTo = todayStart.minus({ days: 1 });
    const from = parseFacilityDateBoundary(query.from, timezone, "start", defaultFrom);
    const to = parseFacilityDateBoundary(query.to, timezone, "end", defaultTo);
    requireCondition(to >= from, 400, "Encounter recovery date range is invalid.");
    const unresolvedOnly = parseQueryBoolean(query.unresolvedOnly, true);
    const search = query.search?.trim() || "";

    const rows = await prisma.encounter.findMany({
      where: {
        clinic: {
          facilityId: facility.id,
          ...(query.clinicId ? { id: query.clinicId } : {})
        },
        dateOfService: {
          gte: from.toUTC().toJSDate(),
          lte: to.toUTC().toJSDate()
        },
        ...(query.status
          ? { currentStatus: query.status }
          : unresolvedOnly
            ? { currentStatus: { not: EncounterStatus.Optimized } }
            : {}),
        ...(search
          ? {
              OR: [
                { patientId: { contains: search } },
                { id: { contains: search } }
              ]
            }
          : {})
      },
      include: {
        clinic: { select: { id: true, name: true, status: true } },
        provider: { select: { id: true, name: true, active: true } },
        reason: { select: { id: true, name: true } },
        room: { select: { id: true, name: true, status: true } }
      },
      orderBy: [{ dateOfService: "desc" }, { checkInAt: "desc" }, { patientId: "asc" }],
      take: 250
    });

    const maUserIds = Array.from(new Set(rows.map((row) => row.assignedMaUserId).filter((value): value is string => Boolean(value))));
    const maUsers = maUserIds.length
      ? await prisma.user.findMany({
          where: { id: { in: maUserIds } },
          select: { id: true, name: true, status: true, email: true }
        })
      : [];
    const maById = new Map(maUsers.map((user) => [user.id, user]));

    return rows.map((row) => {
      const dateOfService = DateTime.fromJSDate(row.dateOfService).setZone(timezone).toISODate() || row.dateOfService.toISOString().slice(0, 10);
      const assignedMa = row.assignedMaUserId ? maById.get(row.assignedMaUserId) : null;
      const archivedForOperations = row.dateOfService.getTime() < todayStart.toUTC().toJSDate().getTime();
      return {
        id: row.id,
        version: row.version,
        patientId: row.patientId,
        clinicId: row.clinicId,
        clinicName: formatClinicDisplayName(row.clinic),
        dateOfService,
        currentStatus: row.currentStatus,
        providerName: formatProviderDisplayName(row.provider),
        reasonForVisit: formatReasonDisplayName(row.reason) || null,
        roomId: row.roomId,
        roomName: formatRoomDisplayName(row.room),
        assignedMaUserId: row.assignedMaUserId,
        assignedMaName: assignedMa ? formatUserDisplayName(assignedMa) || assignedMa.email : null,
        checkInAt: row.checkInAt,
        roomingStartAt: row.roomingStartAt,
        roomingCompleteAt: row.roomingCompleteAt,
        providerStartAt: row.providerStartAt,
        providerEndAt: row.providerEndAt,
        checkoutCompleteAt: row.checkoutCompleteAt,
        closedAt: row.closedAt,
        closureType: row.closureType,
        archivedForOperations,
        needsRecovery: archivedForOperations && row.currentStatus !== EncounterStatus.Optimized
      };
    });
  });

  app.post("/admin/encounters/stale-cleanup", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const dto = staleEncounterCleanupSchema.parse(request.body || {});
    return withIdempotentMutation({
      db: prisma,
      request,
      payload: dto,
      execute: async () => {
        const facility = await resolveFacilityForRequest(request, dto.facilityId);
        const timezone = facility.timezone || "America/New_York";
        const todayStart = DateTime.now().setZone(timezone).startOf("day");
        const defaultFrom = todayStart.minus({ days: 14 });
        const defaultTo = todayStart.minus({ days: 1 });
        const from = parseFacilityDateBoundary(dto.from, timezone, "start", defaultFrom);
        const to = parseFacilityDateBoundary(dto.to, timezone, "end", defaultTo);
        requireCondition(to >= from, 400, "Encounter cleanup date range is invalid.");

        const where: Prisma.EncounterWhereInput = {
          clinic: {
            facilityId: facility.id,
            ...(dto.clinicId ? { id: dto.clinicId } : {})
          },
          dateOfService: {
            gte: from.toUTC().toJSDate(),
            lte: to.toUTC().toJSDate(),
            lt: todayStart.toUTC().toJSDate()
          },
          currentStatus: { not: EncounterStatus.Optimized },
          ...(dto.encounterIds?.length ? { id: { in: dto.encounterIds } } : {})
        };

        const candidates = await prisma.encounter.findMany({
          where,
          include: {
            clinic: { select: { id: true, name: true, status: true, facilityId: true } },
            provider: { select: { id: true, name: true, active: true } },
            reason: { select: { id: true, name: true } },
            room: { select: { id: true, name: true, status: true } }
          },
          orderBy: [{ dateOfService: "asc" }, { checkInAt: "asc" }],
          take: 250
        });

        const toCleanupRow = (row: (typeof candidates)[number]) => ({
          id: row.id,
          version: row.version,
          patientId: row.patientId,
          clinicId: row.clinicId,
          clinicName: formatClinicDisplayName(row.clinic),
          dateOfService: DateTime.fromJSDate(row.dateOfService).setZone(timezone).toISODate() || row.dateOfService.toISOString().slice(0, 10),
          currentStatus: row.currentStatus,
          providerName: formatProviderDisplayName(row.provider),
          reasonForVisit: formatReasonDisplayName(row.reason) || null,
          roomId: row.roomId,
          roomName: formatRoomDisplayName(row.room),
          assignedMaUserId: row.assignedMaUserId,
          assignedMaName: null,
          checkInAt: row.checkInAt,
          roomingStartAt: row.roomingStartAt,
          roomingCompleteAt: row.roomingCompleteAt,
          providerStartAt: row.providerStartAt,
          providerEndAt: row.providerEndAt,
          checkoutCompleteAt: row.checkoutCompleteAt,
          closedAt: row.closedAt,
          closureType: row.closureType,
          archivedForOperations: true,
          needsRecovery: row.currentStatus !== EncounterStatus.Optimized
        });

        if (!dto.execute) {
          return {
            status: "dry_run",
            facilityId: facility.id,
            candidateCount: candidates.length,
            releasedRoomCount: candidates.filter((row) => Boolean(row.roomId)).length,
            candidates: candidates.map(toCleanupRow)
          };
        }

        const now = new Date();
        const note = dto.note?.trim() || "Admin stale operational cleanup";
        const result = await prisma.$transaction(async (tx) => {
          const cleaned: Array<ReturnType<typeof toCleanupRow>> = [];
          let releasedRoomCount = 0;
          for (const candidate of candidates) {
            const before = toCleanupRow(candidate);
            if (candidate.roomId) {
              await markEncounterRoomNeedsTurnoverInTx(tx, {
                encounter: { id: candidate.id, clinicId: candidate.clinicId, roomId: candidate.roomId },
                userId: request.user!.id
              });
              releasedRoomCount += 1;
            }
            const updated = await tx.encounter.update({
              where: { id: candidate.id },
              data: {
                currentStatus: EncounterStatus.Optimized,
                roomId: null,
                checkoutCompleteAt: candidate.checkoutCompleteAt || now,
                closedAt: now,
                closureType: "stale_operational_cleanup",
                closureNotes: note,
                archivedAt: candidate.archivedAt || now,
                archivedByUserId: request.user!.id,
                archivedReason: "stale_operational_cleanup",
                version: { increment: 1 }
              },
              include: {
                clinic: { select: { id: true, name: true, status: true, facilityId: true } },
                provider: { select: { id: true, name: true, active: true } },
                reason: { select: { id: true, name: true } },
                room: { select: { id: true, name: true, status: true } }
              }
            });
            await tx.statusChangeEvent.create({
              data: {
                encounterId: candidate.id,
                fromStatus: candidate.currentStatus,
                toStatus: EncounterStatus.Optimized,
                changedByUserId: request.user!.id,
                reasonCode: "stale_operational_cleanup"
              }
            });
            const after = toCleanupRow(updated);
            await recordEntityEventTx({
              db: tx,
              request,
              entityType: "Encounter",
              entityId: candidate.id,
              eventType: "encounter.stale_cleanup",
              before,
              after,
              metadata: {
                note,
                priorStatus: candidate.currentStatus,
                releasedRoomId: candidate.roomId || null
              },
              facilityId: facility.id,
              clinicId: candidate.clinicId
            });
            await persistMutationOperationalEventTx({
              db: tx,
              request,
              entityType: "Encounter",
              entityId: candidate.id
            });
            await queueRevenueEncounterSync(tx, candidate.id, request.correlationId || request.id);
            cleaned.push(after);
          }
          return { cleaned, releasedRoomCount };
        });

        await flushOperationalOutbox(prisma);
        return {
          status: "cleaned",
          facilityId: facility.id,
          cleanedCount: result.cleaned.length,
          releasedRoomCount: result.releasedRoomCount,
          encounters: result.cleaned
        };
      }
    });
  });

  app.get("/admin/assignment-overrides", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const query = assignmentOverrideQuerySchema.parse(request.query);
    const facility = await resolveFacilityForRequest(request, query.facilityId);
    const now = new Date();
    const state = query.state || "all";
    const rows = await prisma.temporaryClinicAssignmentOverride.findMany({
      where: {
        facilityId: facility.id,
        clinicId: query.clinicId,
        userId: query.userId,
        role: query.role,
        ...(state === "active"
          ? { revokedAt: null, startsAt: { lte: now }, endsAt: { gt: now } }
          : state === "upcoming"
            ? { revokedAt: null, startsAt: { gt: now } }
            : state === "expired"
              ? { OR: [{ endsAt: { lte: now } }, { revokedAt: { not: null } }] }
              : {})
      },
      include: {
        user: { select: { id: true, name: true, email: true, status: true } },
        clinic: { select: { id: true, name: true, shortCode: true, status: true } },
        facility: { select: { id: true, name: true, shortCode: true } },
        createdBy: { select: { id: true, name: true, email: true } },
        revokedBy: { select: { id: true, name: true, email: true } }
      },
      orderBy: [{ startsAt: "desc" }, { createdAt: "desc" }]
    });

    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      userName: formatUserDisplayName(row.user) || row.user.email,
      userEmail: row.user.email,
      userStatus: row.user.status,
      role: row.role,
      clinicId: row.clinicId,
      clinicName: row.clinic.name,
      clinicShortCode: row.clinic.shortCode,
      clinicStatus: row.clinic.status,
      facilityId: row.facilityId,
      facilityName: row.facility.name,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      reason: row.reason,
      createdAt: row.createdAt,
      createdByUserId: row.createdByUserId,
      createdByName: formatUserDisplayName(row.createdBy) || row.createdBy.email,
      revokedAt: row.revokedAt,
      revokedByUserId: row.revokedByUserId,
      revokedByName: row.revokedBy ? formatUserDisplayName(row.revokedBy) || row.revokedBy.email : null,
      state: row.revokedAt ? "revoked" : row.startsAt > now ? "upcoming" : row.endsAt <= now ? "expired" : "active"
    }));
  });

  app.post("/admin/assignment-overrides", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const dto = assignmentOverrideSchema.parse(request.body);
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    requireCondition(endsAt > startsAt, 400, "Temporary coverage end must be after the start.");

    const [clinic, user] = await Promise.all([
      prisma.clinic.findUnique({
        where: { id: dto.clinicId },
        select: { id: true, facilityId: true, status: true }
      }),
      prisma.user.findUnique({
        where: { id: dto.userId },
        select: { id: true, status: true }
      })
    ]);
    requireCondition(clinic, 404, "Clinic not found");
    requireCondition(clinic.facilityId === dto.facilityId, 400, "Clinic is outside the selected facility.");
    requireCondition(clinic.status === "active", 400, "Temporary coverage can only be added for active clinics.");
    requireCondition(user, 404, "User not found");
    requireCondition(user.status === "active", 400, "Temporary coverage can only be added for active users.");
    await resolveFacilityForRequest(request, dto.facilityId);
    await assertUserRoleForFacility({ userId: dto.userId, role: dto.role, facilityId: dto.facilityId });

    return prisma.temporaryClinicAssignmentOverride.create({
      data: {
        userId: dto.userId,
        role: dto.role,
        clinicId: dto.clinicId,
        facilityId: dto.facilityId,
        startsAt,
        endsAt,
        reason: dto.reason,
        createdByUserId: request.user!.id
      }
    });
  });

  app.post("/admin/assignment-overrides/:id/revoke", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const overrideId = (request.params as { id: string }).id;
    const existing = await prisma.temporaryClinicAssignmentOverride.findUnique({
      where: { id: overrideId },
      select: { id: true, facilityId: true, revokedAt: true }
    });
    requireCondition(existing, 404, "Temporary coverage override not found");
    await resolveFacilityForRequest(request, existing.facilityId);
    if (existing.revokedAt) return existing;
    return prisma.temporaryClinicAssignmentOverride.update({
      where: { id: overrideId },
      data: {
        revokedAt: new Date(),
        revokedByUserId: request.user!.id
      }
    });
  });

  type TemplateWithAssignments = {
    id: string;
    facilityId: string;
    name: string;
    status: string;
    active: boolean;
    clinicId: string | null;
    reasonForVisitId: string | null;
    type: TemplateType;
    fieldsJson: Prisma.JsonValue;
    jsonSchema: Prisma.JsonValue;
    uiSchema: Prisma.JsonValue;
    requiredFields: Prisma.JsonValue;
    createdAt: Date;
    updatedAt: Date;
    reasonAssignments: Array<{ reasonId: string }>;
  };

  function buildTemplateIntegrityWarnings(template: TemplateWithAssignments, request: FastifyRequest) {
    const fields = normalizeTemplateFieldsJson(template.fieldsJson, request.log, "templateFieldsJson");
    const malformedFieldsJson =
      template.fieldsJson !== null &&
      template.fieldsJson !== undefined &&
      (!Array.isArray(template.fieldsJson) || (template.fieldsJson.length > 0 && fields.length === 0));

    return {
      fields,
      integrityWarnings: malformedFieldsJson ? [buildIntegrityWarning("fieldsJson")] : [],
    };
  }

  function buildRevenueSettingsIntegrityWarnings(row: {
    queueSlaJson: Prisma.JsonValue;
    dayCloseDefaultsJson: Prisma.JsonValue;
    estimateDefaultsJson: Prisma.JsonValue;
    athenaChecklistDefaultsJson: Prisma.JsonValue;
    checklistDefaultsJson: Prisma.JsonValue;
    serviceCatalogJson: Prisma.JsonValue;
    chargeScheduleJson: Prisma.JsonValue;
    reimbursementRulesJson: Prisma.JsonValue;
  }) {
    const warnings = [] as ReturnType<typeof buildIntegrityWarning>[];
    const pushIf = (condition: boolean, field: string) => {
      if (condition) warnings.push(buildIntegrityWarning(field));
    };

    pushIf(Boolean(row.queueSlaJson) && (typeof row.queueSlaJson !== "object" || Array.isArray(row.queueSlaJson)), "queueSlaJson");
    pushIf(
      Boolean(row.dayCloseDefaultsJson) && (typeof row.dayCloseDefaultsJson !== "object" || Array.isArray(row.dayCloseDefaultsJson)),
      "dayCloseDefaultsJson",
    );
    pushIf(
      Boolean(row.estimateDefaultsJson) && (typeof row.estimateDefaultsJson !== "object" || Array.isArray(row.estimateDefaultsJson)),
      "estimateDefaultsJson",
    );
    pushIf(
      Boolean(row.athenaChecklistDefaultsJson) && !Array.isArray(row.athenaChecklistDefaultsJson),
      "athenaChecklistDefaultsJson",
    );
    pushIf(
      Boolean(row.checklistDefaultsJson) && (typeof row.checklistDefaultsJson !== "object" || Array.isArray(row.checklistDefaultsJson)),
      "checklistDefaultsJson",
    );
    pushIf(Boolean(row.serviceCatalogJson) && !Array.isArray(row.serviceCatalogJson), "serviceCatalogJson");
    pushIf(Boolean(row.chargeScheduleJson) && !Array.isArray(row.chargeScheduleJson), "chargeScheduleJson");
    pushIf(
      row.reimbursementRulesJson !== null &&
      row.reimbursementRulesJson !== undefined &&
      !Array.isArray(row.reimbursementRulesJson),
      "reimbursementRulesJson",
    );

    return warnings;
  }

  function mapTemplateRow(template: TemplateWithAssignments) {
    const reasonIds = Array.from(
      new Set([
        ...(template.reasonForVisitId ? [template.reasonForVisitId] : []),
        ...template.reasonAssignments.map((entry) => entry.reasonId)
      ])
    );
    const fields = normalizeTemplateFieldsJson(template.fieldsJson);
    const requiredFields = Array.isArray(template.requiredFields) ? (template.requiredFields as string[]) : [];
    return {
      id: template.id,
      facilityId: template.facilityId,
      name: template.name,
      status: template.status,
      active: template.active,
      clinicId: template.clinicId,
      reasonForVisitId: reasonIds[0] || null,
      reasonIds,
      type: uiTemplateType(template.type),
      fields,
      fieldsJson: fields,
      jsonSchema: template.jsonSchema,
      uiSchema: template.uiSchema,
      requiredFields,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt
    };
  }

  function deriveFieldsFromLegacyPayload(dto: z.infer<typeof templateSchema>): z.infer<typeof templateFieldSchema>[] {
    const source = (dto.jsonSchema as Record<string, unknown> | undefined)?.properties as
      | Record<string, { title?: string; type?: string; enum?: string[] }>
      | undefined;
    const required = new Set(dto.requiredFields || []);
    const fields = Object.entries(source || {}).map(([key, value], index) => {
      const rawType = value.type || "text";
      const fieldType: z.infer<typeof templateFieldTypeSchema> =
        rawType === "boolean"
          ? "checkbox"
          : rawType === "number"
            ? "number"
            : Array.isArray(value.enum)
              ? "select"
              : "text";
      return {
        id: `field_${index + 1}`,
        key,
        label: value.title || key,
        type: fieldType,
        required: required.has(key),
        options: Array.isArray(value.enum) ? value.enum : undefined
      };
    });
    return fields.length > 0 ? fields : [{ id: "field_1", key: "notes", label: "Notes", type: "textarea", required: false }];
  }

  async function deactivateConflictingActiveTemplates(params: {
    tx: Prisma.TransactionClient;
    templateId: string;
    facilityId: string;
    type: TemplateType;
    reasonIds: string[];
  }) {
    const { tx, templateId, facilityId, type, reasonIds } = params;
    if (reasonIds.length === 0) return;

    const conflictingLinks = await tx.templateReasonAssignment.findMany({
      where: {
        reasonId: { in: reasonIds },
        template: {
          id: { not: templateId },
          facilityId,
          type,
          status: "active"
        }
      },
      select: { templateId: true }
    });
    const conflictingIds = Array.from(new Set(conflictingLinks.map((entry) => entry.templateId)));
    if (conflictingIds.length === 0) return;

    await tx.template.updateMany({
      where: { id: { in: conflictingIds } },
      data: { status: "inactive", active: false }
    });
  }

  app.get("/admin/templates", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.MA, RoleName.Clinician, RoleName.FrontDeskCheckOut, RoleName.OfficeManager, RoleName.Admin) }, async (request) => {
    const query = request.query as {
      facilityId?: string;
      clinicId?: string;
      reasonForVisitId?: string;
      reasonId?: string;
      type?: string;
      includeInactive?: string;
      includeArchived?: string;
      definitionsOnly?: string;
    };
    const includeInactive = query.includeInactive === "true";
    const includeArchived = query.includeArchived === "true";
    const facility = await resolveFacilityForRequest(request, query.facilityId);
    const reasonFilterId = query.reasonId || query.reasonForVisitId;

    const statuses = includeArchived
      ? includeInactive
        ? undefined
        : (["active", "archived"] as string[])
      : includeInactive
        ? (["active", "inactive"] as string[])
        : (["active"] as string[]);

    const where: Prisma.TemplateWhereInput = {
      facilityId: facility.id,
      ...(statuses ? { status: { in: statuses } } : {})
    };

    if (query.type) {
      where.type = normalizeTemplateType(query.type);
    }
    if (query.clinicId) {
      await resolveClinicForFacility(query.clinicId, facility.id);
      where.OR = [{ clinicId: null }, { clinicId: query.clinicId }];
    }
    if (reasonFilterId) {
      const andClauses = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
      where.AND = [
        ...andClauses,
        {
          OR: [
            { reasonForVisitId: reasonFilterId },
            { reasonAssignments: { some: { reasonId: reasonFilterId } } }
          ]
        }
      ];
    }
    if (query.definitionsOnly === "true") {
      where.clinicId = null;
    }

    const templates = await prisma.template.findMany({
      where,
      include: {
        reasonAssignments: { select: { reasonId: true } }
      },
      orderBy: [{ type: "asc" }, { name: "asc" }, { createdAt: "asc" }]
    });
    const mappedTemplates = templates.map((template) => {
      const templateRow = template as TemplateWithAssignments;
      const mapped = mapTemplateRow(templateRow);
      const { integrityWarnings } = buildTemplateIntegrityWarnings(templateRow, request);
      return {
        ...mapped,
        integrityWarnings,
      };
    });

    await Promise.all(
      mappedTemplates.flatMap((template) =>
        template.integrityWarnings.map((warning) =>
          recordPersistedJsonAlert({
            facilityId: template.facilityId,
            clinicId: template.clinicId,
            entityType: "template",
            entityId: template.id,
            field: warning.field,
            requestId: request.id,
          }),
        ),
      ),
    );

    return mappedTemplates;
  });

  async function upsertTemplate(params: {
    templateId?: string;
    dto: z.infer<typeof templateSchema>;
    request: FastifyRequest;
  }) {
    const { templateId, dto, request } = params;
    const facility = await resolveFacilityForRequest(request, dto.facilityId);
    const reasonIds = Array.from(new Set(dto.reasonIds?.length ? dto.reasonIds : dto.reasonForVisitId ? [dto.reasonForVisitId] : []));
    requireCondition(reasonIds.length > 0, 400, "At least one visit reason must be selected");

    const reasons = await prisma.reasonForVisit.findMany({
      where: { id: { in: reasonIds } },
      select: { id: true, facilityId: true, status: true }
    });
    requireCondition(reasons.length === reasonIds.length, 400, "One or more visit reasons are invalid");
    requireCondition(
      reasons.every((reason) => reason.facilityId === facility.id && reason.status !== "archived"),
      400,
      "Templates can only be assigned to non-archived reasons in the selected facility"
    );

    const type = normalizeTemplateType(dto.type);
    const status =
      dto.status ??
      (dto.active === undefined ? "active" : dto.active ? "active" : "inactive");

    const normalizedFields = normalizeTemplateFields(dto.fields?.length ? dto.fields : deriveFieldsFromLegacyPayload(dto));
    const schema = buildTemplateSchemas(normalizedFields);

    const template = await prisma.$transaction(async (tx) => {
      const saved = templateId
        ? await tx.template.update({
            where: { id: templateId },
            data: {
              facilityId: facility.id,
              name: dto.name.trim(),
              status,
              active: templateStatusToActive(status),
              clinicId: null,
              reasonForVisitId: reasonIds[0] || null,
              type,
              fieldsJson: asInputJson(parseTemplateFieldsJsonInput(normalizedFields)),
              jsonSchema: schema.jsonSchema,
              uiSchema: schema.uiSchema,
              requiredFields: schema.requiredFields as Prisma.InputJsonValue,
              schemaVersion: CURRENT_TEMPLATE_SCHEMA_VERSION,
              updatedAt: new Date()
            }
          })
        : await tx.template.create({
            data: {
              facilityId: facility.id,
              name: dto.name.trim(),
              status,
              active: templateStatusToActive(status),
              clinicId: null,
              reasonForVisitId: reasonIds[0] || null,
              type,
              fieldsJson: asInputJson(parseTemplateFieldsJsonInput(normalizedFields)),
              jsonSchema: schema.jsonSchema,
              uiSchema: schema.uiSchema,
              requiredFields: schema.requiredFields as Prisma.InputJsonValue,
              schemaVersion: CURRENT_TEMPLATE_SCHEMA_VERSION
            }
          });

      await tx.templateReasonAssignment.deleteMany({ where: { templateId: saved.id } });
      await tx.templateReasonAssignment.createMany({
        data: reasonIds.map((reasonId) => ({ templateId: saved.id, reasonId }))
      });

      if (status === "active") {
        await deactivateConflictingActiveTemplates({
          tx,
          templateId: saved.id,
          facilityId: facility.id,
          type,
          reasonIds
        });
      }

      return tx.template.findUnique({
        where: { id: saved.id },
        include: { reasonAssignments: { select: { reasonId: true } } }
      });
    });

    requireCondition(template, 500, "Failed to save template");
    return mapTemplateRow(template as TemplateWithAssignments);
  }

  app.post("/admin/templates", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const dto = parseTemplatePayload(request.body);
    return upsertTemplate({ dto, request });
  });

  app.post("/admin/templates/:id", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const templateId = (request.params as { id: string }).id;
    const dto = parseTemplatePayload(request.body);
    const existing = await prisma.template.findUnique({ where: { id: templateId } });
    requireCondition(existing, 404, "Template not found");
    return upsertTemplate({ templateId, dto, request });
  });

  app.put("/admin/templates/:id", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const templateId = (request.params as { id: string }).id;
    const dto = parseTemplatePayload(request.body);
    const existing = await prisma.template.findUnique({ where: { id: templateId } });
    requireCondition(existing, 404, "Template not found");
    return upsertTemplate({ templateId, dto, request });
  });

  app.delete("/admin/templates/:id", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const templateId = (request.params as { id: string }).id;
    const template = await prisma.template.findUnique({ where: { id: templateId } });
    requireCondition(template, 404, "Template not found");
    await resolveFacilityForRequest(request, template.facilityId);

    const archived = await prisma.template.update({
      where: { id: templateId },
      data: {
        status: "archived",
        active: false,
        updatedAt: new Date()
      },
      include: {
        reasonAssignments: { select: { reasonId: true } }
      }
    });
    return { status: "archived", template: mapTemplateRow(archived as TemplateWithAssignments) };
  });

  app.post("/admin/templates/:id/assign", { preHandler: requireRoles(RoleName.Admin) }, async () => {
    throw new ApiError(410, "Template clinic re-assignment is deprecated. Edit template settings instead.");
  });

  app.get("/admin/thresholds", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const query = request.query as { facilityId?: string };
    const facility = await resolveFacilityForRequest(request, query.facilityId);
    await ensureFacilityThresholdDefaults(facility.id);
    const rows = await prisma.alertThreshold.findMany({
      where: {
        facilityId: facility.id
      },
      orderBy: [
        { clinicId: "asc" },
        { metric: "asc" },
        { status: "asc" }
      ]
    });
    return rows.sort((a, b) => {
      const aOverrideRank = a.clinicId ? 1 : 0;
      const bOverrideRank = b.clinicId ? 1 : 0;
      if (aOverrideRank !== bOverrideRank) return aOverrideRank - bOverrideRank;
      if ((a.clinicId || "") !== (b.clinicId || "")) return (a.clinicId || "").localeCompare(b.clinicId || "");
      const stageDelta = thresholdSortRank(a.metric, a.status) - thresholdSortRank(b.metric, b.status);
      if (stageDelta !== 0) return stageDelta;
      return a.id.localeCompare(b.id);
    });
  });

  app.post("/admin/thresholds", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const dto = thresholdSchema.parse(request.body);
    const metric = dto.metric ?? AlertThresholdMetric.stage;
    const normalizedStatus = metric === AlertThresholdMetric.overall_visit ? null : dto.status || null;
    requireCondition(metric !== AlertThresholdMetric.stage || normalizedStatus, 400, "Status is required for stage thresholds");

    let facilityId = dto.facilityId || undefined;
    if (dto.clinicId) {
      const clinic = await prisma.clinic.findUnique({
        where: { id: dto.clinicId },
        select: { facilityId: true }
      });
      requireCondition(clinic, 404, "Clinic not found");
      facilityId = clinic.facilityId || undefined;
    }
    const facility = await resolveFacilityForRequest(request, facilityId);
    if (dto.clinicId) {
      await resolveClinicForFacility(dto.clinicId, facility.id);
    }

    const existing = await prisma.alertThreshold.findFirst({
      where: {
        facilityId: facility.id,
        clinicId: dto.clinicId || null,
        metric,
        status: normalizedStatus
      }
    });

    if (existing) {
      return prisma.alertThreshold.update({
        where: { id: existing.id },
        data: {
          reasonForVisitId: dto.reasonForVisitId,
          providerId: dto.providerId,
          yellowAtMin: dto.yellowAtMin,
          redAtMin: dto.redAtMin,
          escalation2Min: dto.escalation2Min
        }
      });
    }

    return prisma.alertThreshold.create({
      data: {
        facilityId: facility.id,
        clinicId: dto.clinicId || null,
        metric,
        status: normalizedStatus,
        reasonForVisitId: dto.reasonForVisitId,
        providerId: dto.providerId,
        yellowAtMin: dto.yellowAtMin,
        redAtMin: dto.redAtMin,
        escalation2Min: dto.escalation2Min
      }
    });
  });

  app.post("/admin/thresholds/:id", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const thresholdId = (request.params as { id: string }).id;
    const dto = thresholdSchema.parse(request.body);
    const existing = await prisma.alertThreshold.findUnique({ where: { id: thresholdId } });
    requireCondition(existing, 404, "Threshold not found");

    const metric = dto.metric ?? existing.metric;
    const normalizedStatus =
      metric === AlertThresholdMetric.overall_visit
        ? null
        : dto.status === undefined
          ? existing.status
          : dto.status;
    requireCondition(metric !== AlertThresholdMetric.stage || normalizedStatus, 400, "Status is required for stage thresholds");

    let facilityId = dto.facilityId || existing.facilityId;
    if (dto.clinicId) {
      const clinic = await prisma.clinic.findUnique({
        where: { id: dto.clinicId },
        select: { facilityId: true }
      });
      requireCondition(clinic, 404, "Clinic not found");
      facilityId = clinic.facilityId || facilityId;
    }
    const facility = await resolveFacilityForRequest(request, facilityId);
    const clinicId = dto.clinicId === undefined ? existing.clinicId : dto.clinicId;
    if (clinicId) {
      await resolveClinicForFacility(clinicId, facility.id);
    }

    return prisma.alertThreshold.update({
      where: { id: thresholdId },
      data: {
        facilityId: facility.id,
        clinicId: clinicId || null,
        metric,
        status: normalizedStatus,
        reasonForVisitId: dto.reasonForVisitId,
        providerId: dto.providerId,
        yellowAtMin: dto.yellowAtMin,
        redAtMin: dto.redAtMin,
        escalation2Min: dto.escalation2Min
      }
    });
  });

  app.post("/admin/thresholds/bulk", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const dto = thresholdBulkSchema.parse(request.body);
    const rowsById = new Map(dto.rows.map((row) => [row.id, row]));
    const existingRows = await prisma.alertThreshold.findMany({
      where: { id: { in: Array.from(rowsById.keys()) } }
    });
    requireCondition(existingRows.length === dto.rows.length, 404, "One or more thresholds were not found");

    const facilityIdSet = new Set(existingRows.map((row) => row.facilityId));
    const requestedFacilityId = dto.facilityId || existingRows[0]?.facilityId;
    requireCondition(requestedFacilityId, 400, "Facility is required");
    const facility = await resolveFacilityForRequest(request, requestedFacilityId);
    requireCondition(
      facilityIdSet.size === 1 && facilityIdSet.has(facility.id),
      400,
      "Bulk threshold update must target one facility"
    );

    const clinicIds = Array.from(
      new Set(
        dto.rows
          .map((row) => row.clinicId)
          .filter((entry): entry is string => Boolean(entry))
      )
    );
    if (clinicIds.length > 0) {
      const clinics = await prisma.clinic.findMany({
        where: {
          id: { in: clinicIds },
          facilityId: facility.id
        },
        select: { id: true }
      });
      requireCondition(clinics.length === clinicIds.length, 400, "One or more threshold clinics are outside the selected facility");
    }

    await prisma.$transaction(async (tx) => {
      for (const existing of existingRows) {
        const payload = rowsById.get(existing.id)!;
        const metric = payload.metric ?? existing.metric;
        const status =
          metric === AlertThresholdMetric.overall_visit
            ? null
            : payload.status === undefined
              ? existing.status
              : payload.status;
        requireCondition(metric !== AlertThresholdMetric.stage || status, 400, "Status is required for stage thresholds");

        await tx.alertThreshold.update({
          where: { id: existing.id },
          data: {
            clinicId: payload.clinicId === undefined ? existing.clinicId : payload.clinicId,
            metric,
            status,
            yellowAtMin: payload.yellowAtMin,
            redAtMin: payload.redAtMin,
            escalation2Min: payload.escalation2Min ?? null
          }
        });
      }
    });

    return prisma.alertThreshold.findMany({
      where: { facilityId: facility.id },
      orderBy: [
        { clinicId: "asc" },
        { metric: "asc" },
        { status: "asc" }
      ]
    });
  });

  app.delete("/admin/thresholds/:id", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const thresholdId = (request.params as { id: string }).id;
    const existing = await prisma.alertThreshold.findUnique({ where: { id: thresholdId } });
    requireCondition(existing, 404, "Threshold not found");
    await resolveFacilityForRequest(request, existing.facilityId);
    // Thresholds are configuration-only rows. Historical alert evidence remains in
    // alert state, inbox alerts, and audit/outbox records, so hard delete is allowed here.
    return prisma.alertThreshold.delete({ where: { id: thresholdId } });
  });

  app.get("/admin/integrations/athenaone", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const query = request.query as { facilityId?: string };
    const facility = await resolveFacilityForRequest(request, query.facilityId);
    const connector = await prisma.integrationConnector.findUnique({
      where: {
        facilityId_vendor: {
          facilityId: facility.id,
          vendor: "athenaone"
        }
      }
    });

    if (!connector) {
      return {
        facilityId: facility.id,
        vendor: "athenaone",
        enabled: false,
        config: redactAthenaConnectorConfig({}),
        mapping: {},
        lastTestStatus: null,
        lastTestAt: null,
        lastTestMessage: null,
        lastSyncStatus: null,
        lastSyncAt: null,
        lastSyncMessage: null
      };
    }

    return mapAthenaConnectorResponse(connector);
  });

  app.post("/admin/integrations/athenaone", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const dto = athenaConnectorSchema.parse(request.body);
    const facility = await resolveFacilityForRequest(request, dto.facilityId);
    const existing = await prisma.integrationConnector.findUnique({
      where: {
        facilityId_vendor: {
          facilityId: facility.id,
          vendor: "athenaone"
        }
      }
    });

    const mergedConfig = mergeAthenaConnectorConfig(existing?.configJson || {}, dto.config || {});
    const normalizedConfig = JSON.parse(JSON.stringify(mergedConfig)) as Prisma.InputJsonValue;
    const normalizedMapping = JSON.parse(
      JSON.stringify(dto.mapping || (existing?.mappingJson as Record<string, string>) || {})
    ) as Prisma.InputJsonValue;
    const enabled = dto.enabled ?? existing?.enabled ?? false;

    const connector = await prisma.integrationConnector.upsert({
      where: {
        facilityId_vendor: {
          facilityId: facility.id,
          vendor: "athenaone"
        }
      },
      update: {
        enabled,
        configJson: normalizedConfig,
        mappingJson: normalizedMapping
      },
      create: {
        facilityId: facility.id,
        vendor: "athenaone",
        enabled,
        configJson: normalizedConfig,
        mappingJson: normalizedMapping
      }
    });

    return mapAthenaConnectorResponse(connector);
  });

  app.post("/admin/integrations/athenaone/test", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const dto = athenaConnectorSchema.parse(request.body);
    const facility = await resolveFacilityForRequest(request, dto.facilityId);
    const existing = await prisma.integrationConnector.findUnique({
      where: {
        facilityId_vendor: {
          facilityId: facility.id,
          vendor: "athenaone"
        }
      }
    });

    const mergedConfig = mergeAthenaConnectorConfig(existing?.configJson || {}, dto.config || {});
    const normalizedConfig = JSON.parse(JSON.stringify(mergedConfig)) as Prisma.InputJsonValue;
    const normalizedMapping = JSON.parse(
      JSON.stringify(dto.mapping || (existing?.mappingJson as Record<string, string>) || {})
    ) as Prisma.InputJsonValue;
    const enabled = dto.enabled ?? existing?.enabled ?? false;

    const testResult = await testAthenaConnectorConfig(mergedConfig);

    const updated = await prisma.integrationConnector.upsert({
      where: {
        facilityId_vendor: {
          facilityId: facility.id,
          vendor: "athenaone"
        }
      },
      update: {
        enabled,
        configJson: normalizedConfig,
        mappingJson: normalizedMapping,
        lastTestStatus: testResult.status,
        lastTestAt: new Date(),
        lastTestMessage: testResult.message
      },
      create: {
        facilityId: facility.id,
        vendor: "athenaone",
        enabled,
        configJson: normalizedConfig,
        mappingJson: normalizedMapping,
        lastTestStatus: testResult.status,
        lastTestAt: new Date(),
        lastTestMessage: testResult.message
      }
    });

    return {
      ok: testResult.ok,
      status: testResult.status,
      message: testResult.message,
      testedAt: updated.lastTestAt,
      detail: testResult.detail
    };
  });

  app.post("/admin/integrations/athenaone/sync-preview", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const dto = athenaPreviewSchema.parse(request.body);
    const facility = await resolveFacilityForRequest(request, dto.facilityId);

    if (dto.clinicId) {
      await resolveClinicForFacility(dto.clinicId, facility.id);
    }

    const connector = await prisma.integrationConnector.findUnique({
      where: {
        facilityId_vendor: {
          facilityId: facility.id,
          vendor: "athenaone"
        }
      }
    });
    requireCondition(connector, 400, "AthenaOne connector is not configured for this facility");

    const previewDate = dto.dateOfService || new Date().toISOString().slice(0, 10);
    const localPreviewRows = await prisma.incomingSchedule.findMany({
      where: {
        clinic: {
          facilityId: facility.id
        },
        ...(dto.clinicId ? { clinicId: dto.clinicId } : {})
      },
      select: {
        id: true,
        patientId: true,
        appointmentTime: true,
        providerLastName: true,
        reasonText: true,
        clinicId: true
      },
      orderBy: { appointmentAt: "asc" },
      take: 10
    });

    const previewResult = await previewAthenaSchedule({
      config: normalizeAthenaConnectorConfig(connector.configJson),
      mapping: connector.mappingJson || {},
      dateOfService: previewDate,
      clinicId: dto.clinicId,
      maxRows: 25
    });

    const fallbackUsed = previewResult.rowCount === 0 && localPreviewRows.length > 0;
    const rows = fallbackUsed ? localPreviewRows : previewResult.rows;
    const rowCount = rows.length;
    const message = fallbackUsed
      ? `${previewResult.message} Local preview rows are shown as fallback.`
      : previewResult.message;

    await prisma.integrationConnector.update({
      where: {
        facilityId_vendor: {
          facilityId: facility.id,
          vendor: "athenaone"
        }
      },
      data: {
        lastSyncStatus: previewResult.ok ? "preview_ok" : "preview_error",
        lastSyncAt: new Date(),
        lastSyncMessage: message
      }
    });

    return {
      ok: previewResult.ok,
      mode: "preview",
      dateOfService: previewDate,
      rowCount,
      rows,
      message,
      detail: previewResult.detail
    };
  });

  app.post("/admin/integrations/athenaone/revenue-preview", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const dto = athenaRevenueMonitoringSchema.parse(request.body);
    const facility = await resolveFacilityForRequest(request, dto.facilityId);

    if (dto.clinicId) {
      await resolveClinicForFacility(dto.clinicId, facility.id);
    }

    const connector = await prisma.integrationConnector.findUnique({
      where: {
        facilityId_vendor: {
          facilityId: facility.id,
          vendor: "athenaone"
        }
      }
    });
    requireCondition(connector, 400, "AthenaOne connector is not configured for this facility");

    const previewDate = dto.dateOfService || new Date().toISOString().slice(0, 10);
    const previewResult = await previewAthenaRevenueMonitoring({
      config: normalizeAthenaConnectorConfig(connector.configJson),
      mapping: connector.mappingJson || {},
      dateOfService: previewDate,
      clinicId: dto.clinicId,
      maxRows: dto.maxRows,
    });

    const rows = await Promise.all(
      previewResult.rows.map(async (row) => {
        const matchedCase = await matchRevenueCaseForAthenaRow(facility.id, row);
        return {
          ...row,
          matchedRevenueCaseId: matchedCase?.id || null,
          matchedEncounterId: matchedCase?.encounterId || null,
          matchedPatientId: matchedCase?.patientId || null,
          matchedClinicId: matchedCase?.clinicId || null,
          currentRevenueStatus: matchedCase?.currentRevenueStatus || null,
          currentWorkQueue: matchedCase?.currentWorkQueue || null,
          importable: Boolean(matchedCase),
        };
      }),
    );

    await prisma.integrationConnector.update({
      where: {
        facilityId_vendor: {
          facilityId: facility.id,
          vendor: "athenaone"
        }
      },
      data: {
        lastSyncStatus: previewResult.ok ? "revenue_preview_ok" : "revenue_preview_error",
        lastSyncAt: new Date(),
        lastSyncMessage: previewResult.message
      }
    });

    return {
      ok: previewResult.ok,
      mode: "revenue_preview",
      dateOfService: previewDate,
      rowCount: rows.length,
      matchedCount: rows.filter((row) => row.importable).length,
      rows,
      message: previewResult.message,
      detail: previewResult.detail,
    };
  });

  app.post("/admin/integrations/athenaone/revenue-import", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const dto = athenaRevenueMonitoringSchema.parse(request.body);
    const facility = await resolveFacilityForRequest(request, dto.facilityId);

    if (dto.clinicId) {
      await resolveClinicForFacility(dto.clinicId, facility.id);
    }

    const connector = await prisma.integrationConnector.findUnique({
      where: {
        facilityId_vendor: {
          facilityId: facility.id,
          vendor: "athenaone"
        }
      }
    });
    requireCondition(connector, 400, "AthenaOne connector is not configured for this facility");

    const importDate = dto.dateOfService || new Date().toISOString().slice(0, 10);
    const previewResult = await previewAthenaRevenueMonitoring({
      config: normalizeAthenaConnectorConfig(connector.configJson),
      mapping: connector.mappingJson || {},
      dateOfService: importDate,
      clinicId: dto.clinicId,
      maxRows: dto.maxRows,
    });
    if (!previewResult.ok) {
      throw new ApiError(400, previewResult.message);
    }

    let importedCount = 0;
    let skippedCount = 0;
    const importedCaseIds: string[] = [];
    const importedClinicIds = new Set<string>();
    const unmatchedRows: Array<{ index: number; patientId: string; encounterId: string; dateOfService: string }> = [];

    for (const row of previewResult.rows) {
      const matchedCase = await matchRevenueCaseForAthenaRow(facility.id, row);
      if (!matchedCase) {
        skippedCount += 1;
        unmatchedRows.push({
          index: row.index,
          patientId: row.patientId,
          encounterId: row.encounterId,
          dateOfService: row.dateOfService,
        });
        continue;
      }

      await prisma.$transaction(async (tx) => {
        await tx.revenueCase.update({
          where: { id: matchedCase.id },
          data: {
            athenaChargeEnteredAt: row.chargeEnteredAt ? new Date(row.chargeEnteredAt) : undefined,
            athenaClaimSubmittedAt: row.claimSubmittedAt ? new Date(row.claimSubmittedAt) : undefined,
            athenaDaysToSubmit: row.daysToSubmit,
            athenaDaysInAR: row.daysInAR,
            athenaClaimStatus: row.claimStatus || null,
            athenaPatientBalanceCents: row.patientBalanceCents,
            athenaLastSyncAt: new Date(),
            version: { increment: 1 },
          },
        });
        await tx.revenueCaseEvent.create({
          data: {
            revenueCaseId: matchedCase.id,
            eventType: "athena_monitoring_imported",
            actorUserId: request.user!.id,
            eventText: row.claimStatus
              ? `Athena monitoring imported: ${row.claimStatus}`
              : "Athena monitoring imported.",
            payloadJson: row.raw as Prisma.InputJsonValue,
          },
        });
      });

      importedCount += 1;
      importedCaseIds.push(matchedCase.id);
      importedClinicIds.add(matchedCase.clinicId);
    }

    await prisma.integrationConnector.update({
      where: {
        facilityId_vendor: {
          facilityId: facility.id,
          vendor: "athenaone"
        }
      },
      data: {
        lastSyncStatus: "revenue_import_ok",
        lastSyncAt: new Date(),
        lastSyncMessage: `Imported Athena monitoring for ${importedCount} revenue case(s). ${skippedCount} unmatched row(s).`
      }
    });

    if (importedClinicIds.size > 0) {
      const clinics = await prisma.clinic.findMany({
        where: {
          id: { in: [...importedClinicIds] },
        },
        select: {
          id: true,
          name: true,
          timezone: true,
          facilityId: true,
        },
      });
      await getRevenueDailyHistoryRollups(prisma, clinics, listDateKeys(importDate, importDate), {
        persist: true,
        forceRecompute: true,
      });
    }

    return {
      ok: true,
      mode: "revenue_import",
      dateOfService: importDate,
      rowCount: previewResult.rows.length,
      importedCount,
      skippedCount,
      importedCaseIds,
      unmatchedRows,
      message: `Imported Athena monitoring for ${importedCount} revenue case(s).`,
    };
  });

  app.get(
    "/admin/revenue-settings",
    {
      preHandler: requireRoles(
        RoleName.FrontDeskCheckIn,
        RoleName.MA,
        RoleName.Clinician,
        RoleName.FrontDeskCheckOut,
        RoleName.OfficeManager,
        RoleName.RevenueCycle,
        RoleName.Admin,
      ),
    },
    async (request) => {
    const query = request.query as { facilityId?: string };
    const facility = await resolveFacilityForRequest(request, query.facilityId);
    const settings = await getRevenueSettings(prisma, facility.id);
    const rawSettings = await prisma.revenueCycleSettings.findUnique({
      where: { facilityId: facility.id },
      select: {
        queueSlaJson: true,
        dayCloseDefaultsJson: true,
        estimateDefaultsJson: true,
        athenaChecklistDefaultsJson: true,
        checklistDefaultsJson: true,
        serviceCatalogJson: true,
        chargeScheduleJson: true,
        reimbursementRulesJson: true,
      },
    });
    const integrityWarnings = rawSettings ? buildRevenueSettingsIntegrityWarnings(rawSettings) : [];

    if (integrityWarnings.length > 0) {
      await Promise.all(
        integrityWarnings.map((warning) =>
          recordPersistedJsonAlert({
            facilityId: facility.id,
            entityType: "revenueCycleSettings",
            entityId: facility.id,
            field: warning.field,
            requestId: request.id,
          }),
        ),
      );
    }

    return {
      facilityId: facility.id,
      missedCollectionReasons: settings.missedCollectionReasons,
      queueSla: settings.queueSla,
      dayCloseDefaults: settings.dayCloseDefaults,
      estimateDefaults: settings.estimateDefaults,
      providerQueryTemplates: settings.providerQueryTemplates,
      athenaLinkTemplate: settings.athenaLinkTemplate,
      athenaChecklistDefaults: settings.athenaChecklistDefaults,
      checklistDefaults: settings.checklistDefaults,
      serviceCatalog: settings.serviceCatalog,
      chargeSchedule: settings.chargeSchedule,
      reimbursementRules: settings.reimbursementRules,
      defaults: {
        missedCollectionReasons: [...DEFAULT_MISSED_COLLECTION_REASONS],
        providerQueryTemplates: [...DEFAULT_PROVIDER_QUERY_TEMPLATES],
        queueSla: { ...DEFAULT_REVENUE_SETTINGS.queueSla },
        dayCloseDefaults: { ...DEFAULT_REVENUE_SETTINGS.dayCloseDefaults },
        estimateDefaults: { ...DEFAULT_REVENUE_SETTINGS.estimateDefaults },
        checklistDefaults: { ...DEFAULT_REVENUE_SETTINGS.checklistDefaults },
        serviceCatalog: [...DEFAULT_REVENUE_SETTINGS.serviceCatalog],
        chargeSchedule: [...DEFAULT_REVENUE_SETTINGS.chargeSchedule],
        reimbursementRules: [...DEFAULT_REVENUE_SETTINGS.reimbursementRules],
      },
      integrityWarnings,
    };
    },
  );

  app.post("/admin/revenue-settings", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const dto = revenueSettingsSchema.parse(request.body);
    const facility = await resolveFacilityForRequest(request, dto.facilityId);
    const existing = await getRevenueSettings(prisma, facility.id);
    const createMissedCollectionReasons = parseRevenueSettingsJsonInput(
      "missedCollectionReasons",
      dto.missedCollectionReasons || existing.missedCollectionReasons,
    );
    const createQueueSla = parseRevenueSettingsJsonInput("queueSla", dto.queueSla || existing.queueSla);
    const createDayCloseDefaults = parseRevenueSettingsJsonInput(
      "dayCloseDefaults",
      dto.dayCloseDefaults ? { ...existing.dayCloseDefaults, ...dto.dayCloseDefaults } : existing.dayCloseDefaults,
    );
    const createEstimateDefaults = parseRevenueSettingsJsonInput(
      "estimateDefaults",
      dto.estimateDefaults ? { ...existing.estimateDefaults, ...dto.estimateDefaults } : existing.estimateDefaults,
    );
    const createProviderQueryTemplates = parseRevenueSettingsJsonInput(
      "providerQueryTemplates",
      dto.providerQueryTemplates || existing.providerQueryTemplates,
    );
    const createAthenaChecklistDefaults = parseRevenueSettingsJsonInput(
      "athenaChecklistDefaults",
      dto.athenaChecklistDefaults || existing.athenaChecklistDefaults,
    );
    const createChecklistDefaults = parseRevenueSettingsJsonInput(
      "checklistDefaults",
      dto.checklistDefaults || existing.checklistDefaults,
    );
    const createServiceCatalog = parseRevenueSettingsJsonInput("serviceCatalog", dto.serviceCatalog || existing.serviceCatalog);
    const createChargeSchedule = parseRevenueSettingsJsonInput("chargeSchedule", dto.chargeSchedule || existing.chargeSchedule);
    const createReimbursementRules = parseRevenueSettingsJsonInput(
      "reimbursementRules",
      dto.reimbursementRules || existing.reimbursementRules,
    );

    await prisma.revenueCycleSettings.upsert({
      where: { facilityId: facility.id },
      create: {
        facilityId: facility.id,
        missedCollectionReasonsJson: asInputJson(createMissedCollectionReasons),
        queueSlaJson: asInputJson(createQueueSla),
        dayCloseDefaultsJson: asInputJson(createDayCloseDefaults),
        estimateDefaultsJson: asInputJson(createEstimateDefaults),
        providerQueryTemplatesJson: asInputJson(createProviderQueryTemplates),
        athenaLinkTemplate: dto.athenaLinkTemplate ?? existing.athenaLinkTemplate,
        athenaChecklistDefaultsJson: asInputJson(createAthenaChecklistDefaults),
        checklistDefaultsJson: asInputJson(createChecklistDefaults),
        serviceCatalogJson: asInputJson(createServiceCatalog),
        chargeScheduleJson: asInputJson(createChargeSchedule),
        reimbursementRulesJson: asInputJson(createReimbursementRules),
        schemaVersion: CURRENT_REVENUE_CYCLE_SETTINGS_SCHEMA_VERSION,
      },
      update: {
        missedCollectionReasonsJson: dto.missedCollectionReasons
          ? asInputJson(parseRevenueSettingsJsonInput("missedCollectionReasons", dto.missedCollectionReasons))
          : undefined,
        queueSlaJson: dto.queueSla ? asInputJson(parseRevenueSettingsJsonInput("queueSla", dto.queueSla)) : undefined,
        dayCloseDefaultsJson: dto.dayCloseDefaults
          ? asInputJson(
              parseRevenueSettingsJsonInput("dayCloseDefaults", {
                ...existing.dayCloseDefaults,
                ...dto.dayCloseDefaults,
              }),
            )
          : undefined,
        estimateDefaultsJson: dto.estimateDefaults
          ? asInputJson(
              parseRevenueSettingsJsonInput("estimateDefaults", {
                ...existing.estimateDefaults,
                ...dto.estimateDefaults,
              }),
            )
          : undefined,
        providerQueryTemplatesJson: dto.providerQueryTemplates
          ? asInputJson(parseRevenueSettingsJsonInput("providerQueryTemplates", dto.providerQueryTemplates))
          : undefined,
        athenaLinkTemplate: dto.athenaLinkTemplate === undefined ? undefined : dto.athenaLinkTemplate,
        athenaChecklistDefaultsJson: dto.athenaChecklistDefaults
          ? asInputJson(parseRevenueSettingsJsonInput("athenaChecklistDefaults", dto.athenaChecklistDefaults))
          : undefined,
        checklistDefaultsJson: dto.checklistDefaults
          ? asInputJson(parseRevenueSettingsJsonInput("checklistDefaults", dto.checklistDefaults))
          : undefined,
        serviceCatalogJson: dto.serviceCatalog
          ? asInputJson(parseRevenueSettingsJsonInput("serviceCatalog", dto.serviceCatalog))
          : undefined,
        chargeScheduleJson: dto.chargeSchedule
          ? asInputJson(parseRevenueSettingsJsonInput("chargeSchedule", dto.chargeSchedule))
          : undefined,
        reimbursementRulesJson: dto.reimbursementRules
          ? asInputJson(parseRevenueSettingsJsonInput("reimbursementRules", dto.reimbursementRules))
          : undefined,
        schemaVersion: CURRENT_REVENUE_CYCLE_SETTINGS_SCHEMA_VERSION,
      }
    });

    invalidateRevenueSettingsCache(facility.id);
    const settings = await getRevenueSettings(prisma, facility.id);
    return {
      facilityId: facility.id,
      missedCollectionReasons: settings.missedCollectionReasons,
      queueSla: settings.queueSla,
      dayCloseDefaults: settings.dayCloseDefaults,
      estimateDefaults: settings.estimateDefaults,
      providerQueryTemplates: settings.providerQueryTemplates,
      athenaLinkTemplate: settings.athenaLinkTemplate,
      athenaChecklistDefaults: settings.athenaChecklistDefaults,
      checklistDefaults: settings.checklistDefaults,
      serviceCatalog: settings.serviceCatalog,
      chargeSchedule: settings.chargeSchedule,
      reimbursementRules: settings.reimbursementRules,
    };
  });

  app.get("/admin/notifications", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const query = request.query as { facilityId?: string };
    const facility = await resolveFacilityForRequest(request, query.facilityId);
    const clinicIds = (
      await prisma.clinic.findMany({
        where: { facilityId: facility.id },
        select: { id: true }
      })
    ).map((clinic) => clinic.id);
    if (clinicIds.length === 0) {
      return [];
    }
    const rows = await prisma.notificationPolicy.findMany({
      where: {
        clinicId: { in: clinicIds }
      }
    });
    return rows.map((row) => ({
      ...row,
      recipients: normalizeRoleNameArrayJson(row.recipientsJson, request.log, "notificationRecipientsJson"),
      channels: normalizeStringArrayJson(row.channelsJson, request.log, "notificationChannelsJson"),
      escalationRecipients: normalizeRoleNameArrayJson(row.escalationRecipientsJson, request.log, "notificationEscalationRecipientsJson"),
      quietHours: normalizeQuietHoursJson(row.quietHoursJson, request.log, "notificationQuietHoursJson")
    }));
  });

  app.post("/admin/notifications", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const dto = notificationSchema.parse(request.body);
    const clinic = await prisma.clinic.findUnique({
      where: { id: dto.clinicId },
      select: { facilityId: true }
    });
    requireCondition(clinic, 404, "Clinic not found");
    await resolveFacilityForRequest(request, clinic.facilityId || undefined);
    return prisma.notificationPolicy.create({
      data: {
        clinicId: dto.clinicId,
        status: dto.status,
        severity: dto.severity,
        recipientsJson: asInputJson(parseRoleNameArrayJsonInput(dto.recipients, "notificationRecipientsJson")),
        channelsJson: asInputJson(parseStringArrayJsonInput(dto.channels, "notificationChannelsJson")),
        cooldownMinutes: dto.cooldownMinutes,
        ackRequired: dto.ackRequired ?? false,
        escalationAfterMin: dto.escalationAfterMin,
        escalationRecipientsJson: dto.escalationRecipients
          ? asInputJson(parseRoleNameArrayJsonInput(dto.escalationRecipients, "notificationEscalationRecipientsJson"))
          : Prisma.JsonNull,
        quietHoursJson: dto.quietHours
          ? asInputJson(parseQuietHoursJsonInput(dto.quietHours, "notificationQuietHoursJson"))
          : Prisma.JsonNull
      }
    });
  });

  app.post("/admin/notifications/:id", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const policyId = (request.params as { id: string }).id;
    const dto = notificationSchema.parse(request.body);
    const clinic = await prisma.clinic.findUnique({
      where: { id: dto.clinicId },
      select: { facilityId: true }
    });
    requireCondition(clinic, 404, "Clinic not found");
    await resolveFacilityForRequest(request, clinic.facilityId || undefined);
    return prisma.notificationPolicy.update({
      where: { id: policyId },
      data: {
        clinicId: dto.clinicId,
        status: dto.status,
        severity: dto.severity,
        recipientsJson: asInputJson(parseRoleNameArrayJsonInput(dto.recipients, "notificationRecipientsJson")),
        channelsJson: asInputJson(parseStringArrayJsonInput(dto.channels, "notificationChannelsJson")),
        cooldownMinutes: dto.cooldownMinutes,
        ackRequired: dto.ackRequired ?? false,
        escalationAfterMin: dto.escalationAfterMin,
        escalationRecipientsJson: dto.escalationRecipients
          ? asInputJson(parseRoleNameArrayJsonInput(dto.escalationRecipients, "notificationEscalationRecipientsJson"))
          : Prisma.JsonNull,
        quietHoursJson: dto.quietHours
          ? asInputJson(parseQuietHoursJsonInput(dto.quietHours, "notificationQuietHoursJson"))
          : Prisma.JsonNull
      }
    });
  });

  app.delete("/admin/notifications/:id", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const policyId = (request.params as { id: string }).id;
    const policy = await prisma.notificationPolicy.findUnique({
      where: { id: policyId },
      select: {
        id: true,
        clinicId: true
      }
    });
    requireCondition(policy, 404, "Notification policy not found");
    const clinic = await prisma.clinic.findUnique({
      where: { id: policy.clinicId },
      select: { facilityId: true }
    });
    requireCondition(clinic, 404, "Clinic not found");
    await resolveFacilityForRequest(request, clinic.facilityId || undefined);
    // Notification policies are configuration-only rows. Historical alert delivery
    // evidence lives outside this row, so hard delete is allowed here.
    return prisma.notificationPolicy.delete({ where: { id: policyId } });
  });

  app.post("/admin/notifications/:id/test", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const policyId = (request.params as { id: string }).id;
    const policy = await prisma.notificationPolicy.findUnique({
      where: { id: policyId }
    });
    requireCondition(policy, 404, "Notification policy not found");
    const clinic = await prisma.clinic.findUnique({
      where: { id: policy.clinicId },
      select: {
        id: true,
        facilityId: true,
        name: true
      }
    });
    requireCondition(clinic?.facilityId, 404, "Clinic not found");
    await resolveFacilityForRequest(request, clinic.facilityId || undefined);

    const recipients = (Array.isArray(policy.recipientsJson) ? policy.recipientsJson : [])
      .map((entry) => String(entry))
      .filter((entry): entry is RoleName => Object.values(RoleName).includes(entry as RoleName));
    const channels = (Array.isArray(policy.channelsJson) ? policy.channelsJson : [])
      .map((entry) => String(entry))
      .filter(Boolean);

    const results: Array<{
      channel: string;
      status: "sent" | "skipped";
      recipientCount: number;
      message: string;
    }> = [];

    for (const channel of channels) {
      if (channel === "in_app") {
        const timestamp = new Date().toISOString();
        const recipientCount = await createInboxAlert({
          facilityId: clinic.facilityId,
          clinicId: policy.clinicId,
          kind: "threshold",
          sourceId: policy.id,
          sourceVersionKey: `notification-policy-test:${policy.id}:${timestamp}`,
          title: "Notification policy test",
          message: `Test alert for ${clinic.name} ${policy.status} ${policy.severity}.`,
          payload: {
            policyId: policy.id,
            clinicId: policy.clinicId,
            clinicName: clinic.name,
            status: policy.status,
            severity: policy.severity,
            test: true
          },
          roles: recipients
        });
        results.push({
          channel,
          status: "sent",
          recipientCount,
          message: recipientCount > 0 ? "In-app test alerts created." : "No active recipients matched this policy."
        });
        continue;
      }

      results.push({
        channel,
        status: "skipped",
        recipientCount: 0,
        message: `${channel.toUpperCase()} test delivery is not configured in this environment.`
      });
    }

    return {
      policyId: policy.id,
      status: "completed",
      results
    };
  });

  app.get("/admin/users", { preHandler: requireRoles(RoleName.Admin, RoleName.OfficeManager, RoleName.RevenueCycle) }, async (request) => {
    const query = request.query as { facilityId?: string };
    const facility = await resolveFacilityForRequest(request, query.facilityId);
    const users = await prisma.user.findMany({
      where: {
        status: { not: "archived" },
        OR: [
          { activeFacilityId: facility.id },
          { roles: { some: { facilityId: facility.id } } },
          { roles: { some: { clinic: { facilityId: facility.id } } } }
        ]
      },
      include: {
        roles: {
          where: {
            OR: [{ facilityId: facility.id }, { clinic: { facilityId: facility.id } }]
          }
        }
      },
      orderBy: { name: "asc" }
    });
    return users;
  });

  app.get("/admin/patient-identity-reviews", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const query = patientIdentityReviewQuerySchema.parse(request.query);
    const facility = await resolveFacilityForRequest(request, query.facilityId);
    const reviews = await prisma.patientIdentityReview.findMany({
      where: {
        facilityId: facility.id,
        ...(query.status ? { status: query.status } : {}),
      },
      include: {
        patient: {
          select: {
            id: true,
            sourcePatientId: true,
            displayName: true,
            dateOfBirth: true,
          },
        },
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: query.limit || 100,
    });

    const matchedPatientIds = Array.from(
      new Set(
        reviews.flatMap((review) =>
          normalizeStringArrayJson(review.matchedPatientIdsJson, request.log, "patientIdentityReviewMatchedPatientIdsJson"),
        ),
      ),
    );

    const matchedPatients = matchedPatientIds.length > 0
      ? await prisma.patient.findMany({
          where: {
            facilityId: facility.id,
            id: { in: matchedPatientIds },
          },
          select: {
            id: true,
            sourcePatientId: true,
            displayName: true,
            dateOfBirth: true,
          },
        })
      : [];
    const matchedPatientsById = new Map(matchedPatients.map((patient) => [patient.id, patient]));

    const mappedReviews = reviews.map((review) => {
      const reviewMatchedPatientIds = normalizeStringArrayJson(
        review.matchedPatientIdsJson,
        request.log,
        "patientIdentityReviewMatchedPatientIdsJson",
      );
      const normalizedContextJson = normalizeGenericObjectJson(
        review.contextJson,
        request.log,
        "patientIdentityReviewContextJson",
      );
      const integrityWarnings = [
        review.matchedPatientIdsJson !== null &&
        (!Array.isArray(review.matchedPatientIdsJson) ||
          (review.matchedPatientIdsJson.length > 0 && reviewMatchedPatientIds.length === 0))
          ? buildIntegrityWarning("matchedPatientIdsJson")
          : null,
        review.contextJson !== null && normalizedContextJson === null ? buildIntegrityWarning("contextJson") : null,
      ].filter((warning): warning is NonNullable<typeof warning> => Boolean(warning));

      return {
        ...review,
        matchedPatientIds: reviewMatchedPatientIds,
        contextJson: normalizedContextJson,
        matchedPatients: reviewMatchedPatientIds
          .map((patientId) => matchedPatientsById.get(patientId))
          .filter((patient): patient is NonNullable<typeof patient> => Boolean(patient)),
        integrityWarnings,
      };
    });

    await Promise.all(
      mappedReviews.flatMap((review) =>
        review.integrityWarnings.map((warning) =>
          recordPersistedJsonAlert({
            facilityId: facility.id,
            entityType: "patientIdentityReview",
            entityId: review.id,
            field: warning.field,
            requestId: request.id,
          }),
        ),
      ),
    );

    return mappedReviews;
  });

  app.post("/admin/patient-identity-reviews/:id", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const reviewId = (request.params as { id: string }).id;
    const dto = patientIdentityReviewUpdateSchema.parse(request.body);
    const review = await prisma.patientIdentityReview.findUnique({
      where: { id: reviewId },
    });
    requireCondition(review, 404, "Patient identity review not found");

    await resolveFacilityForRequest(request, review.facilityId);

    const resolved = await prisma.$transaction(async (tx) => {
      let targetPatientId = dto.patientId?.trim() || review.patientId || null;

      if (dto.status === "resolved") {
        requireCondition(targetPatientId, 400, "Resolved reviews must choose a canonical patient", "PATIENT_IDENTITY_TARGET_REQUIRED");
        const targetPatient = await tx.patient.findUnique({
          where: { id: targetPatientId },
          select: {
            id: true,
            facilityId: true,
            displayName: true,
            dateOfBirth: true,
          },
        });
        requireCondition(targetPatient, 404, "Canonical patient not found", "PATIENT_NOT_FOUND");
        requireCondition(targetPatient.facilityId === review.facilityId, 400, "Canonical patient is outside the selected facility", "PATIENT_OUTSIDE_FACILITY_SCOPE");

        if (review.dateOfBirth && targetPatient.dateOfBirth && !sameIsoBirthDate(review.dateOfBirth, targetPatient.dateOfBirth)) {
          throw new ApiError({
            statusCode: 409,
            code: "PATIENT_DATE_OF_BIRTH_CONFLICT",
            message: "Selected patient has a conflicting date of birth.",
          });
        }

        await upsertPatientAliasInTx(tx, {
          patientId: targetPatient.id,
          facilityId: review.facilityId,
          aliasType: "source_patient_id",
          aliasValue: review.sourcePatientId,
          normalizedAliasValue: review.normalizedSourcePatientId,
        });
        await upsertPatientAliasInTx(tx, {
          patientId: targetPatient.id,
          facilityId: review.facilityId,
          aliasType: "display_name",
          aliasValue: review.displayName,
          normalizedAliasValue: review.normalizedDisplayName,
        });

        if (review.patientId && review.patientId !== targetPatient.id) {
          await migratePatientReferencesToCanonical(tx, {
            sourcePatientId: review.patientId,
            targetPatientId: targetPatient.id,
            facilityId: review.facilityId,
            archivedByUserId: request.user!.id,
            archivedReason: `identity_review_merge:${review.id}`,
          });
        }

        await tx.patient.update({
          where: { id: targetPatient.id },
          data: {
            displayName: targetPatient.displayName || review.displayName || undefined,
            dateOfBirth: targetPatient.dateOfBirth || review.dateOfBirth || undefined,
          },
        });

        targetPatientId = targetPatient.id;
      }

      return tx.patientIdentityReview.update({
        where: { id: review.id },
        data: {
          status: dto.status,
          patientId: targetPatientId,
          contextJson:
            dto.status === "resolved"
              ? asInputJson(parseGenericObjectJsonInput({
                  ...(review.contextJson && typeof review.contextJson === "object" && !Array.isArray(review.contextJson)
                    ? (review.contextJson as Record<string, unknown>)
                    : {}),
                  resolvedByUserId: request.user!.id,
                  resolvedAt: new Date().toISOString(),
                }, "patientIdentityReviewContextJson"))
              : review.contextJson === null
                ? Prisma.JsonNull
                : asInputJson(parseGenericObjectJsonInput(review.contextJson, "patientIdentityReviewContextJson")),
        },
      });
    });

    return resolved;
  });

  app.get("/admin/directory-users", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const query = directorySearchSchema.parse(request.query);
    return searchEntraDirectoryUsers(query.query);
  });

  app.post("/admin/users/provision", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const dto = provisionUserSchema.parse(request.body);
    const directoryUser = await getEntraDirectoryUserByObjectId(dto.objectId);
    requireCondition(directoryUser, 404, "Microsoft Entra user was not found");
    requireCondition(directoryUser.accountEnabled, 400, "Microsoft Entra user is disabled");
    requireCondition(directoryUser.userType.toLowerCase() === "member", 400, "Guest and B2B Microsoft accounts are not allowed");

    const normalizedFacilityIds = Array.from(
      new Set(
        [
          ...(Array.isArray(dto.facilityIds) ? dto.facilityIds : []),
          ...(dto.facilityId ? [dto.facilityId] : [])
        ]
          .map((entry) => entry.trim())
          .filter(Boolean)
      )
    );

    let clinicFacilityId: string | null = null;
    if (dto.clinicId) {
      const clinic = await prisma.clinic.findUnique({
        where: { id: dto.clinicId },
        select: { facilityId: true }
      });
      requireCondition(clinic, 404, "Clinic not found");
      clinicFacilityId = clinic.facilityId ?? null;
      await resolveFacilityForRequest(request, clinicFacilityId || undefined);
    }

    const resolvedFacilityIds: string[] = [];
    for (const facilityId of normalizedFacilityIds) {
      const facility = await resolveFacilityForRequest(request, facilityId);
      if (!resolvedFacilityIds.includes(facility.id)) {
        resolvedFacilityIds.push(facility.id);
      }
    }
    if (clinicFacilityId && !resolvedFacilityIds.includes(clinicFacilityId)) {
      resolvedFacilityIds.push(clinicFacilityId);
    }

    const fallbackFacility =
      resolvedFacilityIds[0] ||
      (await resolveFacilityForRequest(request, dto.facilityId)).id;

    const email = resolveDirectoryEmail(directoryUser);
    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { entraObjectId: directoryUser.objectId },
          { cognitoSub: directoryUser.objectId },
          { email }
        ]
      },
      include: { roles: true }
    });

    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: {
            email,
            name: directoryUser.displayName,
            status: existing.status === "archived" ? "active" : existing.status,
            entraObjectId: directoryUser.objectId,
            entraTenantId: directoryUser.tenantId || env.ENTRA_TENANT_ID || null,
            entraUserPrincipalName: directoryUser.userPrincipalName || null,
            identityProvider: directoryUser.identityProvider,
            directoryStatus: directoryUser.directoryStatus,
            directoryUserType: directoryUser.userType,
            directoryAccountEnabled: directoryUser.accountEnabled,
            lastDirectorySyncAt: new Date(),
            cognitoSub: legacyIdentityAlias(existing.cognitoSub, directoryUser.objectId),
            activeFacilityId: existing.activeFacilityId || fallbackFacility
          }
        })
      : await prisma.user.create({
          data: {
            email,
            name: directoryUser.displayName,
            status: "active",
            entraObjectId: directoryUser.objectId,
            entraTenantId: directoryUser.tenantId || env.ENTRA_TENANT_ID || null,
            entraUserPrincipalName: directoryUser.userPrincipalName || null,
            identityProvider: directoryUser.identityProvider,
            directoryStatus: directoryUser.directoryStatus,
            directoryUserType: directoryUser.userType,
            directoryAccountEnabled: directoryUser.accountEnabled,
            lastDirectorySyncAt: new Date(),
            cognitoSub: legacyIdentityAlias(null, directoryUser.objectId),
            activeFacilityId: fallbackFacility
          }
        });

    if (dto.clinicId) {
      const existingRole = await prisma.userRole.findFirst({
        where: {
          userId: user.id,
          role: dto.role,
          clinicId: dto.clinicId,
          facilityId: clinicFacilityId
        }
      });
      if (!existingRole) {
        await prisma.userRole.create({
          data: {
            userId: user.id,
            role: dto.role,
            clinicId: dto.clinicId,
            facilityId: clinicFacilityId
          }
        });
      }
    } else {
      const roleFacilityIds = resolvedFacilityIds.length > 0 ? resolvedFacilityIds : [fallbackFacility];
      for (const facilityId of roleFacilityIds) {
        const existingRole = await prisma.userRole.findFirst({
          where: {
            userId: user.id,
            role: dto.role,
            facilityId,
            clinicId: null
          }
        });
        if (!existingRole) {
          await prisma.userRole.create({
            data: {
              userId: user.id,
              role: dto.role,
              facilityId
            }
          });
        }
      }
    }

    await syncUserActiveFacilityToScope({
      userId: user.id,
      preferredFacilityId: fallbackFacility
    });

    return prisma.user.findUnique({
      where: { id: user.id },
      include: { roles: true }
    });
  });

  app.post("/admin/users/:id/resync", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const userId = (request.params as { id: string }).id;
    const existing = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        entraObjectId: true,
        entraUserPrincipalName: true,
        cognitoSub: true
      }
    });
    requireCondition(existing, 404, "User not found");

    const objectId = resolveUserDirectoryObjectId(existing);
    requireCondition(objectId, 400, "User is not linked to Microsoft Entra");

    const directoryUser = await getEntraDirectoryUserByObjectId(objectId, {
      email: existing.email,
      userPrincipalName: existing.entraUserPrincipalName
    });
    return syncUserFromDirectory({
      userId,
      directoryUser
    });
  });

  app.post("/admin/users", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    if (isStrictEntraProvisioningMode()) {
      throw new ApiError(
        405,
        "Local user creation is disabled in Entra-only environments. Search Microsoft Entra and provision the user instead."
      );
    }
    const dto = createUserSchema.parse(request.body);
    const email = dto.email.trim().toLowerCase();
    const displayName = composeUserDisplayName({
      name: dto.name,
      firstName: dto.firstName,
      lastName: dto.lastName,
      credential: dto.credential
    });

    const existing = await prisma.user.findFirst({
      where: { email: { equals: email } }
    });
    if (existing) {
      throw new ApiError(400, "A user with that email already exists");
    }

    const normalizedFacilityIds = Array.from(
      new Set(
        [
          ...(Array.isArray(dto.facilityIds) ? dto.facilityIds : []),
          ...(dto.facilityId ? [dto.facilityId] : [])
        ]
          .map((entry) => entry.trim())
          .filter(Boolean)
      )
    );

    let clinicFacilityId: string | null = null;
    if (dto.clinicId) {
      const clinic = await prisma.clinic.findUnique({
        where: { id: dto.clinicId },
        select: { facilityId: true }
      });
      requireCondition(clinic, 404, "Clinic not found");
      clinicFacilityId = clinic.facilityId ?? null;
      await resolveFacilityForRequest(request, clinicFacilityId || undefined);
    }

    const resolvedFacilityIds: string[] = [];
    for (const facilityId of normalizedFacilityIds) {
      const facility = await resolveFacilityForRequest(request, facilityId);
      if (!resolvedFacilityIds.includes(facility.id)) {
        resolvedFacilityIds.push(facility.id);
      }
    }
    if (clinicFacilityId && !resolvedFacilityIds.includes(clinicFacilityId)) {
      resolvedFacilityIds.push(clinicFacilityId);
    }

    const fallbackFacility =
      resolvedFacilityIds[0] ||
      (await resolveFacilityForRequest(request, dto.facilityId)).id;

    const user = await prisma.user.create({
      data: {
        email,
        name: displayName,
        status: (dto.status || "active").toLowerCase(),
        phone: dto.phone,
        activeFacilityId: fallbackFacility
      }
    });

    if (dto.role) {
      if (dto.clinicId) {
        await prisma.userRole.create({
          data: {
            userId: user.id,
            role: dto.role,
            clinicId: dto.clinicId,
            facilityId: clinicFacilityId
          }
        });
      } else {
        const roleFacilityIds = resolvedFacilityIds.length > 0 ? resolvedFacilityIds : [fallbackFacility];
        await prisma.userRole.createMany({
          data: roleFacilityIds.map((facilityId) => ({
            userId: user.id,
            role: dto.role!,
            facilityId
          }))
        });
      }
    }

    await syncUserActiveFacilityToScope({
      userId: user.id,
      preferredFacilityId: fallbackFacility
    });

    return prisma.user.findUnique({
      where: { id: user.id },
      include: {
        roles: true
      }
    });
  });

  app.post("/admin/users/:id", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const userId = (request.params as { id: string }).id;
    const dto = updateUserSchema.parse(request.body);
    const existing = await prisma.user.findUnique({ where: { id: userId } });
    requireCondition(existing, 404, "User not found");

    if (isStrictEntraProvisioningMode()) {
      const attemptedIdentityEdit = Boolean(dto.email || dto.name || dto.firstName || dto.lastName || dto.credential);
      if (attemptedIdentityEdit) {
        throw new ApiError(400, "Identity details are managed in Microsoft Entra. Use resync to refresh them.");
      }
    }

    const nextName =
      dto.name || dto.firstName || dto.lastName || dto.credential
        ? composeUserDisplayName({
            name: dto.name || existing.name,
            firstName: dto.firstName,
            lastName: dto.lastName,
            credential: dto.credential
          })
        : undefined;

    if (dto.email && dto.email.toLowerCase() !== existing.email.toLowerCase()) {
      const duplicate = await prisma.user.findFirst({
        where: {
          email: { equals: dto.email.toLowerCase() },
          id: { not: userId }
        }
      });
      if (duplicate) {
        throw new ApiError(400, "A user with that email already exists");
      }
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        email: dto.email?.toLowerCase(),
        name: nextName,
        status: dto.status?.toLowerCase(),
        phone: dto.phone
      }
    });

    const shouldIncludeImpact =
      typeof dto.status === "string" &&
      ["suspended", "active"].includes(dto.status.toLowerCase());
    if (!shouldIncludeImpact) {
      return updated;
    }

    const impact = await listUserAssignmentImpact(userId);
    return {
      ...updated,
      impact
    };
  });

  app.delete("/admin/users/:id", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const userId = (request.params as { id: string }).id;
    const actorUserId = request.user!.id;
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    requireCondition(user, 404, "User not found");
    requireCondition(user.id !== actorUserId, 400, "You cannot archive the current signed-in admin user");
    requireCondition(user.status === "suspended", 400, "Only suspended users can be archived");

    const archivedName = user.name.endsWith(" (Archived)") ? user.name : `${user.name} (Archived)`;

    await prisma.$transaction(async (tx) => {
      const providerLinks = await tx.clinicAssignment.findMany({
        where: {
          providerUserId: userId,
          providerId: { not: null }
        },
        select: { providerId: true }
      });
      const providerIds = Array.from(
        new Set(
          providerLinks
            .map((row) => row.providerId)
            .filter((value): value is string => Boolean(value))
        )
      );
      for (const providerId of providerIds) {
        const hasOtherProviderUserLinks = await tx.clinicAssignment.count({
          where: {
            providerId,
            providerUserId: { not: userId }
          }
        });
        if (hasOtherProviderUserLinks > 0) {
          continue;
        }
        const provider = await tx.provider.findUnique({
          where: { id: providerId },
          select: { id: true, name: true, active: true }
        });
        if (!provider) continue;
        const archivedProviderName = provider.name.endsWith(" (Archived)")
          ? provider.name
          : `${provider.name} (Archived)`;
        await tx.provider.update({
          where: { id: provider.id },
          data: {
            name: archivedProviderName,
            active: false
          }
        });
      }

      await tx.userRole.deleteMany({
        where: { userId }
      });

      await tx.clinicAssignment.updateMany({
        where: { providerUserId: userId },
        data: {
          providerUserId: null,
          providerId: null
        }
      });
      await tx.clinicAssignment.updateMany({
        where: { maUserId: userId },
        data: { maUserId: null }
      });

      await tx.user.update({
        where: { id: userId },
        data: {
          name: archivedName,
          email: `archived+${user.id}@flow.local`,
          status: "archived",
          phone: null,
          activeFacilityId: null
        }
      });
    });

    return { status: "archived", userId };
  });

  app.post("/admin/users/:id/roles", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const userId = (request.params as { id: string }).id;
    const dto = roleSchema.parse(request.body);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    requireCondition(user, 404, "User not found");
    requireCondition(user.status !== "archived", 400, "Cannot assign roles to archived users");

    let clinicFacilityId: string | null = null;
    if (dto.clinicId) {
      const clinic = await prisma.clinic.findUnique({
        where: { id: dto.clinicId },
        select: { id: true, facilityId: true }
      });
      requireCondition(clinic, 404, "Clinic not found");
      clinicFacilityId = clinic.facilityId ?? null;
    }

    const facilityId = dto.clinicId ? clinicFacilityId : (await resolveFacilityForRequest(request, dto.facilityId)).id;
    if (dto.clinicId) {
      await resolveFacilityForRequest(request, clinicFacilityId || undefined);
    }

    if (!dto.clinicId) {
      await prisma.userRole.deleteMany({
        where: {
          userId,
          role: dto.role,
          clinicId: null,
          NOT: { facilityId }
        }
      });
    }

    const existingRole = await prisma.userRole.findFirst({
      where: {
        userId,
        role: dto.role,
        clinicId: dto.clinicId ?? null,
        facilityId
      }
    });
    if (existingRole) {
      await syncUserActiveFacilityToScope({
        userId,
        preferredFacilityId: facilityId
      });
      return prisma.user.findUniqueOrThrow({
        where: { id: userId },
        include: { roles: true }
      });
    }

    await prisma.userRole.create({
      data: {
        userId,
        role: dto.role,
        clinicId: dto.clinicId,
        facilityId
      }
    });

    await syncUserActiveFacilityToScope({
      userId,
      preferredFacilityId: facilityId
    });

    return prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { roles: true }
    });
  });

  app.post("/admin/users/:id/roles/remove", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const userId = (request.params as { id: string }).id;
    const dto = roleSchema.parse(request.body);

    const roles = await prisma.userRole.findMany({
      where: { userId, role: dto.role },
      select: { id: true, clinicId: true, facilityId: true }
    });
    if (roles.length === 0) return { removed: 0 };

    const idsToDelete = roles
      .filter((role) => {
        if (dto.clinicId && role.clinicId === dto.clinicId) return true;
        if (dto.facilityId && role.facilityId === dto.facilityId) return true;
        if (!dto.clinicId && !dto.facilityId) return true;
        return false;
      })
      .map((role) => role.id);

    const deleted = await prisma.userRole.deleteMany({
      where: { id: { in: idsToDelete } }
    });

    await syncUserActiveFacilityToScope({ userId });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { roles: true }
    });
    if (!user) {
      return { removed: deleted.count };
    }
    return {
      ...user,
      removed: deleted.count
    };
  });
}
