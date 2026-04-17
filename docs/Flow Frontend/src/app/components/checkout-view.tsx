import { useState, useMemo, useEffect } from "react";
import {
  CreditCard,
  Clock,
  CheckCircle2,
  FileText,
  Calendar,
  Printer,
  User,
  DoorOpen,
  ChevronDown,
  ChevronUp,
  LayoutTemplate,
  StickyNote,
  AlertCircle,
  ChevronRight,
  X,
  BookOpen,
  ClipboardList,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";
import { statusColors, type Encounter } from "./mock-data";
import { useEncounters, type CompletedCheckout } from "./encounter-context";
import { admin, tasks as tasksApi } from "./api-client";
import { loadSession } from "./auth-session";
import { toast } from "sonner";
import { ADMIN_REFRESH_EVENT, FACILITY_CONTEXT_CHANGED_EVENT } from "./app-events";

// ── Default checklist items (shown for every encounter) ──

const checklistItems = [
  { id: "followup", label: "Schedule follow-up appointment", icon: Calendar },
  { id: "docs", label: "Print visit summary", icon: Printer },
  { id: "referrals", label: "Process referrals", icon: FileText },
  { id: "billing", label: "Verify billing codes", icon: CreditCard },
];

// ── Template types (matching encounter-detail-view pattern) ──

type TemplateField = {
  key?: string;
  name: string;
  type: "text" | "checkbox" | "select" | "textarea" | "number" | "radio" | "date" | "time";
  required: boolean;
  options?: string[];
  group?: string;
};

function fieldKey(field: TemplateField) {
  return field.key || field.name;
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
        typeRaw === "time"
          ? typeRaw
          : "text";
      return {
        key,
        name: label,
        type,
        required: Boolean(field?.required),
        options: Array.isArray(field?.options) ? field.options.map((option: unknown) => String(option)) : undefined,
      } as TemplateField;
    })
    .filter((field) => field.name.length > 0);
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
  return Object.entries(properties).map(([key, definition]) => {
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
}

// Visit-type-conditional checkout templates
const checkoutTemplates: Record<string, TemplateField[]> = {
  "Follow-up": [
    { name: "Follow-up Interval Confirmed", type: "select", required: true, options: ["1 week", "2 weeks", "1 month", "3 months", "6 months", "PRN"], group: "Scheduling" },
    { name: "Lab Orders Printed", type: "checkbox", required: false, group: "Orders" },
    { name: "Medication Changes Reviewed with Patient", type: "checkbox", required: true, group: "Patient Education" },
    { name: "Return Precautions Provided", type: "checkbox", required: false, group: "Patient Education" },
    { name: "Copay / Balance Collected", type: "checkbox", required: false, group: "Billing" },
    { name: "Copay Amount", type: "text", required: false, group: "Billing" },
    { name: "Prescriptions Sent to Pharmacy", type: "checkbox", required: false, group: "Orders" },
    { name: "Checkout Notes", type: "textarea", required: false, group: "Notes" },
  ],
  "Annual Physical": [
    { name: "Preventive Care Summary Given", type: "checkbox", required: true, group: "Patient Education" },
    { name: "Immunization Records Updated", type: "checkbox", required: true, group: "Orders" },
    { name: "Screening Orders Printed", type: "checkbox", required: false, group: "Orders" },
    { name: "Health Maintenance Letter Provided", type: "checkbox", required: false, group: "Patient Education" },
    { name: "Next Annual Scheduled", type: "checkbox", required: true, group: "Scheduling" },
    { name: "Copay / Balance Collected", type: "checkbox", required: false, group: "Billing" },
    { name: "Checkout Notes", type: "textarea", required: false, group: "Notes" },
  ],
  "Sick Visit": [
    { name: "Prescriptions Sent to Pharmacy", type: "checkbox", required: true, group: "Orders" },
    { name: "Pharmacy Confirmed", type: "select", required: false, options: ["CVS", "Walgreens", "Rite Aid", "Mail Order", "Other"], group: "Orders" },
    { name: "Return Precautions Reviewed", type: "checkbox", required: true, group: "Patient Education" },
    { name: "Sick Note Provided", type: "checkbox", required: false, group: "Documentation" },
    { name: "Follow-up If Worsens", type: "checkbox", required: true, group: "Scheduling" },
    { name: "Copay / Balance Collected", type: "checkbox", required: false, group: "Billing" },
    { name: "Checkout Notes", type: "textarea", required: false, group: "Notes" },
  ],
  "New Patient": [
    { name: "Welcome Packet Given", type: "checkbox", required: true, group: "Patient Education" },
    { name: "Patient Portal Access Set Up", type: "checkbox", required: true, group: "Patient Education" },
    { name: "Referrals Processed", type: "checkbox", required: false, group: "Orders" },
    { name: "Lab Orders Printed", type: "checkbox", required: false, group: "Orders" },
    { name: "Follow-up Scheduled", type: "select", required: true, options: ["1 week", "2 weeks", "1 month", "3 months"], group: "Scheduling" },
    { name: "Insurance Copay Collected", type: "checkbox", required: false, group: "Billing" },
    { name: "Copay Amount", type: "text", required: false, group: "Billing" },
    { name: "Checkout Notes", type: "textarea", required: false, group: "Notes" },
  ],
  Procedure: [
    { name: "Post-Procedure Instructions Given", type: "checkbox", required: true, group: "Patient Education" },
    { name: "Wound Care Instructions", type: "checkbox", required: false, group: "Patient Education" },
    { name: "Follow-up Scheduled", type: "select", required: true, options: ["Next day", "2-3 days", "1 week", "2 weeks"], group: "Scheduling" },
    { name: "Prescriptions Sent", type: "checkbox", required: false, group: "Orders" },
    { name: "Specimen Sent to Lab", type: "checkbox", required: false, group: "Orders" },
    { name: "Copay / Balance Collected", type: "checkbox", required: false, group: "Billing" },
    { name: "Checkout Notes", type: "textarea", required: false, group: "Notes" },
  ],
  "Lab Work": [
    { name: "Results Expected Timeframe Given", type: "select", required: true, options: ["Same day", "1-2 days", "3-5 days", "1 week", "2 weeks"], group: "Patient Education" },
    { name: "Results Notification Preference", type: "select", required: false, options: ["Portal", "Phone", "Letter"], group: "Patient Education" },
    { name: "Additional Lab Orders Printed", type: "checkbox", required: false, group: "Orders" },
    { name: "Copay / Balance Collected", type: "checkbox", required: false, group: "Billing" },
    { name: "Checkout Notes", type: "textarea", required: false, group: "Notes" },
  ],
};

// Group config
const groupIcons: Record<string, React.ElementType> = {
  Scheduling: Calendar,
  Orders: ClipboardList,
  "Patient Education": BookOpen,
  Billing: CreditCard,
  Documentation: FileText,
  Notes: StickyNote,
};

const groupColors: Record<string, string> = {
  Scheduling: "#6366f1",
  Orders: "#0ea5e9",
  "Patient Education": "#8b5cf6",
  Billing: "#10b981",
  Documentation: "#f59e0b",
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

export function CheckOutView() {
  const { encounters, completedCheckouts, completeCheckout, getCheckoutData } = useEncounters();
  const [runtimeTemplatesByReason, setRuntimeTemplatesByReason] = useState<Record<string, TemplateField[]>>({});
  const [checkoutTasks, setCheckoutTasks] = useState<any[]>([]);

  const checkoutEncounters = useMemo(
    () => encounters.filter((e) => e.status === "CheckOut"),
    [encounters],
  );
  const optimizedEncounters = useMemo(
    () => encounters.filter((e) => e.status === "Optimized"),
    [encounters],
  );

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedCompletedId, setSelectedCompletedId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const loadRuntimeTemplates = async () => {
      try {
        const facilityId = loadSession()?.facilityId;
        const [reasonRows, templateRows] = await Promise.all([
          admin.listReasons({ facilityId, includeInactive: true, includeArchived: false }),
          admin.listTemplates({ facilityId, type: "checkout" }),
        ]);
        if (!mounted) return;

        const reasonNameById = new Map<string, string>(
          (reasonRows as any[]).map((reason) => [String(reason.id), String(reason.name)]),
        );
        const mapped: Record<string, TemplateField[]> = {};
        (templateRows as any[]).forEach((template) => {
          const reasonIds: string[] = Array.isArray(template.reasonIds)
            ? template.reasonIds
            : template.reasonForVisitId
              ? [template.reasonForVisitId]
              : [];
          const normalizedFields = normalizeRuntimeTemplateFieldsFromTemplate(template);
          reasonIds.forEach((reasonId) => {
            const reasonName = reasonNameById.get(String(reasonId));
            if (reasonName) {
              mapped[reasonName] = normalizedFields;
            }
          });
        });
        setRuntimeTemplatesByReason(mapped);
      } catch {
        if (!mounted) return;
        setRuntimeTemplatesByReason({});
      }
    };

    loadRuntimeTemplates().catch(() => undefined);
    const onRefresh = () => {
      loadRuntimeTemplates().catch(() => undefined);
    };
    if (typeof window !== "undefined") {
      window.addEventListener(ADMIN_REFRESH_EVENT, onRefresh);
      window.addEventListener(FACILITY_CONTEXT_CHANGED_EVENT, onRefresh);
    }
    return () => {
      mounted = false;
      if (typeof window !== "undefined") {
        window.removeEventListener(ADMIN_REFRESH_EVENT, onRefresh);
        window.removeEventListener(FACILITY_CONTEXT_CHANGED_EVENT, onRefresh);
      }
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const loadTasks = async () => {
      try {
        const rows = await tasksApi.list({ assignedToRole: "FrontDeskCheckOut", includeCompleted: false });
        if (!mounted) return;
        const deduped = Array.from(new Map((rows as any[]).map((task) => [task.id, task])).values());
        setCheckoutTasks(deduped);
      } catch {
        if (!mounted) return;
        setCheckoutTasks([]);
      }
    };

    loadTasks().catch(() => undefined);
    const onRefresh = () => {
      loadTasks().catch(() => undefined);
    };
    if (typeof window !== "undefined") {
      window.addEventListener(ADMIN_REFRESH_EVENT, onRefresh);
      window.addEventListener(FACILITY_CONTEXT_CHANGED_EVENT, onRefresh);
    }
    return () => {
      mounted = false;
      if (typeof window !== "undefined") {
        window.removeEventListener(ADMIN_REFRESH_EVENT, onRefresh);
        window.removeEventListener(FACILITY_CONTEXT_CHANGED_EVENT, onRefresh);
      }
    };
  }, []);

  // Recently completed: locally completed first, then base optimized (deduped)
  const recentlyCompleted = useMemo(() => {
    const completedIds = new Set(completedCheckouts.map((c) => c.encounterId));
    const fromCompletions = completedCheckouts.map((c) => c.encounter);
    const fromBase = optimizedEncounters.filter((e) => !completedIds.has(e.id));
    return [...fromCompletions, ...fromBase].slice(0, 8);
  }, [completedCheckouts, optimizedEncounters]);

  // The selected completed data (if any), or a basic encounter for mock Optimized
  const selectedCompleted = useMemo<{ data: CompletedCheckout | null; encounter: Encounter | null }>(() => {
    if (!selectedCompletedId) return { data: null, encounter: null };
    const checkoutData = getCheckoutData(selectedCompletedId);
    if (checkoutData) return { data: checkoutData, encounter: checkoutData.encounter };
    // Fall back to the encounter itself (mock Optimized without checkout data)
    const enc = optimizedEncounters.find((e) => e.id === selectedCompletedId);
    return { data: null, encounter: enc ?? null };
  }, [selectedCompletedId, getCheckoutData, optimizedEncounters]);

  function handleComplete(
    enc: Encounter,
    checkedItems: string[],
    templateValues: Record<string, string | boolean>,
  ) {
    const now = new Date();
    const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
    completeCheckout({
      encounterId: enc.id,
      encounter: enc,
      checkedItems,
      templateValues,
      completedAt: timeStr,
    });
    if (expandedId === enc.id) {
      setExpandedId(null);
    }
    toast.success(`${enc.patientId} checkout complete`, {
      description: `Encounter ${enc.id} finalized at ${timeStr}`,
    });
  }

  async function handleTaskCompletion(taskId: string, completed: boolean) {
    try {
      const updated = await tasksApi.update(taskId, { completed, status: completed ? "completed" : "open" });
      setCheckoutTasks((prev) =>
        completed
          ? prev.filter((task) => task.id !== taskId)
          : prev.map((task) => (task.id === taskId ? { ...task, ...updated } : task)),
      );
    } catch (error) {
      toast.error("Unable to update checkout task", {
        description: (error as Error).message || "Please try again",
      });
    }
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-6 pt-6 pb-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[22px] tracking-tight" style={{ fontWeight: 700 }}>
              <CreditCard className="w-6 h-6 inline-block mr-2 text-emerald-500 -mt-1" />
              Front Desk Check-Out
            </h1>
            <p className="text-[13px] text-muted-foreground mt-0.5">
              Complete checkout checklists and finalize encounters
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-[13px] text-muted-foreground">
              <span style={{ fontWeight: 500 }} className="text-foreground">{checkoutEncounters.length}</span> in queue
            </div>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 min-h-0 overflow-hidden flex px-6 pb-6 gap-6">
        {/* Left: checkout queue */}
        <div className="flex-1 min-h-0 overflow-y-auto px-1 py-1">
          <div className="space-y-3 max-w-[780px]">
            {checkoutEncounters.length === 0 && (
              <Card className="border-0 shadow-sm">
                <CardContent className="p-12 text-center">
                  <CheckCircle2 className="w-12 h-12 text-emerald-300 mx-auto mb-3" />
                  <p className="text-[14px] text-muted-foreground" style={{ fontWeight: 500 }}>No patients awaiting checkout</p>
                  <p className="text-[12px] text-muted-foreground mt-1">Patients will appear here after their visit ends</p>
                </CardContent>
              </Card>
            )}
            {checkoutEncounters.map((e) => (
              <CheckoutCard
                key={e.id}
                encounter={e}
                templatesByReason={runtimeTemplatesByReason}
                assignedTasks={checkoutTasks.filter((task) => task.encounterId === e.id)}
                isExpanded={expandedId === e.id}
                onToggle={() => setExpandedId(expandedId === e.id ? null : e.id)}
                onTaskToggle={handleTaskCompletion}
                onComplete={handleComplete}
              />
            ))}
          </div>
        </div>

        {/* Right: recently completed / detail */}
        <div className="w-[340px] min-w-[340px] flex flex-col min-h-0">
          {selectedCompleted.encounter ? (
            /* ── Completed detail view ── */
            <CompletedDetailPanel
              data={selectedCompleted.data}
              encounter={selectedCompleted.encounter}
              templatesByReason={runtimeTemplatesByReason}
              onClose={() => setSelectedCompletedId(null)}
            />
          ) : (
            /* ── Recently completed list ── */
            <Card className="border-0 shadow-sm flex-1 min-h-0 flex flex-col overflow-hidden">
              <CardHeader className="pb-2 pt-5 px-5 shrink-0">
                <CardTitle className="text-[14px] flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-cyan-500" />
                  Recently Completed
                  {recentlyCompleted.length > 0 && (
                    <Badge className="border-0 bg-cyan-100 text-cyan-700 text-[9px] px-1.5 h-4">
                      {recentlyCompleted.length}
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-5 pb-5 flex-1 min-h-0 overflow-y-auto">
                <div className="space-y-2">
                  {recentlyCompleted.length === 0 ? (
                    <div className="py-8 text-center">
                      <Clock className="w-8 h-8 text-gray-200 mx-auto mb-2" />
                      <p className="text-[12px] text-muted-foreground">No completed checkouts yet</p>
                    </div>
                  ) : (
                    recentlyCompleted.map((e) => {
                      const hasCheckoutData = !!getCheckoutData(e.id);
                      return (
                        <div
                          key={e.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => setSelectedCompletedId(e.id)}
                          onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") setSelectedCompletedId(e.id); }}
                          className="w-full text-left rounded-lg border border-gray-100 p-3 flex items-center gap-3 transition-colors cursor-pointer hover:bg-gray-50 hover:border-gray-200"
                        >
                          <div
                            className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[11px] shrink-0"
                            style={{ backgroundColor: statusColors.Optimized, fontWeight: 600 }}
                          >
                            {e.patientInitials}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[13px] truncate" style={{ fontWeight: 500 }}>{e.patientId}</span>
                              <Badge className="bg-gray-100 text-gray-500 border-0 text-[9px] h-4 px-1.5">{e.visitType}</Badge>
                            </div>
                            <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                              <span>{e.provider}</span>
                              {hasCheckoutData && (
                                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600" style={{ fontWeight: 500 }}>
                                  Checked out
                                </span>
                              )}
                            </div>
                          </div>
                          <ChevronRight className="w-4 h-4 text-gray-300 shrink-0" />
                        </div>
                      );
                    })
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// ── Checkout Card (expanded with default fields + template + action) ──
// ══════════════════════════════════════════════════════════

function CheckoutCard({
  encounter: e,
  templatesByReason,
  assignedTasks,
  isExpanded,
  onToggle,
  onTaskToggle,
  onComplete,
}: {
  encounter: Encounter;
  templatesByReason: Record<string, TemplateField[]>;
  assignedTasks: any[];
  isExpanded: boolean;
  onToggle: () => void;
  onTaskToggle: (taskId: string, completed: boolean) => Promise<void>;
  onComplete: (enc: Encounter, checkedItems: string[], templateValues: Record<string, string | boolean>) => void;
}) {
  const [checked, setChecked] = useState<string[]>([]);
  const [templateValues, setTemplateValues] = useState<Record<string, string | boolean>>({});
  const [collectionExpected, setCollectionExpected] = useState(false);
  const [amountDueCents, setAmountDueCents] = useState("0");
  const [amountCollectedCents, setAmountCollectedCents] = useState("0");
  const [collectionOutcome, setCollectionOutcome] = useState("NoCollectionExpected");
  const [missedCollectionReason, setMissedCollectionReason] = useState("");
  const [collectionNote, setCollectionNote] = useState("");

  const templateFields = templatesByReason[e.visitType] ?? checkoutTemplates[e.visitType] ?? [];
  const fieldGroups = useMemo(() => groupFields(templateFields), [templateFields]);
  const hasGroups = templateFields.some((f) => f.group);

  const requiredFields = templateFields.filter((f) => f.required);
  const requiredCount = requiredFields.length;
  const completedCount = requiredFields.filter((f) => {
    const val = templateValues[fieldKey(f)];
    if (f.type === "checkbox") return !!val;
    return !!val && (typeof val === "string" ? val.trim() !== "" : true);
  }).length;

  const defaultsDone = checked.length === checklistItems.length;
  const templateDone = requiredCount === 0 || completedCount === requiredCount;
  const blockingOpenTasks = assignedTasks.filter((task) => task.blocking && !task.completedAt && String(task.status || "").toLowerCase() !== "completed");
  const blockingCompletedCount = assignedTasks.filter((task) => task.blocking && (task.completedAt || String(task.status || "").toLowerCase() === "completed")).length;
  const collectionNeedsReason = ["CollectedPartial", "NotCollected", "Deferred"].includes(collectionOutcome);
  const collectionTrackingReady = !collectionNeedsReason || missedCollectionReason.trim().length > 0;
  const allReady = defaultsDone && templateDone && blockingOpenTasks.length === 0 && collectionTrackingReady;

  const totalRequired = checklistItems.length + requiredCount + blockingOpenTasks.length + blockingCompletedCount;
  const totalCompleted = checked.length + completedCount + blockingCompletedCount;

  function setFieldValue(fieldName: string, value: string | boolean) {
    setTemplateValues((prev) => ({ ...prev, [fieldName]: value }));
  }

  return (
    <Card className={`border-0 shadow-sm transition-all overflow-hidden ${isExpanded ? "ring-2 ring-emerald-200" : ""}`}>
      {isExpanded && <div className="h-1 bg-gradient-to-r from-emerald-500 to-teal-400" />}

      {/* Header row */}
      <div
        className="flex items-center gap-4 px-5 py-4 cursor-pointer hover:bg-gray-50/50 transition-colors"
        onClick={onToggle}
      >
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center text-white text-[13px]"
          style={{ backgroundColor: statusColors.CheckOut, fontWeight: 600 }}
        >
          {e.patientInitials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[14px]" style={{ fontWeight: 500 }}>{e.patientId}</span>
            <Badge className="bg-emerald-100 text-emerald-700 border-0 text-[10px]">{e.visitType}</Badge>
          </div>
          <div className="flex items-center gap-3 mt-1 text-[12px] text-muted-foreground">
            <span className="flex items-center gap-1"><User className="w-3 h-3" />{e.provider}</span>
            {e.roomNumber && <span className="flex items-center gap-1"><DoorOpen className="w-3 h-3" />{e.roomNumber}</span>}
            <span className="flex items-center gap-1"><Clock className="w-3 h-3" />In checkout {e.minutesInStage}m</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-muted-foreground">{totalCompleted}/{totalRequired}</span>
          <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: totalRequired > 0 ? `${(totalCompleted / totalRequired) * 100}%` : "0%",
                backgroundColor: allReady ? "#10b981" : "#8b5cf6",
              }}
            />
          </div>
          {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
        </div>
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <div className="px-5 pb-5 border-t border-gray-100 pt-4 space-y-5">
          {/* ── Default checklist fields ── */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-6 h-6 rounded-md bg-emerald-100 flex items-center justify-center">
                <ClipboardList className="w-3.5 h-3.5 text-emerald-600" />
              </div>
              <span className="text-[12px]" style={{ fontWeight: 600 }}>Checkout Checklist</span>
              <span className="text-[11px] text-muted-foreground">{checked.length}/{checklistItems.length}</span>
              {defaultsDone && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />}
            </div>
            <div className="space-y-2">
              {checklistItems.map((item) => {
                const isChecked = checked.includes(item.id);
                return (
                  <label
                    key={item.id}
                    className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                      isChecked ? "bg-emerald-50 border-emerald-200" : "border-gray-100 hover:border-gray-200"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => {
                        setChecked((prev) =>
                          isChecked ? prev.filter((id) => id !== item.id) : [...prev, item.id]
                        );
                      }}
                      className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                    />
                    <item.icon className={`w-4 h-4 ${isChecked ? "text-emerald-500" : "text-gray-400"}`} />
                    <span className={`text-[13px] ${isChecked ? "line-through text-muted-foreground" : ""}`}>
                      {item.label}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-6 h-6 rounded-md bg-amber-100 flex items-center justify-center">
                <AlertCircle className="w-3.5 h-3.5 text-amber-600" />
              </div>
              <span className="text-[12px]" style={{ fontWeight: 600 }}>Assigned Tasks</span>
              <span className="text-[11px] text-muted-foreground">{assignedTasks.length}</span>
            </div>
            {assignedTasks.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50/60 p-3 text-[12px] text-muted-foreground">
                No Front Desk Check-Out tasks are assigned to this patient.
              </div>
            ) : (
              <div className="space-y-2">
                {assignedTasks.map((task) => {
                  const isDone = Boolean(task.completedAt) || String(task.status || "").toLowerCase() === "completed";
                  return (
                    <label
                      key={task.id}
                      className={`flex items-start gap-3 p-3 rounded-lg border transition-all ${
                        isDone ? "bg-emerald-50 border-emerald-200" : task.blocking ? "bg-amber-50 border-amber-200" : "border-gray-100 hover:border-gray-200"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isDone}
                        onChange={(event) => {
                          onTaskToggle(task.id, event.target.checked).catch(() => undefined);
                        }}
                        className="mt-0.5 w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-[13px] ${isDone ? "line-through text-muted-foreground" : ""}`} style={{ fontWeight: 500 }}>
                            {task.description}
                          </span>
                          {task.blocking && (
                            <Badge className="bg-amber-100 text-amber-700 border-0 text-[9px] h-4 px-1.5">
                              Blocking
                            </Badge>
                          )}
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-1">
                          {task.taskType} · {task.assignedToRole || "Assigned"} · Created {new Date(task.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                        </div>
                        {task.notes && (
                          <div className="text-[11px] text-gray-600 mt-1">
                            {task.notes}
                          </div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-emerald-100 bg-emerald-50/50 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-emerald-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-emerald-100 flex items-center justify-center">
                  <CreditCard className="w-3.5 h-3.5 text-emerald-600" />
                </div>
                <div>
                  <span className="text-[13px]" style={{ fontWeight: 600 }}>Collection Tracking</span>
                  <span className="text-[11px] text-muted-foreground ml-2">Revenue Cycle normalization</span>
                </div>
              </div>
              <Badge className={`border-0 text-[10px] ${collectionTrackingReady ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                {collectionTrackingReady ? "Complete" : "Needs reason"}
              </Badge>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label className="flex items-center justify-between rounded-lg border border-emerald-100 bg-white px-4 py-3 cursor-pointer">
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-emerald-700" style={{ fontWeight: 700 }}>
                      Collection Expected
                    </div>
                    <div className="text-[12px] text-gray-600 mt-1">Should front desk expect same-day patient responsibility?</div>
                  </div>
                  <Switch checked={collectionExpected} onCheckedChange={setCollectionExpected} />
                </label>
                <div>
                  <label className="text-[11px] text-muted-foreground mb-1.5 block uppercase tracking-wider" style={{ fontWeight: 500 }}>
                    Collection Outcome
                  </label>
                  <select
                    value={collectionOutcome}
                    onChange={(event) => setCollectionOutcome(event.target.value)}
                    className="w-full h-10 px-4 rounded-lg border border-gray-200 bg-white text-[13px] appearance-none focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                  >
                    <option value="CollectedInFull">Collected in full</option>
                    <option value="CollectedPartial">Collected partial</option>
                    <option value="NotCollected">Not collected</option>
                    <option value="NoCollectionExpected">No collection expected</option>
                    <option value="Waived">Waived</option>
                    <option value="Deferred">Deferred</option>
                  </select>
                </div>
                <FormField label="Amount Due (cents)" icon={CreditCard}>
                  <input
                    type="number"
                    value={amountDueCents}
                    onChange={(event) => setAmountDueCents(event.target.value)}
                    className="w-full h-10 pl-10 pr-4 rounded-lg border border-gray-200 bg-white text-[13px] focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                  />
                </FormField>
                <FormField label="Amount Collected (cents)" icon={CreditCard}>
                  <input
                    type="number"
                    value={amountCollectedCents}
                    onChange={(event) => setAmountCollectedCents(event.target.value)}
                    className="w-full h-10 pl-10 pr-4 rounded-lg border border-gray-200 bg-white text-[13px] focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                  />
                </FormField>
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground mb-1.5 block uppercase tracking-wider" style={{ fontWeight: 500 }}>
                  Missed Collection Reason {collectionNeedsReason && <span className="text-red-500">*</span>}
                </label>
                <textarea
                  rows={2}
                  value={missedCollectionReason}
                  onChange={(event) => setMissedCollectionReason(event.target.value)}
                  placeholder="Required for partial, deferred, or not-collected outcomes..."
                  className={`w-full px-4 py-2.5 rounded-lg border bg-white text-[13px] resize-none focus:outline-none focus:ring-2 ${
                    collectionNeedsReason && !collectionTrackingReady
                      ? "border-red-300 focus:border-red-400 focus:ring-red-100"
                      : "border-gray-200 focus:border-indigo-300 focus:ring-indigo-100"
                  }`}
                />
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground mb-1.5 block uppercase tracking-wider" style={{ fontWeight: 500 }}>
                  Collection Note
                </label>
                <textarea
                  rows={2}
                  value={collectionNote}
                  onChange={(event) => setCollectionNote(event.target.value)}
                  placeholder="Optional context for Revenue Cycle..."
                  className="w-full px-4 py-2.5 rounded-lg border border-gray-200 bg-white text-[13px] resize-none focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                />
              </div>
            </div>
          </div>

          {/* ── Visit-reason-conditional template section (purple sub-card) ── */}
          {templateFields.length > 0 && (
            <div className="rounded-xl border border-purple-100 bg-purple-50/50 overflow-hidden">
              {/* Template header bar */}
              <div className="px-5 py-3.5 border-b border-purple-100 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-purple-100 flex items-center justify-center">
                    <LayoutTemplate className="w-3.5 h-3.5 text-purple-600" />
                  </div>
                  <div>
                    <span className="text-[13px]" style={{ fontWeight: 600 }}>
                      Checkout Template
                    </span>
                    <span className="text-[11px] text-muted-foreground ml-2">
                      {e.visitType}
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
                        backgroundColor: templateDone && requiredCount > 0 ? "#10b981" : "#8b5cf6",
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* Template fields — grouped */}
              <div className="p-5 space-y-5">
                {hasGroups ? (
                  fieldGroups.map((grp) => {
                    const GrpIcon = groupIcons[grp.group] || FileText;
                    const grpColor = groupColors[grp.group] || "#64748b";
                    const grpRequired = grp.fields.filter((f) => f.required).length;
                    const grpCompleted = grp.fields.filter((f) => {
                      if (!f.required) return false;
                      const val = templateValues[fieldKey(f)];
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
                              key={`checkout-${grp.group}-${idx}`}
                              field={field}
                              value={templateValues[fieldKey(field)]}
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
                        key={`checkout-${idx}`}
                        field={field}
                        value={templateValues[fieldKey(field)]}
                        onChange={(val) => setFieldValue(fieldKey(field), val)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Empty state: visit type has no template */}
          {templateFields.length === 0 && (
            <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50/50 p-6 text-center">
              <LayoutTemplate className="w-7 h-7 text-gray-300 mx-auto mb-1.5" />
              <p className="text-[12px] text-muted-foreground" style={{ fontWeight: 500 }}>
                No checkout template for {e.visitType}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Create one in Admin Console → Reasons &amp; Templates
              </p>
            </div>
          )}

          {/* ── Status line + Complete Checkout button ── */}
          <div className="pt-2">
            <div className="flex items-center gap-2.5 mb-3">
              {!defaultsDone && (
                <span className="text-[11px] text-amber-600 flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5" /> {checklistItems.length - checked.length} checklist item{checklistItems.length - checked.length !== 1 ? "s" : ""} remaining
                </span>
              )}
              {requiredCount > 0 && completedCount < requiredCount && (
                <span className="text-[11px] text-muted-foreground">
                  {requiredCount - completedCount} required template field{requiredCount - completedCount !== 1 ? "s" : ""} remaining
                </span>
              )}
              {blockingOpenTasks.length > 0 && (
                <span className="text-[11px] text-amber-600">
                  {blockingOpenTasks.length} blocking checkout task{blockingOpenTasks.length !== 1 ? "s" : ""} remaining
                </span>
              )}
              {!collectionTrackingReady && (
                <span className="text-[11px] text-amber-600">
                  Add a missed collection reason before completing checkout
                </span>
              )}
              {allReady && (
                <span className="text-[11px] text-emerald-600 flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" /> All requirements met
                </span>
              )}
            </div>
            <button
              onClick={() =>
                onComplete(e, checked, {
                  ...templateValues,
                  "billing.collection_expected": collectionExpected,
                  "billing.amount_due_cents": amountDueCents,
                  "billing.amount_collected_cents": amountCollectedCents,
                  "billing.collection_outcome": collectionOutcome,
                  "billing.missed_reason": missedCollectionReason,
                  "billing.tracking_note": collectionNote,
                })
              }
              disabled={!allReady}
              className={`w-full h-12 rounded-xl text-[14px] flex items-center justify-center gap-2 shadow-sm transition-all ${
                allReady
                  ? "bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800"
                  : "bg-gray-200 text-gray-400 cursor-not-allowed"
              }`}
              style={{ fontWeight: 600 }}
            >
              <CheckCircle2 className="w-5 h-5" />
              Complete Checkout
              <ChevronRight className="w-4 h-4 ml-1" />
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ══════════════════════════════════════════════════════════
// ── Completed Detail Panel ──
// ══════════════════════════════════════════════════════════

function CompletedDetailPanel({
  data,
  encounter: e,
  templatesByReason,
  onClose,
}: {
  data: CompletedCheckout | null;
  encounter: Encounter;
  templatesByReason: Record<string, TemplateField[]>;
  onClose: () => void;
}) {
  const templateFields = templatesByReason[e.visitType] ?? checkoutTemplates[e.visitType] ?? [];
  const fieldGroups = groupFields(templateFields);
  const hasGroups = templateFields.some((f) => f.group);
  const hasData = !!data;

  return (
    <div className="flex-1 min-h-0 flex flex-col rounded-xl bg-white shadow-sm overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-cyan-500 to-emerald-400" />

      {/* Header */}
      <div className="shrink-0 px-5 py-4 border-b border-gray-100 flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center text-white text-[13px] shrink-0"
          style={{ backgroundColor: statusColors.Optimized, fontWeight: 600 }}
        >
          {e.patientInitials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[15px]" style={{ fontWeight: 600 }}>{e.patientId}</span>
            <Badge className="bg-emerald-50 text-emerald-600 border-0 text-[10px] h-5 px-2" style={{ fontWeight: 600 }}>
              Completed
            </Badge>
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[11px] text-muted-foreground">
            <span>{e.visitType}</span>
            <span>·</span>
            <span>{e.provider}</span>
            {data && (
              <span className="contents">
                <span>·</span>
                <span>Checked out {data.completedAt}</span>
              </span>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 w-8 h-8 rounded-lg hover:bg-gray-100 flex items-center justify-center transition-colors"
        >
          <X className="w-4 h-4 text-gray-400" />
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-5 space-y-4">
          {hasData ? (
            <>
              {/* Default checklist summary */}
              <div className="rounded-xl border border-emerald-100 bg-emerald-50/30 overflow-hidden">
                <div className="px-4 py-3 border-b border-emerald-100/80 flex items-center gap-2">
                  <div className="w-6 h-6 rounded-md bg-emerald-100 flex items-center justify-center">
                    <ClipboardList className="w-3.5 h-3.5 text-emerald-600" />
                  </div>
                  <span className="text-[12px]" style={{ fontWeight: 600 }}>Checkout Checklist</span>
                  <span className="text-[10px] text-muted-foreground ml-auto">{data!.checkedItems.length}/{checklistItems.length}</span>
                  {data!.checkedItems.length === checklistItems.length && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />}
                </div>
                <div className="p-4 space-y-1.5">
                  {checklistItems.map((item) => {
                    const wasChecked = data!.checkedItems.includes(item.id);
                    return (
                      <div key={item.id} className="flex items-center gap-2.5 py-1">
                        <div className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 ${wasChecked ? "bg-emerald-100" : "bg-gray-100"}`}>
                          {wasChecked ? (
                            <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                          ) : (
                            <X className="w-2.5 h-2.5 text-gray-400" />
                          )}
                        </div>
                        <item.icon className={`w-3.5 h-3.5 ${wasChecked ? "text-emerald-500" : "text-gray-300"}`} />
                        <span className={`text-[12px] ${wasChecked ? "text-gray-700" : "text-gray-400 line-through"}`}>
                          {item.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Template values summary */}
              {templateFields.length > 0 && (
                <div className="rounded-xl border border-purple-100 bg-purple-50/30 overflow-hidden">
                  <div className="px-4 py-3 border-b border-purple-100/80 flex items-center gap-2">
                    <div className="w-6 h-6 rounded-md bg-purple-100 flex items-center justify-center">
                      <LayoutTemplate className="w-3.5 h-3.5 text-purple-600" />
                    </div>
                    <span className="text-[12px]" style={{ fontWeight: 600 }}>Checkout Template</span>
                    <span className="text-[11px] text-muted-foreground">{e.visitType}</span>
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 ml-auto" />
                  </div>
                  <div className="p-4 space-y-4">
                    {hasGroups ? (
                      fieldGroups.map((grp) => {
                        const GrpIcon = groupIcons[grp.group] || FileText;
                        const grpColor = groupColors[grp.group] || "#64748b";
                        return (
                          <div key={grp.group}>
                            <div className="flex items-center gap-2 mb-2">
                              <div className="w-4 h-4 rounded flex items-center justify-center" style={{ backgroundColor: `${grpColor}15` }}>
                                <GrpIcon className="w-2.5 h-2.5" style={{ color: grpColor }} />
                              </div>
                              <span className="text-[10px] uppercase tracking-wider" style={{ fontWeight: 600, color: grpColor }}>
                                {grp.group}
                              </span>
                            </div>
                            <div className="space-y-1.5 pl-6">
                              {grp.fields.map((field) => (
                                <CompletedFieldRow
                                  key={field.name}
                                  field={field}
                                  value={data!.templateValues[fieldKey(field)]}
                                />
                              ))}
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="space-y-1.5">
                        {templateFields.map((field) => (
                          <CompletedFieldRow
                            key={field.name}
                            field={field}
                            value={data!.templateValues[fieldKey(field)]}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : (
            /* ── No checkout data: show basic encounter info ── */
            <div className="rounded-xl border border-gray-100 bg-gray-50/30 p-6 text-center">
              <CheckCircle2 className="w-10 h-10 text-emerald-300 mx-auto mb-2" />
              <p className="text-[13px] text-gray-600 mb-1" style={{ fontWeight: 500 }}>
                Completed prior to this session
              </p>
              <p className="text-[11px] text-muted-foreground">
                Checkout details were not recorded in the current session. This encounter was already in Optimized status.
              </p>
            </div>
          )}

          {/* Encounter info (always shown) */}
          <div className="rounded-xl border border-gray-100 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
              <div className="w-6 h-6 rounded-md bg-gray-100 flex items-center justify-center">
                <FileText className="w-3.5 h-3.5 text-gray-500" />
              </div>
              <span className="text-[12px]" style={{ fontWeight: 600 }}>Encounter Info</span>
            </div>
            <div className="p-4 grid grid-cols-2 gap-x-4 gap-y-2.5 text-[11px]">
              <InfoRow label="Encounter ID" value={e.id} />
              <InfoRow label="Visit Type" value={e.visitType} />
              <InfoRow label="Provider" value={e.provider} />
              <InfoRow label="Room" value={e.roomNumber || "—"} />
              <InfoRow label="Clinic" value={e.clinicName} />
              <InfoRow label="Check-In" value={e.checkinTime} />
              {data && <InfoRow label="Completed" value={data.completedAt} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Helper: read-only field display for completed checkout ──

function CompletedFieldRow({
  field,
  value,
}: {
  field: TemplateField;
  value: string | boolean | undefined;
}) {
  const hasValue = value !== undefined && value !== "" && value !== false;

  if (field.type === "checkbox") {
    return (
      <div className="flex items-center gap-2 py-0.5">
        <div className={`w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0 ${hasValue ? "bg-emerald-100" : "bg-gray-100"}`}>
          {hasValue ? (
            <CheckCircle2 className="w-2.5 h-2.5 text-emerald-600" />
          ) : (
            <X className="w-2 h-2 text-gray-400" />
          )}
        </div>
        <span className={`text-[11px] ${hasValue ? "text-gray-700" : "text-gray-400"}`}>
          {field.name}
          {field.required && !hasValue && <span className="text-red-400 ml-0.5">*</span>}
        </span>
      </div>
    );
  }

  if (field.type === "textarea") {
    return (
      <div className="py-0.5">
        <span className="text-[10px] text-muted-foreground">{field.name}</span>
        {hasValue ? (
          <p className="text-[11px] text-gray-700 mt-0.5 bg-white rounded-md border border-gray-100 px-2.5 py-1.5">
            {String(value)}
          </p>
        ) : (
          <p className="text-[11px] text-gray-400 italic mt-0.5">Not filled</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-[11px] text-muted-foreground">
        {field.name}
        {field.required && !hasValue && <span className="text-red-400 ml-0.5">*</span>}
      </span>
      <span className={`text-[11px] ${hasValue ? "text-gray-700" : "text-gray-400 italic"}`} style={hasValue ? { fontWeight: 500 } : undefined}>
        {hasValue ? String(value) : "—"}
      </span>
    </div>
  );
}

// ── Info Row ──

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-[9px] text-muted-foreground uppercase tracking-wider" style={{ fontWeight: 500 }}>{label}</span>
      <p className="text-[12px] text-gray-700 mt-0.5" style={{ fontWeight: 500 }}>{value}</p>
    </div>
  );
}

// ── Template Field Input (matches encounter-detail-view pattern) ──

function TemplateFieldInput({
  field,
  value,
  onChange,
}: {
  field: TemplateField;
  value: string | boolean | undefined;
  onChange: (val: string | boolean) => void;
}) {
  if (field.type === "checkbox") {
    return (
      <label className="flex items-center gap-3 cursor-pointer group">
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked)}
          className="w-4 h-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
        />
        <span className="text-[12px] text-gray-700 group-hover:text-gray-900 transition-colors">
          {field.name}
        </span>
        {field.required && (
          <span className="text-[9px] text-red-400" style={{ fontWeight: 500 }}>Required</span>
        )}
      </label>
    );
  }

  if (field.type === "textarea") {
    return (
      <div>
        <label className="text-[11px] text-muted-foreground mb-1 block" style={{ fontWeight: 500 }}>
          {field.name}
          {field.required && <span className="text-red-400 ml-1">*</span>}
        </label>
        <textarea
          rows={2}
          placeholder={`Enter ${field.name.toLowerCase()}...`}
          value={(value as string) || ""}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-purple-200 bg-white text-[13px] focus:outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-100 resize-none"
        />
      </div>
    );
  }

  if (field.type === "select") {
    return (
      <div>
        <label className="text-[11px] text-muted-foreground mb-1 block" style={{ fontWeight: 500 }}>
          {field.name}
          {field.required && <span className="text-red-400 ml-1">*</span>}
        </label>
        <select
          value={(value as string) || ""}
          onChange={(e) => onChange(e.target.value)}
          className="w-full h-9 px-3 rounded-lg border border-purple-200 bg-white text-[13px] appearance-none focus:outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-100"
        >
          <option value="">Select...</option>
          {field.options?.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      </div>
    );
  }

  if (field.type === "radio") {
    return (
      <div>
        <label className="text-[11px] text-muted-foreground mb-1 block" style={{ fontWeight: 500 }}>
          {field.name}
          {field.required && <span className="text-red-400 ml-1">*</span>}
        </label>
        <div className="flex flex-wrap gap-2">
          {(field.options ?? []).map((opt) => (
            <label key={opt} className="h-8 px-3 rounded-lg border border-purple-200 bg-white text-[12px] flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name={`checkout-${fieldKey(field)}`}
                checked={value === opt}
                onChange={() => onChange(opt)}
                className="w-3.5 h-3.5 rounded-full border-gray-300 text-purple-600"
              />
              <span>{opt}</span>
            </label>
          ))}
        </div>
      </div>
    );
  }

  if (field.type === "date" || field.type === "time" || field.type === "number") {
    return (
      <div>
        <label className="text-[11px] text-muted-foreground mb-1 block" style={{ fontWeight: 500 }}>
          {field.name}
          {field.required && <span className="text-red-400 ml-1">*</span>}
        </label>
        <input
          type={field.type}
          placeholder={`Enter ${field.name.toLowerCase()}...`}
          value={(value as string) || ""}
          onChange={(e) => onChange(e.target.value)}
          className="w-full h-9 px-3 rounded-lg border border-purple-200 bg-white text-[13px] focus:outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-100"
        />
      </div>
    );
  }

  // text
  return (
    <div>
      <label className="text-[11px] text-muted-foreground mb-1 block" style={{ fontWeight: 500 }}>
        {field.name}
        {field.required && <span className="text-red-400 ml-1">*</span>}
      </label>
      <input
        type="text"
        placeholder={`Enter ${field.name.toLowerCase()}...`}
        value={(value as string) || ""}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-9 px-3 rounded-lg border border-purple-200 bg-white text-[13px] focus:outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-100"
      />
    </div>
  );
}
