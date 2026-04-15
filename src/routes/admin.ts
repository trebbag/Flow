import type { FastifyInstance, FastifyRequest } from "fastify";
import { AlertLevel, AlertThresholdMetric, EncounterStatus, Prisma, RoleName, TemplateType } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { ApiError, assert } from "../lib/errors.js";
import { requireRoles } from "../lib/auth.js";
import { formatUserDisplayName } from "../lib/display-names.js";
import { getEntraDirectoryUserByObjectId, searchEntraDirectoryUsers, type EntraDirectoryUser } from "../lib/entra-directory.js";
import { createInboxAlert } from "../lib/user-alert-inbox.js";
import {
  mergeAthenaConnectorConfig,
  normalizeAthenaConnectorConfig,
  previewAthenaSchedule,
  redactAthenaConnectorConfig,
  testAthenaConnectorConfig
} from "../lib/athena-one.js";

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
  phone: z.string().optional(),
  cognitoSub: z.string().optional()
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

async function syncUserFromDirectory(params: {
  userId: string;
  directoryUser: EntraDirectoryUser | null;
}) {
  const existing = await prisma.user.findUnique({
    where: { id: params.userId },
    include: { roles: true }
  });
  assert(existing, 404, "User not found");

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
      cognitoSub: existing.cognitoSub || directoryUser.objectId,
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
    const facility = await prisma.facility.findUnique({ where: { id: requested } });
    assert(facility, 404, "Facility not found");
    if (scopedIds && !scopedIds.includes(facility.id)) {
      throw new ApiError(403, "Facility is outside your assigned scope");
    }
    return facility;
  }

  if (scopedIds && scopedIds.length > 0) {
    const facility = await prisma.facility.findFirst({
      where: { id: { in: scopedIds } },
      orderBy: { createdAt: "asc" }
    });
    assert(facility, 404, "No facilities available in your scope");
    return facility;
  }

  const facility = await getFirstActiveFacility();
  assert(facility, 404, "No facility found");
  return facility;
}

async function resolveClinicForFacility(clinicId: string, facilityId: string) {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { id: true, facilityId: true }
  });
  assert(clinic, 404, "Clinic not found");
  assert(clinic.facilityId === facilityId, 400, "Clinic is outside the selected facility scope");
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
  assert(matchedRole, 400, `Selected user is not assigned to role ${role} in this facility`);
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
  assert(user, 404, "User not found");

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
}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
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

async function restoreRoomWithAllocatedNumber(roomId: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const room = await tx.clinicRoom.findUnique({ where: { id: roomId } });
        assert(room, 404, "Room not found");
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
      const [providers, roomAssignments, clinicAssignments] = await Promise.all([
        prisma.provider.groupBy({
          by: ["clinicId"],
          where: { clinicId: { in: clinicIds }, active: true },
          _count: { _all: true }
        }),
        prisma.clinicRoomAssignment.findMany({
          where: { clinicId: { in: clinicIds }, active: true },
          include: { room: true }
        }),
        prisma.clinicAssignment.findMany({
          where: { clinicId: { in: clinicIds } },
          include: {
            providerUser: { select: { id: true, name: true, status: true } },
            maUser: { select: { id: true, name: true, status: true } }
          }
        })
      ]);

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
    assert(existing, 404, "Facility not found");

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
    assert(dto.maRun !== undefined, 400, "Clinic run model is required");
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
        cardTags: dto.cardTags ? (dto.cardTags as Prisma.InputJsonValue) : Prisma.JsonNull
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
      assert(rooms.length === dto.roomIds.length, 400, "One or more rooms are invalid for this facility");
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
    assert(existing, 404, "Clinic not found");
    if (dto.maRun !== undefined && dto.maRun !== existing.maRun) {
      throw new ApiError(400, "MA run model is intrinsic and cannot be changed after clinic creation.");
    }

    const facilityId = dto.facilityId ?? existing.facilityId;
    if (facilityId) {
      const facility = await resolveFacilityForRequest(request, facilityId);
      assert(facility, 404, "Facility not found");
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
        cardTags: dto.cardTags ? (dto.cardTags as Prisma.InputJsonValue) : undefined
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
      assert(rooms.length === dto.roomIds.length, 400, "One or more rooms are invalid for this facility");

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
    assert(clinic, 404, "Clinic not found");
    await resolveFacilityForRequest(request, clinic.facilityId || undefined);

    const encounterCount = await prisma.encounter.count({ where: { clinicId } });
    if (encounterCount > 0) {
      const archived = await prisma.$transaction(async (tx) => {
        await tx.clinicRoomAssignment.updateMany({
          where: { clinicId },
          data: { active: false }
        });
        return tx.clinic.update({
          where: { id: clinicId },
          data: { status: "archived" }
        });
      });
      return { status: "archived", clinic: archived };
    }

    await prisma.$transaction(async (tx) => {
      // Remove schedule/import rows first so dependent provider/reason rows can be removed safely.
      await ignoreMissingSchema(() => tx.incomingImportIssue.updateMany({
        where: { clinicId },
        data: { clinicId: null }
      }));
      await ignoreMissingSchema(() => tx.incomingSchedule.deleteMany({ where: { clinicId } }));
      await ignoreMissingSchema(() => tx.incomingImportBatch.deleteMany({ where: { clinicId } }));

      await ignoreMissingSchema(() => tx.maProviderMap.deleteMany({ where: { clinicId } }));
      await ignoreMissingSchema(() => tx.maClinicMap.deleteMany({ where: { clinicId } }));
      await ignoreMissingSchema(() => tx.clinicAssignment.deleteMany({ where: { clinicId } }));
      await ignoreMissingSchema(() => tx.provider.deleteMany({ where: { clinicId } }));
      await ignoreMissingSchema(() => tx.officeManagerDailyRollup.deleteMany({ where: { clinicId } }));
      await ignoreMissingSchema(() => tx.templateReasonAssignment.deleteMany({
        where: {
          template: {
            clinicId
          }
        }
      }));
      await ignoreMissingSchema(() => tx.template.deleteMany({ where: { clinicId } }));
      await ignoreMissingSchema(() => tx.reasonClinicAssignment.deleteMany({ where: { clinicId } }));
      await ignoreMissingSchema(() => tx.reasonForVisit.updateMany({ where: { clinicId }, data: { clinicId: null } }));
      await ignoreMissingSchema(() => tx.alertThreshold.deleteMany({ where: { clinicId } }));
      await ignoreMissingSchema(() => tx.notificationPolicy.deleteMany({ where: { clinicId } }));
      await ignoreMissingSchema(() => tx.clinicRoomAssignment.deleteMany({ where: { clinicId } }));
      await ignoreMissingSchema(() => tx.userRole.updateMany({
        where: { clinicId },
        data: { clinicId: null }
      }));

      await tx.clinic.delete({ where: { id: clinicId } });
    });

    return { status: "deleted", clinicId };
  });

  app.post("/admin/clinics/:id/restore", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const clinicId = (request.params as { id: string }).id;
    const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
    assert(clinic, 404, "Clinic not found");
    const restored = await prisma.clinic.update({
      where: { id: clinicId },
      data: { status: "active" }
    });
    await prisma.clinicRoomAssignment.updateMany({
      where: { clinicId },
      data: { active: true }
    });
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
    assert(clinicIds.length > 0, 400, "At least one clinic must be selected");

    const clinics = await prisma.clinic.findMany({
      where: { id: { in: clinicIds } },
      select: { id: true, facilityId: true, status: true }
    });
    assert(clinics.length === clinicIds.length, 400, "One or more clinics are invalid");
    assert(
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

    assert(created, 500, "Failed to create visit reason");
    const mapped = mapReasonRow(created);
    assert(mapped.clinicIds.length > 0, 500, "Visit reason clinic assignments were not persisted");
    return mapped;
  });

  app.post("/admin/reasons/:id", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const reasonId = (request.params as { id: string }).id;
    const dto = updateReasonSchema.parse(request.body);

    const reason = await prisma.reasonForVisit.findUnique({
      where: { id: reasonId },
      include: { clinicAssignments: { select: { clinicId: true } } }
    });
    assert(reason, 404, "Visit reason not found");
    const facility = await resolveFacilityForRequest(request, reason.facilityId || undefined);
    assert(reason.facilityId === facility.id, 400, "Visit reason is outside selected facility");

    let clinicIds: string[] | undefined = undefined;
    if (dto.clinicIds) {
      clinicIds = Array.from(new Set(dto.clinicIds));
      const clinics = await prisma.clinic.findMany({
        where: { id: { in: clinicIds } },
        select: { id: true, facilityId: true, status: true }
      });
      assert(clinics.length === clinicIds.length, 400, "One or more clinics are invalid");
      assert(
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

    assert(updated, 500, "Failed to update visit reason");
    const mapped = mapReasonRow(updated);
    assert(mapped.clinicIds.length > 0, 500, "Visit reason clinic assignments were not persisted");
    return mapped;
  });

  app.delete("/admin/reasons/:id", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const reasonId = (request.params as { id: string }).id;
    const reason = await prisma.reasonForVisit.findUnique({ where: { id: reasonId } });
    assert(reason, 404, "Visit reason not found");
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
    const room = await createRoomWithAllocatedNumber({
      facilityId: facility.id,
      name: dto.name,
      roomType,
      status: dto.status ?? "active"
    });
    if (room.status === "active") {
      await prisma.roomOperationalState.upsert({
        where: { roomId: room.id },
        create: { roomId: room.id, currentStatus: "Ready", lastReadyAt: new Date() },
        update: {}
      });
    }
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
    assert(
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
    assert(room, 404, "Room not found");
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
    assert(room, 404, "Room not found");
    await resolveFacilityForRequest(request, room.facilityId);

    const usedCount = await prisma.encounter.count({ where: { roomId } });
    if (usedCount > 0) {
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
    assert(room, 404, "Room not found");
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
    const [assignments, activeRoomCounts] = await Promise.all([
      prisma.clinicAssignment.findMany({
        where: { clinicId: { in: clinicIds } },
        include: {
          providerUser: { select: { id: true, name: true, status: true } },
          maUser: { select: { id: true, name: true, status: true } }
        }
      }),
      prisma.clinicRoomAssignment.groupBy({
        by: ["clinicId"],
        where: {
          clinicId: { in: clinicIds },
          active: true,
          room: { status: "active" }
        },
        _count: { _all: true }
      })
    ]);

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
    assert(clinic, 404, "Clinic not found");
    assert(clinic.facilityId, 400, "Clinic must belong to a facility");
    await resolveFacilityForRequest(request, clinic.facilityId || undefined);
    assert(clinic.status !== "archived", 400, "Cannot manage assignments for archived clinics");

    assert(normalizedMaUserId, 400, "An MA assignment is required for this clinic");
    await assertUserRoleForFacility({
      userId: normalizedMaUserId,
      role: RoleName.MA,
      facilityId: clinic.facilityId
    });
    const maUser = await prisma.user.findUnique({
      where: { id: normalizedMaUserId },
      select: { id: true, name: true, status: true }
    });
    assert(maUser, 404, "MA user not found");
    assert(maUser.status === "active", 400, "Selected MA user is not active");

    if (!clinic.maRun) {
      assert(normalizedProviderUserId, 400, "A provider assignment is required for non MA-run clinics");
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
      assert(providerUser, 404, "Provider user not found");
      assert(providerUser.status === "active", 400, "Selected provider user is not active");
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
        assert(providerId, 400, "Provider assignment is required for non MA-run clinics");
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
    assert(endsAt > startsAt, 400, "Temporary coverage end must be after the start.");

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
    assert(clinic, 404, "Clinic not found");
    assert(clinic.facilityId === dto.facilityId, 400, "Clinic is outside the selected facility.");
    assert(clinic.status === "active", 400, "Temporary coverage can only be added for active clinics.");
    assert(user, 404, "User not found");
    assert(user.status === "active", 400, "Temporary coverage can only be added for active users.");
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
    assert(existing, 404, "Temporary coverage override not found");
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

  function mapTemplateRow(template: TemplateWithAssignments) {
    const reasonIds = Array.from(
      new Set([
        ...(template.reasonForVisitId ? [template.reasonForVisitId] : []),
        ...template.reasonAssignments.map((entry) => entry.reasonId)
      ])
    );
    const fields = Array.isArray(template.fieldsJson) ? (template.fieldsJson as unknown[]) : [];
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
    return templates.map((template) => mapTemplateRow(template as TemplateWithAssignments));
  });

  async function upsertTemplate(params: {
    templateId?: string;
    dto: z.infer<typeof templateSchema>;
    request: FastifyRequest;
  }) {
    const { templateId, dto, request } = params;
    const facility = await resolveFacilityForRequest(request, dto.facilityId);
    const reasonIds = Array.from(new Set(dto.reasonIds?.length ? dto.reasonIds : dto.reasonForVisitId ? [dto.reasonForVisitId] : []));
    assert(reasonIds.length > 0, 400, "At least one visit reason must be selected");

    const reasons = await prisma.reasonForVisit.findMany({
      where: { id: { in: reasonIds } },
      select: { id: true, facilityId: true, status: true }
    });
    assert(reasons.length === reasonIds.length, 400, "One or more visit reasons are invalid");
    assert(
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
              fieldsJson: normalizedFields as Prisma.InputJsonValue,
              jsonSchema: schema.jsonSchema,
              uiSchema: schema.uiSchema,
              requiredFields: schema.requiredFields as Prisma.InputJsonValue,
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
              fieldsJson: normalizedFields as Prisma.InputJsonValue,
              jsonSchema: schema.jsonSchema,
              uiSchema: schema.uiSchema,
              requiredFields: schema.requiredFields as Prisma.InputJsonValue
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

    assert(template, 500, "Failed to save template");
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
    assert(existing, 404, "Template not found");
    return upsertTemplate({ templateId, dto, request });
  });

  app.put("/admin/templates/:id", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const templateId = (request.params as { id: string }).id;
    const dto = parseTemplatePayload(request.body);
    const existing = await prisma.template.findUnique({ where: { id: templateId } });
    assert(existing, 404, "Template not found");
    return upsertTemplate({ templateId, dto, request });
  });

  app.delete("/admin/templates/:id", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const templateId = (request.params as { id: string }).id;
    const template = await prisma.template.findUnique({ where: { id: templateId } });
    assert(template, 404, "Template not found");
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
    assert(metric !== AlertThresholdMetric.stage || normalizedStatus, 400, "Status is required for stage thresholds");

    let facilityId = dto.facilityId || undefined;
    if (dto.clinicId) {
      const clinic = await prisma.clinic.findUnique({
        where: { id: dto.clinicId },
        select: { facilityId: true }
      });
      assert(clinic, 404, "Clinic not found");
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
    assert(existing, 404, "Threshold not found");

    const metric = dto.metric ?? existing.metric;
    const normalizedStatus =
      metric === AlertThresholdMetric.overall_visit
        ? null
        : dto.status === undefined
          ? existing.status
          : dto.status;
    assert(metric !== AlertThresholdMetric.stage || normalizedStatus, 400, "Status is required for stage thresholds");

    let facilityId = dto.facilityId || existing.facilityId;
    if (dto.clinicId) {
      const clinic = await prisma.clinic.findUnique({
        where: { id: dto.clinicId },
        select: { facilityId: true }
      });
      assert(clinic, 404, "Clinic not found");
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
    assert(existingRows.length === dto.rows.length, 404, "One or more thresholds were not found");

    const facilityIdSet = new Set(existingRows.map((row) => row.facilityId));
    const requestedFacilityId = dto.facilityId || existingRows[0]?.facilityId;
    assert(requestedFacilityId, 400, "Facility is required");
    const facility = await resolveFacilityForRequest(request, requestedFacilityId);
    assert(
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
      assert(clinics.length === clinicIds.length, 400, "One or more threshold clinics are outside the selected facility");
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
        assert(metric !== AlertThresholdMetric.stage || status, 400, "Status is required for stage thresholds");

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
    assert(existing, 404, "Threshold not found");
    await resolveFacilityForRequest(request, existing.facilityId);
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
    assert(connector, 400, "AthenaOne connector is not configured for this facility");

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
      recipients: row.recipientsJson,
      channels: row.channelsJson,
      escalationRecipients: row.escalationRecipientsJson,
      quietHours: row.quietHoursJson
    }));
  });

  app.post("/admin/notifications", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const dto = notificationSchema.parse(request.body);
    const clinic = await prisma.clinic.findUnique({
      where: { id: dto.clinicId },
      select: { facilityId: true }
    });
    assert(clinic, 404, "Clinic not found");
    await resolveFacilityForRequest(request, clinic.facilityId || undefined);
    return prisma.notificationPolicy.create({
      data: {
        clinicId: dto.clinicId,
        status: dto.status,
        severity: dto.severity,
        recipientsJson: dto.recipients as Prisma.InputJsonValue,
        channelsJson: dto.channels as Prisma.InputJsonValue,
        cooldownMinutes: dto.cooldownMinutes,
        ackRequired: dto.ackRequired ?? false,
        escalationAfterMin: dto.escalationAfterMin,
        escalationRecipientsJson: jsonOrNull(dto.escalationRecipients),
        quietHoursJson: jsonOrNull(dto.quietHours)
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
    assert(clinic, 404, "Clinic not found");
    await resolveFacilityForRequest(request, clinic.facilityId || undefined);
    return prisma.notificationPolicy.update({
      where: { id: policyId },
      data: {
        clinicId: dto.clinicId,
        status: dto.status,
        severity: dto.severity,
        recipientsJson: dto.recipients as Prisma.InputJsonValue,
        channelsJson: dto.channels as Prisma.InputJsonValue,
        cooldownMinutes: dto.cooldownMinutes,
        ackRequired: dto.ackRequired ?? false,
        escalationAfterMin: dto.escalationAfterMin,
        escalationRecipientsJson: jsonOrNull(dto.escalationRecipients),
        quietHoursJson: jsonOrNull(dto.quietHours)
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
    assert(policy, 404, "Notification policy not found");
    const clinic = await prisma.clinic.findUnique({
      where: { id: policy.clinicId },
      select: { facilityId: true }
    });
    assert(clinic, 404, "Clinic not found");
    await resolveFacilityForRequest(request, clinic.facilityId || undefined);
    return prisma.notificationPolicy.delete({ where: { id: policyId } });
  });

  app.post("/admin/notifications/:id/test", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const policyId = (request.params as { id: string }).id;
    const policy = await prisma.notificationPolicy.findUnique({
      where: { id: policyId }
    });
    assert(policy, 404, "Notification policy not found");
    const clinic = await prisma.clinic.findUnique({
      where: { id: policy.clinicId },
      select: {
        id: true,
        facilityId: true,
        name: true
      }
    });
    assert(clinic?.facilityId, 404, "Clinic not found");
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

  app.get("/admin/users", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
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

  app.get("/admin/directory-users", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const query = directorySearchSchema.parse(request.query);
    return searchEntraDirectoryUsers(query.query);
  });

  app.post("/admin/users/provision", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const dto = provisionUserSchema.parse(request.body);
    const directoryUser = await getEntraDirectoryUserByObjectId(dto.objectId);
    assert(directoryUser, 404, "Microsoft Entra user was not found");
    assert(directoryUser.accountEnabled, 400, "Microsoft Entra user is disabled");
    assert(directoryUser.userType.toLowerCase() === "member", 400, "Guest and B2B Microsoft accounts are not allowed");

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
      assert(clinic, 404, "Clinic not found");
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
            cognitoSub: existing.cognitoSub || directoryUser.objectId,
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
            cognitoSub: directoryUser.objectId,
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
    assert(existing, 404, "User not found");

    const objectId = existing.entraObjectId || existing.cognitoSub;
    assert(objectId, 400, "User is not linked to Microsoft Entra");

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
      assert(clinic, 404, "Clinic not found");
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
        cognitoSub: dto.cognitoSub,
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
    assert(existing, 404, "User not found");

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

  app.post("/admin/users/:id/reset-password", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    if (isStrictEntraProvisioningMode()) {
      throw new ApiError(405, "Password resets are managed in Microsoft Entra for this environment.");
    }
    const userId = (request.params as { id: string }).id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, status: true }
    });
    assert(user, 404, "User not found");
    assert(user.status !== "archived", 400, "Cannot reset password for archived users");
    return {
      status: "queued",
      message: `Password reset initiated for ${user.email}`
    };
  });

  app.delete("/admin/users/:id", { preHandler: requireRoles(RoleName.Admin) }, async (request) => {
    const userId = (request.params as { id: string }).id;
    const actorUserId = request.user!.id;
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    assert(user, 404, "User not found");
    assert(user.id !== actorUserId, 400, "You cannot archive the current signed-in admin user");
    assert(user.status === "suspended", 400, "Only suspended users can be archived");

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
    assert(user, 404, "User not found");
    assert(user.status !== "archived", 400, "Cannot assign roles to archived users");

    let clinicFacilityId: string | null = null;
    if (dto.clinicId) {
      const clinic = await prisma.clinic.findUnique({
        where: { id: dto.clinicId },
        select: { id: true, facilityId: true }
      });
      assert(clinic, 404, "Clinic not found");
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
