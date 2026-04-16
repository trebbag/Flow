import {
  AlertInboxKind,
  CodingStage,
  CollectionOutcome,
  type Encounter,
  EncounterStatus,
  FinancialEligibilityStatus,
  type FinancialReadiness,
  type Prisma,
  type PrismaClient,
  ProviderClarificationStatus,
  RevenueChecklistGroup,
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
  collectionNote: "billing.collection_note",
} as const;

export const CLINICIAN_CODING_KEYS = {
  diagnosisText: "coding.working_diagnosis_codes_text",
  procedureText: "coding.working_procedure_codes_text",
  documentationComplete: "coding.documentation_complete",
  note: "coding.note",
} as const;

export const CHECKIN_FINANCIAL_KEYS = {
  eligibilityChecked: "financial.eligibility_checked",
  eligibilityStatus: "financial.eligibility_status",
  coverageIssueFlag: "financial.coverage_issue_flag",
  expectedCollectionIndicator: "financial.expected_collection_indicator",
  priorAuthRequired: "financial.prior_auth_required",
  referralRequired: "financial.referral_required",
} as const;

const DEFAULT_ATHENA_CHECKLIST = [
  { label: "Review coding summary", sortOrder: 10 },
  { label: "Open encounter in Athena", sortOrder: 20 },
  { label: "Confirm charge entry completed in Athena", sortOrder: 30 },
  { label: "Record Athena note / reference", sortOrder: 40 },
] as const;

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
  if (!outcome && !collectionExpected) {
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
    trackingNote: asString(source[BILLING_FIELD_KEYS.collectionNote]),
    sourceFieldJson: source,
  };
}

function parseFinancialReadiness(encounter: {
  intakeData: Prisma.JsonValue | null;
  insuranceVerified: boolean;
}) {
  const source = asRecord(encounter.intakeData);
  const eligibilityStatus = toEligibilityStatus(asString(source[CHECKIN_FINANCIAL_KEYS.eligibilityStatus]), encounter.insuranceVerified);
  return {
    eligibilityStatus,
    coverageIssueCategory:
      asBoolean(source[CHECKIN_FINANCIAL_KEYS.coverageIssueFlag]) === true ? "coverage_issue" : null,
    coverageIssueText: asBoolean(source[CHECKIN_FINANCIAL_KEYS.coverageIssueFlag]) === true ? "Coverage issue flagged at check-in" : null,
    referralRequired: asBoolean(source[CHECKIN_FINANCIAL_KEYS.referralRequired]) ?? false,
    priorAuthRequired: asBoolean(source[CHECKIN_FINANCIAL_KEYS.priorAuthRequired]) ?? false,
    pointOfServiceAmountDueCents:
      (asBoolean(source[CHECKIN_FINANCIAL_KEYS.expectedCollectionIndicator]) ?? false)
        ? currencyToCents(source[BILLING_FIELD_KEYS.amountDueCents])
        : 0,
    notesJson: source,
  };
}

function parseChargeCapture(encounter: {
  clinicianData: Prisma.JsonValue | null;
}) {
  const source = asRecord(encounter.clinicianData);
  const diagnosisText = asString(source[CLINICIAN_CODING_KEYS.diagnosisText]);
  const procedureText = asString(source[CLINICIAN_CODING_KEYS.procedureText]);
  const documentationComplete = asBoolean(source[CLINICIAN_CODING_KEYS.documentationComplete]) ?? false;
  const codingNote = asString(source[CLINICIAN_CODING_KEYS.note]);
  let codingStage = CodingStage.NotStarted;
  if (diagnosisText || procedureText || codingNote) codingStage = CodingStage.InProgress;
  if (documentationComplete && (diagnosisText || procedureText)) codingStage = CodingStage.ReadyForAthena;
  return {
    documentationComplete,
    codingStage,
    icd10CodesJson: splitCodes(diagnosisText),
    cptCodesJson: splitCodes(procedureText),
    codingNote,
  };
}

function isCollectionTrackingComplete(input: {
  encounterStatus: EncounterStatus;
  checkoutCompleteAt: Date | null;
  collectionOutcome: CollectionOutcome | null;
  collectionExpected: boolean;
  missedCollectionReason: string | null;
}) {
  if (![EncounterStatus.CheckOut, EncounterStatus.Optimized].includes(input.encounterStatus)) {
    return false;
  }
  if (!input.collectionOutcome) return false;
  if (
    [CollectionOutcome.CollectedPartial, CollectionOutcome.NotCollected, CollectionOutcome.Deferred].includes(input.collectionOutcome) &&
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
}) {
  if (params.revenueStatus === RevenueStatus.MonitoringOnly || params.revenueStatus === RevenueStatus.Closed) {
    return RevenueDayBucket.Monitoring;
  }
  if (params.rolledFromDateKey) return RevenueDayBucket.Rolled;

  const today = todayDateKey(params.timezone);
  const dosKey = getDateKey(params.dateOfService, params.timezone);
  const yesterday = DateTime.fromISO(today, { zone: params.timezone }).minus({ days: 1 }).toISODate();
  if (dosKey === today) return RevenueDayBucket.Today;
  if (dosKey === yesterday) return RevenueDayBucket.Yesterday;
  return RevenueDayBucket.Rolled;
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
    [
      RevenueStatus.ChargeCaptureNeeded,
      RevenueStatus.CodingReviewInProgress,
      RevenueStatus.ReadyForAthenaHandoff,
      RevenueStatus.AthenaHandoffInProgress,
    ].includes(params.revenueStatus)
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
  financialReadiness: Pick<FinancialReadiness, "eligibilityStatus" | "coverageIssueText">;
  checkoutTracking: ReturnType<typeof parseCheckoutTracking>;
  chargeCapture: ReturnType<typeof parseChargeCapture> & { readyForAthenaAt?: Date | null };
  revenueCase: Pick<RevenueCase, "rolledFromDateKey" | "athenaHandoffConfirmedAt" | "rollReason"> | null;
  athenaChecklistCompletedCount: number;
  openClarifications: number;
  earliestOpenQueryAt: Date | null;
}) {
  const financialClear = params.financialReadiness.eligibilityStatus === FinancialEligibilityStatus.Clear;
  const checkoutComplete = isCollectionTrackingComplete({
    encounterStatus: params.encounter.currentStatus,
    checkoutCompleteAt: params.encounter.checkoutCompleteAt,
    collectionOutcome: params.checkoutTracking.collectionOutcome,
    collectionExpected: params.checkoutTracking.collectionExpected,
    missedCollectionReason: params.checkoutTracking.missedCollectionReason,
  });
  const chargeReady =
    params.chargeCapture.documentationComplete &&
    params.chargeCapture.codingStage === CodingStage.ReadyForAthena;
  const hasAthenaConfirmation = Boolean(params.revenueCase?.athenaHandoffConfirmedAt);
  let currentRevenueStatus = RevenueStatus.FinanciallyCleared;
  let currentWorkQueue = RevenueWorkQueue.FinancialReadiness;
  let blockerCategory: string | null = null;
  let blockerText: string | null = null;

  if (params.encounter.closedAt && params.encounter.closureType) {
    currentRevenueStatus = RevenueStatus.Closed;
    currentWorkQueue = RevenueWorkQueue.Monitoring;
  } else if (!financialClear) {
    currentRevenueStatus = RevenueStatus.FinancialReadinessNeeded;
    currentWorkQueue = RevenueWorkQueue.FinancialReadiness;
    blockerCategory = "financial_readiness";
    blockerText = params.financialReadiness.coverageIssueText || "Eligibility is not yet cleared.";
  } else if ([EncounterStatus.CheckOut, EncounterStatus.Optimized].includes(params.encounter.currentStatus) && !checkoutComplete) {
    currentRevenueStatus = RevenueStatus.CheckoutTrackingNeeded;
    currentWorkQueue = RevenueWorkQueue.CheckoutTracking;
    blockerCategory = "checkout_tracking";
    blockerText = "Collection outcome is incomplete or uncategorized.";
  } else if (params.openClarifications > 0) {
    currentRevenueStatus = RevenueStatus.ProviderClarificationNeeded;
    currentWorkQueue = RevenueWorkQueue.ProviderQueries;
    blockerCategory = "provider_clarification";
    blockerText = `${params.openClarifications} provider clarification${params.openClarifications === 1 ? "" : "s"} open.`;
  } else if ([EncounterStatus.CheckOut, EncounterStatus.Optimized].includes(params.encounter.currentStatus) && !chargeReady) {
    currentRevenueStatus =
      params.chargeCapture.codingStage === CodingStage.InProgress || params.chargeCapture.codingStage === CodingStage.ReadyForReview
        ? RevenueStatus.CodingReviewInProgress
        : RevenueStatus.ChargeCaptureNeeded;
    currentWorkQueue = RevenueWorkQueue.ChargeCapture;
    blockerCategory = "charge_capture";
    blockerText = "Coding summary is incomplete for Athena handoff.";
  } else if (chargeReady && !hasAthenaConfirmation) {
    currentRevenueStatus =
      params.athenaChecklistCompletedCount > 0
        ? RevenueStatus.AthenaHandoffInProgress
        : RevenueStatus.ReadyForAthenaHandoff;
    currentWorkQueue = RevenueWorkQueue.AthenaHandoff;
    blockerCategory = "athena_handoff";
    blockerText = "Athena handoff is not yet confirmed.";
  } else if (hasAthenaConfirmation) {
    currentRevenueStatus = RevenueStatus.MonitoringOnly;
    currentWorkQueue = RevenueWorkQueue.Monitoring;
  }

  const currentDayBucket = buildDayBucket({
    dateOfService: params.encounter.dateOfService,
    timezone: params.encounter.clinic.timezone,
    revenueStatus: currentRevenueStatus,
    rolledFromDateKey: params.revenueCase?.rolledFromDateKey || null,
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

type RevenueEncounter = Prisma.EncounterGetPayload<{
  include: {
    clinic: { select: { id: true; facilityId: true; timezone: true; name: true; status: true; shortCode: true; cardColor: true } };
    provider: { select: { id: true; name: true; active: true } };
    reason: { select: { id: true; name: true; status: true } };
    room: { select: { id: true; name: true; status: true } };
    revenueCase: { include: { checklistItems: true; providerClarifications: true } };
  };
}>;

async function ensureAthenaChecklist(db: PrismaClient | Prisma.TransactionClient, revenueCaseId: string) {
  const existing = await db.revenueChecklistItem.findMany({
    where: {
      revenueCaseId,
      group: RevenueChecklistGroup.athena_handoff,
    },
  });
  for (const item of DEFAULT_ATHENA_CHECKLIST) {
    if (existing.find((entry) => entry.label === item.label && entry.group === RevenueChecklistGroup.athena_handoff)) {
      continue;
    }
    await db.revenueChecklistItem.create({
      data: {
        revenueCaseId,
        group: RevenueChecklistGroup.athena_handoff,
        label: item.label,
        required: true,
        sortOrder: item.sortOrder,
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

  const financial = parseFinancialReadiness(encounter);
  const checkoutTracking = parseCheckoutTracking(encounter);
  const chargeCapture = parseChargeCapture(encounter);

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
      referralRequired: financial.referralRequired,
      priorAuthRequired: financial.priorAuthRequired,
      pointOfServiceAmountDueCents: financial.pointOfServiceAmountDueCents,
      notesJson: financial.notesJson as Prisma.InputJsonValue,
      verifiedAt: encounter.insuranceVerified ? new Date() : null,
    },
    update: {
      eligibilityStatus: financial.eligibilityStatus,
      coverageIssueCategory: financial.coverageIssueCategory,
      coverageIssueText: financial.coverageIssueText,
      referralRequired: financial.referralRequired,
      priorAuthRequired: financial.priorAuthRequired,
      pointOfServiceAmountDueCents: financial.pointOfServiceAmountDueCents,
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
      cptCodesJson: chargeCapture.cptCodesJson as Prisma.InputJsonValue,
      codingNote: chargeCapture.codingNote,
      readyForAthenaAt: chargeCapture.codingStage === CodingStage.ReadyForAthena ? new Date() : null,
    },
    update: {
      documentationComplete: chargeCapture.documentationComplete,
      codingStage: chargeCapture.codingStage,
      icd10CodesJson: chargeCapture.icd10CodesJson as Prisma.InputJsonValue,
      cptCodesJson: chargeCapture.cptCodesJson as Prisma.InputJsonValue,
      codingNote: chargeCapture.codingNote,
      readyForAthenaAt: chargeCapture.codingStage === CodingStage.ReadyForAthena ? new Date() : null,
    },
  });

  await ensureAthenaChecklist(db, upsertedCase.id);

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
    revenueCase: refreshed,
    athenaChecklistCompletedCount: refreshed.checklistItems.filter(
      (item) => item.group === RevenueChecklistGroup.athena_handoff && item.status === "completed",
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
