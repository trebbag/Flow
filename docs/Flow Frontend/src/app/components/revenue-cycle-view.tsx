import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Building2,
  CheckCircle2,
  CircleOff,
  Clock,
  DollarSign,
  ExternalLink,
  FileText,
  Filter,
  Inbox,
  MessageSquare,
  RefreshCcw,
  Search,
  Send,
  ShieldAlert,
  TrendingUp,
  UserCircle2,
  ChevronDown,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { Switch } from "./ui/switch";
import { admin, dashboards, revenueCases } from "./api-client";
import { loadSession } from "./auth-session";
import { getClinicalCodeReference } from "./clinical-code-reference";
import type {
  CollectionOutcome,
  FinancialRequirementStatus,
  RevenueCaseDetail,
  RevenueDashboardSnapshot,
  RevenueDailyHistoryRollup,
  RevenueDayBucket,
  RevenueHistorySummary,
  RevenueProcedureLine,
  RevenueSettings,
  RevenueWorkQueue,
  RevenueStatus,
  Role,
  StaffUser,
} from "./types";
import {
  REVENUE_DAY_BUCKET_LABELS,
  REVENUE_STATUS_COLORS,
  REVENUE_STATUS_LABELS,
  REVENUE_WORK_QUEUE_LABELS,
} from "./types";
import { ADMIN_REFRESH_EVENT, FACILITY_CONTEXT_CHANGED_EVENT } from "./app-events";

const viewTabs = ["Overview", "Work Queues", "Day Close", "History"] as const;
type RevenueViewTab = (typeof viewTabs)[number];

type DrawerTab = "Summary" | "Insurance" | "Checkout" | "Coding" | "Athena" | "Activity";
const drawerTabs: DrawerTab[] = ["Summary", "Insurance", "Checkout", "Coding", "Athena", "Activity"];
const dayBuckets: RevenueDayBucket[] = ["Today", "Yesterday", "Rolled", "Monitoring"];
const workQueues: RevenueWorkQueue[] = [
  "FinancialReadiness",
  "CheckoutTracking",
  "ChargeCapture",
  "ProviderQueries",
  "AthenaHandoff",
];

const athenaUnavailableText = "Not yet synced from Athena. Flow is tracking handoff only in this MVP slice.";
const financialRequirementStatuses: FinancialRequirementStatus[] = [
  "NotRequired",
  "Pending",
  "Approved",
  "Expired",
  "UnableToObtain",
];
const collectionOutcomes: CollectionOutcome[] = [
  "CollectedInFull",
  "CollectedPartial",
  "NotCollected",
  "NoCollectionExpected",
  "Waived",
  "Deferred",
];

type DayCloseDraft = {
  ownerUserId: string;
  ownerRole: Role;
  reasonNotCompleted: string;
  nextAction: string;
  dueAt: string;
  rollover: boolean;
};

function parseRevenueView(value: string | null): RevenueViewTab {
  return viewTabs.includes(value as RevenueViewTab) ? (value as RevenueViewTab) : "Overview";
}

function parseDrawerTab(value: string | null): DrawerTab {
  return drawerTabs.includes(value as DrawerTab) ? (value as DrawerTab) : "Summary";
}

function parseDayBucket(value: string | null): RevenueDayBucket {
  return dayBuckets.includes(value as RevenueDayBucket) ? (value as RevenueDayBucket) : "Today";
}

function parseWorkQueue(value: string | null): RevenueWorkQueue {
  return workQueues.includes(value as RevenueWorkQueue) ? (value as RevenueWorkQueue) : "FinancialReadiness";
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "Manual";
  return `${value.toFixed(1)}%`;
}

function formatHours(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "Manual";
  return `${value.toFixed(1)}h`;
}

function formatCurrency(cents?: number | null) {
  const amount = Number(cents || 0) / 100;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

function parseCurrencyInputToCents(value: string) {
  const normalized = value.replace(/[^0-9.-]/g, "").trim();
  if (!normalized) return 0;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

function formatCurrencyInput(cents?: number | null) {
  const amount = Number(cents || 0) / 100;
  return amount === 0 ? "0.00" : amount.toFixed(2);
}

function formatNullableAthenaMetric(value?: number | null) {
  if (value === null || value === undefined || Number.isNaN(value)) return "Not yet synced";
  return String(value);
}

function formatDateTime(value?: string | null) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function isoDate(daysAgo = 0) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function timeUntilDue(dueAt?: string | null) {
  if (!dueAt) return { label: "No due time", urgent: false };
  const diffMs = new Date(dueAt).getTime() - Date.now();
  if (diffMs <= 0) return { label: "Overdue", urgent: true };
  const hours = Math.floor(diffMs / 3_600_000);
  const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
  return { label: `${hours}h ${minutes}m`, urgent: hours < 4 };
}

function splitCodes(value: string) {
  return value
    .split(/[,\n]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function buildAthenaLink(template: string | undefined, revenueCase: RevenueCaseDetail | null) {
  if (!template || !revenueCase) return "";
  return template
    .replaceAll("{encounterId}", revenueCase.encounterId)
    .replaceAll("{revenueCaseId}", revenueCase.id)
    .replaceAll("{patientId}", revenueCase.patientId)
    .replaceAll("{clinicId}", revenueCase.clinicId);
}

function defaultCloseoutDraft(
  row: RevenueCaseDetail,
  currentUserId?: string | null,
  defaultDueHours = 18,
): DayCloseDraft {
  const due = new Date();
  due.setHours(due.getHours() + defaultDueHours);
  const defaultReason = row.currentBlockerText || row.rollReason || "";
  const defaultNextAction =
    row.currentBlockerCategory === "documentation_incomplete"
      ? "Follow up with the clinician to complete documentation, then finish Athena handoff."
      : row.currentWorkQueue === "AthenaHandoff"
        ? "Complete Athena handoff and confirm it back in Flow."
        : row.currentWorkQueue === "ChargeCapture"
          ? "Finish charge capture review and move the case toward Athena handoff."
          : "";
  return {
    ownerUserId: row.assignedToUserId || currentUserId || "",
    ownerRole: row.assignedToRole || "RevenueCycle",
    reasonNotCompleted: defaultReason,
    nextAction: defaultNextAction,
    dueAt: due.toISOString().slice(0, 16),
    rollover: true,
  };
}

function buildChargeScheduleMap(settings: RevenueSettings | null) {
  return new Map((settings?.chargeSchedule || []).filter((item) => item.active !== false).map((item) => [item.code.toUpperCase(), item]));
}

function checklistItemsFor(revenueCase: RevenueCaseDetail, groups: string[]) {
  return revenueCase.checklistItems.filter((item) => groups.includes(item.group));
}

function getRevenueExpectation(row: RevenueCaseDetail, settings: RevenueSettings | null) {
  const chargeSchedule = buildChargeScheduleMap(settings);
  const serviceItems = row.chargeCaptureRecord?.serviceCaptureItemsJson || [];
  const procedureLines = row.chargeCaptureRecord?.procedureLinesJson || [];
  let expectedGrossChargeCents = 0;
  let missingChargeMapping = false;

  if (procedureLines.length > 0) {
    procedureLines.forEach((line) => {
      const scheduleRow = chargeSchedule.get(line.cptCode.toUpperCase());
      if (!scheduleRow) {
        missingChargeMapping = true;
        return;
      }
      expectedGrossChargeCents += scheduleRow.amountCents * Math.max(1, line.units || 1);
    });
  } else {
    serviceItems.forEach((item) => {
      if (item.expectedChargeCents == null) {
        missingChargeMapping = true;
        return;
      }
      expectedGrossChargeCents += item.expectedChargeCents * Math.max(1, item.quantity || 1);
    });
  }

  const reimbursementRules = (settings?.reimbursementRules || []).filter((item) => item.active !== false);
  const payerName = row.financialReadiness?.primaryPayerName?.trim().toLowerCase() || "";
  const financialClass = row.financialReadiness?.financialClass?.trim().toLowerCase() || "";
  const matchedRule =
    reimbursementRules.find(
      (item) =>
        (item.payerName?.trim().toLowerCase() || "") === payerName &&
        (item.financialClass?.trim().toLowerCase() || "") === financialClass,
    ) ||
    reimbursementRules.find(
      (item) => !item.payerName && Boolean(item.financialClass) && item.financialClass!.trim().toLowerCase() === financialClass,
    ) ||
    reimbursementRules.find(
      (item) => Boolean(item.payerName) && item.payerName!.trim().toLowerCase() === payerName && !item.financialClass,
    ) ||
    null;
  const expectedNetReimbursementCents = matchedRule ? Math.round(expectedGrossChargeCents * (matchedRule.expectedPercent / 100)) : 0;
  const missingReimbursementMapping = expectedGrossChargeCents > 0 && !matchedRule;

  return {
    expectedGrossChargeCents,
    expectedNetReimbursementCents,
    missingChargeMapping,
    missingReimbursementMapping,
    serviceCaptureComplete: serviceItems.length > 0,
  };
}

function queueRowSubsummary(row: RevenueCaseDetail, settings: RevenueSettings | null) {
  const diagnosisCount = row.chargeCaptureRecord?.icd10CodesJson?.length || 0;
  const procedureCount = row.chargeCaptureRecord?.procedureLinesJson?.length || 0;
  const expectation = getRevenueExpectation(row, settings);
  const serviceDetailComplete = (row.chargeCaptureRecord?.serviceCaptureItemsJson || []).every((item) => item.detailComplete !== false);
  const codingReady = row.chargeCaptureRecord?.documentationComplete && serviceDetailComplete && diagnosisCount > 0 && procedureCount > 0;
  const documentationIncomplete = diagnosisCount > 0 && procedureCount > 0 && row.chargeCaptureRecord?.documentationComplete === false;
  return {
    diagnosisCount,
    procedureCount,
    codingReady,
    documentationIncomplete,
    documentationStructured: row.chargeCaptureRecord?.documentationComplete ?? false,
    serviceCaptureComplete: expectation.serviceCaptureComplete && serviceDetailComplete,
    expectedGrossChargeCents: expectation.expectedGrossChargeCents,
    expectedNetReimbursementCents: expectation.expectedNetReimbursementCents,
    missingChargeMapping: expectation.missingChargeMapping,
    missingReimbursementMapping: expectation.missingReimbursementMapping,
    athenaStatus: row.athenaClaimStatus || (row.athenaHandoffConfirmedAt ? "Handoff confirmed" : "Not yet synced from Athena"),
  };
}

function queueIcon(queue: RevenueWorkQueue) {
  switch (queue) {
    case "FinancialReadiness":
      return ShieldAlert;
    case "CheckoutTracking":
      return DollarSign;
    case "ChargeCapture":
      return FileText;
    case "ProviderQueries":
      return MessageSquare;
    case "AthenaHandoff":
      return Send;
    case "Monitoring":
      return Activity;
  }
}

function statusTone(status: RevenueStatus) {
  return REVENUE_STATUS_COLORS[status] || "#64748b";
}

function selectedInitialDueAt() {
  const next = new Date();
  next.setDate(next.getDate() + 1);
  next.setHours(10, 0, 0, 0);
  return next.toISOString().slice(0, 16);
}

export function RevenueCycleView() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const session = loadSession();
  const [activeView, setActiveView] = useState<RevenueViewTab>(() => parseRevenueView(searchParams.get("view")));
  const [activeDrawerTab, setActiveDrawerTab] = useState<DrawerTab>(() => parseDrawerTab(searchParams.get("drawer")));
  const [dayBucket, setDayBucket] = useState<RevenueDayBucket>(() => parseDayBucket(searchParams.get("bucket")));
  const [workQueue, setWorkQueue] = useState<RevenueWorkQueue>(() => parseWorkQueue(searchParams.get("queue")));
  const [search, setSearch] = useState(() => searchParams.get("search") || "");
  const [mineOnly, setMineOnly] = useState(() => searchParams.get("mine") === "true");
  const [dashboard, setDashboard] = useState<RevenueDashboardSnapshot | null>(null);
  const [history, setHistory] = useState<RevenueDailyHistoryRollup[]>([]);
  const [historySummary, setHistorySummary] = useState<RevenueHistorySummary | null>(null);
  const [queueRows, setQueueRows] = useState<RevenueCaseDetail[]>([]);
  const [dayCloseRows, setDayCloseRows] = useState<RevenueCaseDetail[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(() => searchParams.get("case"));
  const [selectedCase, setSelectedCase] = useState<RevenueCaseDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [userOptions, setUserOptions] = useState<StaffUser[]>([]);
  const [providerQueryText, setProviderQueryText] = useState("");
  const [athenaReference, setAthenaReference] = useState("");
  const [settings, setSettings] = useState<RevenueSettings | null>(null);
  const [financialDraft, setFinancialDraft] = useState({
    eligibilityStatus: "NotChecked",
    registrationVerified: false,
    contactInfoVerified: false,
    coverageIssueCategory: "",
    coverageIssueText: "",
    primaryPayerName: "",
    primaryPlanName: "",
    secondaryPayerName: "",
    financialClass: "",
    benefitsSummaryText: "",
    patientEstimateAmountCents: "0",
    pointOfServiceAmountDueCents: "0",
    estimateExplainedToPatient: false,
    outstandingPriorBalanceCents: "0",
    priorAuthRequired: false,
    priorAuthStatus: "NotRequired",
    priorAuthNumber: "",
    referralRequired: false,
    referralStatus: "NotRequired",
  });
  const [checkoutDraft, setCheckoutDraft] = useState({
    collectionExpected: false,
    amountDueCents: "0",
    amountCollectedCents: "0",
    collectionOutcome: "NoCollectionExpected",
    missedCollectionReason: "",
    trackingNote: "",
  });
  const [codingDraft, setCodingDraft] = useState({
    documentationComplete: false,
    diagnoses: [] as string[],
    procedureLines: [] as RevenueProcedureLine[],
    codingNote: "",
  });
  const [diagnosisInput, setDiagnosisInput] = useState("");
  const [rollDrafts, setRollDrafts] = useState<Record<string, DayCloseDraft>>({});

  const historyFrom = useMemo(() => isoDate(6), []);
  const historyTo = useMemo(() => isoDate(0), []);

  useEffect(() => {
    const next = new URLSearchParams();
    next.set("view", activeView);
    next.set("drawer", activeDrawerTab);
    next.set("bucket", dayBucket);
    next.set("queue", workQueue);
    if (search.trim()) next.set("search", search.trim());
    if (mineOnly) next.set("mine", "true");
    if (selectedCaseId) next.set("case", selectedCaseId);
    setSearchParams(next, { replace: true });
  }, [activeDrawerTab, activeView, dayBucket, mineOnly, search, selectedCaseId, setSearchParams, workQueue]);

  async function refreshRevenue() {
    setLoading(true);
    try {
      const facilityId = session?.facilityId;
      const [dashboardResult, queueResult, historyResult, todayCloseoutRowsResult, userRowsResult] = await Promise.allSettled([
        dashboards.revenueCycle({ dayBucket, workQueue, mine: mineOnly, search }),
        revenueCases.list({ dayBucket, workQueue, mine: mineOnly, search }),
        dashboards.revenueCycleHistory({ from: historyFrom, to: historyTo }),
        revenueCases.list({ dayBucket: "Today", from: isoDate(0), to: isoDate(0) }),
        admin.listUsers(facilityId),
      ]);

      const failures = [dashboardResult, queueResult, historyResult, todayCloseoutRowsResult, userRowsResult]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason instanceof Error ? result.reason.message : "Request failed");

      const dashboardValue = dashboardResult.status === "fulfilled" ? dashboardResult.value : dashboard;
      const queueValue = queueResult.status === "fulfilled" ? queueResult.value : queueRows;
      const historyValue = historyResult.status === "fulfilled" ? historyResult.value : { daily: history, summary: historySummary };
      const dayCloseValue = todayCloseoutRowsResult.status === "fulfilled" ? todayCloseoutRowsResult.value : dayCloseRows;
      const userValue = userRowsResult.status === "fulfilled" ? userRowsResult.value : userOptions;

      if (dashboardValue) {
        setDashboard(dashboardValue);
        const nextSettings: RevenueSettings = {
          facilityId: session?.facilityId || "",
          missedCollectionReasons: dashboardValue.settings?.missedCollectionReasons || [],
          providerQueryTemplates: dashboardValue.settings?.providerQueryTemplates || [],
          athenaLinkTemplate: dashboardValue.settings?.athenaLinkTemplate || "",
          queueSla: {},
          dayCloseDefaults: { defaultDueHours: 18, requireNextAction: true },
          estimateDefaults: dashboardValue.settings?.estimateDefaults || {
            defaultPatientEstimateCents: 0,
            defaultPosCollectionPercent: 100,
            explainEstimateByDefault: true,
          },
          athenaChecklistDefaults: dashboardValue.settings?.checklistDefaults?.athena_handoff_attestation || [],
          checklistDefaults: dashboardValue.settings?.checklistDefaults || {},
          serviceCatalog: dashboardValue.settings?.serviceCatalog || [],
          chargeSchedule: dashboardValue.settings?.chargeSchedule || [],
          reimbursementRules: dashboardValue.settings?.reimbursementRules || [],
        };
        setSettings(nextSettings);
        setRollDrafts((prev) => {
          const next = { ...prev };
          (dayCloseValue || []).forEach((row) => {
            next[row.id] = next[row.id] || defaultCloseoutDraft(row, session?.userId, nextSettings.dayCloseDefaults?.defaultDueHours || 18);
          });
          return next;
        });
      }

      setQueueRows(queueValue || []);
      setHistory(historyValue?.daily || []);
      setHistorySummary(historyValue?.summary || null);
      setDayCloseRows((dayCloseValue || []).filter((row) => !["MonitoringOnly", "Closed"].includes(row.currentRevenueStatus)));
      setUserOptions((userValue || []).filter((row) => row.status !== "archived"));

      const candidateId = selectedCaseId && [...(queueValue || []), ...(dayCloseValue || [])].some((row) => row.id === selectedCaseId)
        ? selectedCaseId
        : queueValue?.[0]?.id || dashboardValue?.cases?.[0]?.id || dayCloseValue?.[0]?.id || null;
      setSelectedCaseId(candidateId);

      if (failures.length > 0) {
        toast.error("Some Revenue Cycle data did not refresh", {
          description: failures[0],
        });
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshRevenue().catch(() => undefined);
    const onRefresh = () => {
      refreshRevenue().catch(() => undefined);
    };
    if (typeof window !== "undefined") {
      window.addEventListener(ADMIN_REFRESH_EVENT, onRefresh);
      window.addEventListener(FACILITY_CONTEXT_CHANGED_EVENT, onRefresh);
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener(ADMIN_REFRESH_EVENT, onRefresh);
        window.removeEventListener(FACILITY_CONTEXT_CHANGED_EVENT, onRefresh);
      }
    };
  }, [dayBucket, workQueue, mineOnly, search, historyFrom, historyTo]);

  useEffect(() => {
    if (!selectedCaseId) {
      setSelectedCase(null);
      return;
    }
    let mounted = true;
    revenueCases.get(selectedCaseId)
      .then((result) => {
        if (!mounted) return;
        setSelectedCase(result);
      })
      .catch(() => {
        if (mounted) setSelectedCase(null);
      });
    return () => {
      mounted = false;
    };
  }, [selectedCaseId, dashboard?.cases.length, queueRows.length]);

  useEffect(() => {
    if (!selectedCase) return;
    setFinancialDraft({
      eligibilityStatus: selectedCase.financialReadiness?.eligibilityStatus || "NotChecked",
      registrationVerified: Boolean(selectedCase.financialReadiness?.registrationVerified),
      contactInfoVerified: Boolean(selectedCase.financialReadiness?.contactInfoVerified),
      coverageIssueCategory: selectedCase.financialReadiness?.coverageIssueCategory || "",
      coverageIssueText: selectedCase.financialReadiness?.coverageIssueText || "",
      primaryPayerName: selectedCase.financialReadiness?.primaryPayerName || "",
      primaryPlanName: selectedCase.financialReadiness?.primaryPlanName || "",
      secondaryPayerName: selectedCase.financialReadiness?.secondaryPayerName || "",
      financialClass: selectedCase.financialReadiness?.financialClass || "",
      benefitsSummaryText: selectedCase.financialReadiness?.benefitsSummaryText || "",
      patientEstimateAmountCents: formatCurrencyInput(selectedCase.financialReadiness?.patientEstimateAmountCents || 0),
      pointOfServiceAmountDueCents: formatCurrencyInput(selectedCase.financialReadiness?.pointOfServiceAmountDueCents || 0),
      estimateExplainedToPatient: Boolean(selectedCase.financialReadiness?.estimateExplainedToPatient),
      outstandingPriorBalanceCents: formatCurrencyInput(selectedCase.financialReadiness?.outstandingPriorBalanceCents || 0),
      priorAuthRequired: Boolean(selectedCase.financialReadiness?.priorAuthRequired),
      priorAuthStatus: selectedCase.financialReadiness?.priorAuthStatus || "NotRequired",
      priorAuthNumber: selectedCase.financialReadiness?.priorAuthNumber || "",
      referralRequired: Boolean(selectedCase.financialReadiness?.referralRequired),
      referralStatus: selectedCase.financialReadiness?.referralStatus || "NotRequired",
    });
    setCheckoutDraft({
      collectionExpected: Boolean(selectedCase.checkoutCollectionTracking?.collectionExpected),
      amountDueCents: formatCurrencyInput(selectedCase.checkoutCollectionTracking?.amountDueCents || 0),
      amountCollectedCents: formatCurrencyInput(selectedCase.checkoutCollectionTracking?.amountCollectedCents || 0),
      collectionOutcome: selectedCase.checkoutCollectionTracking?.collectionOutcome || "NoCollectionExpected",
      missedCollectionReason: selectedCase.checkoutCollectionTracking?.missedCollectionReason || "",
      trackingNote: selectedCase.checkoutCollectionTracking?.trackingNote || "",
    });
    setCodingDraft({
      documentationComplete: Boolean(selectedCase.chargeCaptureRecord?.documentationComplete),
      diagnoses: selectedCase.chargeCaptureRecord?.icd10CodesJson || [],
      procedureLines: selectedCase.chargeCaptureRecord?.procedureLinesJson?.length
        ? selectedCase.chargeCaptureRecord.procedureLinesJson
        : (selectedCase.chargeCaptureRecord?.cptCodesJson || []).map((code, index) => ({
            lineId: crypto.randomUUID(),
            cptCode: code,
            modifiers: selectedCase.chargeCaptureRecord?.modifiersJson?.[index]
              ? splitCodes(selectedCase.chargeCaptureRecord.modifiersJson[index])
              : [],
            units: Number(selectedCase.chargeCaptureRecord?.unitsJson?.[index] || 1),
            diagnosisPointers: [],
          })),
      codingNote: selectedCase.chargeCaptureRecord?.codingNote || "",
    });
    setDiagnosisInput("");
    setAthenaReference(selectedCase.athenaHandoffNote || "");
  }, [selectedCase]);

  const riskCards = useMemo(() => {
    if (!dashboard) return [];
    return [
      { key: "eligibility", label: "Eligibility blockers", value: dashboard.risks.eligibilityBlockers, queue: "FinancialReadiness" as RevenueWorkQueue, tone: "#dc2626" },
      { key: "checkout", label: "Checkout misses", value: dashboard.risks.checkoutCollectionMisses, queue: "CheckoutTracking" as RevenueWorkQueue, tone: "#f97316" },
      { key: "charge", label: "Charge capture not started", value: dashboard.risks.chargeCaptureNotStarted, queue: "ChargeCapture" as RevenueWorkQueue, tone: "#6366f1" },
      { key: "queries", label: "Provider queries open", value: dashboard.risks.providerQueriesOpen, queue: "ProviderQueries" as RevenueWorkQueue, tone: "#8b5cf6" },
      { key: "athena", label: "Ready for Athena", value: dashboard.risks.readyForAthena, queue: "AthenaHandoff" as RevenueWorkQueue, tone: "#0891b2" },
      { key: "rolled", label: "Rolled from yesterday", value: dashboard.risks.rolledFromYesterday, queue: "FinancialReadiness" as RevenueWorkQueue, tone: "#64748b" },
    ];
  }, [dashboard]);

  const selectedDue = timeUntilDue(selectedCase?.dueAt || null);

  async function refreshSelectedCase(caseId = selectedCaseId) {
    if (!caseId) return;
    const refreshed = await revenueCases.get(caseId);
    setSelectedCase(refreshed);
    await refreshRevenue();
  }

  async function assignToMe() {
    if (!selectedCase || !session?.userId) return;
    setSaving(true);
    try {
      await revenueCases.assign(selectedCase.id, {
        assignedToUserId: session.userId,
        assignedToRole: "RevenueCycle",
      });
      toast.success("Revenue case assigned", {
        description: `${selectedCase.patientId} is now assigned to you.`,
      });
      await refreshSelectedCase(selectedCase.id);
    } catch (error) {
      toast.error("Unable to assign case", {
        description: (error as Error).message || "Try again.",
      });
    } finally {
      setSaving(false);
    }
  }

  async function saveFinancialReadiness() {
    if (!selectedCase) return;
    setSaving(true);
    try {
      await revenueCases.update(selectedCase.id, {
        financialReadiness: {
          eligibilityStatus: financialDraft.eligibilityStatus as any,
          registrationVerified: financialDraft.registrationVerified,
          contactInfoVerified: financialDraft.contactInfoVerified,
          coverageIssueCategory: financialDraft.coverageIssueCategory || null,
          coverageIssueText: financialDraft.coverageIssueText || null,
          primaryPayerName: financialDraft.primaryPayerName || null,
          primaryPlanName: financialDraft.primaryPlanName || null,
          secondaryPayerName: financialDraft.secondaryPayerName || null,
          financialClass: financialDraft.financialClass || null,
          benefitsSummaryText: financialDraft.benefitsSummaryText || null,
          patientEstimateAmountCents: parseCurrencyInputToCents(financialDraft.patientEstimateAmountCents || "0"),
          pointOfServiceAmountDueCents: parseCurrencyInputToCents(financialDraft.pointOfServiceAmountDueCents || "0"),
          estimateExplainedToPatient: financialDraft.estimateExplainedToPatient,
          outstandingPriorBalanceCents: parseCurrencyInputToCents(financialDraft.outstandingPriorBalanceCents || "0"),
          priorAuthRequired: financialDraft.priorAuthRequired,
          priorAuthStatus: (financialDraft.priorAuthStatus || "NotRequired") as FinancialRequirementStatus,
          priorAuthNumber: financialDraft.priorAuthNumber || null,
          referralRequired: financialDraft.referralRequired,
          referralStatus: (financialDraft.referralStatus || "NotRequired") as FinancialRequirementStatus,
        },
      });
      toast.success("Financial readiness saved");
      await refreshSelectedCase(selectedCase.id);
    } catch (error) {
      toast.error("Unable to save financial readiness", { description: (error as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function saveCheckoutTracking() {
    if (!selectedCase) return;
    const outcome = checkoutDraft.collectionOutcome;
    if (["CollectedPartial", "NotCollected", "Deferred"].includes(outcome) && !checkoutDraft.missedCollectionReason.trim()) {
      toast.error("Missed collection reason is required", {
        description: "Partial, deferred, and not-collected outcomes must be categorized before you save.",
      });
      return;
    }
    setSaving(true);
    try {
      await revenueCases.update(selectedCase.id, {
        checkoutTracking: {
          collectionExpected: checkoutDraft.collectionExpected,
          amountDueCents: parseCurrencyInputToCents(checkoutDraft.amountDueCents || "0"),
          amountCollectedCents: parseCurrencyInputToCents(checkoutDraft.amountCollectedCents || "0"),
          collectionOutcome: outcome as any,
          missedCollectionReason: checkoutDraft.missedCollectionReason || null,
          trackingNote: checkoutDraft.trackingNote || null,
        },
      });
      toast.success("Checkout tracking saved");
      await refreshSelectedCase(selectedCase.id);
    } catch (error) {
      toast.error("Unable to save checkout tracking", { description: (error as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function saveCodingHandoff(markReadyForAthena = false) {
    if (!selectedCase) return;
    const serviceCaptureCount = selectedCase.chargeCaptureRecord?.serviceCaptureItemsJson?.length || 0;
    const validProcedureLines = codingDraft.procedureLines
      .map((line) => ({
        ...line,
        cptCode: line.cptCode.trim(),
        modifiers: line.modifiers.map((value) => value.trim()).filter(Boolean),
        diagnosisPointers: line.diagnosisPointers.filter((value) => value > 0),
      }))
      .filter((line) => line.cptCode);
    if (markReadyForAthena && (serviceCaptureCount === 0 || !codingDraft.documentationComplete || codingDraft.diagnoses.length === 0 || validProcedureLines.length === 0)) {
      toast.error("Coding is not ready for Athena yet", {
        description: "Complete MA service capture, add at least one diagnosis and one procedure line, and mark documentation complete before handoff.",
      });
      return;
    }
    setSaving(true);
    try {
      await revenueCases.update(selectedCase.id, {
        readyForAthena: markReadyForAthena,
        chargeCapture: {
          documentationComplete: codingDraft.documentationComplete,
          codingStage: markReadyForAthena ? "ReadyForAthena" : codingDraft.documentationComplete ? "ReadyForReview" : "InProgress",
          icd10Codes: codingDraft.diagnoses,
          procedureLines: validProcedureLines,
          codingNote: codingDraft.codingNote || null,
        },
      });
      toast.success(markReadyForAthena ? "Marked ready for Athena" : "Coding handoff saved");
      await refreshSelectedCase(selectedCase.id);
    } catch (error) {
      toast.error("Unable to save coding handoff", { description: (error as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function createProviderQuery() {
    if (!selectedCase || !providerQueryText.trim()) return;
    setSaving(true);
    try {
      await revenueCases.createProviderClarification(selectedCase.id, {
        questionText: providerQueryText.trim(),
        queryType: "documentation_clarification",
      });
      setProviderQueryText("");
      toast.success("Provider query sent");
      await refreshSelectedCase(selectedCase.id);
    } catch (error) {
      toast.error("Unable to send provider query", { description: (error as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function completeAthenaHandoff() {
    if (!selectedCase) return;
    setSaving(true);
    try {
      await revenueCases.confirmAthenaHandoff(selectedCase.id, {
        athenaHandoffNote: athenaReference || null,
        checklistUpdates: selectedCase.checklistItems
          .filter((item) => item.group === "athena_handoff_attestation" && item.status !== "completed")
          .map((item) => ({
            id: item.id,
            status: "completed",
            evidenceText: athenaReference || "Manual Athena handoff confirmed in Flow",
          })),
      });
      toast.success("Athena handoff confirmed");
      await refreshSelectedCase(selectedCase.id);
    } catch (error) {
      toast.error("Unable to complete Athena handoff", { description: (error as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function closeRevenueDay() {
    const unresolvedRows = dayCloseRows.filter((row) => !["MonitoringOnly", "Closed"].includes(row.currentRevenueStatus));
    const missing = unresolvedRows.find((row) => {
      const draft = rollDrafts[row.id];
      return !draft?.reasonNotCompleted?.trim() || !draft?.nextAction?.trim() || !draft?.dueAt || !draft?.ownerRole;
    });
    if (missing) {
      toast.error("Every unresolved case needs closeout details", {
        description: `Capture owner, reason, next action, and due date for ${missing.patientId} before closing the day.`,
      });
      return;
    }
    setSaving(true);
    try {
      await revenueCases.closeout({
        clinicId: dayCloseRows[0]?.clinicId,
        date: isoDate(0),
        items: unresolvedRows.map((row) => ({
          revenueCaseId: row.id,
          ownerUserId: rollDrafts[row.id]?.ownerUserId || null,
          ownerRole: rollDrafts[row.id]?.ownerRole || "RevenueCycle",
          reasonNotCompleted: rollDrafts[row.id]?.reasonNotCompleted || "Revenue work remained unresolved at close.",
          nextAction: rollDrafts[row.id]?.nextAction || "Resume revenue work next day.",
          dueAt: new Date(rollDrafts[row.id]?.dueAt || selectedInitialDueAt()).toISOString(),
          rollover: Boolean(rollDrafts[row.id]?.rollover),
        })),
      });
      toast.success("Revenue day closed", {
        description: `${unresolvedRows.length} unresolved cases were captured for supervisor follow-up.`,
      });
      await refreshRevenue();
    } catch (error) {
      toast.error("Unable to close revenue day", { description: (error as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function resolveClarification(clarificationId: string) {
    setSaving(true);
    try {
      await revenueCases.updateProviderClarification(clarificationId, {
        status: "Resolved",
        resolve: true,
      });
      toast.success("Provider clarification resolved");
      await refreshSelectedCase(selectedCaseId || undefined);
    } catch (error) {
      toast.error("Unable to resolve clarification", { description: (error as Error).message });
    } finally {
      setSaving(false);
    }
  }

  function addDiagnosisChip() {
    const next = diagnosisInput.trim();
    if (!next) return;
    setCodingDraft((prev) => ({
      ...prev,
      diagnoses: Array.from(new Set([...prev.diagnoses, next])),
    }));
    setDiagnosisInput("");
  }

  function removeDiagnosisChip(code: string) {
    setCodingDraft((prev) => ({
      ...prev,
      diagnoses: prev.diagnoses.filter((entry) => entry !== code),
    }));
  }

  function addProcedureLine() {
    setCodingDraft((prev) => ({
      ...prev,
      procedureLines: [
        ...prev.procedureLines,
        {
          lineId: crypto.randomUUID(),
          cptCode: "",
          modifiers: [],
          units: 1,
          diagnosisPointers: [],
        },
      ],
    }));
  }

  function updateProcedureLine(lineId: string, patch: Partial<RevenueProcedureLine>) {
    setCodingDraft((prev) => ({
      ...prev,
      procedureLines: prev.procedureLines.map((line) => (line.lineId === lineId ? { ...line, ...patch } : line)),
    }));
  }

  function removeProcedureLine(lineId: string) {
    setCodingDraft((prev) => ({
      ...prev,
      procedureLines: prev.procedureLines.filter((line) => line.lineId !== lineId),
    }));
  }

  return (
    <div className="h-full overflow-hidden bg-[radial-gradient(circle_at_top,#f5fbff,transparent_55%),linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)]">
      <div className="h-full overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-[1480px] space-y-6">
          <div className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-sm lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 via-teal-500 to-cyan-600 text-white shadow-sm">
                  <DollarSign className="h-5 w-5" />
                </div>
                <div>
                  <h1 className="text-[24px] tracking-tight text-slate-900" style={{ fontWeight: 700 }}>
                    Revenue Operations Cockpit
                  </h1>
                  <p className="text-[13px] text-slate-500">
                    Flow-owned work from financial readiness through Athena handoff, with AthenaOne kept as the billing system of record.
                  </p>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                <Badge className="border-0 bg-emerald-50 text-emerald-700">Clinic-local</Badge>
                <Badge className="border-0 bg-cyan-50 text-cyan-700">Athena handoff only</Badge>
                <Badge className="border-0 bg-slate-100 text-slate-600">Source of truth stays in Athena</Badge>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {viewTabs.map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveView(tab)}
                  className={`rounded-full px-4 py-2 text-[12px] transition-colors ${
                    activeView === tab ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                  style={{ fontWeight: 600 }}
                >
                  {tab}
                </button>
              ))}
              <button
                onClick={() => refreshRevenue().catch(() => undefined)}
                className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-4 py-2 text-[12px] text-slate-600 hover:border-slate-300"
                style={{ fontWeight: 600 }}
              >
                <RefreshCcw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm xl:flex-row xl:items-center xl:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              {dayBuckets.map((bucket) => (
                <button
                  key={bucket}
                  onClick={() => setDayBucket(bucket)}
                  className={`rounded-full px-3 py-1.5 text-[11px] ${
                    dayBucket === bucket ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                  style={{ fontWeight: 600 }}
                >
                  {REVENUE_DAY_BUCKET_LABELS[bucket]}
                </button>
              ))}
            </div>
            <div className="flex flex-1 flex-wrap items-center gap-2 xl:justify-end">
              <div className="relative min-w-[240px] max-w-[420px] flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search patient, clinic, or blocker"
                  className="h-10 w-full rounded-full border border-slate-200 bg-white pl-9 pr-4 text-[12px] outline-none focus:border-slate-300"
                />
              </div>
              <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-600">
                <Filter className="h-3.5 w-3.5" />
                My work
                <Switch checked={mineOnly} onCheckedChange={setMineOnly} />
              </div>
            </div>
          </div>

          {activeView === "Overview" && dashboard && (
            <div className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <KpiCard
                  title="Visits collected"
                  value={`${dashboard.kpis.sameDayCollectionCapturedVisitCount}/${dashboard.kpis.sameDayCollectionExpectedVisitCount || 0}`}
                  hint={`${formatPercent(dashboard.kpis.sameDayCollectionVisitRate)} of expected same-day visits`}
                  icon={DollarSign}
                  tone="#10b981"
                />
                <KpiCard
                  title="Dollars captured"
                  value={formatCurrency(dashboard.kpis.sameDayCollectionCapturedCents)}
                  hint={`${formatPercent(dashboard.kpis.sameDayCollectionDollarRate)} of ${formatCurrency(dashboard.kpis.sameDayCollectionExpectedCents)} expected`}
                  icon={DollarSign}
                  tone="#059669"
                />
                <KpiCard
                  title="Expected gross charges"
                  value={formatCurrency(dashboard.kpis.expectedGrossChargeCents)}
                  hint="Flow-estimated from service capture and coded charge lines"
                  icon={TrendingUp}
                  tone="#0f766e"
                />
                <KpiCard
                  title="Expected net reimbursement"
                  value={formatCurrency(dashboard.kpis.expectedNetReimbursementCents)}
                  hint="Flow projection from payer-class reimbursement rules"
                  icon={TrendingUp}
                  tone="#0f766e"
                />
                <KpiCard
                  title="Service capture complete"
                  value={`${dashboard.kpis.serviceCaptureCompletedVisitCount}`}
                  hint={`${dashboard.kpis.chargeCaptureReadyVisitCount}/${dashboard.kpis.sameDayCollectionExpectedVisitCount || dashboard.cases.length || 0} cases moving toward Athena-ready capture`}
                  icon={CheckCircle2}
                  tone="#7c3aed"
                />
                <KpiCard
                  title="Clinician coding entered"
                  value={`${dashboard.kpis.clinicianCodingEnteredVisitCount}`}
                  hint="Working codes entered in Flow before revenue verification"
                  icon={FileText}
                  tone="#2563eb"
                />
                <KpiCard title="Average Flow handoff lag" value={formatHours(dashboard.kpis.averageFlowHandoffLagHours)} hint="Checkout complete to Athena handoff confirmation" icon={Clock} tone="#2563eb" />
                <KpiCard title="Athena days to submit" value={formatNullableAthenaMetric(dashboard.kpis.athenaDaysToSubmit)} hint={athenaUnavailableText} icon={Send} tone="#64748b" unavailable={dashboard.kpis.athenaDaysToSubmit == null} />
                <KpiCard title="Athena days in A/R" value={formatNullableAthenaMetric(dashboard.kpis.athenaDaysInAR)} hint={athenaUnavailableText} icon={TrendingUp} tone="#64748b" unavailable={dashboard.kpis.athenaDaysInAR == null} />
              </div>

              <Card className="border-0 shadow-sm">
                <CardContent className="p-5">
                  <div className="mb-4 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                    <h2 className="text-[14px] text-slate-900" style={{ fontWeight: 700 }}>
                      Today&apos;s risk strip
                    </h2>
                  </div>
                  <div className="grid gap-3 lg:grid-cols-3 xl:grid-cols-6">
                    {riskCards.map((card) => (
                      <button
                        key={card.key}
                        onClick={() => {
                          setActiveView("Work Queues");
                          setWorkQueue(card.queue);
                        }}
                        className="rounded-2xl border px-4 py-4 text-left transition-transform hover:-translate-y-0.5"
                        style={{ borderColor: `${card.tone}25`, background: `${card.tone}08` }}
                      >
                        <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{card.label}</div>
                        <div className="mt-3 text-[26px]" style={{ fontWeight: 700, color: card.tone }}>
                          {card.value}
                        </div>
                        <div className="mt-2 flex items-center gap-1 text-[11px] text-slate-500">
                          Open queue
                          <ArrowRight className="h-3 w-3" />
                        </div>
                      </button>
                    ))}
                  </div>
                </CardContent>
              </Card>

              <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
                <Card className="border-0 shadow-sm">
                  <CardContent className="p-5">
                    <div className="mb-4 flex items-center gap-2">
                      <Inbox className="h-4 w-4 text-cyan-600" />
                      <h2 className="text-[14px] text-slate-900" style={{ fontWeight: 700 }}>
                        Queue pressure
                      </h2>
                    </div>
                    <div className="space-y-3">
                      {workQueues.map((queue) => {
                        const Icon = queueIcon(queue);
                        const count = Number(dashboard.queueCounts?.[queue] || 0);
                        return (
                          <button
                            key={queue}
                            onClick={() => {
                              setActiveView("Work Queues");
                              setWorkQueue(queue);
                            }}
                            className={`flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-left ${
                              workQueue === queue ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 hover:bg-slate-50"
                            }`}
                          >
                            <div className="flex items-center gap-3">
                              <div className={`flex h-10 w-10 items-center justify-center rounded-2xl ${workQueue === queue ? "bg-white/15" : "bg-slate-100"}`}>
                                <Icon className="h-4 w-4" />
                              </div>
                              <div>
                                <div className="text-[13px]" style={{ fontWeight: 700 }}>{REVENUE_WORK_QUEUE_LABELS[queue]}</div>
                                <div className={`text-[11px] ${workQueue === queue ? "text-white/70" : "text-slate-500"}`}>Operational work queue</div>
                              </div>
                            </div>
                            <div className="text-[22px]" style={{ fontWeight: 700 }}>{count}</div>
                          </button>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-0 shadow-sm">
                  <CardContent className="p-5">
                    <div className="mb-4 flex items-center gap-2">
                      <Building2 className="h-4 w-4 text-slate-500" />
                      <h2 className="text-[14px] text-slate-900" style={{ fontWeight: 700 }}>
                        Operating boundaries
                      </h2>
                    </div>
                    <div className="space-y-3 text-[12px] text-slate-600">
                      <BoundaryRow title="Pre-service in Flow" body="Check-In plus Revenue guide registration checks, eligibility, patient estimate capture, POS expectation, and auth/referral follow-through even without Athena configured." />
                      <BoundaryRow title="Time-of-service in Flow" body="Flow directly owns service capture, clinician working codes, checkout tracking, revenue verification, and Athena documentation plus handoff attestation." />
                      <BoundaryRow title="Post-service stays in Athena" body="Claim edits, submission, adjudication, payment posting, denials, patient billing, collections, and payment truth remain Athena-only in this MVP." />
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {activeView === "Work Queues" && (
            <div className="grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_420px]">
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  {workQueues.map((queue) => (
                    <button
                      key={queue}
                      onClick={() => setWorkQueue(queue)}
                      className={`rounded-full px-3 py-1.5 text-[11px] ${
                        workQueue === queue ? "bg-slate-900 text-white" : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
                      }`}
                      style={{ fontWeight: 600 }}
                    >
                      {REVENUE_WORK_QUEUE_LABELS[queue]}
                    </button>
                  ))}
                </div>
                <div className="rounded-3xl border border-slate-200 bg-white/90 p-3 shadow-sm">
                  <div className="space-y-2">
                    {queueRows.length === 0 && (
                      <div className="rounded-2xl border border-dashed border-slate-200 px-6 py-12 text-center text-[13px] text-slate-500">
                        No revenue cases match the current filters.
                      </div>
                    )}
                    {queueRows.map((row) => (
                      <button
                        key={row.id}
                        onClick={() => setSelectedCaseId(row.id)}
                        className={`grid w-full gap-3 rounded-2xl border px-4 py-4 text-left transition-all lg:grid-cols-[minmax(0,1.1fr)_220px_170px] ${
                          selectedCaseId === row.id ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[13px]" style={{ fontWeight: 700 }}>{row.patientId}</span>
                            <Badge
                              className="border-0"
                              style={{ backgroundColor: `${statusTone(row.currentRevenueStatus)}20`, color: selectedCaseId === row.id ? "white" : statusTone(row.currentRevenueStatus) }}
                            >
                              {REVENUE_STATUS_LABELS[row.currentRevenueStatus]}
                            </Badge>
                          </div>
                          <div className={`mt-1 text-[12px] ${selectedCaseId === row.id ? "text-white/75" : "text-slate-500"}`}>
                            {row.providerName} · {row.clinicName} · {row.encounter.reasonForVisit || "Visit"}
                          </div>
                          <div className={`mt-2 text-[12px] ${selectedCaseId === row.id ? "text-white/85" : "text-slate-600"}`}>
                            {row.currentBlockerText || "No blocker text recorded"}
                          </div>
                          <div className={`mt-3 flex flex-wrap gap-2 text-[11px] ${selectedCaseId === row.id ? "text-white/80" : "text-slate-500"}`}>
                            <span>{queueRowSubsummary(row, settings).serviceCaptureComplete ? "Service capture complete" : "Service capture missing"}</span>
                            <span>Dx {queueRowSubsummary(row, settings).diagnosisCount}</span>
                            <span>Proc {queueRowSubsummary(row, settings).procedureCount}</span>
                            <span>
                              {queueRowSubsummary(row, settings).codingReady
                                ? "Coding ready"
                                : queueRowSubsummary(row, settings).documentationIncomplete
                                  ? "Documentation incomplete"
                                  : "Coding incomplete"}
                            </span>
                            <span>
                              {queueRowSubsummary(row, settings).expectedGrossChargeCents > 0
                                ? `Expected ${formatCurrency(queueRowSubsummary(row, settings).expectedGrossChargeCents)}`
                                : queueRowSubsummary(row, settings).missingChargeMapping
                                  ? "Missing charge mapping"
                                  : "No expected charge yet"}
                            </span>
                            <span>
                              {queueRowSubsummary(row, settings).expectedNetReimbursementCents > 0
                                ? `Net ${formatCurrency(queueRowSubsummary(row, settings).expectedNetReimbursementCents)}`
                                : queueRowSubsummary(row, settings).missingReimbursementMapping
                                  ? "Missing reimbursement mapping"
                                  : "No net projection yet"}
                            </span>
                            <span>{queueRowSubsummary(row, settings).athenaStatus}</span>
                          </div>
                        </div>
                        <div className={`text-[12px] ${selectedCaseId === row.id ? "text-white/80" : "text-slate-600"}`}>
                          <div>Owner</div>
                          <div className="mt-1" style={{ fontWeight: 700 }}>
                            {row.assignedToUserName || row.assignedToRole || "Unassigned"}
                          </div>
                          <div className="mt-3">Due</div>
                          <div className={`mt-1 ${timeUntilDue(row.dueAt).urgent ? "text-red-500" : ""}`} style={{ fontWeight: 700 }}>
                            {timeUntilDue(row.dueAt).label}
                          </div>
                          <div className="mt-3">DOS</div>
                          <div className="mt-1" style={{ fontWeight: 700 }}>
                            {row.encounter.checkInAt ? new Date(row.encounter.checkInAt).toLocaleDateString() : "Unscheduled"}
                          </div>
                        </div>
                        <div className={`text-[12px] ${selectedCaseId === row.id ? "text-white/80" : "text-slate-600"}`}>
                          <div>Queue</div>
                          <div className="mt-1" style={{ fontWeight: 700 }}>{REVENUE_WORK_QUEUE_LABELS[row.currentWorkQueue]}</div>
                          <div className="mt-3">Queries</div>
                          <div className="mt-1" style={{ fontWeight: 700 }}>{row.providerQueryOpenCount}</div>
                          <div className="mt-3">Athena</div>
                          <div className="mt-1" style={{ fontWeight: 700 }}>{row.athenaClaimStatus || (row.athenaHandoffConfirmedAt ? "Confirmed" : "Pending")}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <RevenueCaseDetailPane
                revenueCase={selectedCase}
                activeDrawerTab={activeDrawerTab}
                onDrawerTabChange={setActiveDrawerTab}
                saving={saving}
                dueLabel={selectedDue.label}
                dueUrgent={selectedDue.urgent}
                userOptions={userOptions}
                onAssignToMe={assignToMe}
                onOpenEncounter={() => selectedCase && navigate(`/encounter/${selectedCase.encounterId}`)}
                financialDraft={financialDraft}
                setFinancialDraft={setFinancialDraft}
                checkoutDraft={checkoutDraft}
                setCheckoutDraft={setCheckoutDraft}
                codingDraft={codingDraft}
                setCodingDraft={setCodingDraft}
                diagnosisInput={diagnosisInput}
                setDiagnosisInput={setDiagnosisInput}
                onAddDiagnosis={addDiagnosisChip}
                onRemoveDiagnosis={removeDiagnosisChip}
                onAddProcedureLine={addProcedureLine}
                onUpdateProcedureLine={updateProcedureLine}
                onRemoveProcedureLine={removeProcedureLine}
                providerQueryText={providerQueryText}
                setProviderQueryText={setProviderQueryText}
                athenaReference={athenaReference}
                setAthenaReference={setAthenaReference}
                settings={settings}
                onSaveFinancial={saveFinancialReadiness}
                onSaveCheckout={saveCheckoutTracking}
                onSaveCoding={saveCodingHandoff}
                onCreateProviderQuery={createProviderQuery}
                onCompleteAthena={completeAthenaHandoff}
                onResolveClarification={resolveClarification}
              />
            </div>
          )}

          {activeView === "Day Close" && (
            <div className="space-y-4">
              <Card className="border-0 shadow-sm">
                <CardContent className="p-5">
                  <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                      <h2 className="text-[16px] text-slate-900" style={{ fontWeight: 700 }}>Revenue day close</h2>
                      <p className="text-[12px] text-slate-500">
                        Soft closeout captures unresolved work structurally. Every unresolved case needs an owner, reason not completed, next action, due date, and rollover choice.
                      </p>
                    </div>
                    <button
                      onClick={() => closeRevenueDay().catch(() => undefined)}
                      disabled={saving}
                      className="rounded-full bg-slate-900 px-4 py-2 text-[12px] text-white disabled:opacity-50"
                      style={{ fontWeight: 700 }}
                    >
                      {saving ? "Closing..." : "Complete Revenue Close"}
                    </button>
                  </div>
                </CardContent>
              </Card>

              <div className="grid gap-3">
                {dayCloseRows.length === 0 && (
                  <Card className="border-0 shadow-sm">
                    <CardContent className="px-6 py-12 text-center text-[13px] text-slate-500">
                      No unresolved same-day revenue work remains. The day is ready to close.
                    </CardContent>
                  </Card>
                )}
                {dayCloseRows.map((row) => (
                  <Card key={row.id} className="border-0 shadow-sm">
                    <CardContent className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_180px_180px_180px] lg:items-start">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-[14px] text-slate-900" style={{ fontWeight: 700 }}>{row.patientId}</span>
                          <Badge className="border-0" style={{ backgroundColor: `${statusTone(row.currentRevenueStatus)}18`, color: statusTone(row.currentRevenueStatus) }}>
                            {REVENUE_STATUS_LABELS[row.currentRevenueStatus]}
                          </Badge>
                        </div>
                        <div className="mt-1 text-[12px] text-slate-500">{row.providerName} · {row.clinicName}</div>
                        <div className="mt-2 text-[12px] text-slate-700">{row.currentBlockerText || "No blocker text recorded."}</div>
                        <div className="mt-3 grid gap-3 md:grid-cols-2">
                          <Field label="Owner">
                            <select
                              value={rollDrafts[row.id]?.ownerUserId || ""}
                              onChange={(event) =>
                                setRollDrafts((prev) => ({
                                  ...prev,
                                  [row.id]: {
                                    ...(prev[row.id] || defaultCloseoutDraft(row, session?.userId, settings?.dayCloseDefaults?.defaultDueHours || 18)),
                                    ownerUserId: event.target.value,
                                  },
                                }))
                              }
                              className="h-10 w-full rounded-xl border border-slate-200 px-3 text-[12px] outline-none focus:border-slate-300"
                            >
                              <option value="">Role-owned</option>
                              {userOptions.map((user) => (
                                <option key={user.id} value={user.id}>{user.name}</option>
                              ))}
                            </select>
                          </Field>
                          <Field label="Owner role">
                            <select
                              value={rollDrafts[row.id]?.ownerRole || "RevenueCycle"}
                              onChange={(event) =>
                                setRollDrafts((prev) => ({
                                  ...prev,
                                  [row.id]: {
                                    ...(prev[row.id] || defaultCloseoutDraft(row, session?.userId, settings?.dayCloseDefaults?.defaultDueHours || 18)),
                                    ownerRole: event.target.value as Role,
                                  },
                                }))
                              }
                              className="h-10 w-full rounded-xl border border-slate-200 px-3 text-[12px] outline-none focus:border-slate-300"
                            >
                              <option value="RevenueCycle">Revenue Cycle</option>
                              <option value="OfficeManager">Office Manager</option>
                              <option value="Admin">Admin</option>
                            </select>
                          </Field>
                        </div>
                      </div>
                      <div>
                        <label className="mb-1.5 block text-[10px] uppercase tracking-[0.2em] text-slate-500">Reason not completed</label>
                        <input
                          value={rollDrafts[row.id]?.reasonNotCompleted || ""}
                          onChange={(event) =>
                            setRollDrafts((prev) => ({
                              ...prev,
                              [row.id]: {
                                ...(prev[row.id] || defaultCloseoutDraft(row, session?.userId, settings?.dayCloseDefaults?.defaultDueHours || 18)),
                                reasonNotCompleted: event.target.value,
                              },
                            }))
                          }
                          placeholder="What is still unfinished and why?"
                          className="h-10 w-full rounded-xl border border-slate-200 px-3 text-[12px] outline-none focus:border-slate-300"
                        />
                        <div className="mt-3">
                          <label className="mb-1.5 block text-[10px] uppercase tracking-[0.2em] text-slate-500">Next action</label>
                          <input
                            value={rollDrafts[row.id]?.nextAction || ""}
                            onChange={(event) =>
                              setRollDrafts((prev) => ({
                                ...prev,
                                [row.id]: {
                                  ...(prev[row.id] || defaultCloseoutDraft(row, session?.userId, settings?.dayCloseDefaults?.defaultDueHours || 18)),
                                  nextAction: event.target.value,
                                },
                              }))
                            }
                            placeholder="What should happen next?"
                            className="h-10 w-full rounded-xl border border-slate-200 px-3 text-[12px] outline-none focus:border-slate-300"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="mb-1.5 block text-[10px] uppercase tracking-[0.2em] text-slate-500">Due next</label>
                        <input
                          type="datetime-local"
                          value={rollDrafts[row.id]?.dueAt || selectedInitialDueAt()}
                          onChange={(event) =>
                            setRollDrafts((prev) => ({
                              ...prev,
                              [row.id]: {
                                ...(prev[row.id] || defaultCloseoutDraft(row, session?.userId, settings?.dayCloseDefaults?.defaultDueHours || 18)),
                                dueAt: event.target.value,
                              },
                            }))
                          }
                          className="h-10 w-full rounded-xl border border-slate-200 px-3 text-[12px] outline-none focus:border-slate-300"
                        />
                        <div className="mt-3 flex items-center justify-between rounded-2xl border border-slate-200 px-4 py-3">
                          <div>
                            <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Roll to tomorrow</div>
                            <div className="mt-1 text-[12px] text-slate-700" style={{ fontWeight: 700 }}>
                              {rollDrafts[row.id]?.rollover !== false ? "Yes, put in Rolled" : "No, keep in Yesterday"}
                            </div>
                          </div>
                          <Switch
                            checked={rollDrafts[row.id]?.rollover !== false}
                            onCheckedChange={(checked) =>
                              setRollDrafts((prev) => ({
                                ...prev,
                                [row.id]: {
                                  ...(prev[row.id] || defaultCloseoutDraft(row, session?.userId, settings?.dayCloseDefaults?.defaultDueHours || 18)),
                                  rollover: checked,
                                },
                              }))
                            }
                          />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
              <Card className="border-0 shadow-sm">
                <CardContent className="grid gap-4 p-5 md:grid-cols-3">
                  <SummaryBox
                    title="Unfinished queue pressure"
                    rows={(historySummary?.unfinishedQueues || []).slice(0, 4).map((entry) => ({ label: entry.label, value: String(entry.count) }))}
                  />
                  <SummaryBox
                    title="Most unfinished owners"
                    rows={(historySummary?.unfinishedOwners || []).slice(0, 4).map((entry) => ({ label: entry.label, value: String(entry.count) }))}
                  />
                  <SummaryBox title="Yesterday vs rolled" rows={[
                    { label: "Rolled today", value: String(dayCloseRows.filter((row) => rollDrafts[row.id]?.rollover !== false).length) },
                    { label: "Keep in yesterday", value: String(dayCloseRows.filter((row) => rollDrafts[row.id]?.rollover === false).length) },
                    { label: "Open clarifications", value: String(dayCloseRows.reduce((sum, row) => sum + row.providerQueryOpenCount, 0)) },
                    { label: "Handoff pending", value: String(dayCloseRows.filter((row) => !row.athenaHandoffConfirmedAt).length) },
                  ]} />
                </CardContent>
              </Card>
            </div>
          )}

          {activeView === "History" && (
            <div className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
                <KpiCard
                  title="Visits collected"
                  value={history.length ? `${history[history.length - 1].sameDayCollectionCapturedVisitCount}/${history[history.length - 1].sameDayCollectionExpectedVisitCount}` : "0/0"}
                  hint={history.length ? formatPercent(history[history.length - 1].sameDayCollectionVisitRate) : "Manual"}
                  icon={DollarSign}
                  tone="#10b981"
                />
                <KpiCard
                  title="Dollars captured"
                  value={history.length ? formatCurrency(history[history.length - 1].sameDayCollectionTrackedCents) : formatCurrency(0)}
                  hint={history.length ? formatPercent(history[history.length - 1].sameDayCollectionDollarRate) : "Manual"}
                  icon={DollarSign}
                  tone="#059669"
                />
                <KpiCard
                  title="Expected gross charges"
                  value={history.length ? formatCurrency(history[history.length - 1].expectedGrossChargeCents) : formatCurrency(0)}
                  hint="Flow-controlled"
                  icon={TrendingUp}
                  tone="#0f766e"
                />
                <KpiCard
                  title="Expected net reimbursement"
                  value={history.length ? formatCurrency(history[history.length - 1].expectedNetReimbursementCents) : formatCurrency(0)}
                  hint="Flow projection"
                  icon={TrendingUp}
                  tone="#0d9488"
                />
                <KpiCard
                  title="Avg handoff lag"
                  value={formatHours(historySummary?.averageFlowHandoffLagHours ?? (history.length ? history[history.length - 1].avgFlowHandoffHours : 0))}
                  hint="Flow-controlled"
                  icon={Clock}
                  tone="#2563eb"
                />
                <KpiCard
                  title="Athena days to submit"
                  value={formatNullableAthenaMetric(historySummary?.averageAthenaDaysToSubmit ?? (history.length ? history[history.length - 1].avgAthenaDaysToSubmit : null))}
                  hint={athenaUnavailableText}
                  icon={Send}
                  tone="#64748b"
                  unavailable={(historySummary?.averageAthenaDaysToSubmit ?? null) == null}
                />
              </div>
              <Card className="border-0 shadow-sm">
                <CardContent className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-5">
                  <SummaryBox
                    title="Most rolled queues"
                    rows={(historySummary?.unfinishedQueues || []).slice(0, 4).map((entry) => ({ label: entry.label, value: String(entry.count) }))}
                  />
                  <SummaryBox
                    title="Common unresolved reasons"
                    rows={(historySummary?.unfinishedReasons || []).slice(0, 4).map((entry) => ({ label: entry.label, value: String(entry.count) }))}
                  />
                  <SummaryBox
                    title="Unfinished owners"
                    rows={(historySummary?.unfinishedOwners || []).slice(0, 4).map((entry) => ({ label: entry.label, value: String(entry.count) }))}
                  />
                  <SummaryBox
                    title="Provider pressure"
                    rows={(historySummary?.unfinishedProviders || []).slice(0, 4).map((entry) => ({ label: entry.label, value: String(entry.count) }))}
                  />
                  <SummaryBox
                    title="Clinic pressure"
                    rows={(historySummary?.unfinishedClinics || []).slice(0, 4).map((entry) => ({ label: entry.label, value: String(entry.count) }))}
                  />
                </CardContent>
              </Card>
              <div className="grid gap-3 xl:grid-cols-3">
                {history.map((entry) => (
                  <Card key={`${entry.clinicId}:${entry.dateKey}`} className="border-0 shadow-sm">
                    <CardContent className="p-5">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">{entry.dateKey}</div>
                          <div className="mt-1 text-[15px] text-slate-900" style={{ fontWeight: 700 }}>{entry.clinicName}</div>
                        </div>
                        <Badge className="border-0 bg-slate-100 text-slate-600">Flow-controlled</Badge>
                      </div>
                      <div className="mt-4 grid grid-cols-2 gap-3 text-[12px] text-slate-600">
                        <MetricMini label="Visit rate" value={formatPercent(entry.sameDayCollectionVisitRate)} />
                        <MetricMini label="Dollar rate" value={formatPercent(entry.sameDayCollectionDollarRate)} />
                        <MetricMini label="Expected gross" value={formatCurrency(entry.expectedGrossChargeCents)} />
                        <MetricMini label="Expected net" value={formatCurrency(entry.expectedNetReimbursementCents)} />
                        <MetricMini label="Service capture" value={String(entry.serviceCaptureCompletedVisitCount)} />
                        <MetricMini label="Clinician coding" value={String(entry.clinicianCodingEnteredVisitCount)} />
                        <MetricMini label="Charge capture done" value={String(entry.chargeCaptureCompletedCount)} />
                        <MetricMini label="Athena handoffs" value={String(entry.athenaHandoffConfirmedCount)} />
                        <MetricMini label="Rolled" value={String(entry.rolledCount)} />
                        <MetricMini label="Flow lag" value={formatHours(entry.avgFlowHandoffHours)} />
                        <MetricMini label="Athena metrics" value={formatNullableAthenaMetric(entry.avgAthenaDaysInAR)} muted={entry.avgAthenaDaysInAR == null} />
                      </div>
                      <div className="mt-4 grid gap-2">
                        <Badge className="w-fit border-0 bg-slate-100 text-slate-600">Flow-controlled</Badge>
                        <div className="text-[11px] text-slate-500">Unfinished queues: {Object.entries(entry.unfinishedQueueCountsJson || {}).map(([label, value]) => `${label} ${value}`).join(" · ") || "None recorded"}</div>
                        <div className="text-[11px] text-slate-500">Common reasons: {Object.entries(entry.rollReasonsJson || {}).map(([label, value]) => `${label} ${value}`).join(" · ") || "None recorded"}</div>
                        <div className="text-[11px] text-slate-400">Athena-observed: {entry.avgAthenaDaysToSubmit == null ? "Not yet synced from Athena" : `${entry.avgAthenaDaysToSubmit} days to submit`}</div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function KpiCard({
  title,
  value,
  hint,
  icon: Icon,
  tone,
  unavailable = false,
}: {
  title: string;
  value: string;
  hint: string;
  icon: React.ElementType;
  tone: string;
  unavailable?: boolean;
}) {
  return (
    <Card className="border-0 shadow-sm">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">{title}</div>
            <div className="mt-3 text-[28px]" style={{ fontWeight: 700, color: tone }}>{value}</div>
            <div className="mt-2 text-[12px] text-slate-500">{hint}</div>
          </div>
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl" style={{ backgroundColor: `${tone}14`, color: tone }}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
        {unavailable && <div className="mt-4 text-[11px] text-slate-400">Not yet synced from Athena</div>}
      </CardContent>
    </Card>
  );
}

function BoundaryRow({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
      <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{title}</div>
      <div className="mt-1 text-[12px] leading-5 text-slate-700">{body}</div>
    </div>
  );
}

function MetricMini({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={`rounded-xl border px-3 py-3 ${muted ? "border-slate-100 bg-slate-50 text-slate-400" : "border-slate-200 bg-white text-slate-700"}`}>
      <div className="text-[10px] uppercase tracking-[0.18em]">{label}</div>
      <div className="mt-1 text-[18px]" style={{ fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function RevenueCaseDetailPane({
  revenueCase,
  activeDrawerTab,
  onDrawerTabChange,
  saving,
  dueLabel,
  dueUrgent,
  userOptions,
  onAssignToMe,
  onOpenEncounter,
  financialDraft,
  setFinancialDraft,
  checkoutDraft,
  setCheckoutDraft,
  codingDraft,
  setCodingDraft,
  diagnosisInput,
  setDiagnosisInput,
  onAddDiagnosis,
  onRemoveDiagnosis,
  onAddProcedureLine,
  onUpdateProcedureLine,
  onRemoveProcedureLine,
  providerQueryText,
  setProviderQueryText,
  athenaReference,
  setAthenaReference,
  settings,
  onSaveFinancial,
  onSaveCheckout,
  onSaveCoding,
  onCreateProviderQuery,
  onCompleteAthena,
  onResolveClarification,
}: {
  revenueCase: RevenueCaseDetail | null;
  activeDrawerTab: DrawerTab;
  onDrawerTabChange: (tab: DrawerTab) => void;
  saving: boolean;
  dueLabel: string;
  dueUrgent: boolean;
  userOptions: StaffUser[];
  onAssignToMe: () => void;
  onOpenEncounter: () => void;
  financialDraft: {
    eligibilityStatus: string;
    coverageIssueCategory: string;
    coverageIssueText: string;
    primaryPayerName: string;
    primaryPlanName: string;
    secondaryPayerName: string;
    financialClass: string;
    pointOfServiceAmountDueCents: string;
    outstandingPriorBalanceCents: string;
    priorAuthRequired: boolean;
    priorAuthStatus: string;
    priorAuthNumber: string;
    referralRequired: boolean;
    referralStatus: string;
  };
  setFinancialDraft: React.Dispatch<React.SetStateAction<{
    eligibilityStatus: string;
    coverageIssueCategory: string;
    coverageIssueText: string;
    primaryPayerName: string;
    primaryPlanName: string;
    secondaryPayerName: string;
    financialClass: string;
    pointOfServiceAmountDueCents: string;
    outstandingPriorBalanceCents: string;
    priorAuthRequired: boolean;
    priorAuthStatus: string;
    priorAuthNumber: string;
    referralRequired: boolean;
    referralStatus: string;
  }>>;
  checkoutDraft: {
    collectionExpected: boolean;
    amountDueCents: string;
    amountCollectedCents: string;
    collectionOutcome: string;
    missedCollectionReason: string;
    trackingNote: string;
  };
  setCheckoutDraft: React.Dispatch<React.SetStateAction<{
    collectionExpected: boolean;
    amountDueCents: string;
    amountCollectedCents: string;
    collectionOutcome: string;
    missedCollectionReason: string;
    trackingNote: string;
  }>>;
  codingDraft: {
    documentationComplete: boolean;
    diagnoses: string[];
    procedureLines: RevenueProcedureLine[];
    codingNote: string;
  };
  setCodingDraft: React.Dispatch<React.SetStateAction<{
    documentationComplete: boolean;
    diagnoses: string[];
    procedureLines: RevenueProcedureLine[];
    codingNote: string;
  }>>;
  diagnosisInput: string;
  setDiagnosisInput: (value: string) => void;
  onAddDiagnosis: () => void;
  onRemoveDiagnosis: (code: string) => void;
  onAddProcedureLine: () => void;
  onUpdateProcedureLine: (lineId: string, patch: Partial<RevenueProcedureLine>) => void;
  onRemoveProcedureLine: (lineId: string) => void;
  providerQueryText: string;
  setProviderQueryText: (value: string) => void;
  athenaReference: string;
  setAthenaReference: (value: string) => void;
  settings: RevenueSettings | null;
  onSaveFinancial: () => void;
  onSaveCheckout: () => void;
  onSaveCoding: (markReadyForAthena?: boolean) => void;
  onCreateProviderQuery: () => void;
  onCompleteAthena: () => void;
  onResolveClarification: (clarificationId: string) => void;
}) {
  if (!revenueCase) {
    return (
      <Card className="border-0 shadow-sm">
        <CardContent className="px-6 py-16 text-center text-[13px] text-slate-500">
          Select a revenue case to review the encounter handoff, collection tracking, and Athena checklist.
        </CardContent>
      </Card>
    );
  }

  const athenaLink = buildAthenaLink(settings?.athenaLinkTemplate, revenueCase);
  const unresolvedClarifications = revenueCase.providerClarifications.filter((item) => item.status !== "Resolved");

  return (
    <Card className="border-0 shadow-sm">
      <CardContent className="flex h-full min-h-[720px] flex-col p-0">
        <div className="border-b border-slate-200 px-5 py-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[18px] text-slate-900" style={{ fontWeight: 700 }}>{revenueCase.patientId}</span>
                <Badge className="border-0" style={{ backgroundColor: `${statusTone(revenueCase.currentRevenueStatus)}18`, color: statusTone(revenueCase.currentRevenueStatus) }}>
                  {REVENUE_STATUS_LABELS[revenueCase.currentRevenueStatus]}
                </Badge>
              </div>
              <div className="mt-1 text-[12px] text-slate-500">{revenueCase.providerName} · {revenueCase.clinicName} · DOS {formatDateTime(revenueCase.encounter.checkInAt)}</div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                <Badge className="border-0 bg-slate-100 text-slate-600">{REVENUE_WORK_QUEUE_LABELS[revenueCase.currentWorkQueue]}</Badge>
                <Badge className={`border-0 ${dueUrgent ? "bg-red-50 text-red-600" : "bg-slate-100 text-slate-600"}`}>{dueLabel}</Badge>
                <Badge className="border-0 bg-slate-100 text-slate-600">Owner: {revenueCase.assignedToUserName || revenueCase.assignedToRole || "Unassigned"}</Badge>
              </div>
            </div>
            <button
              onClick={onOpenEncounter}
              className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-600 hover:border-slate-300"
              style={{ fontWeight: 700 }}
            >
              Open full encounter
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="border-b border-slate-200 px-3 py-3">
          <div className="flex flex-wrap gap-2">
            {drawerTabs.map((tab) => (
              <button
                key={tab}
                onClick={() => onDrawerTabChange(tab)}
                className={`rounded-full px-3 py-1.5 text-[11px] ${
                  activeDrawerTab === tab ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
                }`}
                style={{ fontWeight: 600 }}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {activeDrawerTab === "Summary" && (
            <div className="space-y-4">
              <SummaryStat title="Primary blocker" value={revenueCase.currentBlockerText || "No blocker recorded"} icon={AlertTriangle} tone={statusTone(revenueCase.currentRevenueStatus)} />
              <div className="grid gap-3 md:grid-cols-2">
                <SummaryBox title="Encounter review" rows={[
                  { label: "Clinical status", value: revenueCase.encounter.currentStatus },
                  { label: "Reason for visit", value: revenueCase.encounter.reasonForVisit || "Not recorded" },
                  { label: "Room", value: revenueCase.encounter.roomName || "No room" },
                  { label: "Check-in", value: formatDateTime(revenueCase.encounter.checkInAt) },
                  { label: "Provider end", value: formatDateTime(revenueCase.encounter.providerEndAt) },
                  { label: "Checkout complete", value: formatDateTime(revenueCase.encounter.checkoutCompleteAt) },
                ]} />
                <SummaryBox title="Revenue handoff state" rows={[
                  { label: "Work queue", value: REVENUE_WORK_QUEUE_LABELS[revenueCase.currentWorkQueue] },
                  { label: "Day bucket", value: REVENUE_DAY_BUCKET_LABELS[revenueCase.currentDayBucket] },
                  { label: "Open provider queries", value: String(revenueCase.providerQueryOpenCount) },
                  { label: "Ready for Athena", value: revenueCase.readyForAthenaAt ? formatDateTime(revenueCase.readyForAthenaAt) : "No" },
                  { label: "Handoff owner", value: revenueCase.assignedToUserName || revenueCase.assignedToRole || "Unassigned" },
                  { label: "Handoff confirmed", value: revenueCase.athenaHandoffConfirmedAt ? formatDateTime(revenueCase.athenaHandoffConfirmedAt) : "No" },
                  { label: "Rolled reason", value: revenueCase.rollReason || "None" },
                ]} />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <SummaryBox title="Flow-controlled" rows={[
                  { label: "Registration verified", value: revenueCase.financialReadiness?.registrationVerified ? "Yes" : "No" },
                  { label: "Contact verified", value: revenueCase.financialReadiness?.contactInfoVerified ? "Yes" : "No" },
                  { label: "Eligibility", value: revenueCase.financialReadiness?.eligibilityStatus || "Not checked" },
                  { label: "Benefits summary", value: revenueCase.financialReadiness?.benefitsSummaryText || "Not captured" },
                  { label: "Collection outcome", value: revenueCase.checkoutCollectionTracking?.collectionOutcome || "Not tracked" },
                  { label: "Service capture items", value: String(revenueCase.chargeCaptureRecord?.serviceCaptureItemsJson.length || 0) },
                  { label: "Diagnoses", value: String(revenueCase.chargeCaptureRecord?.icd10CodesJson.length || 0) },
                  { label: "Procedure lines", value: String(revenueCase.chargeCaptureRecord?.procedureLinesJson.length || 0) },
                  { label: "Documentation complete", value: revenueCase.chargeCaptureRecord?.documentationComplete ? "Yes" : "No - still blocks handoff" },
                  { label: "Expected gross", value: formatCurrency(getRevenueExpectation(revenueCase, settings).expectedGrossChargeCents) },
                  { label: "Expected net", value: formatCurrency(getRevenueExpectation(revenueCase, settings).expectedNetReimbursementCents) },
                ]} />
                <SummaryBox title="Athena-observed" rows={[
                  { label: "Charge entered", value: revenueCase.athenaChargeEnteredAt ? formatDateTime(revenueCase.athenaChargeEnteredAt) : "Not yet synced from Athena" },
                  { label: "Claim submitted", value: revenueCase.athenaClaimSubmittedAt ? formatDateTime(revenueCase.athenaClaimSubmittedAt) : "Not yet synced from Athena" },
                  { label: "Days to submit", value: revenueCase.athenaDaysToSubmit == null ? "Not yet synced from Athena" : String(revenueCase.athenaDaysToSubmit) },
                  { label: "Days in A/R", value: revenueCase.athenaDaysInAR == null ? "Not yet synced from Athena" : String(revenueCase.athenaDaysInAR) },
                ]} />
              </div>
            </div>
          )}

          {activeDrawerTab === "Insurance" && (
            <div className="space-y-4">
              <ChecklistGroupCard
                title="Pre-service checklist"
                items={checklistItemsFor(revenueCase, [
                  "registration_demographics",
                  "eligibility_benefits",
                  "patient_estimate_pos",
                  "referral_prior_auth",
                ])}
              />
              <section className="grid gap-3 md:grid-cols-2">
                <ToggleField label="Registration verified" checked={financialDraft.registrationVerified} onChange={(checked) => setFinancialDraft((prev) => ({ ...prev, registrationVerified: checked }))} />
                <ToggleField label="Contact info verified" checked={financialDraft.contactInfoVerified} onChange={(checked) => setFinancialDraft((prev) => ({ ...prev, contactInfoVerified: checked }))} />
                <Field label="Eligibility status">
                  <div className="relative">
                    <select
                      value={financialDraft.eligibilityStatus}
                      onChange={(event) => setFinancialDraft((prev) => ({ ...prev, eligibilityStatus: event.target.value }))}
                      className="h-10 w-full rounded-xl border border-slate-200 px-3 pr-9 text-[12px] outline-none appearance-none focus:border-slate-300"
                    >
                      <option value="NotChecked">Not checked</option>
                      <option value="Clear">Clear</option>
                      <option value="Blocked">Blocked</option>
                      <option value="Pending">Pending</option>
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  </div>
                </Field>
                <Field label="Primary payer">
                  <input
                    value={financialDraft.primaryPayerName}
                    onChange={(event) => setFinancialDraft((prev) => ({ ...prev, primaryPayerName: event.target.value }))}
                    className="h-10 w-full rounded-xl border border-slate-200 px-3 text-[12px] outline-none focus:border-slate-300"
                  />
                </Field>
                <Field label="Primary plan">
                  <input
                    value={financialDraft.primaryPlanName}
                    onChange={(event) => setFinancialDraft((prev) => ({ ...prev, primaryPlanName: event.target.value }))}
                    className="h-10 w-full rounded-xl border border-slate-200 px-3 text-[12px] outline-none focus:border-slate-300"
                  />
                </Field>
                <Field label="Secondary payer">
                  <input
                    value={financialDraft.secondaryPayerName}
                    onChange={(event) => setFinancialDraft((prev) => ({ ...prev, secondaryPayerName: event.target.value }))}
                    className="h-10 w-full rounded-xl border border-slate-200 px-3 text-[12px] outline-none focus:border-slate-300"
                  />
                </Field>
                <Field label="Financial class">
                  <input
                    value={financialDraft.financialClass}
                    onChange={(event) => setFinancialDraft((prev) => ({ ...prev, financialClass: event.target.value }))}
                    className="h-10 w-full rounded-xl border border-slate-200 px-3 text-[12px] outline-none focus:border-slate-300"
                  />
                </Field>
                <Field label="Point-of-service amount due (USD)">
                  <input
                    value={financialDraft.pointOfServiceAmountDueCents}
                    onChange={(event) => setFinancialDraft((prev) => ({ ...prev, pointOfServiceAmountDueCents: event.target.value }))}
                    type="text"
                    inputMode="decimal"
                    onWheel={(event) => event.currentTarget.blur()}
                    className="h-10 w-full rounded-xl border border-slate-200 px-3 text-[12px] outline-none focus:border-slate-300"
                  />
                </Field>
                <Field label="Prior balance (USD)">
                  <input
                    value={financialDraft.outstandingPriorBalanceCents}
                    onChange={(event) => setFinancialDraft((prev) => ({ ...prev, outstandingPriorBalanceCents: event.target.value }))}
                    type="text"
                    inputMode="decimal"
                    onWheel={(event) => event.currentTarget.blur()}
                    className="h-10 w-full rounded-xl border border-slate-200 px-3 text-[12px] outline-none focus:border-slate-300"
                  />
                </Field>
                <Field label="Patient estimate (USD)">
                  <input
                    value={financialDraft.patientEstimateAmountCents}
                    onChange={(event) => setFinancialDraft((prev) => ({ ...prev, patientEstimateAmountCents: event.target.value }))}
                    type="text"
                    inputMode="decimal"
                    onWheel={(event) => event.currentTarget.blur()}
                    className="h-10 w-full rounded-xl border border-slate-200 px-3 text-[12px] outline-none focus:border-slate-300"
                  />
                </Field>
                <ToggleField label="Estimate explained to patient" checked={financialDraft.estimateExplainedToPatient} onChange={(checked) => setFinancialDraft((prev) => ({ ...prev, estimateExplainedToPatient: checked }))} />
                <Field label="Coverage issue category">
                  <input
                    value={financialDraft.coverageIssueCategory}
                    onChange={(event) => setFinancialDraft((prev) => ({ ...prev, coverageIssueCategory: event.target.value }))}
                    className="h-10 w-full rounded-xl border border-slate-200 px-3 text-[12px] outline-none focus:border-slate-300"
                  />
                </Field>
                <Field label="Coverage issue detail">
                  <input
                    value={financialDraft.coverageIssueText}
                    onChange={(event) => setFinancialDraft((prev) => ({ ...prev, coverageIssueText: event.target.value }))}
                    className="h-10 w-full rounded-xl border border-slate-200 px-3 text-[12px] outline-none focus:border-slate-300"
                  />
                </Field>
                <Field label="Benefits summary">
                  <textarea
                    value={financialDraft.benefitsSummaryText}
                    onChange={(event) => setFinancialDraft((prev) => ({ ...prev, benefitsSummaryText: event.target.value }))}
                    className="min-h-[96px] w-full rounded-2xl border border-slate-200 px-3 py-3 text-[12px] outline-none focus:border-slate-300"
                  />
                </Field>
                <ToggleField label="Prior auth required" checked={financialDraft.priorAuthRequired} onChange={(checked) => setFinancialDraft((prev) => ({ ...prev, priorAuthRequired: checked }))} />
                <Field label="Prior auth status">
                  <div className="relative">
                    <select
                      value={financialDraft.priorAuthStatus}
                      onChange={(event) => setFinancialDraft((prev) => ({ ...prev, priorAuthStatus: event.target.value }))}
                      className="h-10 w-full rounded-xl border border-slate-200 px-3 pr-9 text-[12px] outline-none appearance-none focus:border-slate-300"
                    >
                      {financialRequirementStatuses.map((status) => (
                        <option key={status} value={status}>{status}</option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  </div>
                </Field>
                <Field label="Prior auth number">
                  <input
                    value={financialDraft.priorAuthNumber}
                    onChange={(event) => setFinancialDraft((prev) => ({ ...prev, priorAuthNumber: event.target.value }))}
                    className="h-10 w-full rounded-xl border border-slate-200 px-3 text-[12px] outline-none focus:border-slate-300"
                  />
                </Field>
                <ToggleField label="Referral required" checked={financialDraft.referralRequired} onChange={(checked) => setFinancialDraft((prev) => ({ ...prev, referralRequired: checked }))} />
                <Field label="Referral status">
                  <div className="relative">
                    <select
                      value={financialDraft.referralStatus}
                      onChange={(event) => setFinancialDraft((prev) => ({ ...prev, referralStatus: event.target.value }))}
                      className="h-10 w-full rounded-xl border border-slate-200 px-3 pr-9 text-[12px] outline-none appearance-none focus:border-slate-300"
                    >
                      {financialRequirementStatuses.map((status) => (
                        <option key={status} value={status}>{status}</option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  </div>
                </Field>
              </section>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-[12px] text-slate-600">
                Flow guides pre-service steps here even without Athena. Registration, eligibility, estimate capture, and auth/referral stay visible until they are either completed or explicitly categorized.
              </div>
              <ActionRow>
                <button onClick={onAssignToMe} className="rounded-full border border-slate-200 px-3 py-2 text-[11px] text-slate-600" style={{ fontWeight: 700 }}>Assign to me</button>
                <button onClick={onSaveFinancial} disabled={saving} className="rounded-full bg-slate-900 px-4 py-2 text-[11px] text-white disabled:opacity-50" style={{ fontWeight: 700 }}>Save financial readiness</button>
              </ActionRow>
            </div>
          )}

          {activeDrawerTab === "Checkout" && (
            <div className="space-y-4">
              <ChecklistGroupCard
                title="Checkout tracking checklist"
                items={revenueCase.checklistItems.filter((item) => item.group === "checkout_tracking")}
              />
              <div className="grid gap-3 md:grid-cols-2">
                <ToggleField label="Collection expected" checked={checkoutDraft.collectionExpected} onChange={(checked) => setCheckoutDraft((prev) => ({ ...prev, collectionExpected: checked }))} />
                <Field label="Collection outcome">
                  <div className="relative">
                    <select
                      value={checkoutDraft.collectionOutcome}
                      onChange={(event) => setCheckoutDraft((prev) => ({ ...prev, collectionOutcome: event.target.value }))}
                      className="h-10 w-full rounded-xl border border-slate-200 px-3 pr-9 text-[12px] outline-none appearance-none focus:border-slate-300"
                    >
                      {collectionOutcomes.map((outcome) => (
                        <option key={outcome} value={outcome}>{outcome}</option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  </div>
                </Field>
                <Field label="Amount due (USD)">
                  <input value={checkoutDraft.amountDueCents} onChange={(event) => setCheckoutDraft((prev) => ({ ...prev, amountDueCents: event.target.value }))} type="text" inputMode="decimal" onWheel={(event) => event.currentTarget.blur()} className="h-10 w-full rounded-xl border border-slate-200 px-3 text-[12px] outline-none focus:border-slate-300" />
                </Field>
                <Field label="Amount collected (USD)">
                  <input value={checkoutDraft.amountCollectedCents} onChange={(event) => setCheckoutDraft((prev) => ({ ...prev, amountCollectedCents: event.target.value }))} type="text" inputMode="decimal" onWheel={(event) => event.currentTarget.blur()} className="h-10 w-full rounded-xl border border-slate-200 px-3 text-[12px] outline-none focus:border-slate-300" />
                </Field>
              </div>
              <Field label="Missed collection reason">
                <div className="space-y-3">
                  <div className="relative">
                    <select
                      value={checkoutDraft.missedCollectionReason}
                      onChange={(event) => setCheckoutDraft((prev) => ({ ...prev, missedCollectionReason: event.target.value }))}
                      className="h-10 w-full rounded-xl border border-slate-200 px-3 pr-9 text-[12px] outline-none appearance-none focus:border-slate-300"
                    >
                      <option value="">Select a reason</option>
                      {(settings?.missedCollectionReasons || []).map((reason) => (
                        <option key={reason} value={reason}>{reason}</option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(settings?.missedCollectionReasons || []).map((reason) => (
                      <button
                        key={reason}
                        type="button"
                        onClick={() => setCheckoutDraft((prev) => ({ ...prev, missedCollectionReason: reason }))}
                        className={`rounded-full px-3 py-1.5 text-[11px] ${
                          checkoutDraft.missedCollectionReason === reason ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {reason}
                      </button>
                    ))}
                  </div>
                </div>
              </Field>
              <Field label="Tracking note">
                <textarea value={checkoutDraft.trackingNote} onChange={(event) => setCheckoutDraft((prev) => ({ ...prev, trackingNote: event.target.value }))} className="min-h-[88px] w-full rounded-2xl border border-slate-200 px-3 py-3 text-[12px] outline-none focus:border-slate-300" />
              </Field>
              <ActionRow>
                <div className="text-[11px] text-slate-500">Current tracked amount: {formatCurrency(Number(checkoutDraft.amountCollectedCents || 0))}</div>
                <button onClick={onSaveCheckout} disabled={saving} className="rounded-full bg-slate-900 px-4 py-2 text-[11px] text-white disabled:opacity-50" style={{ fontWeight: 700 }}>Save checkout tracking</button>
              </ActionRow>
            </div>
          )}

          {activeDrawerTab === "Coding" && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-[12px] text-slate-600">
                Clinicians provide the structured code handoff upstream. Revenue finalizes codes here and uses an Athena documentation attestation instead of Flow-side encounter documentation fields.
              </div>
              <ChecklistGroupCard
                title="Documentation and coding checklist"
                items={checklistItemsFor(revenueCase, ["encounter_documentation", "charge_capture_coding"])}
              />
              <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                <div className="mb-3 text-[11px] uppercase tracking-[0.18em] text-slate-500">Documentation attestation and projection quality</div>
                <div className="grid gap-3 md:grid-cols-2">
                  <SummaryBox title="Documentation status" rows={[
                    {
                      label: "Documentation completed in Athena",
                      value: revenueCase.chargeCaptureRecord?.documentationComplete ? "Yes" : "No",
                    },
                    {
                      label: "Attestation note",
                      value:
                        typeof revenueCase.encounter.clinicianData?.["documentation.athena_attestation_note"] === "string" &&
                        revenueCase.encounter.clinicianData?.["documentation.athena_attestation_note"]
                          ? String(revenueCase.encounter.clinicianData?.["documentation.athena_attestation_note"])
                          : "Not entered",
                    },
                    {
                      label: "Current blocker",
                      value: revenueCase.currentBlockerText || "No blocker",
                    },
                  ]} />
                  <SummaryBox title="Projection quality" rows={[
                    { label: "Expected gross", value: formatCurrency(getRevenueExpectation(revenueCase, settings).expectedGrossChargeCents) },
                    { label: "Expected net", value: formatCurrency(getRevenueExpectation(revenueCase, settings).expectedNetReimbursementCents) },
                    {
                      label: "Charge schedule mapping",
                      value: getRevenueExpectation(revenueCase, settings).missingChargeMapping ? "Missing mapping" : "Mapped",
                    },
                    {
                      label: "Reimbursement mapping",
                      value: getRevenueExpectation(revenueCase, settings).missingReimbursementMapping ? "Missing mapping" : "Mapped",
                    },
                  ]} />
                </div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                <div className="mb-3 text-[11px] uppercase tracking-[0.18em] text-slate-500">MA service capture</div>
                <div className="space-y-2">
                  {(revenueCase.chargeCaptureRecord?.serviceCaptureItemsJson || []).length === 0 && (
                    <div className="text-[12px] text-slate-500">No structured service capture items recorded yet. MA service capture must be completed in Flow before Athena handoff.</div>
                  )}
                  {(revenueCase.chargeCaptureRecord?.serviceCaptureItemsJson || []).map((item) => (
                    <div key={item.id} className="flex items-start justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-[12px]">
                      <div>
                        <div className="text-slate-900" style={{ fontWeight: 700 }}>{item.label}</div>
                        <div className="text-slate-500">
                          Qty {item.quantity}
                          {item.suggestedProcedureCode ? ` · suggested CPT ${item.suggestedProcedureCode}` : ""}
                          {item.note ? ` · ${item.note}` : ""}
                        </div>
                        {item.detailJson && (
                          <div className="mt-1 text-[11px] text-slate-500">
                            {Object.entries(item.detailJson)
                              .filter(([, value]) => String(value || "").trim().length > 0)
                              .slice(0, 3)
                              .map(([key, value]) => `${key}: ${String(value)}`)
                              .join(" · ")}
                          </div>
                        )}
                      </div>
                      <div className="text-right text-slate-600">
                        <div className={`mb-1 text-[10px] ${item.detailComplete ? "text-emerald-700" : "text-amber-700"}`} style={{ fontWeight: 700 }}>
                          {item.detailComplete ? "Detail complete" : "Detail incomplete"}
                        </div>
                        {item.expectedChargeCents == null ? "Needs mapping" : formatCurrency(item.expectedChargeCents * Math.max(1, item.quantity || 1))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <ToggleField label="Documentation completed in Athena" checked={codingDraft.documentationComplete} onChange={(checked) => setCodingDraft((prev) => ({ ...prev, documentationComplete: checked }))} />
              <Field label="Diagnosis codes">
                <div className="rounded-2xl border border-slate-200 p-3">
                  <div className="flex gap-2">
                    <input
                      value={diagnosisInput}
                      onChange={(event) => setDiagnosisInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          onAddDiagnosis();
                        }
                      }}
                      placeholder="Add ICD-10 code"
                      className="h-10 flex-1 rounded-xl border border-slate-200 px-3 text-[12px] outline-none focus:border-slate-300"
                    />
                    <button onClick={onAddDiagnosis} className="rounded-full bg-slate-900 px-4 py-2 text-[11px] text-white" style={{ fontWeight: 700 }}>
                      Add
                    </button>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {codingDraft.diagnoses.length === 0 && <span className="text-[12px] text-slate-400">No diagnoses added yet.</span>}
                    {codingDraft.diagnoses.map((code) => (
                      <button
                        key={code}
                        type="button"
                        onClick={() => onRemoveDiagnosis(code)}
                        className="rounded-full bg-cyan-50 px-3 py-1.5 text-[11px] text-cyan-700"
                      >
                        {(() => {
                          const reference = getClinicalCodeReference("diagnosis", code);
                          return reference ? `${reference.code} — ${reference.label}` : code;
                        })()} <span className="ml-1 text-cyan-500">×</span>
                      </button>
                    ))}
                  </div>
                </div>
              </Field>
              <Field label="Procedure lines">
                <div className="space-y-3 rounded-2xl border border-slate-200 p-3">
                  {codingDraft.procedureLines.length === 0 && <div className="text-[12px] text-slate-400">Add at least one CPT/HCPCS line before Athena handoff.</div>}
                  {codingDraft.procedureLines.map((line, index) => (
                    <div key={line.lineId} className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
                      <div className="flex items-center justify-between">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Procedure line {index + 1}</div>
                        <button onClick={() => onRemoveProcedureLine(line.lineId)} className="text-[11px] text-rose-500">Remove</button>
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <Field label="CPT / HCPCS">
                          <input
                            value={line.cptCode}
                            onChange={(event) => onUpdateProcedureLine(line.lineId, { cptCode: event.target.value })}
                            className="h-10 w-full rounded-xl border border-slate-200 px-3 text-[12px] outline-none focus:border-slate-300"
                          />
                          {(() => {
                            const reference = getClinicalCodeReference("procedure", line.cptCode);
                            return reference ? (
                              <div className="mt-1 text-[11px] text-slate-500">{reference.label}</div>
                            ) : null;
                          })()}
                        </Field>
                        <Field label="Units">
                          <input
                            type="text"
                            inputMode="numeric"
                            value={line.units}
                            onWheel={(event) => event.currentTarget.blur()}
                            onChange={(event) => onUpdateProcedureLine(line.lineId, { units: Number(event.target.value || 1) })}
                            className="h-10 w-full rounded-xl border border-slate-200 px-3 text-[12px] outline-none focus:border-slate-300"
                          />
                        </Field>
                        <Field label="Modifiers">
                          <input
                            value={line.modifiers.join(", ")}
                            onChange={(event) => onUpdateProcedureLine(line.lineId, { modifiers: splitCodes(event.target.value) })}
                            placeholder="25, GT"
                            className="h-10 w-full rounded-xl border border-slate-200 px-3 text-[12px] outline-none focus:border-slate-300"
                          />
                        </Field>
                        <Field label="Diagnosis pointers">
                          <input
                            value={line.diagnosisPointers.join(", ")}
                            onChange={(event) =>
                              onUpdateProcedureLine(line.lineId, {
                                diagnosisPointers: splitCodes(event.target.value).map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0),
                              })
                            }
                            placeholder="1, 2"
                            className="h-10 w-full rounded-xl border border-slate-200 px-3 text-[12px] outline-none focus:border-slate-300"
                          />
                        </Field>
                      </div>
                    </div>
                  ))}
                  <button onClick={onAddProcedureLine} className="rounded-full border border-slate-200 px-3 py-2 text-[11px] text-slate-600" style={{ fontWeight: 700 }}>
                    Add procedure line
                  </button>
                </div>
              </Field>
              <Field label="Coding note">
                <textarea value={codingDraft.codingNote} onChange={(event) => setCodingDraft((prev) => ({ ...prev, codingNote: event.target.value }))} className="min-h-[96px] w-full rounded-2xl border border-slate-200 px-3 py-3 text-[12px] outline-none focus:border-slate-300" />
              </Field>
              <Field label="Provider clarification">
                <div className="space-y-3">
                  {(settings?.providerQueryTemplates || []).length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {(settings?.providerQueryTemplates || []).map((template) => (
                        <button
                          key={template}
                          type="button"
                          onClick={() => setProviderQueryText(template)}
                          className="rounded-full bg-slate-100 px-3 py-1.5 text-[11px] text-slate-600"
                        >
                          {template}
                        </button>
                      ))}
                    </div>
                  )}
                  <textarea value={providerQueryText} onChange={(event) => setProviderQueryText(event.target.value)} placeholder="Ask the provider only what is needed to finish coding and Athena handoff." className="min-h-[96px] w-full rounded-2xl border border-slate-200 px-3 py-3 text-[12px] outline-none focus:border-slate-300" />
                </div>
              </Field>
              {unresolvedClarifications.length > 0 && (
                <div className="space-y-2 rounded-2xl border border-purple-200 bg-purple-50 px-4 py-4">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-purple-700">Open clarification thread</div>
                  {unresolvedClarifications.map((query) => (
                    <div key={query.id} className="rounded-2xl border border-white/80 bg-white px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[12px] text-slate-900" style={{ fontWeight: 700 }}>{query.questionText}</div>
                        <Badge className="border-0 bg-purple-100 text-purple-700">{query.status}</Badge>
                      </div>
                      {query.responseText && <div className="mt-2 text-[12px] text-slate-600">Response: {query.responseText}</div>}
                      {query.status === "Responded" && (
                        <div className="mt-3">
                          <button onClick={() => onResolveClarification(query.id)} className="rounded-full border border-purple-200 px-3 py-2 text-[11px] text-purple-700">
                            Mark resolved
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <ActionRow>
                <button onClick={onCreateProviderQuery} disabled={saving || !providerQueryText.trim()} className="rounded-full border border-slate-200 px-3 py-2 text-[11px] text-slate-600 disabled:opacity-50" style={{ fontWeight: 700 }}>Send provider query</button>
                <div className="flex gap-2">
                  <button onClick={() => onSaveCoding(false)} disabled={saving} className="rounded-full border border-slate-200 px-3 py-2 text-[11px] text-slate-600 disabled:opacity-50" style={{ fontWeight: 700 }}>Save coding</button>
                  <button onClick={() => onSaveCoding(true)} disabled={saving} className="rounded-full bg-slate-900 px-4 py-2 text-[11px] text-white disabled:opacity-50" style={{ fontWeight: 700 }}>Mark ready for Athena</button>
                </div>
              </ActionRow>
            </div>
          )}

          {activeDrawerTab === "Athena" && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-cyan-200 bg-cyan-50 px-4 py-4 text-[12px] text-cyan-900">
                Flow does not submit claims. Use this checklist to confirm that the Athena handoff work was completed and timestamped.
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <SummaryBox title="Flow-owned handoff" rows={[
                  { label: "Owner", value: revenueCase.assignedToUserName || revenueCase.assignedToRole || "Unassigned" },
                  { label: "Started", value: revenueCase.athenaHandoffStartedAt ? formatDateTime(revenueCase.athenaHandoffStartedAt) : "Not started" },
                  { label: "Confirmed", value: revenueCase.athenaHandoffConfirmedAt ? formatDateTime(revenueCase.athenaHandoffConfirmedAt) : "Not confirmed" },
                  { label: "Confirmed by", value: revenueCase.athenaHandoffConfirmedByUserId || "Not recorded" },
                ]} />
                <SummaryBox title="Athena-observed" rows={[
                  { label: "Charge entered", value: revenueCase.athenaChargeEnteredAt ? formatDateTime(revenueCase.athenaChargeEnteredAt) : "Not yet synced from Athena" },
                  { label: "Claim submitted", value: revenueCase.athenaClaimSubmittedAt ? formatDateTime(revenueCase.athenaClaimSubmittedAt) : "Not yet synced from Athena" },
                  { label: "Claim status", value: revenueCase.athenaClaimStatus || "Not yet synced from Athena" },
                  { label: "Patient balance", value: revenueCase.athenaPatientBalanceCents == null ? "Not yet synced from Athena" : formatCurrency(revenueCase.athenaPatientBalanceCents) },
                ]} />
              </div>
              <div className="space-y-2">
                <ChecklistGroupCard
                  title="Athena handoff checklist"
                  items={checklistItemsFor(revenueCase, ["athena_handoff_attestation"])}
                />
              </div>
              <Field label="Athena note / reference">
                <textarea value={athenaReference} onChange={(event) => setAthenaReference(event.target.value)} placeholder="Optional note or reference from Athena." className="min-h-[88px] w-full rounded-2xl border border-slate-200 px-3 py-3 text-[12px] outline-none focus:border-slate-300" />
              </Field>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-[12px] text-slate-600">
                Athena lagging metrics are intentionally nullable in this MVP. When import is unavailable, the cockpit shows “Not yet synced from Athena” instead of fake status.
              </div>
              <ActionRow>
                {athenaLink ? (
                  <a href={athenaLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-3 py-2 text-[11px] text-slate-600" style={{ fontWeight: 700 }}>
                    Open Athena
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                ) : (
                  <button onClick={() => toast.info("Open Athena manually", { description: "Use your AthenaOne workflow, then return here to confirm the handoff." })} className="rounded-full border border-slate-200 px-3 py-2 text-[11px] text-slate-600" style={{ fontWeight: 700 }}>
                    Open Athena
                  </button>
                )}
                <button onClick={onCompleteAthena} disabled={saving} className="rounded-full bg-slate-900 px-4 py-2 text-[11px] text-white disabled:opacity-50" style={{ fontWeight: 700 }}>
                  Confirm Athena handoff
                </button>
              </ActionRow>
            </div>
          )}

          {activeDrawerTab === "Activity" && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-[12px] text-slate-600">
                Activity in this MVP reflects Flow-owned revenue events and provider clarifications. Athena lagging outcomes are intentionally deferred.
              </div>
              <div className="space-y-3">
                {revenueCase.events.length === 0 && <div className="text-[12px] text-slate-500">No activity recorded.</div>}
                {revenueCase.events.map((event) => (
                  <div key={event.id} className="rounded-2xl border border-slate-200 px-4 py-3">
                    <div className="flex items-center justify-between gap-4">
                      <div className="text-[12px] text-slate-900" style={{ fontWeight: 700 }}>{event.eventText || event.eventType}</div>
                      <div className="text-[11px] text-slate-500">{formatDateTime(event.createdAt)}</div>
                    </div>
                    {event.fromStatus || event.toStatus ? (
                      <div className="mt-2 text-[11px] text-slate-500">
                        {event.fromStatus ? REVENUE_STATUS_LABELS[event.fromStatus] : "Start"} → {event.toStatus ? REVENUE_STATUS_LABELS[event.toStatus] : "Current"}
                      </div>
                    ) : null}
                  </div>
                ))}
                {revenueCase.providerClarifications.map((query) => (
                  <div key={query.id} className="rounded-2xl border border-purple-200 bg-purple-50 px-4 py-3">
                    <div className="flex items-center justify-between gap-4">
                      <div className="text-[12px] text-purple-900" style={{ fontWeight: 700 }}>{query.questionText}</div>
                      <Badge className="border-0 bg-white text-purple-700">{query.status}</Badge>
                    </div>
                    <div className="mt-2 text-[11px] text-purple-700">Opened {formatDateTime(query.openedAt)}</div>
                    {query.responseText && <div className="mt-2 text-[12px] text-purple-900">Response: {query.responseText}</div>}
                    {query.status === "Responded" && (
                      <div className="mt-3">
                        <button onClick={() => onResolveClarification(query.id)} className="rounded-full border border-purple-200 bg-white px-3 py-2 text-[11px] text-purple-700">
                          Resolve clarification
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-slate-200 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3 text-[11px] text-slate-500">
            <div className="flex items-center gap-2">
              <UserCircle2 className="h-3.5 w-3.5" />
              Revenue read-only encounter review is available through the existing encounter route.
            </div>
            <div className="flex items-center gap-2">
              <span>{userOptions.filter((user) => user.status !== "archived").length} active staff in scope</span>
              <CircleOff className="h-3.5 w-3.5 text-slate-300" />
              <span>No Athena PM duplication</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SummaryStat({ title, value, icon: Icon, tone }: { title: string; value: string; icon: React.ElementType; tone: string }) {
  return (
    <div className="rounded-2xl border px-4 py-4" style={{ borderColor: `${tone}22`, backgroundColor: `${tone}08` }}>
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-slate-500">
        <Icon className="h-3.5 w-3.5" style={{ color: tone }} />
        {title}
      </div>
      <div className="mt-2 text-[14px] leading-6 text-slate-900" style={{ fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function SummaryBox({ title, rows }: { title: string; rows: Array<{ label: string; value: string }> }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
      <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{title}</div>
      <div className="mt-3 space-y-2.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-start justify-between gap-4 text-[12px]">
            <span className="text-slate-500">{row.label}</span>
            <span className="text-right text-slate-800" style={{ fontWeight: 600 }}>{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChecklistGroupCard({
  title,
  items,
}: {
  title: string;
  items: Array<{ id: string; label: string; status: string; completedAt?: string | null }>;
}) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
      <div className="mb-3 text-[11px] uppercase tracking-[0.18em] text-slate-500">{title}</div>
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.id} className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-3 text-[12px]">
            <div>
              <div className="text-slate-900" style={{ fontWeight: 700 }}>{item.label}</div>
              <div className="text-slate-500">{item.completedAt ? formatDateTime(item.completedAt) : "Not completed"}</div>
            </div>
            <Badge className={`border-0 ${item.status === "completed" ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-600"}`}>
              {item.status}
            </Badge>
          </div>
        ))}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[10px] uppercase tracking-[0.2em] text-slate-500">{label}</div>
      {children}
    </label>
  );
}

function ToggleField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-center justify-between rounded-2xl border border-slate-200 px-4 py-3">
      <div>
        <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">{label}</div>
        <div className="mt-1 text-[12px] text-slate-700" style={{ fontWeight: 700 }}>{checked ? "Yes" : "No"}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function ActionRow({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-2">{children}</div>;
}
