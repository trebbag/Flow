import {
  AlertInboxKind,
  CodingStage,
  CollectionOutcome,
  type Encounter,
  EncounterStatus,
  FinancialEligibilityStatus,
  FinancialRequirementStatus,
  type FinancialReadiness,
  type Prisma,
  type PrismaClient,
  ProviderClarificationStatus,
  RevenueChecklistGroup,
  RevenueCloseoutState,
  RevenueDayBucket,
  type RevenueCase,
  RevenueStatus,
  RevenueWorkQueue,
  RoleName,
  TaskSourceType,
} from "@prisma/client";
import { DateTime } from "luxon";
import { createInboxAlert } from "./user-alert-inbox.js";

const TODAY_WINDOW_DAYS = 30;

export const BILLING_FIELD_KEYS = {
  collectionExpected: "billing.collection_expected",
  amountDueCents: "billing.amount_due_cents",
  amountCollectedCents: "billing.amount_collected_cents",
  collectionOutcome: "billing.collection_outcome",
  missedReason: "billing.missed_reason",
  trackingNote: "billing.tracking_note",
} as const;

export const CLINICIAN_CODING_KEYS = {
  diagnosisText: "coding.working_diagnosis_codes_text",
  procedureText: "coding.working_procedure_codes_text",
  documentationComplete: "coding.documentation_complete",
  note: "coding.note",
} as const;

export const CLINICIAN_DOCUMENTATION_ATTESTATION_KEYS = {
  note: "documentation.athena_attestation_note",
} as const;

export const CLINICIAN_DOCUMENTATION_KEYS = {
  chiefConcernSummary: "documentation.chief_concern_summary",
  assessmentSummary: "documentation.assessment_summary",
  planFollowUp: "documentation.plan_follow_up",
  ordersOrProcedures: "documentation.orders_or_procedures",
} as const;

export const CHECKIN_FINANCIAL_KEYS = {
  registrationVerified: "financial.registration_demographics_verified",
  contactInfoVerified: "financial.contact_info_verified",
  eligibilityChecked: "financial.eligibility_checked",
  eligibilityStatus: "financial.eligibility_status",
  coverageIssueFlag: "financial.coverage_issue_flag",
  benefitsSummary: "financial.benefits_summary",
  expectedCollectionIndicator: "financial.expected_collection_indicator",
  patientEstimateAmountCents: "financial.patient_estimate_amount_cents",
  expectedPosCollectionAmountCents: "financial.expected_pos_collection_amount_cents",
  estimateExplainedToPatient: "financial.estimate_explained_to_patient",
  primaryPayerName: "financial.primary_payer_name",
  primaryPlanName: "financial.primary_plan_name",
  secondaryPayerName: "financial.secondary_payer_name",
  financialClass: "financial.financial_class",
  outstandingPriorBalanceCents: "financial.outstanding_prior_balance_cents",
  priorAuthRequired: "financial.prior_auth_required",
  priorAuthStatus: "financial.prior_auth_status",
  priorAuthNumber: "financial.prior_auth_number",
  referralRequired: "financial.referral_required",
  referralStatus: "financial.referral_status",
} as const;

export const ROOMING_SERVICE_CAPTURE_KEY = "service.capture_items" as const;

export const DEFAULT_ATHENA_CHECKLIST = [
  { label: "Review coding summary", sortOrder: 10 },
  { label: "Open encounter in Athena", sortOrder: 20 },
  { label: "Confirm charge entry completed in Athena", sortOrder: 30 },
  { label: "Record Athena note / reference", sortOrder: 40 },
] as const;

export const DEFAULT_MISSED_COLLECTION_REASONS = [
  "patient declined",
  "forgot to ask",
  "amount not known",
  "eligibility/coverage issue",
  "payment method issue",
  "waived",
  "deferred/payment plan",
  "other",
] as const;

export const DEFAULT_PROVIDER_QUERY_TEMPLATES = [
  "Please clarify the final diagnosis and CPT selection for Athena handoff.",
  "Please confirm whether documentation supports the planned procedure code and modifiers.",
  "Please add the missing clinical detail revenue needs before Athena handoff.",
] as const;

export type RevenueChecklistDefaultItem = {
  label: string;
  sortOrder: number;
  required?: boolean;
};

export type RevenueServiceCatalogItem = {
  id: string;
  label: string;
  suggestedProcedureCode: string | null;
  expectedChargeCents: number | null;
  detailSchemaKey?: string | null;
  active: boolean;
  allowCustomNote?: boolean;
};

export type RevenueChargeScheduleItem = {
  code: string;
  amountCents: number;
  description: string | null;
  active: boolean;
};

export type RevenueReimbursementRuleItem = {
  id: string;
  payerName: string | null;
  financialClass: string | null;
  expectedPercent: number;
  active: boolean;
  note?: string | null;
};

export type RevenueEstimateDefaults = {
  defaultPatientEstimateCents: number;
  defaultPosCollectionPercent: number;
  explainEstimateByDefault: boolean;
};

export type RevenueServiceCaptureItem = {
  id: string;
  catalogItemId: string | null;
  label: string;
  sourceRole: string;
  sourceTaskId: string | null;
  quantity: number;
  note: string | null;
  performedAt: string | null;
  capturedByUserId: string | null;
  suggestedProcedureCode: string | null;
  expectedChargeCents: number | null;
  detailSchemaKey: string;
  detailJson: Record<string, unknown> | null;
  detailComplete: boolean;
};

export const DEFAULT_REVENUE_CHECKLIST_DEFAULTS: Record<string, RevenueChecklistDefaultItem[]> = {
  registration_demographics: [
    { label: "Registration / demographics verified", sortOrder: 10 },
    { label: "Contact info verified", sortOrder: 20 },
  ],
  eligibility_benefits: [
    { label: "Eligibility checked", sortOrder: 10 },
    { label: "Payer / plan snapshot confirmed", sortOrder: 20 },
    { label: "Benefits summary captured", sortOrder: 30 },
  ],
  patient_estimate_pos: [
    { label: "Patient estimate amount recorded", sortOrder: 10 },
    { label: "Expected POS collection amount recorded", sortOrder: 20 },
    { label: "Estimate explained to patient", sortOrder: 30 },
  ],
  referral_prior_auth: [
    { label: "Prior auth addressed", sortOrder: 10 },
    { label: "Referral addressed", sortOrder: 20 },
  ],
  checkout_tracking: [
    { label: "Amount due recorded", sortOrder: 10 },
    { label: "Collection outcome recorded", sortOrder: 20 },
    { label: "Missed reason recorded when needed", sortOrder: 30 },
    { label: "Follow-up ownership captured if not fully collected", sortOrder: 40 },
  ],
  encounter_documentation: [
    { label: "Documentation completed in Athena", sortOrder: 10 },
    { label: "Documentation attestation note recorded", sortOrder: 20, required: false },
  ],
  charge_capture_coding: [
    { label: "MA service capture complete", sortOrder: 10 },
    { label: "Clinician working codes entered", sortOrder: 20 },
    { label: "Final diagnosis / procedure set verified", sortOrder: 30 },
  ],
  athena_handoff_attestation: DEFAULT_ATHENA_CHECKLIST.map((item) => ({ ...item })),
  day_close: [
    { label: "Unfinished work routed with owner, next action, and due date", sortOrder: 10 },
  ],
};

export const DEFAULT_SERVICE_CATALOG: RevenueServiceCatalogItem[] = [
  { id: "svc-venipuncture", label: "Venipuncture", suggestedProcedureCode: "36415", expectedChargeCents: 1800, detailSchemaKey: "specimen_collection", active: true },
  { id: "svc-ekg", label: "EKG", suggestedProcedureCode: "93000", expectedChargeCents: 9500, detailSchemaKey: "procedure_performed", active: true },
  { id: "svc-injection", label: "Injection administration", suggestedProcedureCode: "96372", expectedChargeCents: 4200, detailSchemaKey: "injection_medication", active: true },
  { id: "svc-nebulizer", label: "Nebulizer treatment", suggestedProcedureCode: "94640", expectedChargeCents: 6700, detailSchemaKey: "procedure_performed", active: true },
  { id: "svc-spirometry", label: "Spirometry", suggestedProcedureCode: "94010", expectedChargeCents: 7900, detailSchemaKey: "procedure_performed", active: true },
  { id: "svc-urinalysis", label: "Urinalysis", suggestedProcedureCode: "81002", expectedChargeCents: 1600, detailSchemaKey: "point_of_care_test", active: true },
  { id: "svc-rapid-strep", label: "Rapid strep test", suggestedProcedureCode: "87880", expectedChargeCents: 2800, detailSchemaKey: "point_of_care_test", active: true },
  { id: "svc-covid-pcr", label: "COVID PCR test", suggestedProcedureCode: "87635", expectedChargeCents: 5100, detailSchemaKey: "point_of_care_test", active: true },
  { id: "svc-wound-care", label: "Simple wound repair", suggestedProcedureCode: "12001", expectedChargeCents: 12500, detailSchemaKey: "procedure_performed", active: true },
  { id: "svc-vaccine", label: "Vaccine administration", suggestedProcedureCode: "90471", expectedChargeCents: 3800, detailSchemaKey: "vaccine", active: true },
  { id: "svc-other", label: "Other service", suggestedProcedureCode: null, expectedChargeCents: null, detailSchemaKey: "generic_service", active: true, allowCustomNote: true },
];

export const DEFAULT_CHARGE_SCHEDULE: RevenueChargeScheduleItem[] = [
  { code: "99202", amountCents: 15600, description: "New patient office visit, straightforward", active: true },
  { code: "99203", amountCents: 22400, description: "New patient office visit, low complexity", active: true },
  { code: "99204", amountCents: 33800, description: "New patient office visit, moderate complexity", active: true },
  { code: "99205", amountCents: 43200, description: "New patient office visit, high complexity", active: true },
  { code: "99211", amountCents: 7100, description: "Established patient office visit, minimal", active: true },
  { code: "99212", amountCents: 9800, description: "Established patient office visit, straightforward", active: true },
  { code: "99213", amountCents: 14600, description: "Established patient office visit, low complexity", active: true },
  { code: "99214", amountCents: 21200, description: "Established patient office visit, moderate complexity", active: true },
  { code: "99215", amountCents: 29200, description: "Established patient office visit, high complexity", active: true },
  { code: "36415", amountCents: 1800, description: "Venipuncture", active: true },
  { code: "93000", amountCents: 9500, description: "Electrocardiogram", active: true },
  { code: "96372", amountCents: 4200, description: "Therapeutic injection administration", active: true },
  { code: "94640", amountCents: 6700, description: "Inhalation treatment", active: true },
  { code: "94010", amountCents: 7900, description: "Spirometry", active: true },
  { code: "81002", amountCents: 1600, description: "Urinalysis, dip stick or tablet reagent", active: true },
  { code: "87880", amountCents: 2800, description: "Rapid streptococcus antigen detection", active: true },
  { code: "87635", amountCents: 5100, description: "SARS-CoV-2 amplified probe technique", active: true },
  { code: "J1100", amountCents: 500, description: "Dexamethasone sodium phosphate, 1 mg", active: true },
  { code: "12001", amountCents: 12500, description: "Simple repair superficial wounds", active: true },
];

export const DEFAULT_REVENUE_SETTINGS = {
  missedCollectionReasons: [...DEFAULT_MISSED_COLLECTION_REASONS],
  queueSla: {
    FinancialReadiness: 60,
    CheckoutTracking: 60,
    ChargeCapture: 240,
    ProviderQueries: 240,
    AthenaHandoff: 120,
  },
  dayCloseDefaults: {
    defaultDueHours: 24,
    requireNextAction: true,
  },
  estimateDefaults: {
    defaultPatientEstimateCents: 0,
    defaultPosCollectionPercent: 100,
    explainEstimateByDefault: true,
  },
  providerQueryTemplates: [...DEFAULT_PROVIDER_QUERY_TEMPLATES],
  athenaLinkTemplate: "",
  athenaChecklistDefaults: DEFAULT_ATHENA_CHECKLIST.map((item) => ({ ...item })),
  checklistDefaults: Object.fromEntries(
    Object.entries(DEFAULT_REVENUE_CHECKLIST_DEFAULTS).map(([key, rows]) => [key, rows.map((item) => ({ ...item }))]),
  ),
  serviceCatalog: DEFAULT_SERVICE_CATALOG.map((item) => ({ ...item })),
  chargeSchedule: DEFAULT_CHARGE_SCHEDULE.map((item) => ({ ...item })),
  reimbursementRules: [
    { id: "rule-commercial", payerName: null, financialClass: "Commercial", expectedPercent: 62, active: true, note: "Default commercial projection" },
    { id: "rule-medicare", payerName: null, financialClass: "Medicare", expectedPercent: 58, active: true, note: "Default Medicare projection" },
    { id: "rule-medicaid", payerName: null, financialClass: "Medicaid", expectedPercent: 45, active: true, note: "Default Medicaid projection" },
    { id: "rule-selfpay", payerName: null, financialClass: "SelfPay", expectedPercent: 35, active: true, note: "Default self-pay projection" },
  ] satisfies RevenueReimbursementRuleItem[],
} as const;

export type RevenueProcedureLine = {
  lineId: string;
  cptCode: string;
  modifiers: string[];
  units: number;
  diagnosisPointers: number[];
};

export type RevenueDocumentationSummary = {
  chiefConcernSummary: string | null;
  assessmentSummary: string | null;
  planFollowUp: string | null;
  ordersOrProcedures: string | null;
};

export type RevenueDocumentationAttestation = {
  completedInAthena: boolean;
  attestationNote: string | null;
};

export type RevenueExpectationSummary = {
  expectedGrossChargeCents: number;
  expectedNetReimbursementCents: number;
  missingChargeMapping: boolean;
  missingChargeMappingCount: number;
  missingReimbursementMapping: boolean;
  missingReimbursementMappingCount: number;
  serviceCaptureCompleted: boolean;
  clinicianCodingEntered: boolean;
  chargeCaptureReady: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const raw = value.trim().toLowerCase();
    if (["true", "yes", "y", "1", "checked", "complete", "completed", "full"].includes(raw)) return true;
    if (["false", "no", "n", "0", "unchecked", "pending", "none"].includes(raw)) return false;
  }
  return null;
}

function asInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value === "string") {
    const cleaned = value.replace(/[$,]/g, "").trim();
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed)) return Math.round(parsed);
  }
  return null;
}

function currencyToCents(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.abs(value) >= 1000 ? Math.round(value) : Math.round(value * 100);
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/[$,]/g, "").trim();
    if (!cleaned) return 0;
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed)) return 0;
    return Math.round(parsed * 100);
  }
  return 0;
}

function splitCodes(raw: string | null) {
  if (!raw) return [] as string[];
  return raw
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function toRequirementStatus(value: string | null, required: boolean): FinancialRequirementStatus {
  if (!required) return FinancialRequirementStatus.NotRequired;
  const normalized = (value || "").trim().toLowerCase();
  switch (normalized) {
    case "approved":
    case "complete":
    case "completed":
      return FinancialRequirementStatus.Approved;
    case "expired":
      return FinancialRequirementStatus.Expired;
    case "unabletoobtain":
    case "unable_to_obtain":
    case "unable to obtain":
      return FinancialRequirementStatus.UnableToObtain;
    case "pending":
    case "requested":
    case "in progress":
    default:
      return FinancialRequirementStatus.Pending;
  }
}

function isRequirementSatisfied(status: FinancialRequirementStatus, required: boolean) {
  if (!required || status === FinancialRequirementStatus.NotRequired) return true;
  return status === FinancialRequirementStatus.Approved;
}

function normalizeProcedureLineIndex(index: number) {
  return `line-${index + 1}`;
}

function normalizeProcedureLines(params: {
  diagnoses: string[];
  procedureLines?: unknown;
  cptCodes?: unknown;
  modifiers?: unknown;
  units?: unknown;
}) {
  const diagnosisPointers = params.diagnoses.length > 0 ? [1] : [];
  const normalizedFromLines = Array.isArray(params.procedureLines)
    ? params.procedureLines
        .map((entry, index) => {
          const source = asRecord(entry);
          const cptCode = asString(source.cptCode) || "";
          if (!cptCode) return null;
          const modifiers = Array.isArray(source.modifiers)
            ? uniqueStrings(source.modifiers.map((value) => asString(value)).filter((value): value is string => Boolean(value)))
            : [];
          const units = Math.max(1, asInt(source.units) || 1);
          const rawPointers = Array.isArray(source.diagnosisPointers)
            ? source.diagnosisPointers.map((value) => asInt(value)).filter((value): value is number => Boolean(value && value > 0))
            : diagnosisPointers;
          return {
            lineId: asString(source.lineId) || normalizeProcedureLineIndex(index),
            cptCode,
            modifiers,
            units,
            diagnosisPointers: rawPointers.length > 0 ? uniqueStrings(rawPointers.map(String)).map(Number) : diagnosisPointers,
          } satisfies RevenueProcedureLine;
        })
        .filter((entry): entry is RevenueProcedureLine => Boolean(entry))
    : [];

  if (normalizedFromLines.length > 0) return normalizedFromLines;

  const cptCodes = Array.isArray(params.cptCodes)
    ? params.cptCodes.map((value) => asString(value)).filter((value): value is string => Boolean(value))
    : [];
  const modifiers = Array.isArray(params.modifiers)
    ? params.modifiers.map((value) => asString(value)).filter((value): value is string => Boolean(value))
    : [];
  const units = Array.isArray(params.units)
    ? params.units.map((value) => Math.max(1, asInt(value) || 1))
    : [];

  return cptCodes.map((cptCode, index) => ({
    lineId: normalizeProcedureLineIndex(index),
    cptCode,
    modifiers: modifiers[index] ? uniqueStrings(modifiers[index].split(/[,\s]+/).map((entry) => entry.trim()).filter(Boolean)) : [],
    units: units[index] || 1,
    diagnosisPointers,
  }));
}

function buildLegacyCodingArrays(lines: RevenueProcedureLine[]) {
  return {
    cptCodes: lines.map((line) => line.cptCode),
    modifiers: lines.map((line) => line.modifiers.join(",")),
    units: lines.map((line) => String(line.units)),
  };
}

function parseChecklistDefaultRows(
  value: Prisma.JsonValue | null | undefined,
  fallback: readonly RevenueChecklistDefaultItem[],
) {
  if (!Array.isArray(value)) return fallback.map((item) => ({ ...item }));
  const parsed: RevenueChecklistDefaultItem[] = [];
  value.forEach((entry) => {
    const source = asRecord(entry);
    const label = asString(source.label);
    if (!label) return;
    parsed.push({
      label,
      sortOrder: Math.max(0, asInt(source.sortOrder) ?? 0),
      required: asBoolean(source.required) ?? true,
    });
  });
  return parsed.length > 0 ? parsed : fallback.map((item) => ({ ...item }));
}

function parseChecklistDefaults(value: Prisma.JsonValue | null | undefined) {
  const source = asRecord(value);
  const legacyAliases: Record<string, string[]> = {
    registration_demographics: ["financial_readiness"],
    eligibility_benefits: ["financial_readiness"],
    patient_estimate_pos: ["financial_readiness"],
    referral_prior_auth: ["financial_readiness"],
    encounter_documentation: ["charge_capture"],
    charge_capture_coding: ["charge_capture"],
    athena_handoff_attestation: ["athena_handoff"],
    day_close: ["day_close"],
  };
  return Object.fromEntries(
    Object.entries(DEFAULT_REVENUE_CHECKLIST_DEFAULTS).map(([group, fallback]) => [
      group,
      parseChecklistDefaultRows(
        (source[group] ??
          legacyAliases[group]?.map((alias) => source[alias]).find((entry) => entry !== undefined)) as Prisma.JsonValue | null | undefined,
        fallback,
      ),
    ]),
  ) as Record<string, RevenueChecklistDefaultItem[]>;
}

function parseServiceCatalog(value: Prisma.JsonValue | null | undefined) {
  if (!Array.isArray(value)) return DEFAULT_SERVICE_CATALOG.map((item) => ({ ...item }));
  const parsed: RevenueServiceCatalogItem[] = [];
  value.forEach((entry, index) => {
    const source = asRecord(entry);
    const label = asString(source.label);
    if (!label) return;
    parsed.push({
      id: asString(source.id) || `service-catalog-${index + 1}`,
      label,
      suggestedProcedureCode: asString(source.suggestedProcedureCode),
      expectedChargeCents: asInt(source.expectedChargeCents),
      detailSchemaKey: normalizeServiceDetailSchemaKey(
        source.detailSchemaKey,
        asBoolean(source.allowCustomNote) ? "generic_service" : "procedure_performed",
      ),
      active: asBoolean(source.active) ?? true,
      allowCustomNote: asBoolean(source.allowCustomNote) ?? false,
    });
  });
  if (parsed.length === 0) return DEFAULT_SERVICE_CATALOG.map((item) => ({ ...item }));
  const seenIds = new Set(parsed.map((item) => item.id));
  const merged = [...parsed];
  DEFAULT_SERVICE_CATALOG.forEach((item) => {
    if (!seenIds.has(item.id)) merged.push({ ...item });
  });
  return merged;
}

function parseChargeSchedule(value: Prisma.JsonValue | null | undefined) {
  if (!Array.isArray(value)) return DEFAULT_CHARGE_SCHEDULE.map((item) => ({ ...item }));
  const parsed = value
    .map((entry) => {
      const source = asRecord(entry);
      const code = asString(source.code)?.toUpperCase() || null;
      const amountCents = asInt(source.amountCents);
      if (!code || amountCents === null || amountCents < 0) return null;
      return {
        code,
        amountCents,
        description: asString(source.description),
        active: asBoolean(source.active) ?? true,
      } satisfies RevenueChargeScheduleItem;
    })
    .filter((entry): entry is RevenueChargeScheduleItem => Boolean(entry));
  if (parsed.length === 0) return DEFAULT_CHARGE_SCHEDULE.map((item) => ({ ...item }));
  const seenCodes = new Set(parsed.map((item) => item.code.toUpperCase()));
  const merged = [...parsed];
  DEFAULT_CHARGE_SCHEDULE.forEach((item) => {
    if (!seenCodes.has(item.code.toUpperCase())) merged.push({ ...item });
  });
  return merged;
}

function parseEstimateDefaults(value: Prisma.JsonValue | null | undefined): RevenueEstimateDefaults {
  const source = asRecord(value);
  return {
    defaultPatientEstimateCents: Math.max(0, asInt(source.defaultPatientEstimateCents) ?? DEFAULT_REVENUE_SETTINGS.estimateDefaults.defaultPatientEstimateCents),
    defaultPosCollectionPercent: Math.max(0, Math.min(100, asInt(source.defaultPosCollectionPercent) ?? DEFAULT_REVENUE_SETTINGS.estimateDefaults.defaultPosCollectionPercent)),
    explainEstimateByDefault: asBoolean(source.explainEstimateByDefault) ?? DEFAULT_REVENUE_SETTINGS.estimateDefaults.explainEstimateByDefault,
  };
}

function parseReimbursementRules(value: Prisma.JsonValue | null | undefined) {
  if (!Array.isArray(value)) return DEFAULT_REVENUE_SETTINGS.reimbursementRules.map((item) => ({ ...item }));
  const parsed = value
    .map((entry, index) => {
      const source = asRecord(entry);
      const expectedPercent = asInt(source.expectedPercent);
      if (expectedPercent === null) return null;
      return {
        id: asString(source.id) || `rule-${index + 1}`,
        payerName: asString(source.payerName),
        financialClass: asString(source.financialClass),
        expectedPercent: Math.max(0, Math.min(100, expectedPercent)),
        active: asBoolean(source.active) ?? true,
        note: asString(source.note),
      } satisfies RevenueReimbursementRuleItem;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (parsed.length === 0) return DEFAULT_REVENUE_SETTINGS.reimbursementRules.map((item) => ({ ...item }));
  const seenIds = new Set(parsed.map((item) => item.id));
  const merged = [...parsed];
  DEFAULT_REVENUE_SETTINGS.reimbursementRules.forEach((item) => {
    if (!seenIds.has(item.id)) merged.push({ ...item });
  });
  return merged;
}

function buildServiceCatalogMap(serviceCatalog: RevenueServiceCatalogItem[]) {
  return new Map(serviceCatalog.map((item) => [item.id, item]));
}

function buildChargeScheduleMap(chargeSchedule: RevenueChargeScheduleItem[]) {
  return new Map(chargeSchedule.filter((item) => item.active).map((item) => [item.code.toUpperCase(), item]));
}

function buildDocumentationSummary(source: Record<string, unknown>): RevenueDocumentationSummary {
  return {
    chiefConcernSummary: asString(source[CLINICIAN_DOCUMENTATION_KEYS.chiefConcernSummary]),
    assessmentSummary: asString(source[CLINICIAN_DOCUMENTATION_KEYS.assessmentSummary]),
    planFollowUp: asString(source[CLINICIAN_DOCUMENTATION_KEYS.planFollowUp]),
    ordersOrProcedures: asString(source[CLINICIAN_DOCUMENTATION_KEYS.ordersOrProcedures]),
  };
}

function documentationSummaryComplete(summary: RevenueDocumentationSummary) {
  return Boolean(
    summary.chiefConcernSummary &&
      summary.assessmentSummary &&
      summary.planFollowUp &&
      summary.ordersOrProcedures,
  );
}

function buildDocumentationAttestation(source: Record<string, unknown>): RevenueDocumentationAttestation {
  return {
    completedInAthena: asBoolean(source[CLINICIAN_CODING_KEYS.documentationComplete]) ?? false,
    attestationNote: asString(source[CLINICIAN_DOCUMENTATION_ATTESTATION_KEYS.note]),
  };
}

function normalizeServiceDetailSchemaKey(value: unknown, fallback = "generic_service") {
  const raw = asString(value)?.trim().toLowerCase();
  const allowed = new Set([
    "vaccine",
    "injection_medication",
    "point_of_care_test",
    "specimen_collection",
    "procedure_performed",
    "generic_service",
  ]);
  return raw && allowed.has(raw) ? raw : fallback;
}

function isNonEmptyValue(value: unknown) {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

function areServiceDetailFieldsComplete(detail: Record<string, unknown>, requiredKeys: string[]) {
  return requiredKeys.every((key) => isNonEmptyValue(detail[key]));
}

export function isServiceCaptureDetailComplete(item: {
  label?: string | null;
  note?: string | null;
  detailSchemaKey?: string | null;
  detailJson?: Record<string, unknown> | null;
}) {
  const schemaKey = normalizeServiceDetailSchemaKey(item.detailSchemaKey);
  const detail = item.detailJson && typeof item.detailJson === "object" && !Array.isArray(item.detailJson)
    ? item.detailJson
    : {};
  switch (schemaKey) {
    case "vaccine":
      return areServiceDetailFieldsComplete(detail, ["productLabel", "site", "route", "lotNumber", "expirationDate", "dose"]);
    case "injection_medication":
      return areServiceDetailFieldsComplete(detail, ["medicationLabel", "dose", "doseUnit", "route", "site", "lotNumber", "expirationDate"]);
    case "point_of_care_test":
      return areServiceDetailFieldsComplete(detail, ["testName", "specimenSource", "result"]);
    case "specimen_collection":
      return areServiceDetailFieldsComplete(detail, ["specimenType", "collectionMethod"]);
    case "procedure_performed":
      return areServiceDetailFieldsComplete(detail, ["procedureSummary"]);
    case "generic_service":
    default:
      return Boolean((item.note || "").trim() || Object.values(detail).some((value) => isNonEmptyValue(value)));
  }
}

export function serviceCaptureItemsAreComplete(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((entry) => {
    const source = asRecord(entry);
    const label = asString(source.label) || asString(source.name);
    if (!label) return false;
    const detailJson = asRecord(source.detailJson);
    return isServiceCaptureDetailComplete({
      label,
      note: asString(source.note),
      detailSchemaKey: asString(source.detailSchemaKey),
      detailJson,
    });
  });
}

function matchReimbursementRule(
  rules: RevenueReimbursementRuleItem[],
  params: { payerName?: string | null; financialClass?: string | null },
) {
  const activeRules = rules.filter((item) => item.active !== false);
  const payerName = params.payerName?.trim().toLowerCase() || "";
  const financialClass = params.financialClass?.trim().toLowerCase() || "";
  return (
    activeRules.find(
      (item) =>
        (item.payerName?.trim().toLowerCase() || "") === payerName &&
        (item.financialClass?.trim().toLowerCase() || "") === financialClass,
    ) ||
    activeRules.find(
      (item) =>
        !item.payerName &&
        Boolean(item.financialClass) &&
        item.financialClass!.trim().toLowerCase() === financialClass,
    ) ||
    activeRules.find(
      (item) =>
        Boolean(item.payerName) &&
        item.payerName!.trim().toLowerCase() === payerName &&
        !item.financialClass,
    ) ||
    null
  );
}

function normalizeServiceCaptureItems(
  value: unknown,
  serviceCatalog: RevenueServiceCatalogItem[],
): RevenueServiceCaptureItem[] {
  if (!Array.isArray(value)) return [];
  const catalogById = buildServiceCatalogMap(serviceCatalog);
  return value
    .map((entry, index) => {
      const source = asRecord(entry);
      const catalogItemId = asString(source.catalogItemId);
      const catalogItem = catalogItemId ? catalogById.get(catalogItemId) : null;
      const label = asString(source.label) || catalogItem?.label || asString(source.name);
      if (!label) return null;
      const detailJson = asRecord(source.detailJson);
      const detailSchemaKey = normalizeServiceDetailSchemaKey(
        source.detailSchemaKey,
        catalogItem?.detailSchemaKey || (catalogItem?.allowCustomNote ? "generic_service" : "procedure_performed"),
      );
      return {
        id: asString(source.id) || `service-item-${index + 1}`,
        catalogItemId,
        label,
        sourceRole: asString(source.sourceRole) || RoleName.MA,
        sourceTaskId: asString(source.sourceTaskId),
        quantity: Math.max(1, asInt(source.quantity) || 1),
        note: asString(source.note),
        performedAt: asString(source.performedAt),
        capturedByUserId: asString(source.capturedByUserId),
        suggestedProcedureCode: asString(source.suggestedProcedureCode) || catalogItem?.suggestedProcedureCode || null,
        expectedChargeCents: asInt(source.expectedChargeCents) ?? catalogItem?.expectedChargeCents ?? null,
        detailSchemaKey,
        detailJson: Object.keys(detailJson).length > 0 ? detailJson : null,
        detailComplete:
          asBoolean(source.detailComplete) ??
          isServiceCaptureDetailComplete({
            label,
            note: asString(source.note),
            detailSchemaKey,
            detailJson,
          }),
      } satisfies RevenueServiceCaptureItem;
    })
    .filter((entry): entry is RevenueServiceCaptureItem => Boolean(entry));
}

export function buildRevenueExpectationSummary(params: {
  chargeCapture: {
    documentationComplete: boolean;
    icd10CodesJson: string[];
    procedureLinesJson: RevenueProcedureLine[];
    serviceCaptureItemsJson?: RevenueServiceCaptureItem[];
  };
  chargeSchedule: RevenueChargeScheduleItem[];
  reimbursementRules?: RevenueReimbursementRuleItem[];
  financialReadiness?: {
    primaryPayerName?: string | null;
    financialClass?: string | null;
  } | null;
}) {
  const scheduleByCode = buildChargeScheduleMap(params.chargeSchedule);
  const serviceItems = params.chargeCapture.serviceCaptureItemsJson || [];
  const clinicianCodingEntered =
    params.chargeCapture.icd10CodesJson.length > 0 || params.chargeCapture.procedureLinesJson.length > 0;
  const serviceCaptureCompleted = serviceItems.length > 0 && serviceItems.every((item) => item.detailComplete !== false);
  const chargeCaptureReady =
    serviceCaptureCompleted &&
    params.chargeCapture.documentationComplete &&
    params.chargeCapture.icd10CodesJson.length > 0 &&
    params.chargeCapture.procedureLinesJson.length > 0;

  let expectedGrossChargeCents = 0;
  let missingChargeMappingCount = 0;
  let expectedNetReimbursementCents = 0;
  let missingReimbursementMappingCount = 0;
  if (params.chargeCapture.procedureLinesJson.length > 0) {
    params.chargeCapture.procedureLinesJson.forEach((line) => {
      const scheduleRow = scheduleByCode.get(line.cptCode.toUpperCase());
      if (!scheduleRow) {
        missingChargeMappingCount += 1;
        return;
      }
      expectedGrossChargeCents += scheduleRow.amountCents * Math.max(1, line.units || 1);
    });
  } else if (serviceItems.length > 0) {
    serviceItems.forEach((item) => {
      if (item.expectedChargeCents === null || item.expectedChargeCents === undefined) {
        missingChargeMappingCount += 1;
        return;
      }
      expectedGrossChargeCents += item.expectedChargeCents * Math.max(1, item.quantity || 1);
    });
  }

  if (expectedGrossChargeCents > 0) {
    const reimbursementRule = matchReimbursementRule(params.reimbursementRules || [], {
      payerName: params.financialReadiness?.primaryPayerName,
      financialClass: params.financialReadiness?.financialClass,
    });
    if (reimbursementRule) {
      expectedNetReimbursementCents = Math.round(expectedGrossChargeCents * (reimbursementRule.expectedPercent / 100));
    } else {
      missingReimbursementMappingCount = 1;
    }
  }

  return {
    expectedGrossChargeCents,
    expectedNetReimbursementCents,
    missingChargeMapping: missingChargeMappingCount > 0,
    missingChargeMappingCount,
    missingReimbursementMapping: missingReimbursementMappingCount > 0,
    missingReimbursementMappingCount,
    serviceCaptureCompleted,
    clinicianCodingEntered,
    chargeCaptureReady,
  } satisfies RevenueExpectationSummary;
}

export function normalizeChargeCaptureInput(input: {
  documentationComplete?: boolean;
  codingStage?: CodingStage;
  icd10Codes?: string[];
  procedureLines?: Array<Partial<RevenueProcedureLine> & Pick<RevenueProcedureLine, "cptCode">>;
  cptCodes?: string[];
  modifiers?: string[];
  units?: string[];
  codingNote?: string | null;
}) {
  const diagnoses = uniqueStrings((input.icd10Codes || []).map((entry) => entry.trim()).filter(Boolean));
  const procedureLines = normalizeProcedureLines({
    diagnoses,
    procedureLines: input.procedureLines,
    cptCodes: input.cptCodes,
    modifiers: input.modifiers,
    units: input.units,
  });
  const legacy = buildLegacyCodingArrays(procedureLines);
  const documentationComplete = Boolean(input.documentationComplete);
  const inferredCodingStage =
    diagnoses.length > 0 && procedureLines.length > 0
      ? documentationComplete
        ? CodingStage.ReadyForAthena
        : CodingStage.ReadyForReview
      : input.codingNote
        ? CodingStage.InProgress
        : CodingStage.NotStarted;

  return {
    documentationComplete,
    codingStage: input.codingStage || inferredCodingStage,
    icd10CodesJson: diagnoses,
    procedureLinesJson: procedureLines,
    cptCodesJson: legacy.cptCodes,
    modifiersJson: legacy.modifiers,
    unitsJson: legacy.units,
    codingNote: input.codingNote || null,
  };
}

function collectionOutcomeNeedsMissedReason(outcome: CollectionOutcome | null | undefined) {
  return outcome === CollectionOutcome.CollectedPartial
    || outcome === CollectionOutcome.NotCollected
    || outcome === CollectionOutcome.Deferred;
}

function toEligibilityStatus(value: string | null, insuranceVerified: boolean): FinancialEligibilityStatus {
  const normalized = (value || "").trim().toLowerCase();
  if (insuranceVerified || normalized === "clear" || normalized === "verified" || normalized === "eligible") {
    return FinancialEligibilityStatus.Clear;
  }
  if (normalized === "blocked" || normalized === "failed" || normalized === "denied") {
    return FinancialEligibilityStatus.Blocked;
  }
  if (normalized === "pending" || normalized === "review") {
    return FinancialEligibilityStatus.Pending;
  }
  return FinancialEligibilityStatus.NotChecked;
}

function toCollectionOutcome(value: string | null): CollectionOutcome | null {
  const normalized = (value || "").trim().toLowerCase();
  switch (normalized) {
    case "collectedinfull":
    case "collected_in_full":
    case "collected in full":
    case "full":
      return CollectionOutcome.CollectedInFull;
    case "collectedpartial":
    case "collected_partial":
    case "collected partial":
    case "partial":
      return CollectionOutcome.CollectedPartial;
    case "notcollected":
    case "not_collected":
    case "not collected":
      return CollectionOutcome.NotCollected;
    case "nocollectionexpected":
    case "no_collection_expected":
    case "no collection expected":
      return CollectionOutcome.NoCollectionExpected;
    case "waived":
      return CollectionOutcome.Waived;
    case "deferred":
      return CollectionOutcome.Deferred;
    default:
      return null;
  }
}

function getDateKey(date: Date, timezone: string) {
  return DateTime.fromJSDate(date, { zone: "utc" }).setZone(timezone).toISODate() || "";
}

function todayDateKey(timezone: string) {
  return DateTime.now().setZone(timezone).toISODate() || "";
}

function parseCheckoutTracking(encounter: {
  checkoutData: Prisma.JsonValue | null;
  checkoutCompleteAt: Date | null;
}) {
  const source = asRecord(encounter.checkoutData);
  const legacyCollected =
    asBoolean(source["Copay / Balance Collected"]) ??
    asBoolean(source["Insurance Copay Collected"]);
  const legacyAmount = source["Copay Amount"];

  const amountDueCents = currencyToCents(source[BILLING_FIELD_KEYS.amountDueCents] ?? legacyAmount);
  let amountCollectedCents = currencyToCents(source[BILLING_FIELD_KEYS.amountCollectedCents]);
  const collectionExpected =
    asBoolean(source[BILLING_FIELD_KEYS.collectionExpected]) ??
    (amountDueCents > 0 ? true : legacyCollected === true ? true : false);

  let outcome = toCollectionOutcome(asString(source[BILLING_FIELD_KEYS.collectionOutcome]));
  if (!outcome && legacyCollected === true) {
    outcome = CollectionOutcome.CollectedInFull;
  }
  if (!outcome && encounter.checkoutCompleteAt && collectionExpected && amountDueCents > 0) {
    outcome = CollectionOutcome.NotCollected;
  }
  if (!outcome && encounter.checkoutCompleteAt && !collectionExpected) {
    outcome = CollectionOutcome.NoCollectionExpected;
  }
  if (outcome === CollectionOutcome.CollectedInFull && amountCollectedCents === 0 && amountDueCents > 0) {
    amountCollectedCents = amountDueCents;
  }
  if (outcome === CollectionOutcome.CollectedPartial && amountCollectedCents === 0 && amountDueCents > 0) {
    amountCollectedCents = Math.floor(amountDueCents / 2);
  }

  return {
    collectionExpected,
    amountDueCents,
    amountCollectedCents,
    collectionOutcome: outcome,
    missedCollectionReason: asString(source[BILLING_FIELD_KEYS.missedReason]),
    trackingNote: asString(source[BILLING_FIELD_KEYS.trackingNote] ?? source["billing.collection_note"]),
    sourceFieldJson: source,
  };
}

function parseFinancialReadiness(encounter: {
  intakeData: Prisma.JsonValue | null;
  insuranceVerified: boolean;
}, estimateDefaults: RevenueEstimateDefaults = DEFAULT_REVENUE_SETTINGS.estimateDefaults) {
  const source = asRecord(encounter.intakeData);
  const rawEligibilityStatus = asString(source[CHECKIN_FINANCIAL_KEYS.eligibilityStatus]);
  const eligibilityChecked = asBoolean(source[CHECKIN_FINANCIAL_KEYS.eligibilityChecked]);
  const coverageIssueFlag = asBoolean(source[CHECKIN_FINANCIAL_KEYS.coverageIssueFlag]) === true;
  const expectedCollectionIndicator = asBoolean(source[CHECKIN_FINANCIAL_KEYS.expectedCollectionIndicator]);
  const registrationVerified = asBoolean(source[CHECKIN_FINANCIAL_KEYS.registrationVerified]) ?? false;
  const contactInfoVerified = asBoolean(source[CHECKIN_FINANCIAL_KEYS.contactInfoVerified]) ?? false;
  const referralRequired = asBoolean(source[CHECKIN_FINANCIAL_KEYS.referralRequired]) ?? false;
  const priorAuthRequired = asBoolean(source[CHECKIN_FINANCIAL_KEYS.priorAuthRequired]) ?? false;
  const referralStatus = toRequirementStatus(asString(source[CHECKIN_FINANCIAL_KEYS.referralStatus]), referralRequired);
  const priorAuthStatus = toRequirementStatus(asString(source[CHECKIN_FINANCIAL_KEYS.priorAuthStatus]), priorAuthRequired);
  const patientEstimateAmountCents =
    currencyToCents(source[CHECKIN_FINANCIAL_KEYS.patientEstimateAmountCents]) || estimateDefaults.defaultPatientEstimateCents;
  const pointOfServiceAmountDueCents =
    currencyToCents(source[CHECKIN_FINANCIAL_KEYS.expectedPosCollectionAmountCents] ?? source[BILLING_FIELD_KEYS.amountDueCents]) ||
    (expectedCollectionIndicator ? estimateDefaults.defaultPatientEstimateCents : 0);
  const estimateExplainedToPatient =
    asBoolean(source[CHECKIN_FINANCIAL_KEYS.estimateExplainedToPatient]) ?? estimateDefaults.explainEstimateByDefault;
  const hasExplicitReadinessSignal =
    encounter.insuranceVerified ||
    rawEligibilityStatus !== null ||
    eligibilityChecked !== null ||
    coverageIssueFlag ||
    expectedCollectionIndicator !== null ||
    referralRequired ||
    priorAuthRequired;

  let eligibilityStatus: FinancialEligibilityStatus;
  if (coverageIssueFlag) {
    eligibilityStatus = FinancialEligibilityStatus.Blocked;
  } else if (encounter.insuranceVerified) {
    eligibilityStatus = FinancialEligibilityStatus.Clear;
  } else if (rawEligibilityStatus) {
    eligibilityStatus = toEligibilityStatus(rawEligibilityStatus, false);
  } else if (eligibilityChecked === true) {
    eligibilityStatus = FinancialEligibilityStatus.Clear;
  } else if (!hasExplicitReadinessSignal) {
    // This MVP slice adds lightweight check-in revenue signals. If a case has
    // no explicit signal yet, keep the downstream revenue workflow moving.
    eligibilityStatus = FinancialEligibilityStatus.Clear;
  } else {
    eligibilityStatus = FinancialEligibilityStatus.NotChecked;
  }

  return {
    eligibilityStatus,
    registrationVerified,
    contactInfoVerified,
    primaryPayerName: asString(source[CHECKIN_FINANCIAL_KEYS.primaryPayerName]),
    primaryPlanName: asString(source[CHECKIN_FINANCIAL_KEYS.primaryPlanName]),
    secondaryPayerName: asString(source[CHECKIN_FINANCIAL_KEYS.secondaryPayerName]),
    financialClass: asString(source[CHECKIN_FINANCIAL_KEYS.financialClass]),
    benefitsSummaryText: asString(source[CHECKIN_FINANCIAL_KEYS.benefitsSummary]),
    coverageIssueCategory: coverageIssueFlag ? "coverage_issue" : null,
    coverageIssueText: coverageIssueFlag ? "Coverage issue flagged at check-in" : null,
    referralRequired,
    referralStatus,
    priorAuthRequired,
    priorAuthStatus,
    priorAuthNumber: asString(source[CHECKIN_FINANCIAL_KEYS.priorAuthNumber]),
    patientEstimateAmountCents,
    pointOfServiceAmountDueCents,
    estimateExplainedToPatient,
    outstandingPriorBalanceCents: currencyToCents(source[CHECKIN_FINANCIAL_KEYS.outstandingPriorBalanceCents]),
    notesJson: source,
  };
}

function parseChargeCapture(
  encounter: {
    clinicianData: Prisma.JsonValue | null;
    roomingData: Prisma.JsonValue | null;
  },
  serviceCatalog: RevenueServiceCatalogItem[],
) {
  const source = asRecord(encounter.clinicianData);
  const roomingSource = asRecord(encounter.roomingData);
  const diagnosisText = asString(source[CLINICIAN_CODING_KEYS.diagnosisText]);
  const procedureText = asString(source[CLINICIAN_CODING_KEYS.procedureText]);
  const documentationAttestation = buildDocumentationAttestation(source);
  const documentationComplete = documentationAttestation.completedInAthena;
  const codingNote = asString(source[CLINICIAN_CODING_KEYS.note]);
  const diagnoses = splitCodes(diagnosisText);
  const serviceCaptureItemsJson = normalizeServiceCaptureItems(roomingSource[ROOMING_SERVICE_CAPTURE_KEY], serviceCatalog);
  const documentationSummaryJson = buildDocumentationSummary(source);
  const procedureLines = normalizeProcedureLines({
    diagnoses,
    cptCodes: splitCodes(procedureText),
  });
  const legacyCodingArrays = buildLegacyCodingArrays(procedureLines);
  let codingStage: CodingStage = CodingStage.NotStarted;
  if (codingNote) codingStage = CodingStage.InProgress;
  if (diagnoses.length > 0 || procedureLines.length > 0) codingStage = CodingStage.ReadyForReview;
  if (documentationComplete && diagnoses.length > 0 && procedureLines.length > 0) codingStage = CodingStage.ReadyForAthena;
  return {
    documentationComplete,
    codingStage,
    icd10CodesJson: diagnoses,
    procedureLinesJson: procedureLines,
    serviceCaptureItemsJson,
    documentationSummaryJson,
    cptCodesJson: legacyCodingArrays.cptCodes,
    modifiersJson: legacyCodingArrays.modifiers,
    unitsJson: legacyCodingArrays.units,
    codingNote,
    documentationAttestation,
  };
}

function isCollectionTrackingComplete(input: {
  encounterStatus: EncounterStatus;
  checkoutCompleteAt: Date | null;
  collectionOutcome: CollectionOutcome | null;
  collectionExpected: boolean;
  missedCollectionReason: string | null;
}) {
  if (input.encounterStatus !== EncounterStatus.CheckOut && input.encounterStatus !== EncounterStatus.Optimized) {
    return false;
  }
  if (!input.collectionOutcome) return false;
  if (
    (input.collectionOutcome === CollectionOutcome.CollectedPartial ||
      input.collectionOutcome === CollectionOutcome.NotCollected ||
      input.collectionOutcome === CollectionOutcome.Deferred) &&
    !input.missedCollectionReason
  ) {
    return false;
  }
  return true;
}

function buildDayBucket(params: {
  dateOfService: Date;
  timezone: string;
  revenueStatus: RevenueStatus;
  rolledFromDateKey: string | null;
  closeoutState: RevenueCloseoutState | null;
}) {
  if (params.revenueStatus === RevenueStatus.MonitoringOnly || params.revenueStatus === RevenueStatus.Closed) {
    return RevenueDayBucket.Monitoring;
  }
  if (params.rolledFromDateKey || params.closeoutState === RevenueCloseoutState.RolledOver) return RevenueDayBucket.Rolled;

  const today = todayDateKey(params.timezone);
  const dosKey = getDateKey(params.dateOfService, params.timezone);
  if (dosKey === today) return RevenueDayBucket.Today;
  return RevenueDayBucket.Yesterday;
}

function buildPriority(params: {
  revenueStatus: RevenueStatus;
  dayBucket: RevenueDayBucket;
  openQueries: number;
  collectionOutcome: CollectionOutcome | null;
  missedCollectionReason: string | null;
}) {
  if (params.dayBucket === RevenueDayBucket.Rolled) return 1;
  if (params.revenueStatus === RevenueStatus.ProviderClarificationNeeded || params.openQueries > 0) return 1;
  if (
    params.revenueStatus === RevenueStatus.CheckoutTrackingNeeded &&
    params.collectionOutcome === CollectionOutcome.NotCollected &&
    !params.missedCollectionReason
  ) {
    return 1;
  }
  if (
    params.revenueStatus === RevenueStatus.ChargeCaptureNeeded ||
    params.revenueStatus === RevenueStatus.CodingReviewInProgress ||
    params.revenueStatus === RevenueStatus.ReadyForAthenaHandoff ||
    params.revenueStatus === RevenueStatus.AthenaHandoffInProgress
  ) {
    return 2;
  }
  return 3;
}

function buildDueAt(params: {
  timezone: string;
  encounter: { checkInAt: Date | null; providerEndAt: Date | null; checkoutCompleteAt: Date | null };
  revenueStatus: RevenueStatus;
  earliestQueryAt: Date | null;
  readyForAthenaAt: Date | null;
}) {
  let anchor = params.encounter.checkInAt || params.encounter.providerEndAt || params.encounter.checkoutCompleteAt || new Date();
  let plusHours = 8;
  if (params.revenueStatus === RevenueStatus.FinancialReadinessNeeded) {
    plusHours = 1;
  } else if (params.revenueStatus === RevenueStatus.CheckoutTrackingNeeded) {
    anchor = params.encounter.providerEndAt || params.encounter.checkoutCompleteAt || anchor;
    plusHours = 1;
  } else if (
    params.revenueStatus === RevenueStatus.ChargeCaptureNeeded ||
    params.revenueStatus === RevenueStatus.CodingReviewInProgress
  ) {
    anchor = params.encounter.providerEndAt || anchor;
    plusHours = 4;
  } else if (params.revenueStatus === RevenueStatus.ProviderClarificationNeeded) {
    anchor = params.earliestQueryAt || anchor;
    plusHours = 4;
  } else if (
    params.revenueStatus === RevenueStatus.ReadyForAthenaHandoff ||
    params.revenueStatus === RevenueStatus.AthenaHandoffInProgress
  ) {
    anchor = params.readyForAthenaAt || params.encounter.checkoutCompleteAt || anchor;
    plusHours = 2;
  }
  return DateTime.fromJSDate(anchor).setZone(params.timezone).plus({ hours: plusHours }).toUTC().toJSDate();
}

function computeCaseState(params: {
  encounter: {
    currentStatus: EncounterStatus;
    closedAt: Date | null;
    closureType: string | null;
    dateOfService: Date;
    clinic: { timezone: string };
    checkInAt: Date | null;
    providerEndAt: Date | null;
    checkoutCompleteAt: Date | null;
  };
  financialReadiness: Pick<
    FinancialReadiness,
    | "eligibilityStatus"
    | "registrationVerified"
    | "contactInfoVerified"
    | "primaryPayerName"
    | "primaryPlanName"
    | "secondaryPayerName"
    | "benefitsSummaryText"
    | "coverageIssueText"
    | "estimateExplainedToPatient"
    | "priorAuthRequired"
    | "priorAuthStatus"
    | "referralRequired"
    | "referralStatus"
  >;
  checkoutTracking: ReturnType<typeof parseCheckoutTracking>;
  chargeCapture: ReturnType<typeof parseChargeCapture> & { readyForAthenaAt?: Date | null };
  expectation: RevenueExpectationSummary;
  revenueCase: Pick<
    RevenueCase,
    | "rolledFromDateKey"
    | "athenaHandoffConfirmedAt"
    | "rollReason"
    | "closeoutState"
    | "athenaHandoffStartedAt"
    | "athenaHandoffOwnerUserId"
  > | null;
  athenaChecklistCompletedCount: number;
  openClarifications: number;
  earliestOpenQueryAt: Date | null;
}) {
  const payerSnapshotConfirmed = Boolean(
    params.financialReadiness.primaryPayerName ||
      params.financialReadiness.primaryPlanName ||
      params.financialReadiness.secondaryPayerName,
  );
  const benefitsCaptured = Boolean(params.financialReadiness.benefitsSummaryText || params.financialReadiness.coverageIssueText);
  const financialClear =
    params.financialReadiness.registrationVerified &&
    params.financialReadiness.contactInfoVerified &&
    payerSnapshotConfirmed &&
    benefitsCaptured &&
    params.financialReadiness.eligibilityStatus === FinancialEligibilityStatus.Clear &&
    params.financialReadiness.estimateExplainedToPatient &&
    isRequirementSatisfied(params.financialReadiness.priorAuthStatus, params.financialReadiness.priorAuthRequired) &&
    isRequirementSatisfied(params.financialReadiness.referralStatus, params.financialReadiness.referralRequired);
  const checkoutComplete = isCollectionTrackingComplete({
    encounterStatus: params.encounter.currentStatus,
    checkoutCompleteAt: params.encounter.checkoutCompleteAt,
    collectionOutcome: params.checkoutTracking.collectionOutcome,
    collectionExpected: params.checkoutTracking.collectionExpected,
    missedCollectionReason: params.checkoutTracking.missedCollectionReason,
  });
  const chargeReady = params.expectation.chargeCaptureReady;
  const hasAthenaConfirmation = Boolean(params.revenueCase?.athenaHandoffConfirmedAt);
  let currentRevenueStatus: RevenueStatus = RevenueStatus.FinanciallyCleared;
  let currentWorkQueue: RevenueWorkQueue = RevenueWorkQueue.FinancialReadiness;
  let blockerCategory: string | null = null;
  let blockerText: string | null = null;

  if (params.encounter.closedAt && params.encounter.closureType) {
    currentRevenueStatus = RevenueStatus.Closed;
    currentWorkQueue = RevenueWorkQueue.Monitoring;
  } else if (!financialClear) {
    currentRevenueStatus = RevenueStatus.FinancialReadinessNeeded;
    currentWorkQueue = RevenueWorkQueue.FinancialReadiness;
    blockerCategory = "financial_readiness";
    blockerText =
      (!params.financialReadiness.registrationVerified
        ? "Registration and demographics are not yet verified in Flow."
        : !params.financialReadiness.contactInfoVerified
          ? "Contact information still needs to be verified in Flow."
          : !payerSnapshotConfirmed
            ? "Payer and plan snapshot still need to be captured in Flow."
            : !benefitsCaptured
              ? "Benefits summary or coverage issue detail still needs to be captured in Flow."
              : params.financialReadiness.coverageIssueText
                ? params.financialReadiness.coverageIssueText
                : !params.financialReadiness.estimateExplainedToPatient
                  ? "Patient estimate and expected point-of-service collection still need to be reviewed in Flow."
                  : params.financialReadiness.priorAuthRequired &&
      !isRequirementSatisfied(params.financialReadiness.priorAuthStatus, true)
                    ? "Prior authorization is still incomplete."
                    : params.financialReadiness.referralRequired &&
                        !isRequirementSatisfied(params.financialReadiness.referralStatus, true)
                      ? "Referral status is still incomplete."
                      : "Eligibility is not yet cleared.");
  } else if (
    (params.encounter.currentStatus === EncounterStatus.CheckOut ||
      params.encounter.currentStatus === EncounterStatus.Optimized) &&
    !checkoutComplete
  ) {
    currentRevenueStatus = RevenueStatus.CheckoutTrackingNeeded;
    currentWorkQueue = RevenueWorkQueue.CheckoutTracking;
    blockerCategory = "checkout_tracking";
    blockerText = "Collection outcome is incomplete or uncategorized.";
  } else if (params.openClarifications > 0) {
    currentRevenueStatus = RevenueStatus.ProviderClarificationNeeded;
    currentWorkQueue = RevenueWorkQueue.ProviderQueries;
    blockerCategory = "provider_clarification";
    blockerText = `${params.openClarifications} provider clarification${params.openClarifications === 1 ? "" : "s"} open.`;
  } else if (
    (params.encounter.currentStatus === EncounterStatus.CheckOut ||
      params.encounter.currentStatus === EncounterStatus.Optimized) &&
    !chargeReady
  ) {
    currentRevenueStatus =
      params.chargeCapture.codingStage === CodingStage.InProgress || params.chargeCapture.codingStage === CodingStage.ReadyForReview
        ? RevenueStatus.CodingReviewInProgress
        : RevenueStatus.ChargeCaptureNeeded;
    currentWorkQueue = RevenueWorkQueue.ChargeCapture;
    if (!params.expectation.serviceCaptureCompleted) {
      blockerCategory = "charge_capture";
      blockerText = "MA service capture details are incomplete for charge capture.";
    } else if (!params.expectation.clinicianCodingEntered) {
      blockerCategory = "charge_capture";
      blockerText = "Clinician working codes have not been entered yet.";
    } else if (!params.chargeCapture.documentationComplete) {
      blockerCategory = "documentation_incomplete";
      blockerText = "Clinician marked documentation incomplete. Revenue cannot fully close Athena handoff until documentation is complete.";
    } else {
      blockerCategory = "charge_capture";
      blockerText = "Final coding verification is still incomplete for Athena handoff.";
    }
  } else if (chargeReady && !hasAthenaConfirmation) {
    currentRevenueStatus =
      params.athenaChecklistCompletedCount > 0 || params.revenueCase?.athenaHandoffStartedAt || params.revenueCase?.athenaHandoffOwnerUserId
        ? RevenueStatus.AthenaHandoffInProgress
        : RevenueStatus.ReadyForAthenaHandoff;
    currentWorkQueue = RevenueWorkQueue.AthenaHandoff;
    blockerCategory = "athena_handoff";
    blockerText = params.expectation.missingChargeMapping
      ? `Athena handoff is pending and ${params.expectation.missingChargeMappingCount} charge mapping${params.expectation.missingChargeMappingCount === 1 ? " is" : "s are"} missing in Flow.`
      : params.expectation.missingReimbursementMapping
        ? "Athena handoff is pending and Flow projections still need reimbursement mapping for this payer or financial class."
        : "Athena handoff is not yet confirmed.";
  } else if (hasAthenaConfirmation) {
    currentRevenueStatus = RevenueStatus.MonitoringOnly;
    currentWorkQueue = RevenueWorkQueue.Monitoring;
  }

  const currentDayBucket = buildDayBucket({
    dateOfService: params.encounter.dateOfService,
    timezone: params.encounter.clinic.timezone,
    revenueStatus: currentRevenueStatus,
    rolledFromDateKey: params.revenueCase?.rolledFromDateKey || null,
    closeoutState: params.revenueCase?.closeoutState || null,
  });
  const priority = buildPriority({
    revenueStatus: currentRevenueStatus,
    dayBucket: currentDayBucket,
    openQueries: params.openClarifications,
    collectionOutcome: params.checkoutTracking.collectionOutcome,
    missedCollectionReason: params.checkoutTracking.missedCollectionReason,
  });
  const dueAt = buildDueAt({
    timezone: params.encounter.clinic.timezone,
    encounter: params.encounter,
    revenueStatus: currentRevenueStatus,
    earliestQueryAt: params.earliestOpenQueryAt,
    readyForAthenaAt: params.chargeCapture.readyForAthenaAt || null,
  });

  return {
    currentRevenueStatus,
    currentWorkQueue,
    currentDayBucket,
    priority,
    currentBlockerCategory: blockerCategory,
    currentBlockerText: blockerText,
    dueAt,
  };
}

function parseSettingsArray(value: Prisma.JsonValue | null | undefined, fallback: readonly string[]) {
  if (!Array.isArray(value)) return [...fallback];
  const parsed = value.map((entry) => asString(entry)).filter((entry): entry is string => Boolean(entry));
  return parsed.length > 0 ? parsed : [...fallback];
}

function parseAthenaChecklistDefaults(value: Prisma.JsonValue | null | undefined) {
  return parseChecklistDefaultRows(value, DEFAULT_ATHENA_CHECKLIST);
}

function isMissingRevenueSettingsSchemaError(error: unknown) {
  const code = String((error as { code?: unknown })?.code || "");
  const message = String((error as { message?: unknown })?.message || "").toLowerCase();
  return (
    code === "P2021" ||
    code === "P2022" ||
    message.includes("no such table") ||
    message.includes("no such column")
  );
}

function buildDefaultRevenueSettings(facilityId: string) {
  const checklistDefaults = parseChecklistDefaults(DEFAULT_REVENUE_SETTINGS.checklistDefaults as Prisma.JsonValue);
  const athenaChecklistDefaults = parseAthenaChecklistDefaults(
    DEFAULT_REVENUE_SETTINGS.athenaChecklistDefaults as Prisma.JsonValue,
  );
  checklistDefaults[RevenueChecklistGroup.athena_handoff_attestation] = athenaChecklistDefaults;

  return {
    facilityId,
    missedCollectionReasons: [...DEFAULT_MISSED_COLLECTION_REASONS],
    queueSla: { ...DEFAULT_REVENUE_SETTINGS.queueSla },
    dayCloseDefaults: { ...DEFAULT_REVENUE_SETTINGS.dayCloseDefaults },
    estimateDefaults: { ...DEFAULT_REVENUE_SETTINGS.estimateDefaults },
    providerQueryTemplates: [...DEFAULT_PROVIDER_QUERY_TEMPLATES],
    athenaLinkTemplate: DEFAULT_REVENUE_SETTINGS.athenaLinkTemplate || "",
    athenaChecklistDefaults,
    checklistDefaults,
    serviceCatalog: DEFAULT_REVENUE_SETTINGS.serviceCatalog.map((item) => ({ ...item })),
    chargeSchedule: DEFAULT_REVENUE_SETTINGS.chargeSchedule.map((item) => ({ ...item })),
    reimbursementRules: DEFAULT_REVENUE_SETTINGS.reimbursementRules.map((item) => ({ ...item })),
  };
}

export async function getRevenueSettings(db: PrismaClient | Prisma.TransactionClient, facilityId: string) {
  try {
    const settings = await db.revenueCycleSettings.upsert({
      where: { facilityId },
      create: {
        facilityId,
        missedCollectionReasonsJson: [...DEFAULT_REVENUE_SETTINGS.missedCollectionReasons] as Prisma.InputJsonValue,
        queueSlaJson: { ...DEFAULT_REVENUE_SETTINGS.queueSla } as Prisma.InputJsonValue,
        dayCloseDefaultsJson: { ...DEFAULT_REVENUE_SETTINGS.dayCloseDefaults } as Prisma.InputJsonValue,
        estimateDefaultsJson: { ...DEFAULT_REVENUE_SETTINGS.estimateDefaults } as Prisma.InputJsonValue,
        providerQueryTemplatesJson: [...DEFAULT_REVENUE_SETTINGS.providerQueryTemplates] as Prisma.InputJsonValue,
        athenaLinkTemplate: DEFAULT_REVENUE_SETTINGS.athenaLinkTemplate,
        athenaChecklistDefaultsJson: DEFAULT_REVENUE_SETTINGS.athenaChecklistDefaults as Prisma.InputJsonValue,
        checklistDefaultsJson: DEFAULT_REVENUE_SETTINGS.checklistDefaults as Prisma.InputJsonValue,
        serviceCatalogJson: DEFAULT_REVENUE_SETTINGS.serviceCatalog as Prisma.InputJsonValue,
        chargeScheduleJson: DEFAULT_REVENUE_SETTINGS.chargeSchedule as Prisma.InputJsonValue,
        reimbursementRulesJson: DEFAULT_REVENUE_SETTINGS.reimbursementRules as Prisma.InputJsonValue,
      },
      update: {},
    });

    const checklistDefaults = parseChecklistDefaults(settings.checklistDefaultsJson);
    const athenaChecklistDefaults = parseAthenaChecklistDefaults(settings.athenaChecklistDefaultsJson);
    checklistDefaults[RevenueChecklistGroup.athena_handoff_attestation] = athenaChecklistDefaults;

    return {
      facilityId: settings.facilityId,
      missedCollectionReasons: parseSettingsArray(settings.missedCollectionReasonsJson, DEFAULT_MISSED_COLLECTION_REASONS),
      queueSla: asRecord(settings.queueSlaJson),
      dayCloseDefaults: asRecord(settings.dayCloseDefaultsJson),
      estimateDefaults: parseEstimateDefaults(settings.estimateDefaultsJson),
      providerQueryTemplates: parseSettingsArray(settings.providerQueryTemplatesJson, DEFAULT_PROVIDER_QUERY_TEMPLATES),
      athenaLinkTemplate: settings.athenaLinkTemplate || "",
      athenaChecklistDefaults,
      checklistDefaults,
      serviceCatalog: parseServiceCatalog(settings.serviceCatalogJson),
      chargeSchedule: parseChargeSchedule(settings.chargeScheduleJson),
      reimbursementRules: parseReimbursementRules(settings.reimbursementRulesJson),
    };
  } catch (error) {
    if (isMissingRevenueSettingsSchemaError(error)) {
      return buildDefaultRevenueSettings(facilityId);
    }
    throw error;
  }
}

type RevenueEncounter = Prisma.EncounterGetPayload<{
  include: {
    clinic: { select: { id: true; facilityId: true; timezone: true; name: true; status: true; shortCode: true; cardColor: true } };
    provider: { select: { id: true; name: true; active: true } };
    reason: { select: { id: true; name: true; status: true } };
    room: { select: { id: true; name: true; status: true } };
    revenueCase: { include: { checklistItems: true; providerClarifications: true } };
  };
}>;

async function ensureAthenaChecklist(
  db: PrismaClient | Prisma.TransactionClient,
  revenueCaseId: string,
  checklistDefaults: ReadonlyArray<RevenueChecklistDefaultItem> = DEFAULT_ATHENA_CHECKLIST,
) {
  await ensureRevenueChecklistGroup(db, revenueCaseId, RevenueChecklistGroup.athena_handoff_attestation, checklistDefaults);
}

async function ensureRevenueChecklistGroup(
  db: PrismaClient | Prisma.TransactionClient,
  revenueCaseId: string,
  group: RevenueChecklistGroup,
  checklistDefaults: ReadonlyArray<RevenueChecklistDefaultItem>,
) {
  const existing = await db.revenueChecklistItem.findMany({
    where: {
      revenueCaseId,
      group,
    },
  });
  for (const item of checklistDefaults) {
    if (existing.find((entry) => entry.label === item.label && entry.group === group)) {
      continue;
    }
    await db.revenueChecklistItem.create({
      data: {
        revenueCaseId,
        group,
        label: item.label,
        required: item.required ?? true,
        sortOrder: item.sortOrder,
      },
    });
  }
}

async function ensureRevenueChecklistItems(
  db: PrismaClient | Prisma.TransactionClient,
  revenueCaseId: string,
  checklistDefaults: Record<string, RevenueChecklistDefaultItem[]>,
) {
  const supportedGroups: RevenueChecklistGroup[] = [
    RevenueChecklistGroup.registration_demographics,
    RevenueChecklistGroup.eligibility_benefits,
    RevenueChecklistGroup.patient_estimate_pos,
    RevenueChecklistGroup.referral_prior_auth,
    RevenueChecklistGroup.checkout_tracking,
    RevenueChecklistGroup.encounter_documentation,
    RevenueChecklistGroup.charge_capture_coding,
    RevenueChecklistGroup.athena_handoff_attestation,
    RevenueChecklistGroup.day_close,
  ];
  for (const group of supportedGroups) {
    await ensureRevenueChecklistGroup(db, revenueCaseId, group, checklistDefaults[group] || []);
  }
}

async function syncChecklistCompletion(
  db: PrismaClient | Prisma.TransactionClient,
  revenueCaseId: string,
  group: RevenueChecklistGroup,
  completions: Array<{ label: string; completed: boolean; evidenceText?: string | null }>,
) {
  const items = await db.revenueChecklistItem.findMany({
    where: { revenueCaseId, group },
  });
  for (const completion of completions) {
    const match = items.find((item) => item.label === completion.label);
    if (!match) continue;
    await db.revenueChecklistItem.update({
      where: { id: match.id },
      data: {
        status: completion.completed ? "completed" : "pending",
        completedAt: completion.completed ? match.completedAt || new Date() : null,
        completedByUserId: completion.completed ? match.completedByUserId || null : null,
        evidenceText: completion.completed ? completion.evidenceText || match.evidenceText || "Captured in Flow" : null,
      },
    });
  }
}

export async function syncRevenueCaseForEncounter(db: PrismaClient | Prisma.TransactionClient, encounterId: string) {
  const encounter = await db.encounter.findUnique({
    where: { id: encounterId },
    include: {
      clinic: { select: { id: true, facilityId: true, timezone: true, name: true, status: true, shortCode: true, cardColor: true } },
      provider: { select: { id: true, name: true, active: true } },
      reason: { select: { id: true, name: true, status: true } },
      room: { select: { id: true, name: true, status: true } },
      revenueCase: {
        include: {
          checklistItems: true,
          providerClarifications: true,
        },
      },
    },
  }) as RevenueEncounter | null;

  if (!encounter?.clinic?.facilityId) return null;

  const settings = await getRevenueSettings(db, encounter.clinic.facilityId);
  const financial = parseFinancialReadiness(encounter, settings.estimateDefaults);
  const checkoutTracking = parseCheckoutTracking(encounter);
  const chargeCapture = parseChargeCapture(encounter, settings.serviceCatalog);

  const upsertedCase = await db.revenueCase.upsert({
    where: { encounterId: encounter.id },
    create: {
      encounterId: encounter.id,
      facilityId: encounter.clinic.facilityId,
      clinicId: encounter.clinicId,
      patientId: encounter.patientId,
      providerId: encounter.providerId,
      dateOfService: encounter.dateOfService,
      assignedToRole: RoleName.RevenueCycle,
    },
    update: {
      facilityId: encounter.clinic.facilityId,
      clinicId: encounter.clinicId,
      patientId: encounter.patientId,
      providerId: encounter.providerId,
      dateOfService: encounter.dateOfService,
    },
  });

  await db.financialReadiness.upsert({
    where: { revenueCaseId: upsertedCase.id },
    create: {
      revenueCaseId: upsertedCase.id,
      eligibilityStatus: financial.eligibilityStatus,
      coverageIssueCategory: financial.coverageIssueCategory,
      coverageIssueText: financial.coverageIssueText,
      registrationVerified: financial.registrationVerified,
      contactInfoVerified: financial.contactInfoVerified,
      primaryPayerName: financial.primaryPayerName,
      primaryPlanName: financial.primaryPlanName,
      secondaryPayerName: financial.secondaryPayerName,
      financialClass: financial.financialClass,
      benefitsSummaryText: financial.benefitsSummaryText,
      patientEstimateAmountCents: financial.patientEstimateAmountCents,
      referralRequired: financial.referralRequired,
      referralStatus: financial.referralStatus,
      priorAuthRequired: financial.priorAuthRequired,
      priorAuthStatus: financial.priorAuthStatus,
      priorAuthNumber: financial.priorAuthNumber,
      pointOfServiceAmountDueCents: financial.pointOfServiceAmountDueCents,
      estimateExplainedToPatient: financial.estimateExplainedToPatient,
      outstandingPriorBalanceCents: financial.outstandingPriorBalanceCents,
      notesJson: financial.notesJson as Prisma.InputJsonValue,
      verifiedAt: encounter.insuranceVerified ? new Date() : null,
    },
    update: {
      eligibilityStatus: financial.eligibilityStatus,
      coverageIssueCategory: financial.coverageIssueCategory,
      coverageIssueText: financial.coverageIssueText,
      registrationVerified: financial.registrationVerified,
      contactInfoVerified: financial.contactInfoVerified,
      primaryPayerName: financial.primaryPayerName,
      primaryPlanName: financial.primaryPlanName,
      secondaryPayerName: financial.secondaryPayerName,
      financialClass: financial.financialClass,
      benefitsSummaryText: financial.benefitsSummaryText,
      patientEstimateAmountCents: financial.patientEstimateAmountCents,
      referralRequired: financial.referralRequired,
      referralStatus: financial.referralStatus,
      priorAuthRequired: financial.priorAuthRequired,
      priorAuthStatus: financial.priorAuthStatus,
      priorAuthNumber: financial.priorAuthNumber,
      pointOfServiceAmountDueCents: financial.pointOfServiceAmountDueCents,
      estimateExplainedToPatient: financial.estimateExplainedToPatient,
      outstandingPriorBalanceCents: financial.outstandingPriorBalanceCents,
      notesJson: financial.notesJson as Prisma.InputJsonValue,
      verifiedAt: encounter.insuranceVerified ? new Date() : null,
    },
  });

  await db.checkoutCollectionTracking.upsert({
    where: { revenueCaseId: upsertedCase.id },
    create: {
      revenueCaseId: upsertedCase.id,
      collectionExpected: checkoutTracking.collectionExpected,
      amountDueCents: checkoutTracking.amountDueCents,
      amountCollectedCents: checkoutTracking.amountCollectedCents,
      collectionOutcome: checkoutTracking.collectionOutcome,
      missedCollectionReason: checkoutTracking.missedCollectionReason,
      trackingNote: checkoutTracking.trackingNote,
      trackedAt: encounter.checkoutCompleteAt,
      sourceFieldJson: checkoutTracking.sourceFieldJson as Prisma.InputJsonValue,
    },
    update: {
      collectionExpected: checkoutTracking.collectionExpected,
      amountDueCents: checkoutTracking.amountDueCents,
      amountCollectedCents: checkoutTracking.amountCollectedCents,
      collectionOutcome: checkoutTracking.collectionOutcome,
      missedCollectionReason: checkoutTracking.missedCollectionReason,
      trackingNote: checkoutTracking.trackingNote,
      trackedAt: encounter.checkoutCompleteAt,
      sourceFieldJson: checkoutTracking.sourceFieldJson as Prisma.InputJsonValue,
    },
  });

  await db.chargeCaptureRecord.upsert({
    where: { revenueCaseId: upsertedCase.id },
    create: {
      revenueCaseId: upsertedCase.id,
      documentationComplete: chargeCapture.documentationComplete,
      codingStage: chargeCapture.codingStage,
      icd10CodesJson: chargeCapture.icd10CodesJson as Prisma.InputJsonValue,
      procedureLinesJson: chargeCapture.procedureLinesJson as Prisma.InputJsonValue,
      serviceCaptureItemsJson: chargeCapture.serviceCaptureItemsJson as Prisma.InputJsonValue,
      documentationSummaryJson: chargeCapture.documentationSummaryJson as Prisma.InputJsonValue,
      cptCodesJson: chargeCapture.cptCodesJson as Prisma.InputJsonValue,
      modifiersJson: chargeCapture.modifiersJson as Prisma.InputJsonValue,
      unitsJson: chargeCapture.unitsJson as Prisma.InputJsonValue,
      codingNote: chargeCapture.codingNote,
      readyForAthenaAt: chargeCapture.codingStage === CodingStage.ReadyForAthena ? new Date() : null,
    },
    update: {
      documentationComplete: chargeCapture.documentationComplete,
      codingStage: chargeCapture.codingStage,
      icd10CodesJson: chargeCapture.icd10CodesJson as Prisma.InputJsonValue,
      procedureLinesJson: chargeCapture.procedureLinesJson as Prisma.InputJsonValue,
      serviceCaptureItemsJson: chargeCapture.serviceCaptureItemsJson as Prisma.InputJsonValue,
      documentationSummaryJson: chargeCapture.documentationSummaryJson as Prisma.InputJsonValue,
      cptCodesJson: chargeCapture.cptCodesJson as Prisma.InputJsonValue,
      modifiersJson: chargeCapture.modifiersJson as Prisma.InputJsonValue,
      unitsJson: chargeCapture.unitsJson as Prisma.InputJsonValue,
      codingNote: chargeCapture.codingNote,
      readyForAthenaAt: chargeCapture.codingStage === CodingStage.ReadyForAthena ? new Date() : null,
    },
  });

  await ensureRevenueChecklistItems(db, upsertedCase.id, settings.checklistDefaults);

  const priorAuthAddressed = !financial.priorAuthRequired || isRequirementSatisfied(financial.priorAuthStatus, true);
  const referralAddressed = !financial.referralRequired || isRequirementSatisfied(financial.referralStatus, true);
  await syncChecklistCompletion(db, upsertedCase.id, RevenueChecklistGroup.registration_demographics, [
    {
      label: "Registration / demographics verified",
      completed: financial.registrationVerified,
      evidenceText: financial.registrationVerified ? "Registration and demographics verified in Flow" : null,
    },
    {
      label: "Contact info verified",
      completed: financial.contactInfoVerified,
      evidenceText: financial.contactInfoVerified ? "Contact info verified in Flow" : null,
    },
  ]);
  await syncChecklistCompletion(db, upsertedCase.id, RevenueChecklistGroup.eligibility_benefits, [
    {
      label: "Eligibility checked",
      completed: financial.eligibilityStatus !== FinancialEligibilityStatus.NotChecked,
      evidenceText: financial.eligibilityStatus !== FinancialEligibilityStatus.NotChecked ? `Eligibility marked ${financial.eligibilityStatus}` : null,
    },
    {
      label: "Payer / plan snapshot confirmed",
      completed: Boolean(financial.primaryPayerName || financial.primaryPlanName || financial.secondaryPayerName),
      evidenceText: financial.primaryPayerName || financial.primaryPlanName || financial.secondaryPayerName
        ? `${financial.primaryPayerName || "Payer"} / ${financial.primaryPlanName || "Plan"}`
        : null,
    },
    {
      label: "Benefits summary captured",
      completed: Boolean(financial.benefitsSummaryText || financial.coverageIssueText),
      evidenceText: financial.benefitsSummaryText || financial.coverageIssueText,
    },
  ]);
  await syncChecklistCompletion(db, upsertedCase.id, RevenueChecklistGroup.patient_estimate_pos, [
    {
      label: "Patient estimate amount recorded",
      completed: financial.estimateExplainedToPatient || financial.patientEstimateAmountCents > 0 || financial.pointOfServiceAmountDueCents > 0,
      evidenceText: `Patient estimate ${financial.patientEstimateAmountCents}`,
    },
    {
      label: "Expected POS collection amount recorded",
      completed: financial.estimateExplainedToPatient || financial.pointOfServiceAmountDueCents > 0,
      evidenceText: `Expected POS ${financial.pointOfServiceAmountDueCents}`,
    },
    {
      label: "Estimate explained to patient",
      completed: financial.estimateExplainedToPatient,
      evidenceText: financial.estimateExplainedToPatient ? "Estimate reviewed in Flow" : null,
    },
  ]);
  await syncChecklistCompletion(db, upsertedCase.id, RevenueChecklistGroup.referral_prior_auth, [
    {
      label: "Prior auth addressed",
      completed: priorAuthAddressed,
      evidenceText: priorAuthAddressed ? "Prior auth addressed in Flow" : null,
    },
    {
      label: "Referral addressed",
      completed: referralAddressed,
      evidenceText: referralAddressed ? "Referral addressed in Flow" : null,
    },
  ]);

  const followUpCaptured =
    checkoutTracking.collectionOutcome === CollectionOutcome.CollectedInFull ||
    checkoutTracking.collectionOutcome === CollectionOutcome.NoCollectionExpected ||
    checkoutTracking.collectionOutcome === CollectionOutcome.Waived ||
    Boolean(upsertedCase.assignedToUserId || upsertedCase.assignedToRole);
  await syncChecklistCompletion(db, upsertedCase.id, RevenueChecklistGroup.checkout_tracking, [
    {
      label: "Amount due recorded",
      completed: checkoutTracking.amountDueCents >= 0,
      evidenceText: `Amount due ${checkoutTracking.amountDueCents}`,
    },
    {
      label: "Collection outcome recorded",
      completed: Boolean(checkoutTracking.collectionOutcome),
      evidenceText: checkoutTracking.collectionOutcome || null,
    },
    {
      label: "Missed reason recorded when needed",
      completed:
        !checkoutTracking.collectionOutcome ||
        !collectionOutcomeNeedsMissedReason(checkoutTracking.collectionOutcome) ||
        Boolean(checkoutTracking.missedCollectionReason),
      evidenceText: checkoutTracking.missedCollectionReason,
    },
    {
      label: "Follow-up ownership captured if not fully collected",
      completed: followUpCaptured,
      evidenceText: followUpCaptured ? "Owner captured for collection follow-up" : null,
    },
  ]);

  const expectation = buildRevenueExpectationSummary({
    chargeCapture,
    chargeSchedule: settings.chargeSchedule,
    reimbursementRules: settings.reimbursementRules,
    financialReadiness: financial,
  });
  await syncChecklistCompletion(db, upsertedCase.id, RevenueChecklistGroup.encounter_documentation, [
    {
      label: "Documentation completed in Athena",
      completed: chargeCapture.documentationComplete,
      evidenceText: chargeCapture.documentationComplete ? "Clinician attested documentation completed in Athena" : null,
    },
    {
      label: "Documentation attestation note recorded",
      completed: Boolean(chargeCapture.documentationAttestation.attestationNote),
      evidenceText: chargeCapture.documentationAttestation.attestationNote,
    },
  ]);
  await syncChecklistCompletion(db, upsertedCase.id, RevenueChecklistGroup.charge_capture_coding, [
    {
      label: "MA service capture complete",
      completed: expectation.serviceCaptureCompleted,
      evidenceText: expectation.serviceCaptureCompleted ? `${chargeCapture.serviceCaptureItemsJson.length} service item(s) captured` : null,
    },
    {
      label: "Clinician working codes entered",
      completed: expectation.clinicianCodingEntered,
      evidenceText: expectation.clinicianCodingEntered ? "Clinician working codes saved in Flow" : null,
    },
    {
      label: "Final diagnosis / procedure set verified",
      completed: chargeCapture.icd10CodesJson.length > 0 && chargeCapture.procedureLinesJson.length > 0,
      evidenceText:
        chargeCapture.icd10CodesJson.length > 0 && chargeCapture.procedureLinesJson.length > 0
          ? `${chargeCapture.icd10CodesJson.length} dx / ${chargeCapture.procedureLinesJson.length} procedure lines`
          : null,
    },
  ]);

  const refreshed = await db.revenueCase.findUnique({
    where: { id: upsertedCase.id },
    include: {
      checklistItems: true,
      providerClarifications: true,
      chargeCaptureRecord: true,
      financialReadiness: true,
      checkoutCollectionTracking: true,
    },
  });
  if (!refreshed || !refreshed.financialReadiness || !refreshed.checkoutCollectionTracking || !refreshed.chargeCaptureRecord) {
    return null;
  }

  const openClarifications = refreshed.providerClarifications.filter((entry) => entry.status !== ProviderClarificationStatus.Resolved);
  const state = computeCaseState({
    encounter,
    financialReadiness: refreshed.financialReadiness,
    checkoutTracking: checkoutTracking,
    chargeCapture: {
      ...chargeCapture,
      readyForAthenaAt: refreshed.chargeCaptureRecord.readyForAthenaAt,
    },
    expectation,
    revenueCase: refreshed,
    athenaChecklistCompletedCount: refreshed.checklistItems.filter(
      (item) => item.group === RevenueChecklistGroup.athena_handoff_attestation && item.status === "completed",
    ).length,
    openClarifications: openClarifications.length,
    earliestOpenQueryAt: openClarifications[0]?.openedAt || null,
  });

  const updated = await db.revenueCase.update({
    where: { id: refreshed.id },
    data: {
      currentRevenueStatus: state.currentRevenueStatus,
      currentWorkQueue: state.currentWorkQueue,
      currentDayBucket: state.currentDayBucket,
      priority: state.priority,
      currentBlockerCategory: state.currentBlockerCategory,
      currentBlockerText: state.currentBlockerText,
      dueAt: state.dueAt,
      readyForAthenaAt:
        chargeCapture.codingStage === CodingStage.ReadyForAthena
          ? refreshed.readyForAthenaAt || refreshed.chargeCaptureRecord.readyForAthenaAt || new Date()
          : null,
      closeoutState:
        state.currentRevenueStatus === RevenueStatus.MonitoringOnly || state.currentRevenueStatus === RevenueStatus.Closed
          ? RevenueCloseoutState.ClosedResolved
          : refreshed.closeoutState === RevenueCloseoutState.RolledOver
            ? RevenueCloseoutState.RolledOver
            : refreshed.closeoutState === RevenueCloseoutState.ClosedUnresolved
              ? RevenueCloseoutState.ClosedUnresolved
              : RevenueCloseoutState.Open,
      closedAt: state.currentRevenueStatus === RevenueStatus.Closed ? encounter.closedAt || new Date() : null,
    },
  });

  if (refreshed.currentRevenueStatus !== updated.currentRevenueStatus) {
    await db.revenueCaseEvent.create({
      data: {
        revenueCaseId: updated.id,
        eventType: "status_changed",
        fromStatus: refreshed.currentRevenueStatus,
        toStatus: updated.currentRevenueStatus,
        eventText: `Revenue status changed to ${updated.currentRevenueStatus}`,
      },
    });
  }

  return updated;
}

export async function syncRevenueCasesForScope(
  db: PrismaClient | Prisma.TransactionClient,
  params: { clinicIds?: string[]; facilityId?: string | null; fromDateKey?: string | null; toDateKey?: string | null },
) {
  const start = (params.fromDateKey || DateTime.now().minus({ days: TODAY_WINDOW_DAYS }).toISODate() || "").trim();
  const end = (params.toDateKey || DateTime.now().toISODate() || "").trim();
  const startDate = DateTime.fromISO(start, { zone: "utc" }).startOf("day");
  const endDate = DateTime.fromISO(end, { zone: "utc" }).endOf("day");

  const encounters = await db.encounter.findMany({
    where: {
      clinicId: params.clinicIds && params.clinicIds.length > 0 ? { in: params.clinicIds } : undefined,
      clinic: params.facilityId ? { facilityId: params.facilityId } : undefined,
      dateOfService: { gte: startDate.toJSDate(), lte: endDate.toJSDate() },
    },
    select: { id: true },
    orderBy: { dateOfService: "desc" },
  });

  for (const encounter of encounters) {
    await syncRevenueCaseForEncounter(db, encounter.id);
  }

  const unresolvedCases = await db.revenueCase.findMany({
    where: {
      clinicId: params.clinicIds && params.clinicIds.length > 0 ? { in: params.clinicIds } : undefined,
      facilityId: params.facilityId || undefined,
      currentRevenueStatus: { notIn: [RevenueStatus.MonitoringOnly, RevenueStatus.Closed] },
    },
    select: { encounterId: true },
  });
  for (const row of unresolvedCases) {
    await syncRevenueCaseForEncounter(db, row.encounterId);
  }
}

export async function buildRevenueCaseList(
  db: PrismaClient | Prisma.TransactionClient,
  params: {
    clinicIds?: string[];
    facilityId?: string | null;
    encounterId?: string;
    search?: string;
    dayBucket?: RevenueDayBucket;
    workQueue?: RevenueWorkQueue;
    mine?: boolean;
    userId?: string;
    userRole?: RoleName;
  },
) {
  const search = params.search?.trim();
  const rows = await db.revenueCase.findMany({
    where: {
      clinicId: params.clinicIds && params.clinicIds.length > 0 ? { in: params.clinicIds } : undefined,
      facilityId: params.facilityId || undefined,
      encounterId: params.encounterId,
      currentDayBucket: params.dayBucket,
      currentWorkQueue: params.workQueue,
      ...(params.mine && params.userId && params.userRole
        ? {
            OR: [
              { assignedToUserId: params.userId },
              { assignedToRole: params.userRole, assignedToUserId: null },
            ],
          }
        : {}),
      ...(search
        ? {
            OR: [
              { patientId: { contains: search } },
              { currentBlockerText: { contains: search } },
              { encounter: { provider: { name: { contains: search } } } },
              { clinic: { name: { contains: search } } },
            ],
          }
        : {}),
    },
    include: {
      clinic: { select: { id: true, name: true, status: true, shortCode: true, cardColor: true } },
      provider: { select: { id: true, name: true, active: true } },
      encounter: {
        select: {
          id: true,
          patientId: true,
          currentStatus: true,
          checkInAt: true,
          providerEndAt: true,
          checkoutCompleteAt: true,
          roomingData: true,
          clinicianData: true,
          checkoutData: true,
          room: { select: { id: true, name: true, status: true } },
          reason: { select: { id: true, name: true, status: true } },
        },
      },
      assignedToUser: { select: { id: true, name: true, status: true } },
      financialReadiness: true,
      checkoutCollectionTracking: true,
      chargeCaptureRecord: true,
      providerClarifications: {
        where: { status: { not: ProviderClarificationStatus.Resolved } },
        orderBy: { openedAt: "asc" },
      },
      checklistItems: { orderBy: [{ group: "asc" }, { sortOrder: "asc" }] },
      events: { orderBy: { createdAt: "desc" }, take: 20 },
    },
    orderBy: [{ priority: "asc" }, { dueAt: "asc" }, { updatedAt: "desc" }],
  });

  return rows.map((row) => ({
    ...row,
    providerQueryOpenCount: row.providerClarifications.length,
  }));
}

export async function createRevenueProviderClarification(
  db: PrismaClient | Prisma.TransactionClient,
  params: {
    revenueCaseId: string;
    requestedByUserId: string;
    questionText: string;
    queryType?: string | null;
  },
) {
  const revenueCase = await db.revenueCase.findUnique({
    where: { id: params.revenueCaseId },
    include: {
      encounter: {
        include: {
          clinic: { select: { facilityId: true, id: true } },
        },
      },
    },
  });
  if (!revenueCase?.encounter?.clinic?.facilityId) return null;

  const clinicAssignment = await db.clinicAssignment.findUnique({
    where: { clinicId: revenueCase.clinicId },
    select: { providerUserId: true },
  });

  const clarification = await db.providerClarification.create({
    data: {
      revenueCaseId: revenueCase.id,
      encounterId: revenueCase.encounterId,
      requestedByUserId: params.requestedByUserId,
      targetUserId: clinicAssignment?.providerUserId || null,
      queryType: params.queryType || null,
      questionText: params.questionText,
      status: ProviderClarificationStatus.Open,
    },
  });

  await db.task.create({
    data: {
      facilityId: revenueCase.facilityId,
      clinicId: revenueCase.clinicId,
      encounterId: revenueCase.encounterId,
      revenueCaseId: revenueCase.id,
      sourceType: TaskSourceType.ProviderClarification,
      sourceId: clarification.id,
      taskCategory: "revenue",
      taskType: "revenue_provider_query",
      description: params.questionText,
      assignedToRole: RoleName.Clinician,
      assignedToUserId: clinicAssignment?.providerUserId || null,
      priority: 1,
      blocking: false,
      dueAt: DateTime.now().plus({ hours: 4 }).toJSDate(),
      createdBy: params.requestedByUserId,
    },
  });

  await createInboxAlert({
    facilityId: revenueCase.facilityId,
    clinicId: revenueCase.clinicId,
    kind: AlertInboxKind.task,
    sourceId: clarification.id,
    sourceVersionKey: `revenue-query:${clarification.id}:open`,
    title: "Revenue provider query",
    message: "Revenue needs provider clarification before Athena handoff.",
    payload: {
      revenueCaseId: revenueCase.id,
      encounterId: revenueCase.encounterId,
      providerClarificationId: clarification.id,
    },
    ...(clinicAssignment?.providerUserId
      ? { userIds: [clinicAssignment.providerUserId] }
      : { roles: [RoleName.Clinician] }),
  });

  await db.revenueCaseEvent.create({
    data: {
      revenueCaseId: revenueCase.id,
      eventType: "provider_query_opened",
      actorUserId: params.requestedByUserId,
      eventText: params.questionText,
      payloadJson: {
        providerClarificationId: clarification.id,
        queryType: params.queryType || null,
      },
    },
  });

  await syncRevenueCaseForEncounter(db, revenueCase.encounterId);
  return clarification;
}

export async function respondToRevenueProviderClarification(
  db: PrismaClient | Prisma.TransactionClient,
  params: {
    clarificationId: string;
    actorUserId: string;
    responseText: string;
    resolve?: boolean;
  },
) {
  const clarification = await db.providerClarification.findUnique({
    where: { id: params.clarificationId },
    include: { revenueCase: true },
  });
  if (!clarification) return null;

  const updated = await db.providerClarification.update({
    where: { id: clarification.id },
    data: {
      responseText: params.responseText,
      status: params.resolve ? ProviderClarificationStatus.Resolved : ProviderClarificationStatus.Responded,
      respondedAt: new Date(),
      resolvedAt: params.resolve ? new Date() : null,
    },
  });

  await db.revenueCaseEvent.create({
    data: {
      revenueCaseId: clarification.revenueCaseId,
      eventType: params.resolve ? "provider_query_resolved" : "provider_query_responded",
      actorUserId: params.actorUserId,
      eventText: params.responseText,
      payloadJson: {
        providerClarificationId: clarification.id,
      },
    },
  });

  await syncRevenueCaseForEncounter(db, clarification.encounterId);
  return updated;
}
