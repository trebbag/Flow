import { useState, useEffect, useMemo } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router";
import { useKeyboardShortcuts } from "./use-keyboard-shortcuts";
import {
  ArrowLeft,
  Activity,
  Users,
  Stethoscope,
  DoorOpen,
  Clock,
  Timer,
  CheckCircle2,
  AlertTriangle,
  ShieldAlert,
  ChevronRight,
  ClipboardList,
  Footprints,
  Shield,
  Zap,
  Bell,
  ListChecks,
  FileText,
  Heart,
  Thermometer,
  Gauge,
  StickyNote,
  CreditCard,
  LayoutTemplate,
  AlertCircle,
  Plus,
  X,
  ChevronDown,
} from "lucide-react";
import { Card, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import {
  statusLabels,
  statusColors,
  defaultThresholds,
  type Encounter,
  type EncounterStatus,
} from "./mock-data";
import { useEncounters } from "./encounter-context";
import { admin, encounters as encounterApi, revenueCases, rooms as roomsApi, type RoomLiveCard } from "./api-client";
import { loadSession } from "./auth-session";
import { SafetyAssistModal } from "./safety-assist-modal";
import { toast } from "sonner";
import { getEncounterStageSeconds, getEncounterTotalSeconds } from "./encounter-timers";
import { searchClinicalCodes, type ClinicalCodeReference } from "./clinical-code-reference";
import type { RevenueCaseDetail, RevenueServiceCaptureItem, RevenueSettings } from "./types";

// ── Status progression ──

const statusFlow: EncounterStatus[] = [
  "Incoming",
  "Lobby",
  "Rooming",
  "ReadyForProvider",
  "Optimizing",
  "CheckOut",
  "Optimized",
];

const stepIcons: Record<EncounterStatus, React.ElementType> = {
  Incoming: Clock,
  Lobby: Users,
  Rooming: ClipboardList,
  ReadyForProvider: Stethoscope,
  Optimizing: Activity,
  CheckOut: CreditCard,
  Optimized: CheckCircle2,
};

const nextStatusMap: Record<string, EncounterStatus> = {
  Lobby: "Rooming",
  Rooming: "ReadyForProvider",
  ReadyForProvider: "Optimizing",
  Optimizing: "CheckOut",
  CheckOut: "Optimized",
};

const nextStatusActionLabel: Record<string, string> = {
  Lobby: "Begin Rooming",
  Rooming: "Ready for Provider",
  ReadyForProvider: "Start Visit",
  Optimizing: "Check Out",
  CheckOut: "Complete Check Out",
};

const ROOMING_SERVICE_CAPTURE_KEY = "service.capture_items";
const ICD10_CODE_PATTERN = /^[A-TV-Z][0-9][0-9A-Z](?:\.[0-9A-Z]{1,4})?$/i;
const CPT_HCPCS_CODE_PATTERN = /^(?:\d{5}|[A-Z]\d{4})$/i;

function fmtTimer(totalSec: number): string {
  if (totalSec < 0) return "0:00";
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function parseIsoMs(value?: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseServiceCaptureItems(value: unknown): RevenueServiceCaptureItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const source = entry as Record<string, unknown>;
      const label = typeof source.label === "string" ? source.label.trim() : "";
      if (!label) return null;
      return {
        id: typeof source.id === "string" ? source.id : `service-item-${index + 1}`,
        catalogItemId: typeof source.catalogItemId === "string" ? source.catalogItemId : null,
        label,
        sourceRole: typeof source.sourceRole === "string" ? source.sourceRole : "MA",
        sourceTaskId: typeof source.sourceTaskId === "string" ? source.sourceTaskId : null,
        quantity: Number(source.quantity || 1) > 0 ? Number(source.quantity || 1) : 1,
        note: typeof source.note === "string" ? source.note : null,
        performedAt: typeof source.performedAt === "string" ? source.performedAt : null,
        capturedByUserId: typeof source.capturedByUserId === "string" ? source.capturedByUserId : null,
        suggestedProcedureCode: typeof source.suggestedProcedureCode === "string" ? source.suggestedProcedureCode : null,
        expectedChargeCents: Number.isFinite(Number(source.expectedChargeCents)) ? Number(source.expectedChargeCents) : null,
      } satisfies RevenueServiceCaptureItem;
    })
    .filter((entry): entry is RevenueServiceCaptureItem => Boolean(entry));
}

function splitStructuredCodes(value: unknown) {
  if (typeof value !== "string") return [];
  return value
    .split(/[,\n]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeCodeToken(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

function dedupeCodes(values: string[]) {
  return Array.from(new Set(values));
}

function parseValidatedCodes(
  rawValue: string,
  kind: "diagnosis" | "procedure",
): { valid: string[]; invalid: string[] } {
  const pattern = kind === "diagnosis" ? ICD10_CODE_PATTERN : CPT_HCPCS_CODE_PATTERN;
  const candidates = splitStructuredCodes(rawValue).map(normalizeCodeToken);
  const valid: string[] = [];
  const invalid: string[] = [];
  candidates.forEach((code) => {
    if (pattern.test(code)) valid.push(code);
    else invalid.push(code);
  });
  return { valid: dedupeCodes(valid), invalid: dedupeCodes(invalid) };
}

function stageDurationSeconds(encounter: Encounter, status: EncounterStatus, nowMs: number) {
  if (status === "Incoming" || status === "Optimized") return null;

  const events = [...(encounter.statusEvents || [])]
    .flatMap((event) => {
      const atMs = parseIsoMs(event.changedAt);
      return atMs === null ? [] : [{ ...event, atMs }];
    })
    .sort((a, b) => a.atMs - b.atMs);

  const entryEvent = events.find((event) => event.toStatus === status);
  const fallbackStart =
    status === "Lobby"
      ? parseIsoMs(encounter.checkInAtIso)
      : status === encounter.status
        ? parseIsoMs(encounter.currentStageStartAtIso)
        : null;
  const startMs = entryEvent?.atMs ?? fallbackStart;
  if (startMs === null) return null;

  const statusIdx = statusFlow.indexOf(status);
  const currentIdx = statusFlow.indexOf(encounter.status);
  const isCurrent = status === encounter.status;
  const exitEvent = events.find(
    (event) =>
      event.atMs > startMs &&
      (event.fromStatus === status || statusFlow.indexOf(event.toStatus) > statusIdx),
  );
  const endMs =
    isCurrent || currentIdx === statusIdx
      ? nowMs
      : exitEvent?.atMs ?? (statusIdx < currentIdx ? parseIsoMs(encounter.completedAtIso) : null);
  if (endMs === null || endMs <= startMs) return null;

  return Math.max(0, Math.floor((endMs - startMs) / 1000));
}

function stageDurationLabel(encounter: Encounter, status: EncounterStatus, nowMs: number) {
  const seconds = stageDurationSeconds(encounter, status, nowMs);
  if (seconds === null) return null;
  return fmtTimer(seconds);
}

// ── Task type config ──

const taskTypeConfig: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  rooming: { label: "Room", color: "#8b5cf6", icon: DoorOpen },
  vitals: { label: "Vitals", color: "#6366f1", icon: Activity },
  prep: { label: "Prep", color: "#0ea5e9", icon: ClipboardList },
  service_capture: { label: "Service Capture", color: "#0891b2", icon: FileText },
  followup: { label: "Follow-up", color: "#10b981", icon: ListChecks },
  alert_ack: { label: "Alert", color: "#f59e0b", icon: Bell },
  reassignment: { label: "Reassign", color: "#ec4899", icon: Users },
};

// ── Task creation types (from TaskSchema) ──

type NewTask = {
  taskType: string;
  description: string;
  assignedToRole: string;
  priority: number;
  blocking: boolean;
};

const emptyTask: NewTask = {
  taskType: "",
  description: "",
  assignedToRole: "",
  priority: 3,
  blocking: false,
};

const taskTypeOptions = [
  { value: "service_capture", label: "Service Capture" },
  { value: "lab_order", label: "Lab Order" },
  { value: "referral", label: "Referral" },
  { value: "prescription", label: "Prescription" },
  { value: "imaging", label: "Imaging" },
  { value: "followup", label: "Follow-up" },
  { value: "patient_education", label: "Patient Education" },
  { value: "prior_auth", label: "Prior Authorization" },
  { value: "other", label: "Other" },
];

const roleOptions = [
  { value: "FrontDeskCheckIn", label: "Front Desk (Check-In)" },
  { value: "MA", label: "Medical Assistant" },
  { value: "Clinician", label: "Clinician" },
  { value: "FrontDeskCheckOut", label: "Front Desk (Check-Out)" },
  { value: "OfficeManager", label: "Office Manager" },
  { value: "RevenueCycle", label: "Revenue Cycle" },
  { value: "Admin", label: "Admin" },
];

const priorityOptions = [
  { value: 1, label: "Urgent", color: "#ef4444" },
  { value: 2, label: "High", color: "#f59e0b" },
  { value: 3, label: "Normal", color: "#3b82f6" },
  { value: 4, label: "Low", color: "#94a3b8" },
];

// ── Templates ──

type TemplateField = {
  key?: string;
  name: string;
  type:
    | "text"
    | "checkbox"
    | "select"
    | "textarea"
    | "number"
    | "radio"
    | "date"
    | "time"
    | "bloodPressure"
    | "temperature"
    | "pulse"
    | "respirations"
    | "oxygenSaturation"
    | "height"
    | "weight"
    | "painScore"
    | "yesNo";
  required: boolean;
  options?: string[];
  group?: string;
};

const standardRoomingFields: TemplateField[] = [
  { key: "allergiesChanged", name: "Allergies changed", type: "yesNo", required: true, group: "Standard Rooming" },
  { key: "medicationReconciliationChanged", name: "Medication reconciliation changed", type: "yesNo", required: true, group: "Standard Rooming" },
  { key: "labChanged", name: "Lab changed", type: "yesNo", required: true, group: "Standard Rooming" },
  { key: "pharmacyChanged", name: "Pharmacy changed", type: "yesNo", required: true, group: "Standard Rooming" },
];

function fieldKey(field: TemplateField) {
  return field.key || field.name;
}

function isTemplateFieldComplete(field: TemplateField, value: string | boolean | undefined) {
  if (field.type === "checkbox") return Boolean(value);
  if (field.type === "yesNo") return value !== undefined;
  if (typeof value === "string") return value.trim().length > 0;
  return Boolean(value);
}

function normalizeRuntimeTemplateFields(input: any[]): TemplateField[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((field, index) => {
      const key = String(field?.key || field?.name || `field_${index + 1}`).trim();
      const label = String(field?.label || field?.name || key).trim();
      const typeRaw = String(field?.type || "text").toLowerCase();
      const type =
        typeRaw === "textarea" ||
        typeRaw === "number" ||
        typeRaw === "checkbox" ||
        typeRaw === "select" ||
        typeRaw === "radio" ||
        typeRaw === "date" ||
        typeRaw === "time" ||
        typeRaw === "bloodpressure" ||
        typeRaw === "temperature" ||
        typeRaw === "pulse" ||
        typeRaw === "respirations" ||
        typeRaw === "oxygensaturation" ||
        typeRaw === "height" ||
        typeRaw === "weight" ||
        typeRaw === "painscore" ||
        typeRaw === "yesno"
          ? ({
              bloodpressure: "bloodPressure",
              oxygensaturation: "oxygenSaturation",
              painscore: "painScore",
              yesno: "yesNo",
            }[typeRaw] as TemplateField["type"] | undefined) || (typeRaw as TemplateField["type"])
          : "text";
      return {
        key,
        name: label,
        type,
        required: Boolean(field?.required),
        options: Array.isArray(field?.options) ? field.options.map((option: unknown) => String(option)) : undefined,
        group: field?.group ? String(field.group) : undefined,
      } as TemplateField;
    })
    .filter((field) => field.key && field.name);
}

function normalizeRuntimeTemplateFieldsFromTemplate(template: any): TemplateField[] {
  const normalized = normalizeRuntimeTemplateFields(
    Array.isArray(template?.fields)
      ? template.fields
      : Array.isArray(template?.fieldsJson)
        ? template.fieldsJson
        : [],
  );
  if (normalized.length > 0) return normalized;

  const properties =
    template?.jsonSchema?.properties && typeof template.jsonSchema.properties === "object"
      ? template.jsonSchema.properties
      : {};
  const required = new Set(Array.isArray(template?.requiredFields) ? template.requiredFields : []);
  const derived = Object.entries(properties).map(([key, definition]) => {
    const rawType = String((definition as any)?.type || "text");
    const enumValues = Array.isArray((definition as any)?.enum) ? (definition as any).enum : undefined;
    return {
      key,
      name: String((definition as any)?.title || key),
      type:
        rawType === "boolean"
          ? "checkbox"
          : rawType === "number" || rawType === "integer"
            ? "number"
            : enumValues
              ? "select"
              : "text",
      required: required.has(key),
      options: enumValues ? enumValues.map((entry: unknown) => String(entry)) : undefined,
    } as TemplateField;
  });
  return derived;
}

const clinicianTemplates: Record<string, TemplateField[]> = {
  "Follow-up": [
    { name: "Interval History", type: "textarea", required: true },
    { name: "Physical Exam Performed", type: "checkbox", required: true },
    { name: "Assessment", type: "textarea", required: true },
    { name: "Plan", type: "textarea", required: true },
    { name: "Medication Changes Made", type: "checkbox", required: false },
    { name: "Labs Ordered", type: "checkbox", required: false },
    { name: "Referrals Made", type: "checkbox", required: false },
    { name: "Follow-up Interval", type: "select", required: true, options: ["1 week", "2 weeks", "1 month", "3 months", "6 months", "PRN"] },
    { name: "Clinician Notes", type: "textarea", required: false },
  ],
  "Annual Physical": [
    { name: "Review of Systems", type: "textarea", required: true },
    { name: "Physical Exam", type: "textarea", required: true },
    { name: "Preventive Screenings Reviewed", type: "checkbox", required: true },
    { name: "Immunizations Updated", type: "checkbox", required: true },
    { name: "Assessment", type: "textarea", required: true },
    { name: "Plan", type: "textarea", required: true },
    { name: "Health Maintenance Orders", type: "textarea", required: false },
    { name: "Follow-up Interval", type: "select", required: true, options: ["6 months", "1 year"] },
    { name: "Clinician Notes", type: "textarea", required: false },
  ],
  "Sick Visit": [
    { name: "History of Present Illness", type: "textarea", required: true },
    { name: "Physical Exam", type: "textarea", required: true },
    { name: "Assessment / Diagnosis", type: "textarea", required: true },
    { name: "Plan", type: "textarea", required: true },
    { name: "Prescriptions Written", type: "checkbox", required: false },
    { name: "Labs Ordered", type: "checkbox", required: false },
    { name: "Return Precautions Given", type: "checkbox", required: true },
    { name: "Follow-up Interval", type: "select", required: true, options: ["If worsens", "2-3 days", "1 week", "PRN"] },
    { name: "Clinician Notes", type: "textarea", required: false },
  ],
  "New Patient": [
    { name: "Comprehensive History", type: "textarea", required: true },
    { name: "Physical Exam", type: "textarea", required: true },
    { name: "Past Medical History Reviewed", type: "checkbox", required: true },
    { name: "Family History Reviewed", type: "checkbox", required: true },
    { name: "Social History Reviewed", type: "checkbox", required: true },
    { name: "Assessment", type: "textarea", required: true },
    { name: "Plan", type: "textarea", required: true },
    { name: "Orders Placed", type: "textarea", required: false },
    { name: "Follow-up Interval", type: "select", required: true, options: ["1 week", "2 weeks", "1 month", "3 months"] },
    { name: "Clinician Notes", type: "textarea", required: false },
  ],
  Procedure: [
    { name: "Informed Consent Confirmed", type: "checkbox", required: true },
    { name: "Time Out Performed", type: "checkbox", required: true },
    { name: "Procedure Note", type: "textarea", required: true },
    { name: "Complications", type: "select", required: true, options: ["None", "Minor", "Major"] },
    { name: "Post-procedure Instructions Given", type: "checkbox", required: true },
    { name: "Follow-up Interval", type: "select", required: true, options: ["Next day", "1 week", "2 weeks"] },
    { name: "Clinician Notes", type: "textarea", required: false },
  ],
  "Lab Work": [
    { name: "Results Reviewed", type: "checkbox", required: true },
    { name: "Findings Summary", type: "textarea", required: true },
    { name: "Actions Taken", type: "textarea", required: false },
    { name: "Clinician Notes", type: "textarea", required: false },
  ],
};

const checkoutTemplates: TemplateField[] = [
  { name: "Follow-up Scheduled", type: "checkbox", required: true },
  { name: "Visit Summary Printed", type: "checkbox", required: true },
  { name: "Referrals Processed", type: "checkbox", required: false },
  { name: "Billing Codes Verified", type: "checkbox", required: true },
  { name: "Copay / Balance Collected", type: "checkbox", required: false },
  { name: "Prescriptions Sent", type: "checkbox", required: false },
  { name: "Patient Education Provided", type: "checkbox", required: false },
  { name: "Checkout Notes", type: "textarea", required: false },
];

function getTemplateForStatus(
  status: EncounterStatus,
  visitType: string,
  runtimeTemplates: {
    rooming: Record<string, TemplateField[]>;
    clinician: Record<string, TemplateField[]>;
    checkout: Record<string, TemplateField[]>;
  },
): { label: string; fields: TemplateField[] } {
  if (status === "Rooming") {
    return { label: "Rooming Template", fields: runtimeTemplates.rooming[visitType] ?? [] };
  }
  if (status === "Optimizing" || status === "ReadyForProvider") {
    return { label: "Clinician Template", fields: runtimeTemplates.clinician[visitType] ?? clinicianTemplates[visitType] ?? [] };
  }
  if (status === "CheckOut") {
    return { label: "Checkout Template", fields: runtimeTemplates.checkout[visitType] ?? checkoutTemplates };
  }
  return { label: "", fields: [] };
}

// ── Group helpers ──

const groupIcons: Record<string, React.ElementType> = {
  Vitals: Heart,
  Assessment: FileText,
  Review: CheckCircle2,
  Screenings: Activity,
  "History Check-In": ClipboardList,
  "Pre-Procedure": Shield,
  "Lab Prep": ClipboardList,
  Notes: StickyNote,
};

const groupColors: Record<string, string> = {
  Vitals: "#ef4444",
  Assessment: "#6366f1",
  Review: "#10b981",
  Screenings: "#f59e0b",
  "History Check-In": "#8b5cf6",
  "Pre-Procedure": "#0ea5e9",
  "Lab Prep": "#0ea5e9",
  Notes: "#94a3b8",
};

function groupFields(fields: TemplateField[]): { group: string; fields: TemplateField[] }[] {
  const groups: { group: string; fields: TemplateField[] }[] = [];
  const seen = new Set<string>();
  for (const f of fields) {
    const g = f.group || "General";
    if (!seen.has(g)) {
      seen.add(g);
      groups.push({ group: g, fields: [] });
    }
    groups.find((x) => x.group === g)!.fields.push(f);
  }
  return groups;
}

// ══════════════════════════════════════════════════════════
// ── Main Component ──
// ══════════════════════════════════════════════════════════

export function EncounterDetailView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const ctx = useEncounters();
  const session = loadSession();
  const isAdminUser = session?.role === "Admin";
  const isRevenueReadOnly = session?.role === "RevenueCycle";

  // Find the base encounter from shared context
  const baseEnc = ctx.getEncounter(id!);
  const [loadingEncounter, setLoadingEncounter] = useState(false);
  const [encounterLoadError, setEncounterLoadError] = useState<string | null>(null);

  // ── Local state for status transitions ──
  const [localStatus, setLocalStatus] = useState<EncounterStatus | null>(null);
  const [localRoom, setLocalRoom] = useState<string>("");
  const [roomingNotes, setRoomingNotes] = useState<string>("");
  const [localStageStartIso, setLocalStageStartIso] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const [safetyModal, setSafetyModal] = useState<"activate" | "resolve" | null>(null);
  const [templateValues, setTemplateValues] = useState<Record<string, Record<string, string | boolean>>>({});
  const [diagnosisInput, setDiagnosisInput] = useState("");
  const [procedureInput, setProcedureInput] = useState("");
  const [completedStages, setCompletedStages] = useState<Set<EncounterStatus>>(new Set());
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [newTask, setNewTask] = useState<NewTask>({ ...emptyTask });
  const [showRequiredFieldErrors, setShowRequiredFieldErrors] = useState(false);
  const [runtimeTemplates, setRuntimeTemplates] = useState<{
    rooming: Record<string, TemplateField[]>;
    clinician: Record<string, TemplateField[]>;
    checkout: Record<string, TemplateField[]>;
  }>({
    rooming: {},
    clinician: {},
    checkout: {},
  });
  const [operationalRooms, setOperationalRooms] = useState<RoomLiveCard[]>([]);
  const [savingRecoveryRoom, setSavingRecoveryRoom] = useState(false);
  const [revenueCase, setRevenueCase] = useState<RevenueCaseDetail | null>(null);
  const [revenueSettings, setRevenueSettings] = useState<RevenueSettings | null>(null);
  const [serviceCaptureItems, setServiceCaptureItems] = useState<RevenueServiceCaptureItem[]>([]);
  const [customServiceLabel, setCustomServiceLabel] = useState("");
  const [customServiceNote, setCustomServiceNote] = useState("");
  const [clarificationResponses, setClarificationResponses] = useState<Record<string, string>>({});
  const [savingClarificationId, setSavingClarificationId] = useState<string | null>(null);
  const [roomingLaunch] = useState(() => ({
    preferredRoomId: searchParams.get("preferredRoomId") || "",
    lastReadyRoom: searchParams.get("lastReadyRoom") === "true",
  }));

  // Tasks from shared context
  const { maTasks: encMaTasks, createdTasks } = ctx.getTasksForEncounter(id!);

  useEffect(() => {
    if (!id) return;
    if (baseEnc) {
      setEncounterLoadError(null);
      setLoadingEncounter(false);
      return;
    }

    let mounted = true;
    setLoadingEncounter(true);
    setEncounterLoadError(null);
    ctx.fetchEncounter(id)
      .then((encounter) => {
        if (!mounted) return;
        if (!encounter) {
          setEncounterLoadError("Encounter not found");
        }
      })
      .catch((error) => {
        if (!mounted) return;
        setEncounterLoadError((error as Error).message || "Unable to load encounter");
      })
      .finally(() => {
        if (mounted) setLoadingEncounter(false);
      });

    return () => {
      mounted = false;
    };
  }, [baseEnc, ctx.fetchEncounter, id]);

  useEffect(() => {
    let mounted = true;
    const loadRuntimeTemplates = async () => {
      const facilityId = loadSession()?.facilityId;
      const [reasonRowsResult, roomingRowsResult, clinicianRowsResult, checkoutRowsResult, revenueSettingsResult] =
        await Promise.allSettled([
          admin.listReasons({ facilityId, includeInactive: true, includeArchived: false }),
          admin.listTemplates({ facilityId, type: "rooming" }),
          admin.listTemplates({ facilityId, type: "clinician" }),
          admin.listTemplates({ facilityId, type: "checkout" }),
          admin.getRevenueSettings(facilityId),
        ]);
      if (!mounted) return;

      const reasonRows = reasonRowsResult.status === "fulfilled" ? reasonRowsResult.value : [];
      const roomingRows = roomingRowsResult.status === "fulfilled" ? roomingRowsResult.value : [];
      const clinicianRows = clinicianRowsResult.status === "fulfilled" ? clinicianRowsResult.value : [];
      const checkoutRows = checkoutRowsResult.status === "fulfilled" ? checkoutRowsResult.value : [];

      const reasonNameById = new Map<string, string>(
        (reasonRows as any[]).map((reason) => [String(reason.id), String(reason.name)]),
      );

      const mapped = {
        rooming: {} as Record<string, TemplateField[]>,
        clinician: {} as Record<string, TemplateField[]>,
        checkout: {} as Record<string, TemplateField[]>,
      };

      ([
        ["rooming", roomingRows],
        ["clinician", clinicianRows],
        ["checkout", checkoutRows],
      ] as const).forEach(([type, rows]) => {
        (rows as any[]).forEach((template) => {
          const reasonIds: string[] = Array.isArray(template.reasonIds)
            ? template.reasonIds
            : template.reasonForVisitId
              ? [template.reasonForVisitId]
              : [];
          const normalizedFields = normalizeRuntimeTemplateFieldsFromTemplate(template);
          reasonIds.forEach((reasonId) => {
            const reasonName = reasonNameById.get(String(reasonId));
            if (reasonName) {
              mapped[type][reasonName] = normalizedFields;
            }
          });
        });
      });

      setRuntimeTemplates(mapped);
      setRevenueSettings(revenueSettingsResult.status === "fulfilled" ? revenueSettingsResult.value : null);
    };

    loadRuntimeTemplates().catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    if (!baseEnc?.clinicId) {
      setOperationalRooms([]);
      return;
    }
    roomsApi.live({ mine: true, clinicId: baseEnc.clinicId })
      .then((rows) => {
        if (mounted) setOperationalRooms(rows || []);
      })
      .catch(() => {
        if (mounted) setOperationalRooms([]);
      });
    return () => {
      mounted = false;
    };
  }, [baseEnc?.clinicId]);

  useEffect(() => {
    let mounted = true;
    if (!id) {
      setRevenueCase(null);
      return;
    }
    revenueCases.list({ encounterId: id })
      .then((rows) => {
        if (!mounted) return;
        const nextRevenueCase = rows?.[0] || null;
        setRevenueCase(nextRevenueCase);
        setClarificationResponses(
          Object.fromEntries(
            (nextRevenueCase?.providerClarifications || []).map((item) => [item.id, item.responseText || ""]),
          ),
        );
      })
      .catch(() => {
        if (mounted) setRevenueCase(null);
      });
    return () => {
      mounted = false;
    };
  }, [id, baseEnc?.version, baseEnc?.status]);

  // Initialize local state from encounter
  useEffect(() => {
    if (baseEnc) {
      setLocalStatus(null); // null means "use baseEnc.status"
      setLocalRoom(baseEnc.roomNumber || "");
      setLocalStageStartIso(null);
      setShowRequiredFieldErrors(false);
    }
  }, [baseEnc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const roomingValues = (baseEnc?.roomingData || {}) as Record<string, unknown>;
    setServiceCaptureItems(parseServiceCaptureItems(roomingValues[ROOMING_SERVICE_CAPTURE_KEY]));
  }, [baseEnc?.id, baseEnc?.roomingData]);

  useEffect(() => {
    if (!roomingLaunch.preferredRoomId || operationalRooms.length === 0) return;
    const preferred = operationalRooms.find((room) => room.roomId === roomingLaunch.preferredRoomId);
    if (preferred) {
      setLocalRoom(preferred.name);
    }
  }, [operationalRooms, roomingLaunch.preferredRoomId]);

  useEffect(() => {
    setShowRequiredFieldErrors(false);
  }, [localStatus, baseEnc?.status]);

  // Auto-advance from Lobby -> Rooming or ReadyForProvider -> Optimizing when arriving with query actions.
  useEffect(() => {
    if (!baseEnc) return;
    const startRooming = searchParams.get("startRooming");
    const startVisit = searchParams.get("startVisit");
    const effectiveStatus = localStatus ?? baseEnc.status;

    if (startRooming === "true" && effectiveStatus === "Lobby") {
      setCompletedStages((prev) => new Set([...prev, "Lobby"]));
      setLocalStatus("Rooming");
      setLocalStageStartIso(new Date().toISOString());
      ctx.advanceStatus(baseEnc.id, "Rooming");
      toast.success(`${baseEnc.patientId} → ${statusLabels["Rooming"]}`, {
        description: "Rooming workflow started",
      });
      setSearchParams({}, { replace: true });
      return;
    }

    if (startVisit === "true" && effectiveStatus === "ReadyForProvider") {
      setCompletedStages((prev) => new Set([...prev, "ReadyForProvider"]));
      setLocalStatus("Optimizing");
      setLocalStageStartIso(new Date().toISOString());
      ctx.advanceStatus(baseEnc.id, "Optimizing");
      toast.success(`${baseEnc.patientId} → ${statusLabels["Optimizing"]}`, {
        description: "Visit started from Clinician Board",
      });
      setSearchParams({}, { replace: true });
    }
  }, [baseEnc, searchParams, localStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // ── Keyboard shortcut: Cmd+Enter to advance ──
  // (handleAdvance is defined below after baseEnc null check, so we use an effect + event pattern)
  useEffect(() => {
    function onAdvance() {
      // Will be dispatched by the keyboard handler
      const btn = document.querySelector<HTMLButtonElement>("[data-advance-btn]");
      if (btn && !btn.disabled) btn.click();
    }
    document.addEventListener("clinops:advance", onAdvance);
    return () => document.removeEventListener("clinops:advance", onAdvance);
  }, []);

  useKeyboardShortcuts(
    useMemo(
      () => [
        {
          key: "Enter",
          meta: true,
          handler: () => {
            document.dispatchEvent(new CustomEvent("clinops:advance"));
          },
        },
      ],
      [],
    ),
  );

  // Keep hook ordering stable even when the encounter is temporarily unavailable.
  useEffect(() => {
    if (!baseEnc || !showRequiredFieldErrors) return;
    const status = localStatus ?? baseEnc.status;
    const { fields } = getTemplateForStatus(status, baseEnc.visitType, runtimeTemplates);
    const currentVals = templateValues[status] || {};
    const required = (status === "Rooming" ? [...standardRoomingFields, ...fields] : fields).filter((field) => field.required);
    const allComplete = required.every((field) =>
      isTemplateFieldComplete(field, currentVals[fieldKey(field)]),
    );
    if (status === "Rooming") {
      if (!allComplete || !localRoom) return;
    } else if (!allComplete) {
      return;
    }
    setShowRequiredFieldErrors(false);
  }, [baseEnc, showRequiredFieldErrors, localStatus, runtimeTemplates, templateValues, localRoom]);

  const safeStatus = (localStatus ?? baseEnc?.status ?? "Lobby") as EncounterStatus;
  const safeVisitType = baseEnc?.visitType || "";
  const safeTemplateVals = templateValues[safeStatus] || {};
  const safeTemplate = getTemplateForStatus(safeStatus, safeVisitType, runtimeTemplates);
  const clinicianDiagnosisParse = useMemo(
    () => parseValidatedCodes(String(safeTemplateVals["coding.working_diagnosis_codes_text"] || ""), "diagnosis"),
    [safeTemplateVals],
  );
  const clinicianProcedureParse = useMemo(
    () => parseValidatedCodes(String(safeTemplateVals["coding.working_procedure_codes_text"] || ""), "procedure"),
    [safeTemplateVals],
  );
  const clinicianDiagnosisCodes = clinicianDiagnosisParse.valid;
  const clinicianProcedureCodes = clinicianProcedureParse.valid;
  const suggestedProcedureCodes = useMemo(
    () =>
      dedupeCodes(
        serviceCaptureItems
          .map((item) => item.suggestedProcedureCode)
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .map(normalizeCodeToken),
      ),
    [serviceCaptureItems],
  );
  const diagnosisSearchResults = useMemo(() => searchClinicalCodes("diagnosis", diagnosisInput), [diagnosisInput]);
  const procedureSearchResults = useMemo(() => searchClinicalCodes("procedure", procedureInput), [procedureInput]);

  if (!baseEnc && loadingEncounter) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <Activity className="w-12 h-12 text-violet-300 mx-auto mb-3 animate-spin" />
          <h2 className="text-[18px]" style={{ fontWeight: 600 }}>Loading encounter</h2>
          <p className="text-[13px] text-muted-foreground mt-1">Fetching encounter {id}</p>
        </div>
      </div>
    );
  }

  if (!baseEnc) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <FileText className="w-12 h-12 text-gray-200 mx-auto mb-3" />
          <h2 className="text-[18px]" style={{ fontWeight: 600 }}>{encounterLoadError ? "Unable to load encounter" : "Encounter not found"}</h2>
          <p className="text-[13px] text-muted-foreground mt-1">{encounterLoadError || `ID: ${id}`}</p>
          <button
            onClick={() => navigate(-1)}
            className="mt-4 px-4 py-2 rounded-lg bg-gray-100 text-[13px] text-gray-600 hover:bg-gray-200 transition-colors"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  // Effective encounter = base + local overrides
  const currentStatus = localStatus ?? baseEnc.status;
  const enc = {
    ...baseEnc,
    status: currentStatus,
    roomNumber: localRoom || baseEnc.roomNumber,
    currentStageStartAtIso: localStatus !== null ? localStageStartIso || baseEnc.currentStageStartAtIso : baseEnc.currentStageStartAtIso,
  };

  // Available rooms for this clinic. Operational data wins so non-ready rooms cannot be selected.
  const fallbackRooms = ctx.getAvailableRoomsForClinic(baseEnc.clinicId).map((room) => ({
    id: room.id,
    roomId: room.id,
    name: room.name,
    operationalStatus: "Ready" as const,
  }));
  const availableRooms = operationalRooms.length > 0 ? operationalRooms : fallbackRooms;
  const readyRooms = availableRooms.filter((room) => room.operationalStatus === "Ready");
  const nonReadyRooms = availableRooms.filter((room) => room.operationalStatus !== "Ready");
  const selectedOperationalRoom = availableRooms.find((room) => room.name === localRoom);
  const lastReadyRoomSelected = roomingLaunch.lastReadyRoom && selectedOperationalRoom?.roomId === roomingLaunch.preferredRoomId;

  const canEditRecoveryRoom = isAdminUser && enc.status !== "Optimized" && enc.status !== "Rooming";
  const recoveryRoomOptions = (() => {
    const options = new Map<string, { value: string; label: string; disabled?: boolean }>();
    options.set("", { value: "", label: "No room assigned" });
    if (enc.roomNumber) {
      options.set(enc.roomNumber, { value: enc.roomNumber, label: `${enc.roomNumber} (current)` });
    }
    readyRooms.forEach((room) => {
      options.set(room.name, { value: room.name, label: room.name });
    });
    nonReadyRooms.forEach((room) => {
      if (!options.has(room.name)) {
        options.set(room.name, {
          value: room.name,
          label: `${room.name} - ${room.operationalStatus}`,
          disabled: true,
        });
      }
    });
    return Array.from(options.values());
  })();

  async function saveRecoveryRoomAssignment() {
    setSavingRecoveryRoom(true);
    try {
      const selectedRoom = availableRooms.find((room) => room.name === localRoom);
      const roomId = localRoom === "" ? null : selectedRoom?.roomId || selectedRoom?.id || null;

      if (localRoom && !roomId) {
        throw new Error("Select a valid room before saving.");
      }

      await encounterApi.updateRooming(enc.id, { roomId });
      await ctx.refreshData();
      const refreshed = await ctx.fetchEncounter(enc.id, { force: true });
      setLocalRoom(refreshed?.roomNumber || "");
      toast.success("Encounter room updated", {
        description: roomId ? `${enc.patientId} is now assigned to ${localRoom}.` : `${enc.patientId} is no longer assigned to a room.`,
      });
    } catch (error) {
      toast.error("Unable to update encounter room", {
        description: (error as Error).message || "The room assignment could not be saved.",
      });
    } finally {
      setSavingRecoveryRoom(false);
    }
  }

  const statusColor = statusColors[enc.status];
  const currentIdx = statusFlow.indexOf(enc.status);
  const threshold = defaultThresholds.find((t) => t.status === enc.status);
  const encTasks = encMaTasks;
  const { label: templateLabel, fields: templateFields } = safeTemplate;
  const canAdvance = !!nextStatusMap[enc.status];

  const currentTemplateVals = templateValues[enc.status] || {};
  const fieldsForCompletion = enc.status === "Rooming" ? [...standardRoomingFields, ...templateFields] : templateFields;
  const requiredFields = fieldsForCompletion.filter((f) => f.required);
  const requiredCount = requiredFields.length;
  const completedCount = requiredFields.filter((f) => isTemplateFieldComplete(f, currentTemplateVals[fieldKey(f)])).length;
  const allRequiredComplete = requiredCount > 0 ? completedCount === requiredCount : true;
  const missingRequiredFields = requiredFields.filter(
    (field) => !isTemplateFieldComplete(field, currentTemplateVals[fieldKey(field)]),
  );

  // For rooming: also need room assigned
  const roomingReady = enc.status === "Rooming" ? allRequiredComplete && !!localRoom && serviceCaptureItems.length > 0 : allRequiredComplete;

  const stageSec = getEncounterStageSeconds(enc, nowMs);

  const totalSec = getEncounterTotalSeconds(enc, nowMs);

  const stageColor =
    enc.alertLevel === "Red" ? "#ef4444" : enc.alertLevel === "Yellow" ? "#f59e0b" : statusColor;

  // Vitals: extract from saved rooming data (or in-progress values) once rooming is completed
  const capturedVitals = (() => {
    const roomingVals = (enc.roomingData as Record<string, unknown> | null) || templateValues["Rooming"];
    if (!roomingVals) return null;
    if (!completedStages.has("Rooming") && !["ReadyForProvider", "Optimizing", "CheckOut", "Optimized"].includes(enc.status)) return null;
    const read = (...keys: string[]) => {
      for (const key of keys) {
        const value = roomingVals[key];
        if (value !== undefined && value !== null && String(value).trim() !== "") return String(value);
      }
      return null;
    };
    const readBool = (...keys: string[]) => {
      for (const key of keys) {
        const value = roomingVals[key];
        if (typeof value === "boolean") return value;
        if (typeof value === "string") {
          const normalized = value.trim().toLowerCase();
          if (["true", "yes", "y", "1", "completed"].includes(normalized)) return true;
          if (["false", "no", "n", "0", "not completed"].includes(normalized)) return false;
        }
      }
      return false;
    };
    const readYesNo = (...keys: string[]) => {
      for (const key of keys) {
        const value = roomingVals[key];
        if (typeof value === "boolean") return value ? "Yes" : "No";
        if (typeof value === "string") {
          const normalized = value.trim().toLowerCase();
          if (["true", "yes", "y", "1"].includes(normalized)) return "Yes";
          if (["false", "no", "n", "0"].includes(normalized)) return "No";
        }
      }
      return "Not recorded";
    };
    return {
      reasonForVisit: read("reason_for_visit", "Reason for Visit"),
      bloodPressure: read("bp", "BP", "blood_pressure", "Blood Pressure"),
      heartRate: read("pulse", "Pulse", "heart_rate", "Heart Rate"),
      temperature: read("temperature", "Temperature"),
      weight: read("weight", "Weight"),
      height: read("height", "Height"),
      o2Sat: read("oxygen_saturation", "Oxygen Saturation", "o2_saturation", "O2 Saturation"),
      allergyReview: readBool("allergy_review", "Allergy Review"),
      medicationReconciliation: readBool("medication_reconciliation", "Medication Reconciliation"),
      allergiesChanged: readYesNo("allergiesChanged"),
      medicationReconciliationChanged: readYesNo("medicationReconciliationChanged"),
      labChanged: readYesNo("labChanged"),
      pharmacyChanged: readYesNo("pharmacyChanged"),
    };
  })();

  function setFieldValue(fieldName: string, value: string | boolean) {
    setTemplateValues((prev) => ({
      ...prev,
      [enc.status]: { ...(prev[enc.status] || {}), [fieldName]: value },
    }));
  }

  function setCodeListField(fieldName: "coding.working_diagnosis_codes_text" | "coding.working_procedure_codes_text", codes: string[]) {
    setFieldValue(fieldName, codes.join(", "));
  }

  function addStructuredCode(kind: "diagnosis" | "procedure", rawValue?: string) {
    const input = rawValue ?? (kind === "diagnosis" ? diagnosisInput : procedureInput);
    const { valid, invalid } = parseValidatedCodes(input, kind);
    if (valid.length === 0) {
      toast.error(kind === "diagnosis" ? "Add a valid ICD-10 code" : "Add a valid CPT / HCPCS code", {
        description:
          kind === "diagnosis"
            ? "Use ICD-10 format like J01.90."
            : "Use CPT/HCPCS format like 99213.",
      });
      return;
    }

    const nextCodes = dedupeCodes([
      ...(kind === "diagnosis" ? clinicianDiagnosisCodes : clinicianProcedureCodes),
      ...valid,
    ]);
    setCodeListField(
      kind === "diagnosis" ? "coding.working_diagnosis_codes_text" : "coding.working_procedure_codes_text",
      nextCodes,
    );

    if (kind === "diagnosis") setDiagnosisInput("");
    else setProcedureInput("");

    if (invalid.length > 0) {
      toast.error("Some codes were not added", {
        description: invalid.join(", "),
      });
    }
  }

  function removeStructuredCode(kind: "diagnosis" | "procedure", code: string) {
    const nextCodes = (kind === "diagnosis" ? clinicianDiagnosisCodes : clinicianProcedureCodes).filter((entry) => entry !== code);
    setCodeListField(
      kind === "diagnosis" ? "coding.working_diagnosis_codes_text" : "coding.working_procedure_codes_text",
      nextCodes,
    );
  }

  function addServiceCaptureFromCatalog(catalogItemId: string) {
    const catalogItem = (revenueSettings?.serviceCatalog || []).find((item) => item.id === catalogItemId);
    if (!catalogItem) return;
    setServiceCaptureItems((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        catalogItemId: catalogItem.id,
        label: catalogItem.label,
        sourceRole: "MA",
        sourceTaskId: null,
        quantity: 1,
        note: null,
        performedAt: new Date().toISOString(),
        capturedByUserId: session?.userId || null,
        suggestedProcedureCode: catalogItem.suggestedProcedureCode,
        expectedChargeCents: catalogItem.expectedChargeCents,
      },
    ]);
  }

  function addCustomServiceCapture() {
    if (!customServiceLabel.trim()) {
      toast.error("Add a service label before saving other service capture.");
      return;
    }
    setServiceCaptureItems((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        catalogItemId: null,
        label: customServiceLabel.trim(),
        sourceRole: "MA",
        sourceTaskId: null,
        quantity: 1,
        note: customServiceNote.trim() || null,
        performedAt: new Date().toISOString(),
        capturedByUserId: session?.userId || null,
        suggestedProcedureCode: null,
        expectedChargeCents: null,
      },
    ]);
    setCustomServiceLabel("");
    setCustomServiceNote("");
  }

  function removeServiceCaptureItem(itemId: string) {
    setServiceCaptureItems((prev) => prev.filter((item) => item.id !== itemId));
  }

  function handleAdvance() {
    if (isRevenueReadOnly) {
      toast.info("Revenue Cycle review is read-only", {
        description: "Clinical workflow changes stay with the care team roles.",
      });
      return;
    }
    const next = nextStatusMap[enc.status];
    if (!next) return;

    if (!allRequiredComplete) {
      setShowRequiredFieldErrors(true);
      toast.error("Complete required fields before advancing", {
        description: `${completedCount}/${requiredCount} required fields complete`,
      });
      return;
    }

    // For rooming → ReadyForProvider: validate
    if (enc.status === "Rooming" && !roomingReady) {
      setShowRequiredFieldErrors(true);
      toast.error("Complete all required fields before advancing", {
        description: `${completedCount}/${requiredCount} required fields complete${!localRoom ? ", room not assigned" : ""}${serviceCaptureItems.length === 0 ? ", service capture not documented" : ""}`,
      });
      return;
    }

    if (
      enc.status === "Optimizing" &&
      (clinicianDiagnosisCodes.length === 0 || clinicianProcedureCodes.length === 0)
    ) {
      toast.error("Complete the structured coding handoff before checkout", {
        description: "Add at least one diagnosis code and one procedure code before checkout.",
      });
      return;
    }

    setShowRequiredFieldErrors(false);

    // Mark current stage as completed
    setCompletedStages((prev) => new Set([...prev, enc.status]));

    const roomingDataForSave =
      enc.status === "Rooming"
        ? {
            ...(templateValues["Rooming"] || {}),
            [ROOMING_SERVICE_CAPTURE_KEY]: serviceCaptureItems,
          }
        : undefined;

    // Transition locally AND in shared context
    setLocalStatus(next);
    setLocalStageStartIso(new Date().toISOString());
    ctx.advanceStatus(
      enc.id,
      next,
      enc.status === "Rooming"
        ? { roomNumber: localRoom, roomingData: roomingDataForSave as Record<string, unknown> }
        : enc.status === "Optimizing"
          ? { clinicianData: (templateValues["Optimizing"] || {}) as Record<string, unknown> }
          : undefined,
    );

    const advanceDescription =
      enc.status === "Optimizing" && currentTemplateVals["coding.documentation_complete"] !== true
        ? "Moved to checkout. Revenue will keep documentation incomplete flagged until the clinician finishes it."
        : `Encounter ${enc.id} advanced from ${statusLabels[enc.status]}`;

    toast.success(`${enc.patientId} → ${statusLabels[next]}`, {
      description: advanceDescription,
    });

    // When completing the provider visit (Optimizing → CheckOut), return to Clinician Board
    if (enc.status === "Optimizing" && next === "CheckOut") {
      navigate("/clinician");
    }
  }

  async function respondToRevenueClarification(clarificationId: string, resolve = false) {
    const responseText = clarificationResponses[clarificationId]?.trim();
    if (!responseText) {
      toast.error("Add a response before sending it back to Revenue Cycle.");
      return;
    }
    setSavingClarificationId(clarificationId);
    try {
      await revenueCases.updateProviderClarification(clarificationId, {
        responseText,
        resolve,
      });
      const refreshedRows = await revenueCases.list({ encounterId: enc.id });
      const refreshedCase = refreshedRows?.[0] || null;
      setRevenueCase(refreshedCase);
      if (refreshedCase) {
        setClarificationResponses(
          Object.fromEntries(
            refreshedCase.providerClarifications.map((item) => [item.id, item.responseText || ""]),
          ),
        );
      }
      toast.success(resolve ? "Revenue clarification resolved" : "Response sent to Revenue Cycle");
    } catch (error) {
      toast.error("Unable to update revenue clarification", {
        description: (error as Error).message || "Try again.",
      });
    } finally {
      setSavingClarificationId(null);
    }
  }

  // Grouped template fields for rooming
  const fieldGroups = groupFields(templateFields);
  const hasGroups = templateFields.some((f) => f.group);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ── Top Header ── */}
      <div className="shrink-0 bg-white border-b border-gray-100">
        <div
          className="h-1"
          style={{
            background:
              enc.alertLevel === "Red"
                ? "linear-gradient(to right, #ef4444, #dc2626)"
                : enc.alertLevel === "Yellow"
                  ? "linear-gradient(to right, #f59e0b, #d97706)"
                  : `linear-gradient(to right, ${statusColor}, ${statusColor}88)`,
          }}
        />

        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <button
                onClick={() => navigate(-1)}
                className="w-8 h-8 rounded-lg border border-gray-200 flex items-center justify-center text-gray-500 hover:text-gray-700 hover:border-gray-300 transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              <div className="flex items-center gap-2.5">
                <span className="text-[18px]" style={{ fontWeight: 700 }}>{enc.patientId}</span>
                <span className="text-[13px] text-muted-foreground">{enc.id}</span>
                <Badge
                  className="border-0 text-[10px] px-2 h-5"
                  style={{ backgroundColor: `${statusColor}15`, color: statusColor, fontWeight: 600 }}
                >
                  {statusLabels[enc.status]}
                </Badge>
                {enc.alertLevel !== "Green" && (
                  <Badge
                    className="border-0 text-[10px] px-2 h-5 flex items-center gap-0.5"
                    style={{
                      backgroundColor: enc.alertLevel === "Red" ? "#fef2f2" : "#fffbeb",
                      color: enc.alertLevel === "Red" ? "#dc2626" : "#d97706",
                      fontWeight: 600,
                    }}
                  >
                    <AlertTriangle className="w-3 h-3" />
                    {enc.alertLevel} Alert
                  </Badge>
                )}
                {enc.safetyActive && (
                  <Badge className="bg-red-600 text-white border-0 text-[10px] px-2 h-5 animate-pulse flex items-center gap-1">
                    <ShieldAlert className="w-3 h-3" /> SAFETY ASSIST
                  </Badge>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              {!isRevenueReadOnly && (
                <button
                  onClick={() => setSafetyModal(enc.safetyActive ? "resolve" : "activate")}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-red-50 text-red-600 border border-red-200 text-[12px] hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-100 transition-colors"
                  style={{ fontWeight: 500 }}
                >
                  <ShieldAlert className="w-3.5 h-3.5" />
                  {enc.safetyActive ? "Turn Off Safety Assist" : "Safety Assist"}
                </button>
              )}
              {!isRevenueReadOnly && canAdvance && enc.status !== "ReadyForProvider" && enc.status !== "Lobby" && (
                <button
                  data-advance-btn
                  onClick={handleAdvance}
                  disabled={enc.status === "Rooming" && !roomingReady}
                  className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-white text-[12px] shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-1 transition-all ${
                    enc.status === "Rooming" && !roomingReady
                      ? "opacity-50 cursor-not-allowed bg-gray-400"
                      : "hover:brightness-110"
                  }`}
                  style={{ fontWeight: 500, backgroundColor: enc.status === "Rooming" && !roomingReady ? undefined : statusColor }}
                >
                  {nextStatusActionLabel[enc.status]}
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Info chips */}
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-1.5 text-[12px] text-gray-600">
              <Stethoscope className="w-3.5 h-3.5 text-gray-400" />
              {enc.provider}
            </div>
            <div className="flex items-center gap-1.5 text-[12px] text-gray-600">
              <FileText className="w-3.5 h-3.5 text-gray-400" />
              {enc.visitType}
            </div>
            {enc.roomNumber && (
              <div className="flex items-center gap-1.5 text-[12px] text-gray-600">
                <DoorOpen className="w-3.5 h-3.5 text-gray-400" />
                {enc.roomNumber}
              </div>
            )}
            {enc.assignedMA && (
              <div className="flex items-center gap-1.5 text-[12px] text-gray-600">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: enc.maColor || "#94a3b8" }} />
                {enc.assignedMA}
              </div>
            )}
            <div className="flex items-center gap-1.5 text-[12px] text-gray-600">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: enc.clinicColor }} />
              {enc.clinicName}
            </div>
            {enc.walkIn && (
              <Badge className="bg-orange-50 text-orange-500 border-0 text-[10px] h-5">
                <Footprints className="w-3 h-3 mr-0.5" /> Walk-in
              </Badge>
            )}
            {enc.insuranceVerified && (
              <Badge className="bg-emerald-50 text-emerald-500 border-0 text-[10px] h-5">
                <Shield className="w-3 h-3 mr-0.5" /> Ins Verified
              </Badge>
            )}
            {/* Keyboard shortcut hints */}
            <div className="ml-auto flex items-center gap-1.5 text-[10px] text-gray-400 shrink-0">
              <kbd className="px-1.5 py-0.5 rounded bg-gray-100 border border-gray-200 text-[9px]" style={{ fontFamily: "system-ui" }}>Esc</kbd>
              <span>Back</span>
              {!isRevenueReadOnly && canAdvance && (
                <div className="contents">
                  <span className="mx-0.5">&middot;</span>
                  <kbd className="px-1.5 py-0.5 rounded bg-gray-100 border border-gray-200 text-[9px]" style={{ fontFamily: "system-ui" }}>&thinsp;&#8984;&#9166;&thinsp;</kbd>
                  <span>Advance</span>
                </div>
              )}
            </div>
          </div>

          {isRevenueReadOnly && (
            <div className="mt-4 rounded-xl border border-cyan-200 bg-cyan-50 px-4 py-3 text-[12px] text-cyan-900">
              <div className="flex items-center gap-2" style={{ fontWeight: 700 }}>
                <FileText className="w-4 h-4" />
                Revenue Cycle review
              </div>
              <p className="mt-1 text-cyan-800">
                This encounter detail view is read-only for Revenue Cycle. Use it to review rooming, clinician, and checkout context without changing clinical workflow state.
              </p>
            </div>
          )}

          {canEditRecoveryRoom && (
            <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50/70 px-4 py-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[13px] text-blue-900" style={{ fontWeight: 700 }}>
                    <DoorOpen className="w-4 h-4" />
                    Admin room recovery
                  </div>
                  <p className="mt-1 text-[12px] text-blue-800">
                    Use this when an older encounter carried into today with the wrong room state. You can clear the room or move the patient to a different ready room without relying on the live day board.
                  </p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <div className="min-w-[240px]">
                    <label className="text-[11px] text-blue-700 mb-1.5 block uppercase tracking-wider" style={{ fontWeight: 600 }}>
                      Assigned room
                    </label>
                    <select
                      value={localRoom}
                      onChange={(event) => setLocalRoom(event.target.value)}
                      className="h-10 w-full rounded-lg border border-blue-200 bg-white px-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-100"
                    >
                      {recoveryRoomOptions.map((option) => (
                        <option key={`${option.value || "none"}:${option.label}`} value={option.value} disabled={option.disabled}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    onClick={() => saveRecoveryRoomAssignment().catch(() => undefined)}
                    disabled={savingRecoveryRoom}
                    className="h-10 px-4 rounded-lg bg-blue-600 text-white text-[12px] hover:bg-blue-700 transition-colors disabled:opacity-50"
                    style={{ fontWeight: 600 }}
                  >
                    {savingRecoveryRoom ? "Saving..." : "Save Room Fix"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Status Stepper ── */}
      <div className="shrink-0 px-6 py-3 bg-gray-50/80 border-b border-gray-100">
        <div className="flex items-center gap-1">
          {statusFlow.map((status, idx) => {
            const StepIcon = stepIcons[status];
            const isPast = idx < currentIdx || completedStages.has(status);
            const isCurrent = idx === currentIdx;
            const color = statusColors[status];

            return (
              <div key={status} className="flex items-center flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <div
                    className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-all ${isCurrent ? "ring-2 ring-offset-1" : ""}`}
                    style={{
                      backgroundColor: isCurrent ? color : isPast ? `${color}20` : "#f1f5f9",
                      borderColor: isCurrent ? color : "transparent",
                      ringColor: isCurrent ? `${color}40` : undefined,
                    }}
                  >
                    {isPast && !isCurrent ? (
                      <CheckCircle2 className="w-3.5 h-3.5" style={{ color }} />
                    ) : (
                      <StepIcon
                        className="w-3.5 h-3.5"
                        style={{ color: isCurrent ? "white" : "#94a3b8" }}
                      />
                    )}
                  </div>
                  <span
                    className="text-[10px] hidden lg:block truncate"
                    style={{
                      fontWeight: isCurrent ? 600 : 400,
                      color: isCurrent ? color : isPast ? "#64748b" : "#94a3b8",
                    }}
                  >
                    {statusLabels[status]}
                  </span>
                </div>
                {idx < statusFlow.length - 1 && (
                  <div
                    className="flex-1 h-0.5 mx-2 rounded-full transition-colors"
                    style={{
                      backgroundColor: isPast && !isCurrent ? `${color}40` : "#e2e8f0",
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Main Content ── */}
      <div className="flex-1 overflow-hidden flex">
        {/* Left side — Info + Tasks */}
        <div className="w-[340px] min-w-[340px] border-r border-gray-100 flex flex-col overflow-hidden bg-white">
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="p-5 space-y-5">
              {/* Timers */}
              <Card className="border-0 shadow-sm overflow-hidden">
                <div className="h-0.5" style={{ background: `linear-gradient(to right, ${statusColor}, ${statusColor}66)` }} />
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Timer className="w-4 h-4" style={{ color: stageColor }} />
                      <span className="text-[11px] uppercase tracking-wider text-muted-foreground" style={{ fontWeight: 500 }}>
                        Stage Time
                      </span>
                    </div>
                    <span
                      className="text-[22px] tabular-nums"
                      style={{ fontWeight: 700, color: stageColor, lineHeight: 1 }}
                    >
                      {fmtTimer(stageSec)}
                    </span>
                  </div>
                  {threshold && (
                    <div className="flex items-center gap-2 text-[10px]">
                      <span className="text-gray-400">Threshold:</span>
                      <span className="text-amber-500" style={{ fontWeight: 500 }}>{threshold.yellowMinutes}m</span>
                      <span className="text-gray-300">/</span>
                      <span className="text-red-500" style={{ fontWeight: 500 }}>{threshold.redMinutes}m</span>
                    </div>
                  )}
                  <div className="pt-2 border-t border-gray-100 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-gray-400" />
                      <span className="text-[11px] uppercase tracking-wider text-muted-foreground" style={{ fontWeight: 500 }}>
                        Total Time
                      </span>
                    </div>
                    <span className="text-[18px] tabular-nums text-gray-600" style={{ fontWeight: 600, lineHeight: 1 }}>
                      {fmtTimer(totalSec)}
                    </span>
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    Checked in at {enc.checkinTime}
                  </div>
                </CardContent>
              </Card>

              {/* Captured vitals (shown once Rooming is completed) */}
              {capturedVitals && (
                <Card className="border-0 shadow-sm">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Heart className="w-4 h-4 text-rose-400" />
                      <span className="text-[12px]" style={{ fontWeight: 600 }}>Vitals (Rooming)</span>
                      <Badge className="border-0 bg-emerald-50 text-emerald-600 text-[9px] px-1.5 h-4">Captured</Badge>
                    </div>
                    {capturedVitals.reasonForVisit && (
                      <div className="mb-3 px-3 py-2 rounded-lg bg-indigo-50 border border-indigo-100">
                        <span className="text-[9px] uppercase tracking-wider text-indigo-500" style={{ fontWeight: 600 }}>Reason for Visit</span>
                        <p className="text-[12px] text-gray-700 mt-0.5" style={{ fontWeight: 500 }}>{capturedVitals.reasonForVisit}</p>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-2.5">
                      {capturedVitals.bloodPressure && <VitalChip icon={Gauge} label="BP" value={capturedVitals.bloodPressure} />}
                      {capturedVitals.heartRate && <VitalChip icon={Heart} label="HR" value={capturedVitals.heartRate} />}
                      {capturedVitals.temperature && <VitalChip icon={Thermometer} label="Temp" value={capturedVitals.temperature} />}
                      {capturedVitals.weight && <VitalChip icon={Activity} label="Weight" value={capturedVitals.weight} />}
                      {capturedVitals.height && <VitalChip icon={Activity} label="Height" value={capturedVitals.height} />}
                      {capturedVitals.o2Sat && <VitalChip icon={Activity} label="O₂ Sat" value={capturedVitals.o2Sat} />}
                    </div>
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      <CheckRow label="Allergy Review" checked={capturedVitals.allergyReview} />
                      <CheckRow label="Medication Reconciliation" checked={capturedVitals.medicationReconciliation} />
                    </div>
                    <div className="mt-3 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                      <div className="text-[9px] uppercase tracking-wider text-muted-foreground mb-2" style={{ fontWeight: 700 }}>
                        Standard MA changes
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-[11px]">
                        <div>Allergies: <span style={{ fontWeight: 700 }}>{capturedVitals.allergiesChanged}</span></div>
                        <div>Meds: <span style={{ fontWeight: 700 }}>{capturedVitals.medicationReconciliationChanged}</span></div>
                        <div>Lab: <span style={{ fontWeight: 700 }}>{capturedVitals.labChanged}</span></div>
                        <div>Pharmacy: <span style={{ fontWeight: 700 }}>{capturedVitals.pharmacyChanged}</span></div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Tasks for this encounter */}
              <Card className="border-0 shadow-sm">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <ListChecks className="w-4 h-4 text-purple-500" />
                    <span className="text-[12px]" style={{ fontWeight: 600 }}>Tasks</span>
                    {(encTasks.length + createdTasks.length) > 0 && (
                      <Badge className="border-0 bg-purple-100 text-purple-600 text-[9px] px-1.5 h-4">
                        {encTasks.length + createdTasks.length}
                      </Badge>
                    )}
                  </div>
                  {encTasks.length === 0 && createdTasks.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground py-2">No pending tasks</p>
                  ) : (
                    <div className="space-y-2">
                      {encTasks.map((task) => {
                        const cfg = taskTypeConfig[task.taskType] || taskTypeConfig.prep;
                        const Icon = cfg.icon;
                        return (
                          <div
                            key={task.id}
                            className="rounded-lg border px-3 py-2 flex items-start gap-2.5"
                            style={{ borderColor: task.priority === 1 ? `${cfg.color}40` : "#e5e7eb" }}
                          >
                            <div
                              className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 mt-0.5"
                              style={{ backgroundColor: `${cfg.color}15`, color: cfg.color }}
                            >
                              <Icon className="w-3 h-3" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="text-[11px]" style={{ fontWeight: 600, color: cfg.color }}>{cfg.label}</span>
                                {task.priority === 1 && <Zap className="w-3 h-3 text-red-500" />}
                                {task.blocking && (
                                  <span className="text-[8px] px-1 py-0.5 rounded bg-orange-50 text-orange-500" style={{ fontWeight: 500 }}>
                                    BLOCKING
                                  </span>
                                )}
                              </div>
                              <p className="text-[11px] text-muted-foreground">{task.description}</p>
                              <span className="text-[10px] text-gray-400">{task.assignedMA} · {task.createdAt}</span>
                            </div>
                          </div>
                        );
                      })}
                      {createdTasks.map((task) => {
                        const typeLabel = taskTypeOptions.find((t) => t.value === task.taskType)?.label || task.taskType;
                        const roleLabel = roleOptions.find((r) => r.value === task.assignedToRole)?.label || "Unassigned";
                        const prioOption = priorityOptions.find((p) => p.value === task.priority);
                        return (
                          <div
                            key={task.id}
                            className="rounded-lg border px-3 py-2 flex items-start gap-2.5"
                            style={{ borderColor: task.priority <= 2 ? `${prioOption?.color || "#3b82f6"}40` : "#e5e7eb" }}
                          >
                            <div
                              className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 mt-0.5"
                              style={{ backgroundColor: `${prioOption?.color || "#3b82f6"}15` }}
                            >
                              <ListChecks className="w-3 h-3" style={{ color: prioOption?.color || "#3b82f6" }} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-[11px]" style={{ fontWeight: 600, color: prioOption?.color || "#3b82f6" }}>{typeLabel}</span>
                                {task.priority <= 2 && <Zap className="w-3 h-3 text-red-500" />}
                                {task.blocking && (
                                  <span className="text-[8px] px-1 py-0.5 rounded bg-orange-50 text-orange-500" style={{ fontWeight: 500 }}>
                                    BLOCKING
                                  </span>
                                )}
                              </div>
                              <p className="text-[11px] text-muted-foreground">{task.description}</p>
                              <span className="text-[10px] text-gray-400">→ {roleLabel} · {task.createdAt}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Timeline */}
              <Card className="border-0 shadow-sm">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Clock className="w-4 h-4 text-gray-400" />
                    <span className="text-[12px]" style={{ fontWeight: 600 }}>Timeline</span>
                  </div>
                  <div className="space-y-0">
                    {statusFlow.slice(0, currentIdx + 1).map((status, idx) => {
                      const color = statusColors[status];
                      const isLast = idx === currentIdx;
                      const durationLabel = stageDurationLabel(enc, status, nowMs);
                      return (
                        <div key={status} className="flex gap-3">
                          <div className="flex flex-col items-center">
                            <div className="w-2.5 h-2.5 rounded-full shrink-0 mt-1" style={{ backgroundColor: color }} />
                            {!isLast && <div className="w-0.5 flex-1 bg-gray-200 my-0.5" />}
                          </div>
                          <div className="pb-3">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[11px]" style={{ fontWeight: 500 }}>{statusLabels[status]}</span>
                              {durationLabel && (
                                <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[9px] text-gray-500">
                                  {durationLabel}
                                </span>
                              )}
                            </div>
                            <p className="text-[10px] text-muted-foreground">
                              {status === "Incoming" && `Scheduled ${enc.checkinTime}`}
                              {status === "Lobby" && `Checked in at ${enc.checkinTime}`}
                              {status === "Rooming" && (enc.assignedMA ? `Roomed by ${enc.assignedMA}${localRoom ? ` · ${localRoom}` : ""}` : "Rooming started")}
                              {status === "ReadyForProvider" && `Handed off to ${enc.provider}`}
                              {status === "Optimizing" && `Visit started with ${enc.provider}`}
                              {status === "CheckOut" && "Visit complete, at front desk"}
                              {status === "Optimized" && "Encounter completed"}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>

        {/* Right side — scrollable content area */}
        <div className="flex-1 flex flex-col overflow-hidden bg-gray-50/30">
          {enc.status === "Lobby" ? (
            /* ─── Lobby: Entry state (rooming starts from the lobby card flow) ─── */
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center max-w-md">
                <div className="w-16 h-16 rounded-2xl bg-indigo-50 flex items-center justify-center mx-auto mb-4">
                  <Users className="w-8 h-8 text-indigo-400" />
                </div>
                <h3 className="text-[18px] text-gray-700 mb-1" style={{ fontWeight: 600 }}>
                  Patient in Lobby
                </h3>
                <p className="text-[13px] text-muted-foreground mb-1">
                  {enc.patientId} is waiting to be roomed for a <span style={{ fontWeight: 500 }}>{enc.visitType}</span> visit
                  with <span style={{ fontWeight: 500 }}>{enc.provider}</span>.
                </p>
                <p className="text-[12px] text-muted-foreground mb-6">
                  Start rooming from the MA Board. Front Desk can review this patient, but workflow handoff begins with the assigned MA.
                </p>
                <div className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-50 text-indigo-600 border border-indigo-200 text-[13px]" style={{ fontWeight: 600 }}>
                  <ClipboardList className="w-4 h-4" />
                  Awaiting MA rooming start
                </div>
              </div>
            </div>
          ) : enc.status === "Optimized" ? (
            /* ─── Optimized: Completed state ─── */
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="w-16 h-16 rounded-2xl bg-emerald-50 flex items-center justify-center mx-auto mb-4">
                  <CheckCircle2 className="w-8 h-8 text-emerald-400" />
                </div>
                <h3 className="text-[18px] text-gray-700 mb-1" style={{ fontWeight: 600 }}>
                  Encounter Completed
                </h3>
                <p className="text-[13px] text-muted-foreground">
                  This encounter has been fully optimized.
                </p>
              </div>
            </div>
          ) : enc.status === "ReadyForProvider" ? (
            /* ─── ReadyForProvider: Waiting for clinician to start from Clinician Board ─── */
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center max-w-md">
                <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4" style={{ backgroundColor: `${statusColors.ReadyForProvider}15` }}>
                  <Stethoscope className="w-8 h-8" style={{ color: statusColors.ReadyForProvider }} />
                </div>
                <h3 className="text-[18px] text-gray-700 mb-1" style={{ fontWeight: 600 }}>
                  Ready for Provider
                </h3>
                <p className="text-[13px] text-muted-foreground mb-1">
                  {enc.patientId} is in <span style={{ fontWeight: 500 }}>{enc.roomNumber || "their room"}</span> and ready for{" "}
                  <span style={{ fontWeight: 500 }}>{enc.provider}</span>.
                </p>
                <p className="text-[12px] text-muted-foreground mb-6">
                  The provider will start the visit from the Clinician Board.
                </p>
                <div className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gray-100 text-gray-500 text-[13px]" style={{ fontWeight: 500 }}>
                  <Clock className="w-4 h-4" />
                  Waiting for provider...
                </div>
              </div>
            </div>
          ) : enc.status === "Rooming" ? (
            /* ─── Rooming: Single scrollable card (like Front Desk Check-In) ─── */
            <div className="flex-1 overflow-y-auto">
              <div className="p-6 max-w-[780px] mx-auto">
                <Card className="border-0 shadow-sm overflow-hidden">
                  <div className="h-1 bg-gradient-to-r from-violet-500 to-purple-400" />
                  <CardContent className="p-6">
                    {/* Card header */}
                    <div className="flex items-center gap-2 mb-5">
                      <div className="w-8 h-8 rounded-lg bg-violet-100 flex items-center justify-center">
                        <ClipboardList className="w-4 h-4 text-violet-600" />
                      </div>
                      <span className="text-[14px]" style={{ fontWeight: 600 }}>Rooming</span>
                      <Badge
                        className="border-0 text-[10px] px-2 h-5 ml-1"
                        style={{ backgroundColor: `${statusColor}15`, color: statusColor, fontWeight: 600 }}
                      >
                        {enc.visitType}
                      </Badge>
                    </div>

                    {/* ── Default fields: Assign Room ── */}
                    <div className="mb-4">
                      {lastReadyRoomSelected && (
                        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] text-amber-800">
                          <div className="flex items-center gap-2" style={{ fontWeight: 700 }}>
                            <AlertTriangle className="w-4 h-4" />
                            Last ready room
                          </div>
                          <p className="mt-1">
                            {selectedOperationalRoom?.name || "This room"} is the only ready room in your scope. Once it is occupied, no more rooms will be ready until a room is turned over.
                          </p>
                        </div>
                      )}
                      <label className="text-[11px] text-muted-foreground mb-1.5 block uppercase tracking-wider" style={{ fontWeight: 500 }}>
                        Assign Room <span className="text-red-400">*</span>
                      </label>
                      <div className="relative">
                        <DoorOpen className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                        <select
                          value={localRoom}
                          onChange={(e) => setLocalRoom(e.target.value)}
                          className={`w-full h-10 pl-10 pr-4 rounded-lg border bg-white text-[13px] appearance-none transition-all hover:border-violet-300 focus:outline-none focus:ring-2 focus:ring-violet-100 ${
                            localRoom ? "border-emerald-300 focus:border-emerald-400" : "border-gray-200 focus:border-violet-400"
                          }`}
                        >
                          <option value="">Select room...</option>
                          {baseEnc.roomNumber && (
                            <option value={baseEnc.roomNumber}>{baseEnc.roomNumber} (current)</option>
                          )}
                          {readyRooms.map((r) => (
                            <option key={r.id} value={r.name}>{r.name}</option>
                          ))}
                          {nonReadyRooms.length > 0 && (
                            <optgroup label="Unavailable">
                              {nonReadyRooms.map((r) => (
                                <option key={r.id} value={r.name} disabled>{r.name} - {r.operationalStatus}</option>
                              ))}
                            </optgroup>
                          )}
                        </select>
                      </div>
                      {lastReadyRoomSelected && selectedOperationalRoom && (
                        <div className="mt-2 inline-flex items-center rounded-full bg-amber-100 px-2.5 py-1 text-[11px] text-amber-800" style={{ fontWeight: 700 }}>
                          {selectedOperationalRoom.name} · Last ready room
                        </div>
                      )}
                    </div>

                    {/* ── Default fields: Rooming Notes ── */}
                    <div className="mb-2">
                      <label className="text-[11px] text-muted-foreground mb-1.5 block uppercase tracking-wider" style={{ fontWeight: 500 }}>
                        Rooming Notes
                      </label>
                      <div className="relative">
                        <StickyNote className="absolute left-3 top-3 w-4 h-4 text-gray-400 pointer-events-none" />
                        <textarea
                          rows={2}
                          placeholder="Notes for this rooming session..."
                          value={roomingNotes}
                          onChange={(e) => setRoomingNotes(e.target.value)}
                          disabled={isRevenueReadOnly}
                          className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-gray-200 bg-white text-[13px] hover:border-violet-300 focus:outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100 resize-none transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                        />
                      </div>
                    </div>

                    <div className="mt-6 rounded-xl border border-cyan-100 bg-cyan-50/50 overflow-hidden">
                      <div className="px-5 py-3.5 border-b border-cyan-100 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-lg bg-cyan-100 flex items-center justify-center">
                            <FileText className="w-3.5 h-3.5 text-cyan-700" />
                          </div>
                          <div>
                            <span className="text-[13px]" style={{ fontWeight: 600 }}>MA Service Capture</span>
                            <span className="text-[11px] text-muted-foreground ml-2">Time-of-service revenue evidence</span>
                          </div>
                        </div>
                        <Badge className="border-0 bg-white text-cyan-700 text-[10px]">
                          {serviceCaptureItems.length > 0 ? `${serviceCaptureItems.length} captured` : "Required"}
                        </Badge>
                      </div>
                      <div className="p-5 space-y-4">
                        <div className="text-[12px] text-slate-600">
                          Capture the performed MA services here so Revenue Cycle can build the same-day charge expectation in Flow without waiting on Athena data.
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {(revenueSettings?.serviceCatalog || []).filter((item) => item.active !== false && !item.allowCustomNote).map((item) => (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => addServiceCaptureFromCatalog(item.id)}
                              disabled={isRevenueReadOnly}
                              className="rounded-full border border-cyan-200 bg-white px-3 py-1.5 text-[11px] text-cyan-700 hover:bg-cyan-50 disabled:opacity-50"
                              style={{ fontWeight: 600 }}
                            >
                              {item.label}
                              {item.suggestedProcedureCode ? ` · ${item.suggestedProcedureCode}` : ""}
                            </button>
                          ))}
                        </div>
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto]">
                          <input
                            value={customServiceLabel}
                            onChange={(event) => setCustomServiceLabel(event.target.value)}
                            placeholder="Other service label"
                            disabled={isRevenueReadOnly}
                            className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-[12px] focus:outline-none focus:border-cyan-300 focus:ring-2 focus:ring-cyan-100 disabled:opacity-60"
                          />
                          <input
                            value={customServiceNote}
                            onChange={(event) => setCustomServiceNote(event.target.value)}
                            placeholder="Optional note for other service"
                            disabled={isRevenueReadOnly}
                            className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-[12px] focus:outline-none focus:border-cyan-300 focus:ring-2 focus:ring-cyan-100 disabled:opacity-60"
                          />
                          <button
                            type="button"
                            onClick={addCustomServiceCapture}
                            disabled={isRevenueReadOnly}
                            className="h-10 px-3 rounded-lg bg-cyan-600 text-white text-[12px] hover:bg-cyan-700 transition-colors disabled:opacity-50"
                            style={{ fontWeight: 600 }}
                          >
                            Add other
                          </button>
                        </div>
                        <div className="space-y-2">
                          {serviceCaptureItems.length === 0 && (
                            <div className="rounded-xl border border-dashed border-cyan-200 bg-white px-4 py-4 text-[12px] text-cyan-800">
                              Document at least one structured service or other-service note before sending the encounter forward.
                            </div>
                          )}
                          {serviceCaptureItems.map((item) => (
                            <div key={item.id} className="flex items-start justify-between gap-3 rounded-xl border border-cyan-100 bg-white px-4 py-3">
                              <div>
                                <div className="text-[13px] text-slate-900" style={{ fontWeight: 600 }}>{item.label}</div>
                                <div className="mt-1 text-[11px] text-muted-foreground">
                                  Qty {item.quantity}
                                  {item.suggestedProcedureCode ? ` · Suggested CPT ${item.suggestedProcedureCode}` : ""}
                                  {item.note ? ` · ${item.note}` : ""}
                                </div>
                              </div>
                              {!isRevenueReadOnly && (
                                <button onClick={() => removeServiceCaptureItem(item.id)} className="text-rose-500">
                                  <X className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* ── Rooming requirements ── */}
                    <div className="mt-6 rounded-xl border border-purple-100 bg-purple-50/50 overflow-hidden">
                        {/* Template header bar */}
                        <div className="px-5 py-3.5 border-b border-purple-100 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-lg bg-purple-100 flex items-center justify-center">
                              <LayoutTemplate className="w-3.5 h-3.5 text-purple-600" />
                            </div>
                            <div>
                              <span className="text-[13px]" style={{ fontWeight: 600 }}>
                                Rooming Requirements
                              </span>
                              <span className="text-[11px] text-muted-foreground ml-2">
                                {templateFields.length > 0 ? enc.visitType : "Standard MA rooming"}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] text-muted-foreground">
                              {completedCount}/{requiredCount} required
                            </span>
                            <div className="w-20 h-1.5 rounded-full bg-purple-100 overflow-hidden">
                              <div
                                className="h-full rounded-full transition-all duration-300"
                                style={{
                                  width: requiredCount > 0 ? `${(completedCount / requiredCount) * 100}%` : "0%",
                                  backgroundColor: completedCount === requiredCount && requiredCount > 0 ? "#10b981" : "#8b5cf6",
                                }}
                              />
                            </div>
                          </div>
                        </div>

                        {/* Template fields — grouped by section */}
                        <div className="p-5 space-y-5">
                          <div>
                            <div className="flex items-center gap-2 mb-2.5">
                              <div className="w-5 h-5 rounded-md flex items-center justify-center bg-emerald-50">
                                <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                              </div>
                              <span className="text-[11px] uppercase tracking-wider text-emerald-700" style={{ fontWeight: 700 }}>
                                Standard MA Rooming
                              </span>
                              <span className="text-[10px] text-muted-foreground">Always required</span>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 pl-7">
                              {standardRoomingFields.map((field) => (
                                <TemplateFieldInput
                                  key={`standard-${field.key}`}
                                  field={field}
                                  value={currentTemplateVals[fieldKey(field)]}
                                  invalid={
                                    showRequiredFieldErrors &&
                                    field.required &&
                                    !isTemplateFieldComplete(field, currentTemplateVals[fieldKey(field)])
                                  }
                                  disabled={isRevenueReadOnly}
                                  onChange={(val) => setFieldValue(fieldKey(field), val)}
                                />
                              ))}
                            </div>
                          </div>
                          {templateFields.length === 0 ? (
                            <div className="rounded-xl border border-dashed border-purple-200 bg-white/80 px-4 py-4 text-[12px] text-purple-900">
                              No visit-specific rooming template is active for {enc.visitType}. The standard MA rooming fields above are still required.
                            </div>
                          ) : hasGroups ? (
                            fieldGroups.map((grp) => {
                              const GrpIcon = groupIcons[grp.group] || FileText;
                              const grpColor = groupColors[grp.group] || "#64748b";
                              const grpRequired = grp.fields.filter((f) => f.required).length;
                              const grpCompleted = grp.fields.filter((f) => {
                                if (!f.required) return false;
                                const val = currentTemplateVals[fieldKey(f)];
                                if (f.type === "checkbox") return !!val;
                                return !!val && (typeof val === "string" ? val.trim() !== "" : true);
                              }).length;

                              return (
                                <div key={grp.group}>
                                  <div className="flex items-center gap-2 mb-2.5">
                                    <div
                                      className="w-5 h-5 rounded-md flex items-center justify-center"
                                      style={{ backgroundColor: `${grpColor}15` }}
                                    >
                                      <GrpIcon className="w-3 h-3" style={{ color: grpColor }} />
                                    </div>
                                    <span className="text-[11px] uppercase tracking-wider" style={{ fontWeight: 600, color: grpColor }}>
                                      {grp.group}
                                    </span>
                                    {grpRequired > 0 && (
                                      <span className="text-[10px] text-muted-foreground">
                                        {grpCompleted}/{grpRequired}
                                      </span>
                                    )}
                                    {grpRequired > 0 && grpCompleted === grpRequired && (
                                      <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                                    )}
                                  </div>
                                  <div className="space-y-2.5 pl-7">
                                    {grp.fields.map((field, idx) => (
                                      <TemplateFieldInput
                                        key={`rooming-${grp.group}-${idx}`}
                                        field={field}
                                        value={currentTemplateVals[fieldKey(field)]}
                                        invalid={
                                          showRequiredFieldErrors &&
                                          field.required &&
                                          !isTemplateFieldComplete(field, currentTemplateVals[fieldKey(field)])
                                        }
                                        disabled={isRevenueReadOnly}
                                        onChange={(val) => setFieldValue(fieldKey(field), val)}
                                      />
                                    ))}
                                  </div>
                                </div>
                              );
                            })
                          ) : (
                            <div className="space-y-3">
                              {templateFields.map((field, idx) => (
                                <TemplateFieldInput
                                  key={`rooming-${idx}`}
                                  field={field}
                                  value={currentTemplateVals[fieldKey(field)]}
                                  invalid={
                                    showRequiredFieldErrors &&
                                    field.required &&
                                    !isTemplateFieldComplete(field, currentTemplateVals[fieldKey(field)])
                                  }
                                  disabled={isRevenueReadOnly}
                                  onChange={(val) => setFieldValue(fieldKey(field), val)}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      </div>

                    {/* ── Ready for Provider button (inline, like Check-In) ── */}
                    <div className="mt-6 pt-5 border-t border-gray-100">
                      {/* Status line */}
                      <div className="flex items-center gap-2.5 mb-3">
                        {!localRoom && (
                          <span className="text-[11px] text-amber-600 flex items-center gap-1">
                            <AlertCircle className="w-3.5 h-3.5" /> Assign a room
                          </span>
                        )}
                        {requiredCount > 0 && completedCount < requiredCount && (
                          <span className="text-[11px] text-muted-foreground">
                            {requiredCount - completedCount} required field{requiredCount - completedCount !== 1 ? "s" : ""} remaining
                          </span>
                        )}
                        {roomingReady && (
                          <span className="text-[11px] text-emerald-600 flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5" /> All requirements met
                          </span>
                        )}
                      </div>
                      {showRequiredFieldErrors && missingRequiredFields.length > 0 && (
                        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
                          Missing required fields:{" "}
                          {missingRequiredFields
                            .slice(0, 4)
                            .map((field) => field.name || field.key)
                            .join(", ")}
                          {missingRequiredFields.length > 4 ? "..." : ""}
                        </div>
                      )}
                      {!isRevenueReadOnly && (
                        <button
                          data-advance-btn
                          onClick={handleAdvance}
                          disabled={!roomingReady}
                          className={`w-full h-12 rounded-xl text-[14px] flex items-center justify-center gap-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-100 transition-all ${
                            !roomingReady
                              ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                              : "bg-violet-600 text-white hover:bg-violet-700 active:bg-violet-800"
                          }`}
                          style={{ fontWeight: 500 }}
                        >
                          <CheckCircle2 className="w-5 h-5" />
                          Ready for Provider
                          <ChevronRight className="w-4 h-4 ml-1" />
                        </button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          ) : (templateFields.length > 0 || enc.status === "Optimizing") ? (
            /* ─── Other active templates (Clinician / Checkout) ─── */
            <div className="flex-1 overflow-y-auto">
              <div className="p-6 max-w-[780px] mx-auto">
                <Card className="border-0 shadow-sm overflow-hidden">
                  <div className="h-1" style={{ background: `linear-gradient(to right, ${statusColor}, ${statusColor}88)` }} />
                  <CardContent className="p-6">
                    {/* Card header */}
                    <div className="flex items-center gap-2 mb-5">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${statusColor}15` }}>
                        {enc.status === "CheckOut"
                          ? <CreditCard className="w-4 h-4" style={{ color: statusColor }} />
                          : <Stethoscope className="w-4 h-4" style={{ color: statusColor }} />
                        }
                      </div>
                      <span className="text-[14px]" style={{ fontWeight: 600 }}>{templateLabel}</span>
                      <Badge
                        className="border-0 text-[10px] px-2 h-5 ml-1"
                        style={{ backgroundColor: `${statusColor}15`, color: statusColor, fontWeight: 600 }}
                      >
                        {enc.visitType}
                      </Badge>
                    </div>

                    {/* Notes field */}
                    <div className="mb-2">
                      <label className="text-[11px] text-muted-foreground mb-1.5 block uppercase tracking-wider" style={{ fontWeight: 500 }}>
                        {enc.status === "Optimizing" ? "Visit Notes for Team" : "Encounter Notes"}
                      </label>
                      <div className="relative">
                        <StickyNote className="absolute left-3 top-3 w-4 h-4 text-gray-400 pointer-events-none" />
                        <textarea
                          rows={2}
                          placeholder={enc.status === "Optimizing" ? "Add notes for MA, front desk, and checkout teams..." : "Add notes..."}
                          value={typeof currentTemplateVals.encounter_notes === "string" ? currentTemplateVals.encounter_notes : ""}
                          onChange={(event) => setFieldValue("encounter_notes", event.target.value)}
                          disabled={isRevenueReadOnly}
                          className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-gray-200 bg-white text-[13px] focus:outline-none focus:border-purple-300 focus:ring-2 focus:ring-purple-100 resize-none disabled:opacity-60 disabled:cursor-not-allowed"
                        />
                      </div>
                    </div>

                    {/* Template section */}
                    <div className="mt-6 rounded-xl border border-purple-100 bg-purple-50/50 overflow-hidden">
                      <div className="px-5 py-3.5 border-b border-purple-100 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-lg bg-purple-100 flex items-center justify-center">
                            <LayoutTemplate className="w-3.5 h-3.5 text-purple-600" />
                          </div>
                          <div>
                            <span className="text-[13px]" style={{ fontWeight: 600 }}>{templateLabel}</span>
                            <span className="text-[11px] text-muted-foreground ml-2">{enc.visitType}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-muted-foreground">
                            {completedCount}/{requiredCount} required
                          </span>
                          <div className="w-20 h-1.5 rounded-full bg-purple-100 overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-300"
                              style={{
                                width: requiredCount > 0 ? `${(completedCount / requiredCount) * 100}%` : "0%",
                                backgroundColor: completedCount === requiredCount && requiredCount > 0 ? "#10b981" : "#8b5cf6",
                              }}
                            />
                          </div>
                        </div>
                      </div>
                      <div className="p-5 space-y-3">
                        {templateFields.map((field, idx) => (
                          <TemplateFieldInput
                            key={`${enc.status}-${idx}`}
                            field={field}
                            value={currentTemplateVals[fieldKey(field)]}
                            invalid={
                              showRequiredFieldErrors &&
                              field.required &&
                              !isTemplateFieldComplete(field, currentTemplateVals[fieldKey(field)])
                            }
                            disabled={isRevenueReadOnly}
                            onChange={(val) => setFieldValue(fieldKey(field), val)}
                          />
                        ))}
                      </div>
                    </div>

                    {enc.status === "Optimizing" && (
                      <div className="mt-6 rounded-xl border border-cyan-100 bg-cyan-50/50 overflow-hidden">
                        <div className="px-5 py-3.5 border-b border-cyan-100 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-lg bg-cyan-100 flex items-center justify-center">
                              <FileText className="w-3.5 h-3.5 text-cyan-700" />
                            </div>
                            <div>
                              <span className="text-[13px]" style={{ fontWeight: 600 }}>Coding Handoff</span>
                              <span className="text-[11px] text-muted-foreground ml-2">Revenue prep</span>
                            </div>
                          </div>
                          <Badge className="border-0 bg-white text-cyan-700 text-[10px]">MVP</Badge>
                        </div>
                        <div className="p-5 space-y-4">
                          <div className="rounded-xl border border-cyan-200 bg-white px-4 py-3 text-[12px] text-cyan-900">
                            Enter real ICD-10 and CPT/HCPCS codes here, not narrative text.
                          </div>
                          {(clinicianDiagnosisParse.invalid.length > 0 || clinicianProcedureParse.invalid.length > 0) && (
                            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] text-amber-900">
                              Legacy text was found. Replace anything that is not a real ICD-10 or CPT/HCPCS code.
                              <div className="mt-2 space-y-1 text-[11px] text-amber-800">
                                {clinicianDiagnosisParse.invalid.length > 0 && (
                                  <div>Diagnosis cleanup needed: {clinicianDiagnosisParse.invalid.join(", ")}</div>
                                )}
                                {clinicianProcedureParse.invalid.length > 0 && (
                                  <div>Procedure cleanup needed: {clinicianProcedureParse.invalid.join(", ")}</div>
                                )}
                              </div>
                            </div>
                          )}
                          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)]">
                            <div className="space-y-4">
                              <StructuredCodeComposer
                                label="Diagnosis codes"
                                placeholder="Add ICD-10 code"
                                codes={clinicianDiagnosisCodes}
                                inputValue={diagnosisInput}
                                searchResults={diagnosisSearchResults}
                                disabled={isRevenueReadOnly}
                                onInputChange={setDiagnosisInput}
                                onAdd={() => addStructuredCode("diagnosis")}
                                onRemove={(code) => removeStructuredCode("diagnosis", code)}
                                onSuggestionClick={(code) => addStructuredCode("diagnosis", code)}
                              />
                              <StructuredCodeComposer
                                label="Procedure codes"
                                placeholder="Add CPT / HCPCS code"
                                codes={clinicianProcedureCodes}
                                inputValue={procedureInput}
                                searchResults={procedureSearchResults}
                                disabled={isRevenueReadOnly}
                                onInputChange={setProcedureInput}
                                onAdd={() => addStructuredCode("procedure")}
                                onRemove={(code) => removeStructuredCode("procedure", code)}
                                suggestionCodes={suggestedProcedureCodes}
                                onSuggestionClick={(code) => addStructuredCode("procedure", code)}
                              />
                            </div>
                            <div className="space-y-3">
                              <div className="rounded-xl border border-cyan-100 bg-cyan-50/70 px-4 py-4">
                                <div className="text-[11px] uppercase tracking-[0.18em] text-cyan-700">Coding quality checks</div>
                                <div className="mt-3 grid gap-2 text-[12px] text-slate-700">
                                  <div className="flex items-center justify-between rounded-lg bg-white px-3 py-2">
                                    <span>Diagnosis codes added</span>
                                    <span style={{ fontWeight: 700 }}>{clinicianDiagnosisCodes.length}</span>
                                  </div>
                                  <div className="flex items-center justify-between rounded-lg bg-white px-3 py-2">
                                    <span>Procedure codes added</span>
                                    <span style={{ fontWeight: 700 }}>{clinicianProcedureCodes.length}</span>
                                  </div>
                                  <div className="flex items-center justify-between rounded-lg bg-white px-3 py-2">
                                    <span>Documentation complete</span>
                                    <span style={{ fontWeight: 700 }}>
                                      {currentTemplateVals["coding.documentation_complete"] === true ? "Yes" : "No"}
                                    </span>
                                  </div>
                                </div>
                              </div>
                              <TemplateFieldInput
                                field={{ key: "coding.documentation_complete", name: "Documentation Complete", type: "yesNo", required: false }}
                                value={currentTemplateVals["coding.documentation_complete"]}
                                disabled={isRevenueReadOnly}
                                onChange={(val) => setFieldValue("coding.documentation_complete", val)}
                              />
                              {currentTemplateVals["coding.documentation_complete"] !== true && (
                                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] text-amber-900">
                                  Checkout can continue before documentation is complete, but Revenue Cycle will keep this encounter flagged until documentation is finished.
                                </div>
                              )}
                              <TemplateFieldInput
                                field={{ key: "coding.note", name: "Coding Note", type: "textarea", required: false }}
                                value={currentTemplateVals["coding.note"]}
                                disabled={isRevenueReadOnly}
                                onChange={(val) => setFieldValue("coding.note", val)}
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {session?.role === "Clinician" && revenueCase && revenueCase.providerClarifications.some((item) => item.status !== "Resolved") && (
                      <div className="mt-6 rounded-xl border border-violet-100 bg-violet-50/60 overflow-hidden">
                        <div className="px-5 py-3.5 border-b border-violet-100 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-lg bg-violet-100 flex items-center justify-center">
                              <Bell className="w-3.5 h-3.5 text-violet-700" />
                            </div>
                            <div>
                              <span className="text-[13px]" style={{ fontWeight: 600 }}>Revenue Clarifications</span>
                              <span className="text-[11px] text-muted-foreground ml-2">Respond in Flow</span>
                            </div>
                          </div>
                          <Badge className="border-0 bg-white text-violet-700 text-[10px]">
                            {revenueCase.providerClarifications.filter((item) => item.status !== "Resolved").length} open
                          </Badge>
                        </div>
                        <div className="p-5 space-y-3">
                          {revenueCase.providerClarifications.filter((item) => item.status !== "Resolved").map((query) => (
                            <div key={query.id} className="rounded-xl border border-violet-100 bg-white px-4 py-4 space-y-3">
                              <div className="flex items-center justify-between gap-3">
                                <div className="text-[13px] text-slate-900" style={{ fontWeight: 600 }}>{query.questionText}</div>
                                <Badge className="border-0 bg-violet-50 text-violet-700">{query.status}</Badge>
                              </div>
                              <div className="text-[11px] text-muted-foreground">
                                Opened {new Date(query.openedAt).toLocaleString()}
                              </div>
                              <textarea
                                rows={3}
                                value={clarificationResponses[query.id] || ""}
                                onChange={(event) =>
                                  setClarificationResponses((prev) => ({
                                    ...prev,
                                    [query.id]: event.target.value,
                                  }))
                                }
                                placeholder="Answer only what Revenue Cycle needs to finish charge capture or Athena handoff."
                                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-[13px] focus:outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100 resize-none"
                              />
                              <div className="flex flex-wrap justify-end gap-2">
                                <button
                                  onClick={() => respondToRevenueClarification(query.id, false)}
                                  disabled={savingClarificationId === query.id}
                                  className="px-3 py-2 rounded-lg border border-violet-200 text-violet-700 bg-violet-50 text-[12px] hover:bg-violet-100 disabled:opacity-50"
                                  style={{ fontWeight: 500 }}
                                >
                                  {savingClarificationId === query.id ? "Sending..." : "Send Response"}
                                </button>
                                <button
                                  onClick={() => respondToRevenueClarification(query.id, true)}
                                  disabled={savingClarificationId === query.id}
                                  className="px-3 py-2 rounded-lg bg-violet-600 text-white text-[12px] hover:bg-violet-700 disabled:opacity-50"
                                  style={{ fontWeight: 500 }}
                                >
                                  {savingClarificationId === query.id ? "Saving..." : "Send & Resolve"}
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* ── Task Creation (Optimizing only) ── */}
                    {enc.status === "Optimizing" && !isRevenueReadOnly && (
                      <div className="mt-6">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2">
                            <ListChecks className="w-4 h-4 text-teal-500" />
                            <span className="text-[13px]" style={{ fontWeight: 600 }}>Tasks</span>
                            {createdTasks.length > 0 && (
                              <Badge className="border-0 bg-teal-100 text-teal-700 text-[9px] px-1.5 h-4">
                                {createdTasks.length}
                              </Badge>
                            )}
                          </div>
                          {!showTaskForm && (
                            <button
                              onClick={() => setShowTaskForm(true)}
                              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-teal-50 text-teal-600 text-[11px] hover:bg-teal-100 transition-colors"
                              style={{ fontWeight: 500 }}
                            >
                              <Plus className="w-3 h-3" />
                              New Task
                            </button>
                          )}
                        </div>

                        {/* Created tasks list */}
                        {createdTasks.length > 0 && (
                          <div className="space-y-2 mb-3">
                            {createdTasks.map((task) => {
                              const typeLabel = taskTypeOptions.find((t) => t.value === task.taskType)?.label || task.taskType;
                              const roleLabel = roleOptions.find((r) => r.value === task.assignedToRole)?.label || "Unassigned";
                              const prioOption = priorityOptions.find((p) => p.value === task.priority);
                              return (
                                <div
                                  key={task.id}
                                  className="rounded-lg border border-gray-200 bg-white px-4 py-3 flex items-start gap-3"
                                >
                                  <div
                                    className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 mt-0.5"
                                    style={{ backgroundColor: `${prioOption?.color || "#3b82f6"}15` }}
                                  >
                                    <ListChecks className="w-3 h-3" style={{ color: prioOption?.color || "#3b82f6" }} />
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600" style={{ fontWeight: 500 }}>
                                        {typeLabel}
                                      </span>
                                      <span
                                        className="text-[10px] px-1.5 py-0.5 rounded"
                                        style={{ backgroundColor: `${prioOption?.color || "#3b82f6"}15`, color: prioOption?.color || "#3b82f6", fontWeight: 500 }}
                                      >
                                        {prioOption?.label || "Normal"}
                                      </span>
                                      {task.blocking && (
                                        <span className="text-[9px] px-1 py-0.5 rounded bg-orange-50 text-orange-500" style={{ fontWeight: 500 }}>
                                          BLOCKING
                                        </span>
                                      )}
                                    </div>
                                    <p className="text-[12px] text-gray-700 mt-1">{task.description}</p>
                                    <span className="text-[10px] text-gray-400">
                                      Assigned to {roleLabel} · {task.createdAt}
                                    </span>
                                  </div>
                                  <button
                                    onClick={() => ctx.removeTask(task.id)}
                                    className="text-gray-300 hover:text-red-400 transition-colors shrink-0 mt-0.5"
                                  >
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* New task form */}
                        {showTaskForm && (
                          <div className="rounded-xl border border-teal-200 bg-teal-50/50 p-4 space-y-3">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-[12px]" style={{ fontWeight: 600 }}>New Task</span>
                              <button
                                onClick={() => { setShowTaskForm(false); setNewTask({ ...emptyTask }); }}
                                className="text-gray-400 hover:text-gray-600 transition-colors"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </div>

                            {/* Task Type */}
                            <div>
                              <label className="text-[11px] text-muted-foreground mb-1 block uppercase tracking-wider" style={{ fontWeight: 500 }}>
                                Task Type <span className="text-red-400">*</span>
                              </label>
                              <select
                                value={newTask.taskType}
                                onChange={(e) => setNewTask((prev) => ({ ...prev, taskType: e.target.value }))}
                                className="w-full h-9 px-3 rounded-lg border border-teal-200 bg-white text-[13px] appearance-none focus:outline-none focus:border-teal-400 focus:ring-2 focus:ring-teal-100"
                              >
                                <option value="">Select type...</option>
                                {taskTypeOptions.map((opt) => (
                                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                              </select>
                            </div>

                            {/* Description */}
                            <div>
                              <label className="text-[11px] text-muted-foreground mb-1 block uppercase tracking-wider" style={{ fontWeight: 500 }}>
                                Description <span className="text-red-400">*</span>
                              </label>
                              <textarea
                                rows={2}
                                placeholder="Describe the task..."
                                value={newTask.description}
                                onChange={(e) => setNewTask((prev) => ({ ...prev, description: e.target.value }))}
                                className="w-full px-3 py-2 rounded-lg border border-teal-200 bg-white text-[13px] focus:outline-none focus:border-teal-400 focus:ring-2 focus:ring-teal-100 resize-none"
                              />
                            </div>

                            {/* Assigned Role + Priority row */}
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="text-[11px] text-muted-foreground mb-1 block uppercase tracking-wider" style={{ fontWeight: 500 }}>
                                  Assign to Role
                                </label>
                                <select
                                  value={newTask.assignedToRole}
                                  onChange={(e) => setNewTask((prev) => ({ ...prev, assignedToRole: e.target.value }))}
                                  className="w-full h-9 px-3 rounded-lg border border-teal-200 bg-white text-[13px] appearance-none focus:outline-none focus:border-teal-400 focus:ring-2 focus:ring-teal-100"
                                >
                                  <option value="">Unassigned</option>
                                  {roleOptions.map((opt) => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label className="text-[11px] text-muted-foreground mb-1 block uppercase tracking-wider" style={{ fontWeight: 500 }}>
                                  Priority
                                </label>
                                <select
                                  value={newTask.priority}
                                  onChange={(e) => setNewTask((prev) => ({ ...prev, priority: Number(e.target.value) }))}
                                  className="w-full h-9 px-3 rounded-lg border border-teal-200 bg-white text-[13px] appearance-none focus:outline-none focus:border-teal-400 focus:ring-2 focus:ring-teal-100"
                                >
                                  {priorityOptions.map((opt) => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                  ))}
                                </select>
                              </div>
                            </div>

                            {/* Blocking toggle */}
                            <label className="flex items-center gap-2.5 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={newTask.blocking}
                                onChange={(e) => setNewTask((prev) => ({ ...prev, blocking: e.target.checked }))}
                                className="w-4 h-4 rounded border-gray-300 text-orange-500 focus:ring-orange-400"
                              />
                              <span className="text-[12px] text-gray-700">Blocking task</span>
                              <span className="text-[10px] text-muted-foreground">(prevents stage advancement until completed)</span>
                            </label>

                            {/* Submit */}
                            <button
                              onClick={() => {
                                if (!newTask.taskType || !newTask.description.trim()) {
                                  toast.error("Task type and description are required");
                                  return;
                                }
                                ctx.addTask({
                                  encounterId: enc.id,
                                  patientId: enc.patientId,
                                  taskType: newTask.taskType,
                                  description: newTask.description,
                                  assignedToRole: newTask.assignedToRole,
                                  priority: newTask.priority,
                                  blocking: newTask.blocking,
                                });
                                setNewTask({ ...emptyTask });
                                setShowTaskForm(false);
                                toast.success("Task created", {
                                  description: `${taskTypeOptions.find((t) => t.value === newTask.taskType)?.label || newTask.taskType}: ${newTask.description.slice(0, 60)}`,
                                });
                              }}
                              className="w-full h-10 rounded-lg bg-teal-600 text-white text-[13px] flex items-center justify-center gap-2 hover:bg-teal-700 transition-colors shadow-sm"
                              style={{ fontWeight: 500 }}
                            >
                              <Plus className="w-4 h-4" />
                              Create Task
                            </button>
                          </div>
                        )}

                        {/* Empty state */}
                        {createdTasks.length === 0 && !showTaskForm && (
                          <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50/50 py-4 text-center">
                            <p className="text-[11px] text-muted-foreground">No tasks created yet for this visit</p>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Action button */}
                    {showRequiredFieldErrors && missingRequiredFields.length > 0 && (
                      <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
                        Missing required fields:{" "}
                        {missingRequiredFields
                          .slice(0, 4)
                          .map((field) => field.name)
                          .join(", ")}
                        {missingRequiredFields.length > 4 ? "..." : ""}
                      </div>
                    )}
                    {!isRevenueReadOnly && canAdvance && (
                      <button
                        data-advance-btn
                        onClick={handleAdvance}
                        className="w-full h-12 mt-6 rounded-xl text-white text-[14px] flex items-center justify-center gap-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-purple-100 transition-colors hover:brightness-110"
                        style={{ fontWeight: 500, backgroundColor: statusColor }}
                      >
                        <CheckCircle2 className="w-5 h-5" />
                        {nextStatusActionLabel[enc.status]}
                        <ChevronRight className="w-4 h-4 ml-1" />
                      </button>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>
          ) : (
            /* ─── Fallback: no template for this status ─── */
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center rounded-2xl border border-dashed border-gray-200 bg-gradient-to-br from-white to-gray-50 px-8 py-7 shadow-sm">
                <FileText className="w-10 h-10 text-gray-300 mx-auto mb-2.5" />
                <p className="text-[14px] text-gray-600" style={{ fontWeight: 600 }}>
                  No active template for this status
                </p>
                <p className="text-[12px] text-muted-foreground mt-1.5">
                  Status: {statusLabels[enc.status]}
                </p>
                <button
                  type="button"
                  onClick={() => navigate("/admin")}
                  className="mt-3 h-8 px-3 rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-600 text-[11px] hover:bg-indigo-100 transition-colors"
                  style={{ fontWeight: 600 }}
                >
                  Configure Template
                </button>
                {!isRevenueReadOnly && canAdvance && (
                  <button
                    data-advance-btn
                    onClick={handleAdvance}
                    className="mt-4 px-5 py-2.5 rounded-lg text-white text-[13px] flex items-center gap-2 mx-auto shadow-sm transition-colors hover:brightness-110"
                    style={{ fontWeight: 500, backgroundColor: statusColor }}
                  >
                    {nextStatusActionLabel[enc.status]}
                    <ChevronRight className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Safety Modal */}
      {safetyModal && (
        <SafetyAssistModal
          encounterId={enc.id}
          mode={safetyModal}
          onClose={() => setSafetyModal(null)}
          onActivated={() => setSafetyModal(null)}
        />
      )}
    </div>
  );
}

// ── Vital Chip ──

function VitalChip({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div className="rounded-lg bg-gray-50 border border-gray-100 px-2.5 py-2 flex items-center gap-2">
      <Icon className="w-3.5 h-3.5 text-gray-400 shrink-0" />
      <div className="min-w-0">
        <div className="text-[9px] text-muted-foreground uppercase tracking-wider">{label}</div>
        <div className="text-[12px] text-gray-700" style={{ fontWeight: 600 }}>{value}</div>
      </div>
    </div>
  );
}

function CheckRow({ label, checked }: { label: string; checked: boolean }) {
  return (
    <div className={`rounded-lg border px-2.5 py-2 text-[11px] flex items-center justify-between ${checked ? "border-emerald-200 bg-emerald-50/60 text-emerald-700" : "border-gray-100 bg-gray-50 text-gray-500"}`}>
      <span>{label}</span>
      <span style={{ fontWeight: 600 }}>{checked ? "Done" : "Pending"}</span>
    </div>
  );
}

function StructuredCodeComposer({
  label,
  placeholder,
  codes,
  inputValue,
  searchResults = [],
  disabled,
  onInputChange,
  onAdd,
  onRemove,
  suggestionCodes = [],
  onSuggestionClick,
}: {
  label: string;
  placeholder: string;
  codes: string[];
  inputValue: string;
  searchResults?: ClinicalCodeReference[];
  disabled?: boolean;
  onInputChange: (value: string) => void;
  onAdd: () => void;
  onRemove: (code: string) => void;
  suggestionCodes?: string[];
  onSuggestionClick?: (code: string) => void;
}) {
  return (
    <div className="rounded-xl border border-cyan-100 bg-white px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] text-slate-900" style={{ fontWeight: 700 }}>{label}</div>
      </div>
      <div className="mt-3 flex gap-2">
        <input
          value={inputValue}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onAdd();
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          className="h-10 flex-1 rounded-xl border border-cyan-100 px-3 text-[12px] outline-none focus:border-cyan-300 focus:ring-2 focus:ring-cyan-100 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <button
          type="button"
          onClick={onAdd}
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-full bg-cyan-700 px-4 py-2 text-[11px] text-white disabled:opacity-50"
          style={{ fontWeight: 700 }}
        >
          <Plus className="w-3.5 h-3.5" />
          Add
        </button>
      </div>
      {suggestionCodes.length > 0 && onSuggestionClick && (
        <div className="mt-3">
          <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-slate-500">MA suggestions</div>
          <div className="flex flex-wrap gap-2">
            {suggestionCodes.map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => onSuggestionClick(code)}
                disabled={disabled}
                className="rounded-full border border-cyan-200 bg-cyan-50 px-3 py-1.5 text-[11px] text-cyan-700 disabled:opacity-50"
              >
                {code}
              </button>
            ))}
          </div>
        </div>
      )}
      {searchResults.length > 0 && onSuggestionClick && (
        <div className="mt-3">
          <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-slate-500">Matches</div>
          <div className="space-y-2">
            {searchResults
              .filter((entry) => !codes.includes(entry))
              .map((entry) => (
                <button
                  key={entry}
                  type="button"
                  onClick={() => onSuggestionClick(entry)}
                  disabled={disabled}
                  className="flex w-full items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-left disabled:opacity-50"
                >
                  <div className="text-[12px] text-slate-900" style={{ fontWeight: 700 }}>{entry}</div>
                  <div className="text-[11px] text-cyan-700" style={{ fontWeight: 700 }}>Use</div>
                </button>
              ))}
          </div>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {codes.map((code) => (
          <button
            key={code}
            type="button"
            onClick={() => onRemove(code)}
            disabled={disabled}
            className="inline-flex items-center gap-1 rounded-full bg-cyan-50 px-3 py-1.5 text-[11px] text-cyan-700 disabled:opacity-50"
          >
            <span>{code}</span>
            <X className="w-3 h-3" />
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Template Field Input ──

function TemplateFieldInput({
  field,
  value,
  invalid,
  disabled,
  onChange,
}: {
  field: TemplateField;
  value: string | boolean | undefined;
  invalid?: boolean;
  disabled?: boolean;
  onChange: (val: string | boolean) => void;
}) {
  const showError = Boolean(invalid);
  const labelClass = `text-[11px] mb-1.5 flex items-center gap-1 uppercase tracking-wider ${showError ? "text-red-600" : "text-muted-foreground"}`;
  const textInputClass = `w-full px-4 py-3 rounded-lg border bg-white shadow-sm text-[13px] focus:outline-none focus:ring-2 transition-all ${
    showError
      ? "border-red-300 focus:border-red-400 focus:ring-red-100"
      : "border-purple-200/80 hover:border-purple-300 focus:border-purple-400 focus:ring-purple-100"
  }`;
  const shortInputClass = `w-full h-10 px-4 rounded-lg border bg-white shadow-sm text-[13px] appearance-none focus:outline-none focus:ring-2 transition-all ${
    showError
      ? "border-red-300 focus:border-red-400 focus:ring-red-100"
      : "border-purple-200/80 hover:border-purple-300 focus:border-purple-400 focus:ring-purple-100"
  }`;

  if (field.type === "checkbox") {
    return (
      <label
        className={`flex items-center gap-3 px-4 py-3 rounded-lg border bg-white shadow-sm cursor-pointer transition-all ${
          showError
            ? "border-red-300 hover:border-red-400"
            : "border-purple-200/80 hover:border-purple-300 hover:shadow"
        }`}
      >
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked)}
          aria-invalid={showError}
          disabled={disabled}
          className="w-4 h-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
        />
        <span className={`text-[13px] flex-1 ${showError ? "text-red-700" : "text-gray-700"}`}>{field.name}</span>
        {field.required && (
          <span className="text-[9px] text-red-400 uppercase tracking-wider" style={{ fontWeight: 600 }}>Required</span>
        )}
        {showError && (
          <span className="text-[9px] text-red-600 uppercase tracking-wider" style={{ fontWeight: 700 }}>
            Missing
          </span>
        )}
      </label>
    );
  }

  if (field.type === "yesNo") {
    const current = typeof value === "boolean" ? (value ? "yes" : "no") : typeof value === "string" ? value.toLowerCase() : "";
    return (
      <div>
        <label className={labelClass} style={{ fontWeight: 500 }}>
          {field.name}
          {field.required && <span className="text-red-400">*</span>}
        </label>
        <div className="grid grid-cols-2 gap-2">
          {(["yes", "no"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onChange(option === "yes")}
              aria-invalid={showError}
              disabled={disabled}
              className={`h-10 rounded-lg border text-[12px] transition-colors ${
                current === option
                  ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                  : showError
                    ? "border-red-300 bg-white text-red-700"
                    : "border-purple-200/80 bg-white text-gray-700 hover:border-purple-300"
              } disabled:cursor-not-allowed disabled:opacity-60`}
              style={{ fontWeight: 600 }}
            >
              {option === "yes" ? "Yes" : "No"}
            </button>
          ))}
        </div>
        {showError && <p className="text-[10px] text-red-600 mt-1">Choose yes or no to continue.</p>}
      </div>
    );
  }

  if (field.type === "textarea") {
    return (
      <div>
        <label className={labelClass} style={{ fontWeight: 500 }}>
          {field.name}
          {field.required && <span className="text-red-400">*</span>}
        </label>
        <textarea
          rows={3}
          placeholder={field.name}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={showError}
          disabled={disabled}
          className={`${textInputClass} resize-none disabled:cursor-not-allowed disabled:opacity-60`}
        />
        {showError && <p className="text-[10px] text-red-600 mt-1">This field is required.</p>}
      </div>
    );
  }

  if (field.type === "select") {
    return (
      <div>
        <label className={labelClass} style={{ fontWeight: 500 }}>
          {field.name}
          {field.required && <span className="text-red-400">*</span>}
        </label>
        <select
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={showError}
          disabled={disabled}
          className={`${shortInputClass} disabled:cursor-not-allowed disabled:opacity-60`}
        >
          <option value="">Select...</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
        {showError && <p className="text-[10px] text-red-600 mt-1">Select one option to continue.</p>}
      </div>
    );
  }

  if (field.type === "radio") {
    return (
      <div>
        <label className={labelClass} style={{ fontWeight: 500 }}>
          {field.name}
          {field.required && <span className="text-red-400">*</span>}
        </label>
        <div className="flex flex-wrap gap-2">
          {(field.options ?? []).map((opt) => (
            <label
              key={opt}
              className={`h-9 px-3 rounded-lg border bg-white text-[12px] flex items-center gap-2 cursor-pointer transition-colors ${
                showError
                  ? "border-red-300"
                  : "border-purple-200/80 hover:border-purple-300"
              }`}
            >
              <input
                type="radio"
                name={`enc-${fieldKey(field)}`}
                checked={value === opt}
                onChange={() => onChange(opt)}
                aria-invalid={showError}
                disabled={disabled}
                className="w-3.5 h-3.5 rounded-full border-gray-300 text-purple-600"
              />
              <span>{opt}</span>
            </label>
          ))}
        </div>
        {showError && <p className="text-[10px] text-red-600 mt-1">Choose one option to continue.</p>}
      </div>
    );
  }

  if (
    field.type === "date" ||
    field.type === "time" ||
    field.type === "number" ||
    field.type === "bloodPressure" ||
    field.type === "temperature" ||
    field.type === "pulse" ||
    field.type === "respirations" ||
    field.type === "oxygenSaturation" ||
    field.type === "height" ||
    field.type === "weight" ||
    field.type === "painScore"
  ) {
    const vitalPlaceholders: Partial<Record<TemplateField["type"], string>> = {
      bloodPressure: "120/80",
      temperature: "98.6",
      pulse: "72",
      respirations: "16",
      oxygenSaturation: "98",
      height: "5'8\" or 68 in",
      weight: "165 lb",
      painScore: "0-10",
    };
    const numericVitalTypes = new Set<TemplateField["type"]>(["temperature", "pulse", "respirations", "oxygenSaturation", "painScore"]);
    const inputType =
      field.type === "date" || field.type === "time" || field.type === "number"
        ? field.type
        : numericVitalTypes.has(field.type)
          ? "number"
          : "text";
    return (
      <div>
        <label className={labelClass} style={{ fontWeight: 500 }}>
          {field.name}
          {field.required && <span className="text-red-400">*</span>}
        </label>
        <input
          type={inputType}
          placeholder={vitalPlaceholders[field.type] || field.name}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={showError}
          disabled={disabled}
          className={`${shortInputClass} disabled:cursor-not-allowed disabled:opacity-60`}
        />
        {showError && <p className="text-[10px] text-red-600 mt-1">This field is required.</p>}
      </div>
    );
  }

  return (
    <div>
      <label className={labelClass} style={{ fontWeight: 500 }}>
        {field.name}
        {field.required && <span className="text-red-400">*</span>}
      </label>
      <input
        type="text"
        placeholder={field.name}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={showError}
        disabled={disabled}
        className={`${shortInputClass} disabled:cursor-not-allowed disabled:opacity-60`}
      />
      {showError && <p className="text-[10px] text-red-600 mt-1">This field is required.</p>}
    </div>
  );
}
