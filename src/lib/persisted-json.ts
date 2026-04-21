import { RoleName } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { ApiError } from "./errors.js";

type LoggerLike = {
  warn?: (payload: unknown, message?: string) => void;
};

const jsonObjectSchema = z.record(z.string(), z.unknown());
const jsonStringArraySchema = z.array(z.string());
const diagnosisPointerSchema = z.array(z.number().int().min(1));
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
  "yesNo",
]);
const templateFieldDefinitionSchema = z.object({
  id: z.string().trim().optional(),
  key: z.string().trim().optional(),
  label: z.string().trim().optional(),
  type: templateFieldTypeSchema,
  required: z.boolean().optional(),
  options: z.array(z.string().trim().min(1)).optional(),
  group: z.string().trim().optional(),
  icon: z.string().trim().optional(),
  color: z.string().trim().optional(),
});
const quietHoursSchema = z.object({
  start: z.string().trim().min(1),
  end: z.string().trim().min(1),
  timezone: z.string().trim().min(1),
});
const roleNameArraySchema = z.array(z.nativeEnum(RoleName));
const incomingIssueNormalizedSchema = z
  .object({
    clinicId: z.string().uuid().optional(),
    dateOfService: z.string().nullable().optional(),
    patientId: z.string().optional(),
    appointmentTime: z.string().nullable().optional(),
    providerLastName: z.string().nullable().optional(),
    reasonText: z.string().nullable().optional(),
  })
  .passthrough();

const revenueProcedureLineSchema = z.object({
  lineId: z.string().trim().min(1).optional(),
  cptCode: z.string().trim().min(1),
  modifiers: z.array(z.string().trim().min(1)).optional().default([]),
  units: z.number().int().min(1).optional().default(1),
  diagnosisPointers: diagnosisPointerSchema.optional().default([]),
});

const revenueServiceCaptureItemSchema = z.object({
  id: z.string().trim().min(1),
  catalogItemId: z.string().trim().min(1).nullable().optional(),
  label: z.string().trim().min(1),
  sourceRole: z.nativeEnum(RoleName).optional().default(RoleName.MA),
  sourceTaskId: z.string().trim().min(1).nullable().optional(),
  quantity: z.number().int().min(1).optional().default(1),
  note: z.string().trim().nullable().optional(),
  performedAt: z.string().trim().nullable().optional(),
  capturedByUserId: z.string().trim().nullable().optional(),
  suggestedProcedureCode: z.string().trim().nullable().optional(),
  expectedChargeCents: z.number().int().nullable().optional(),
  detailSchemaKey: z.string().trim().min(1).optional().default("generic_service"),
  detailJson: jsonObjectSchema.nullable().optional(),
  detailComplete: z.boolean().optional().default(true),
});

const roomingDataSchema = jsonObjectSchema.superRefine((value, ctx) => {
  const captureItems = value["service.capture_items"];
  if (captureItems === undefined) return;
  const parsed = z.array(revenueServiceCaptureItemSchema).safeParse(captureItems);
  if (!parsed.success) {
    parsed.error.issues.forEach((issue) => {
      ctx.addIssue({
        code: "custom",
        message: `service.capture_items ${issue.message}`,
        path: ["service.capture_items", ...issue.path],
      });
    });
  }
});

const clinicianDataSchema = jsonObjectSchema;
const checkoutDataSchema = jsonObjectSchema;
const intakeDataSchema = jsonObjectSchema;
const documentationSummarySchema = jsonObjectSchema.nullable();

export type EncounterJsonKind = "roomingData" | "clinicianData" | "checkoutData" | "intakeData";

function schemaForEncounterJson(kind: EncounterJsonKind) {
  switch (kind) {
    case "roomingData":
      return roomingDataSchema;
    case "clinicianData":
      return clinicianDataSchema;
    case "checkoutData":
      return checkoutDataSchema;
    case "intakeData":
      return intakeDataSchema;
    default:
      return jsonObjectSchema;
  }
}

function issueMessages(error: z.ZodError) {
  return error.issues.map((issue) => issue.message);
}

function logSchemaDrift(logger: LoggerLike | undefined, params: { label: string; issues: string[] }) {
  logger?.warn?.(
    {
      label: params.label,
      issues: params.issues,
    },
    "Schema drift detected on persisted JSON column",
  );
}

function toInputJson<T>(value: T): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function parseEncounterJsonInput(kind: EncounterJsonKind, value: unknown) {
  const parsed = schemaForEncounterJson(kind).safeParse(value);
  if (!parsed.success) {
    throw new ApiError({
      statusCode: 400,
      code: `INVALID_${kind.toUpperCase()}`,
      message: `Invalid ${kind} payload`,
      details: issueMessages(parsed.error),
    });
  }
  return parsed.data;
}

export function normalizeEncounterJsonRead(
  kind: EncounterJsonKind,
  value: Prisma.JsonValue | null | undefined,
  logger?: LoggerLike,
) {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = schemaForEncounterJson(kind).safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  logSchemaDrift(logger, { label: kind, issues: issueMessages(parsed.error) });
  return null;
}

export function parseIncomingIntakeDataInput(value: unknown) {
  return parseEncounterJsonInput("intakeData", value);
}

export function normalizeStringArrayJson(
  value: Prisma.JsonValue | null | undefined,
  logger?: LoggerLike,
  label = "stringArrayJson",
) {
  if (value === null || value === undefined) return [] as string[];
  const parsed = jsonStringArraySchema.safeParse(value);
  if (parsed.success) return parsed.data;
  logSchemaDrift(logger, { label, issues: issueMessages(parsed.error) });
  return [] as string[];
}

export function parseStringArrayJsonInput(value: unknown, label: string) {
  const parsed = jsonStringArraySchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError({
      statusCode: 400,
      code: `INVALID_${label.toUpperCase()}`,
      message: `Invalid ${label} payload`,
      details: issueMessages(parsed.error),
    });
  }
  return parsed.data;
}

export function normalizeRoleNameArrayJson(
  value: Prisma.JsonValue | null | undefined,
  logger?: LoggerLike,
  label = "roleNameArrayJson",
) {
  if (value === null || value === undefined) return [] as RoleName[];
  const parsed = roleNameArraySchema.safeParse(value);
  if (parsed.success) return parsed.data;
  logSchemaDrift(logger, { label, issues: issueMessages(parsed.error) });
  return [] as RoleName[];
}

export function parseRoleNameArrayJsonInput(value: unknown, label: string) {
  const parsed = roleNameArraySchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError({
      statusCode: 400,
      code: `INVALID_${label.toUpperCase()}`,
      message: `Invalid ${label} payload`,
      details: issueMessages(parsed.error),
    });
  }
  return parsed.data;
}

export function normalizeIncomingIssueNormalizedJson(
  value: Prisma.JsonValue | null | undefined,
  logger?: LoggerLike,
  label = "incomingIssueNormalizedJson",
) {
  if (value === null || value === undefined) {
    return {};
  }
  const parsed = incomingIssueNormalizedSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  logSchemaDrift(logger, { label, issues: issueMessages(parsed.error) });
  return {};
}

export function parseIncomingIssueNormalizedJsonInput(
  value: unknown,
  label = "incomingIssueNormalizedJson",
) {
  const parsed = incomingIssueNormalizedSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError({
      statusCode: 400,
      code: `INVALID_${label.toUpperCase()}`,
      message: `Invalid ${label} payload`,
      details: issueMessages(parsed.error),
    });
  }
  return parsed.data;
}

export function normalizeTemplateFieldsJson(
  value: Prisma.JsonValue | null | undefined,
  logger?: LoggerLike,
  label = "templateFieldsJson",
) {
  if (value === null || value === undefined) return [] as Array<z.infer<typeof templateFieldDefinitionSchema>>;
  const parsed = z.array(templateFieldDefinitionSchema).safeParse(value);
  if (parsed.success) return parsed.data;
  logSchemaDrift(logger, { label, issues: issueMessages(parsed.error) });
  return [] as Array<z.infer<typeof templateFieldDefinitionSchema>>;
}

export function parseTemplateFieldsJsonInput(value: unknown, label = "templateFieldsJson") {
  const parsed = z.array(templateFieldDefinitionSchema).safeParse(value);
  if (!parsed.success) {
    throw new ApiError({
      statusCode: 400,
      code: `INVALID_${label.toUpperCase()}`,
      message: `Invalid ${label} payload`,
      details: issueMessages(parsed.error),
    });
  }
  return parsed.data;
}

export function normalizeQuietHoursJson(
  value: Prisma.JsonValue | null | undefined,
  logger?: LoggerLike,
  label = "quietHoursJson",
) {
  if (value === null || value === undefined) return null;
  const parsed = quietHoursSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  logSchemaDrift(logger, { label, issues: issueMessages(parsed.error) });
  return null;
}

export function parseQuietHoursJsonInput(value: unknown, label = "quietHoursJson") {
  const parsed = quietHoursSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError({
      statusCode: 400,
      code: `INVALID_${label.toUpperCase()}`,
      message: `Invalid ${label} payload`,
      details: issueMessages(parsed.error),
    });
  }
  return parsed.data;
}

export function normalizeGenericObjectJson(
  value: Prisma.JsonValue | null | undefined,
  logger?: LoggerLike,
  label = "jsonObject",
) {
  if (value === null || value === undefined) return null;
  const parsed = jsonObjectSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  logSchemaDrift(logger, { label, issues: issueMessages(parsed.error) });
  return null;
}

export function parseGenericObjectJsonInput(value: unknown, label: string) {
  const parsed = jsonObjectSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError({
      statusCode: 400,
      code: `INVALID_${label.toUpperCase()}`,
      message: `Invalid ${label} payload`,
      details: issueMessages(parsed.error),
    });
  }
  return parsed.data;
}

export function normalizeProcedureLinesJson(value: Prisma.JsonValue | null | undefined, logger?: LoggerLike) {
  if (value === null || value === undefined) return [] as Array<z.infer<typeof revenueProcedureLineSchema>>;
  const parsed = z.array(revenueProcedureLineSchema).safeParse(value);
  if (parsed.success) return parsed.data;
  logSchemaDrift(logger, { label: "procedureLinesJson", issues: issueMessages(parsed.error) });
  return [] as Array<z.infer<typeof revenueProcedureLineSchema>>;
}

export function parseProcedureLinesJsonInput(value: unknown) {
  const parsed = z.array(revenueProcedureLineSchema).safeParse(value);
  if (!parsed.success) {
    throw new ApiError({
      statusCode: 400,
      code: "INVALID_PROCEDURE_LINES_JSON",
      message: "Invalid procedure lines payload",
      details: issueMessages(parsed.error),
    });
  }
  return parsed.data;
}

export function normalizeServiceCaptureItemsJson(value: Prisma.JsonValue | null | undefined, logger?: LoggerLike) {
  if (value === null || value === undefined) return [] as Array<z.infer<typeof revenueServiceCaptureItemSchema>>;
  const parsed = z.array(revenueServiceCaptureItemSchema).safeParse(value);
  if (parsed.success) return parsed.data;
  logSchemaDrift(logger, { label: "serviceCaptureItemsJson", issues: issueMessages(parsed.error) });
  return [] as Array<z.infer<typeof revenueServiceCaptureItemSchema>>;
}

export function parseServiceCaptureItemsJsonInput(value: unknown) {
  const parsed = z.array(revenueServiceCaptureItemSchema).safeParse(value);
  if (!parsed.success) {
    throw new ApiError({
      statusCode: 400,
      code: "INVALID_SERVICE_CAPTURE_ITEMS_JSON",
      message: "Invalid service capture payload",
      details: issueMessages(parsed.error),
    });
  }
  return parsed.data;
}

export function normalizeDocumentationSummaryJson(value: Prisma.JsonValue | null | undefined, logger?: LoggerLike) {
  if (value === null || value === undefined) return null;
  const parsed = documentationSummarySchema.safeParse(value);
  if (parsed.success) return parsed.data;
  logSchemaDrift(logger, { label: "documentationSummaryJson", issues: issueMessages(parsed.error) });
  return null;
}

export function parseDocumentationSummaryJsonInput(value: unknown) {
  const parsed = documentationSummarySchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError({
      statusCode: 400,
      code: "INVALID_DOCUMENTATION_SUMMARY_JSON",
      message: "Invalid documentation summary payload",
      details: issueMessages(parsed.error),
    });
  }
  return parsed.data;
}

export function asInputJson(value: unknown) {
  return toInputJson(JSON.parse(JSON.stringify(value ?? null)));
}
