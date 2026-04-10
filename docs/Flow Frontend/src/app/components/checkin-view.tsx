import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  ClipboardCheck,
  User,
  Stethoscope,
  Clock,
  CheckCircle2,
  ArrowRight,
  Inbox,
  Users,
  AlertTriangle,
  LayoutTemplate,
  Shield,
  Footprints,
  CircleDot,
  FileCheck,
  Pencil,
  Save,
  CalendarDays,
  X,
} from "lucide-react";
import { Card, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { Switch } from "./ui/switch";
import { statusColors } from "./mock-data";
import { useEncounters } from "./encounter-context";
import { admin, incoming } from "./api-client";
import { loadSession } from "./auth-session";
import { toast } from "sonner";
import { labelUserName } from "./display-names";
import { ADMIN_REFRESH_EVENT, FACILITY_CONTEXT_CHANGED_EVENT } from "./app-events";

// ── Data ──

type TemplateField = {
  key: string;
  label: string;
  type: "text" | "checkbox" | "select" | "textarea" | "number" | "radio" | "date" | "time";
  required: boolean;
  options?: string[];
};

function reasonCodeFromName(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("")
    .padEnd(2, "X");
}

function deriveCheckInFallbackFromEncounters(encounters: Array<{
  clinicId: string;
  clinicName: string;
  provider: string;
  visitType: string;
}>) {
  const clinics = Array.from(
    new Map(
      encounters.map((encounter) => [encounter.clinicId, {
        id: encounter.clinicId,
        name: encounter.clinicName,
        maRun: false,
      }]),
    ).values(),
  );

  const providersByName = new Map<string, { id: string; name: string; clinicIds: Set<string> }>();
  encounters.forEach((encounter) => {
    const providerName = (encounter.provider || "").trim();
    if (!providerName || providerName.toLowerCase() === "unassigned" || providerName.includes("(Archived)")) return;
    const key = providerName.toLowerCase();
    if (!providersByName.has(key)) {
      providersByName.set(key, {
        id: providerName,
        name: providerName,
        clinicIds: new Set<string>(),
      });
    }
    providersByName.get(key)!.clinicIds.add(encounter.clinicId);
  });
  const providers = Array.from(providersByName.values()).map((row) => ({
    id: row.id,
    name: row.name,
    clinicIds: Array.from(row.clinicIds),
  }));

  const reasons = Array.from(
    new Map(
      encounters.map((encounter) => [encounter.visitType, {
        id: encounter.visitType,
        name: encounter.visitType,
        clinicIds: [encounter.clinicId],
      }]),
    ).values(),
  );

  return { clinics, providers, reasons };
}

function normalizeTemplateFields(input: any[]): TemplateField[] {
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
        label,
        type,
        required: Boolean(field?.required),
        options: Array.isArray(field?.options) ? field.options.map((option: unknown) => String(option)) : undefined,
      } as TemplateField;
    })
    .filter((field) => field.key.length > 0 && field.label.length > 0);
}

function normalizeTemplateFieldsFromTemplate(template: any): TemplateField[] {
  const normalized = normalizeTemplateFields(
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
  const derived = Object.entries(properties).map(([key, definition], index) => {
    const rawType = String((definition as any)?.type || "text");
    const enumValues = Array.isArray((definition as any)?.enum) ? (definition as any).enum : undefined;
    return {
      key,
      label: String((definition as any)?.title || key),
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
  return derived.length > 0
    ? derived
    : [{ key: "notes", label: "Notes", type: "textarea", required: false }];
}

// ── Component ──

export function CheckInView() {
  const navigate = useNavigate();
  const { encounters, checkInPatient, isLiveMode, syncError, refreshData } = useEncounters();

  const [clinics, setClinics] = useState<Array<{ id: string; name: string; maRun: boolean }>>([]);
  const [providers, setProviders] = useState<Array<{ id: string; name: string; clinicIds: string[] }>>([]);
  const [visitReasons, setVisitReasons] = useState<Array<{ id: string; name: string; clinicIds: string[] }>>([]);
  const [templatesByReasonId, setTemplatesByReasonId] = useState<Record<string, TemplateField[]>>({});

  const [patientId, setPatientId] = useState("");
  const [selectedReason, setSelectedReason] = useState("");
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedClinic, setSelectedClinic] = useState("");
  const [appointmentTime, setAppointmentTime] = useState("");
  const [isWalkIn, setIsWalkIn] = useState(false);
  const [insuranceVerified, setInsuranceVerified] = useState(true);
  const [selectedIncoming, setSelectedIncoming] = useState("");
  const [selectedLobbyEncounterId, setSelectedLobbyEncounterId] = useState("");
  const [templateValues, setTemplateValues] = useState<Record<string, string | boolean>>({});
  const [localDismissedIncomingIds, setLocalDismissedIncomingIds] = useState<string[]>([]);
  const [editingIncomingId, setEditingIncomingId] = useState<string | null>(null);
  const [incomingDraft, setIncomingDraft] = useState<{ dateOfService: string; appointmentTime: string }>({
    dateOfService: "",
    appointmentTime: "",
  });
  const [savingIncomingId, setSavingIncomingId] = useState<string | null>(null);

  const incomingPatients = useMemo(
    () => encounters.filter((encounter) => encounter.status === "Incoming" && !localDismissedIncomingIds.includes(encounter.id)),
    [encounters, localDismissedIncomingIds],
  );
  const lobbyPatients = useMemo(
    () => encounters.filter((encounter) => encounter.status === "Lobby"),
    [encounters],
  );

  useEffect(() => {
    if (localDismissedIncomingIds.length === 0) return;
    const incomingIds = new Set(encounters.filter((encounter) => encounter.status === "Incoming").map((encounter) => encounter.id));
    setLocalDismissedIncomingIds((prev) => prev.filter((id) => incomingIds.has(id)));
  }, [encounters, localDismissedIncomingIds.length]);

  useEffect(() => {
    let mounted = true;
    const fallbackRows = deriveCheckInFallbackFromEncounters(encounters);
    const applyFallback = () => {
      if (!mounted) return;
      setClinics(fallbackRows.clinics);
      setProviders(fallbackRows.providers);
      setVisitReasons(fallbackRows.reasons);
      setTemplatesByReasonId({});
    };

    const loadConfig = async () => {
      const facilityId = loadSession()?.facilityId;
      const [clinicRowsResult, assignmentRowsResult, reasonRowsResult, templateRowsResult] = await Promise.allSettled([
        admin.listClinics({ facilityId }),
        admin.listAssignments(facilityId),
        admin.listReasons({ facilityId }),
        admin.listTemplates({ facilityId, type: "checkin" }),
      ]);
      if (!mounted) return;

      const anySuccess =
        clinicRowsResult.status === "fulfilled" ||
        assignmentRowsResult.status === "fulfilled" ||
        reasonRowsResult.status === "fulfilled" ||
        templateRowsResult.status === "fulfilled";

      if (!anySuccess) {
        applyFallback();
        return;
      }

      if (clinicRowsResult.status === "fulfilled") {
        setClinics(
          (clinicRowsResult.value as any[])
            .filter((row) => String(row.status || "active") === "active")
            .map((row) => ({ id: row.id, name: row.name, maRun: Boolean(row.maRun) })),
        );
      } else {
        setClinics(fallbackRows.clinics);
      }

      if (assignmentRowsResult.status === "fulfilled") {
        const uniqueProviders = new Map<string, { id: string; name: string; clinicIds: Set<string> }>();
        (assignmentRowsResult.value as any[]).forEach((row) => {
          const providerStatus = String(row.providerUserStatus || "").toLowerCase();
          if (providerStatus && providerStatus !== "active") return;
          const providerName = labelUserName(String(row.providerUserName || "").trim(), row.providerUserStatus);
          if (!providerName) return;
          const key = providerName.toLowerCase();
          if (!uniqueProviders.has(key)) {
            uniqueProviders.set(key, {
              id: String(row.providerUserId || providerName),
              name: providerName,
              clinicIds: new Set<string>(),
            });
          }
          uniqueProviders.get(key)!.clinicIds.add(String(row.clinicId));
        });
        setProviders(
          Array.from(uniqueProviders.values()).map((row) => ({
            id: row.id,
            name: row.name,
            clinicIds: Array.from(row.clinicIds),
          })),
        );
      } else {
        setProviders(fallbackRows.providers);
      }

      if (reasonRowsResult.status === "fulfilled") {
        const activeReasons = (reasonRowsResult.value as any[])
          .filter((row) => String(row.status || "active") === "active")
          .map((row) => ({
            id: row.id,
            name: row.name,
            clinicIds: Array.isArray(row.clinicIds) ? row.clinicIds : [],
          }));
        setVisitReasons(activeReasons);
      } else {
        setVisitReasons(fallbackRows.reasons);
      }

      if (templateRowsResult.status === "fulfilled") {
        const templatesByReason: Record<string, TemplateField[]> = {};
        (templateRowsResult.value as any[]).forEach((template) => {
          const reasonIds: string[] = Array.isArray(template.reasonIds)
            ? template.reasonIds
            : template.reasonForVisitId
              ? [template.reasonForVisitId]
              : [];
          const normalized = normalizeTemplateFieldsFromTemplate(template);
          reasonIds.forEach((reasonId) => {
            templatesByReason[reasonId] = normalized;
          });
        });
        setTemplatesByReasonId(templatesByReason);
      } else {
        setTemplatesByReasonId({});
      }
    };

    loadConfig().catch(() => applyFallback());

    const onRefresh = () => {
      loadConfig().catch(() => applyFallback());
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
  }, [encounters]);

  const selectedClinicConfig = useMemo(
    () => clinics.find((clinic) => clinic.id === selectedClinic) || null,
    [clinics, selectedClinic],
  );
  const providerRequired = selectedClinicConfig ? !selectedClinicConfig.maRun : true;
  const reasonOptions = useMemo(
    () =>
      visitReasons.filter(
        (reasonEntry) =>
          !selectedClinic ||
          reasonEntry.clinicIds.length === 0 ||
          reasonEntry.clinicIds.includes(selectedClinic),
      ),
    [visitReasons, selectedClinic],
  );
  const providerOptions = useMemo(
    () =>
      providers.filter(
        (provider) =>
          !selectedClinic ||
          provider.clinicIds.length === 0 ||
          provider.clinicIds.includes(selectedClinic),
      ),
    [providers, selectedClinic],
  );

  useEffect(() => {
    if (!selectedProvider) return;
    if (!providerOptions.some((provider) => provider.name === selectedProvider)) {
      setSelectedProvider("");
    }
  }, [providerOptions, selectedProvider]);

  useEffect(() => {
    if (!selectedReason) return;
    if (!reasonOptions.some((reasonEntry) => reasonEntry.id === selectedReason)) {
      setSelectedReason("");
      setTemplateValues({});
    }
  }, [reasonOptions, selectedReason]);

  useEffect(() => {
    if (!selectedLobbyEncounterId) return;
    if (!lobbyPatients.some((entry) => entry.id === selectedLobbyEncounterId)) {
      setSelectedLobbyEncounterId("");
    }
  }, [lobbyPatients, selectedLobbyEncounterId]);

  const reason = visitReasons.find((r) => r.id === selectedReason);
  const templateFields = useMemo(
    () => (reason ? templatesByReasonId[reason.id] ?? [] : []),
    [reason, templatesByReasonId],
  );

  const todayActive = encounters.filter((e) => e.status !== "Optimized").length;
  const todayCompleted = encounters.filter((e) => e.status === "Optimized").length;
  const selectedLobbyEncounter = lobbyPatients.find((entry) => entry.id === selectedLobbyEncounterId) || null;

  const sortedIncomingPatients = useMemo(() => {
    const toMinutes = (value: string, isoValue?: string | null) => {
      const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
      if (!match) {
        if (isoValue) {
          const d = new Date(isoValue);
          if (!Number.isNaN(d.getTime())) {
            return d.getHours() * 60 + d.getMinutes();
          }
        }
        return Number.MAX_SAFE_INTEGER;
      }
      const hh = Number(match[1] || 0);
      const mm = Number(match[2] || 0);
      if (!Number.isFinite(hh) || !Number.isFinite(mm)) return Number.MAX_SAFE_INTEGER;
      return hh * 60 + mm;
    };
    return [...incomingPatients].sort(
      (a, b) => toMinutes(a.checkinTime || "", a.checkInAtIso) - toMinutes(b.checkinTime || "", b.checkInAtIso),
    );
  }, [incomingPatients]);

  function handleSelectIncoming(encId: string) {
    if (!encId) {
      clearSelection();
      return;
    }
    const enc = incomingPatients.find((e) => e.id === encId);
    if (!enc) return;

    setSelectedIncoming(enc.id);
    setPatientId(enc.patientId);

    const matchedProvider = providers.find((p) => p.name === enc.provider);
    if (matchedProvider) setSelectedProvider(matchedProvider.name);

    const matchedReason = visitReasons.find((r) => r.name === enc.visitType);
    if (matchedReason) setSelectedReason(matchedReason.id);

    const matchedClinic = clinics.find((c) => c.id === enc.clinicId);
    if (matchedClinic) setSelectedClinic(matchedClinic.id);

    setAppointmentTime(enc.checkinTime);
    setIsWalkIn(!!enc.walkIn);
    setInsuranceVerified(!!enc.insuranceVerified);
    setTemplateValues({});
    setEditingIncomingId(null);
  }

  function clearSelection() {
    setSelectedIncoming("");
    setPatientId("");
    setSelectedReason("");
    setSelectedProvider("");
    setSelectedClinic("");
    setAppointmentTime("");
    setIsWalkIn(false);
    setInsuranceVerified(true);
    setTemplateValues({});
    setEditingIncomingId(null);
  }

  function startIncomingEdit(encId: string) {
    const enc = incomingPatients.find((entry) => entry.id === encId);
    if (!enc) return;
    setEditingIncomingId(encId);
    setIncomingDraft({
      dateOfService: String(enc.checkInAtIso || "").slice(0, 10),
      appointmentTime: String(enc.appointmentTime || enc.checkinTime || ""),
    });
  }

  function cancelIncomingEdit() {
    setEditingIncomingId(null);
    setIncomingDraft({
      dateOfService: "",
      appointmentTime: "",
    });
  }

  async function saveIncomingEdit(encId: string) {
    if (!incomingDraft.dateOfService.trim()) {
      toast.error("Appointment date is required");
      return;
    }
    if (!incomingDraft.appointmentTime.trim()) {
      toast.error("Appointment time is required");
      return;
    }
    setSavingIncomingId(encId);
    try {
      await incoming.updateRow(encId, {
        dateOfService: incomingDraft.dateOfService,
        appointmentTime: incomingDraft.appointmentTime,
      });
      toast.success("Incoming appointment updated");
      cancelIncomingEdit();
      await refreshData();
    } catch (error) {
      toast.error("Unable to update incoming appointment", {
        description: (error as Error).message || "Please review the appointment day and time",
      });
    } finally {
      setSavingIncomingId(null);
    }
  }

  async function handleCheckIn() {
    if (!patientId || !selectedReason || !selectedClinic || (providerRequired && !selectedProvider)) {
      toast.error("Please fill in all required fields");
      return;
    }
    const missingRequired = templateFields
      .filter((f) => f.required)
      .filter((f) => {
        const val = templateValues[f.key];
        if (f.type === "checkbox") return !val;
        return !val || (typeof val === "string" && !val.trim());
      });
    if (missingRequired.length > 0) {
      toast.error(`${missingRequired.length} required template field(s) incomplete`, {
        description: missingRequired.map((f) => f.label).join(", "),
      });
      return;
    }
    try {
      await checkInPatient({
        patientId,
        clinicId: selectedClinic,
        providerName: selectedProvider || undefined,
        reasonForVisitId: reason?.id,
        reasonForVisit: reason?.name,
        incomingId: selectedIncoming || undefined,
        walkIn: isWalkIn,
        insuranceVerified,
        intakeData: templateValues,
      });
      if (selectedIncoming) {
        setLocalDismissedIncomingIds((prev) => (prev.includes(selectedIncoming) ? prev : [...prev, selectedIncoming]));
      }
      toast.success("Patient checked in → Lobby", {
        description: `${patientId} · ${reason?.name}${selectedProvider ? ` with ${selectedProvider}` : ""}`,
      });
      clearSelection();
    } catch (error) {
      toast.error("Check-in failed", {
        description: (error as Error).message || "Unable to create encounter",
      });
    }
  }

  function setFieldValue(fieldName: string, value: string | boolean) {
    setTemplateValues((prev) => ({ ...prev, [fieldName]: value }));
  }

  const requiredCount = templateFields.filter((f) => f.required).length;
  const completedCount = templateFields.filter((f) => {
    if (!f.required) return false;
    const val = templateValues[f.key];
    if (f.type === "checkbox") return !!val;
    return !!val && (typeof val === "string" ? val.trim() !== "" : true);
  }).length;

  return (
    <div className="p-6 space-y-5">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center">
            <ClipboardCheck className="w-5 h-5 text-indigo-600" />
          </div>
          <div>
            <h1 className="text-[20px] tracking-tight" style={{ fontWeight: 700 }}>
              Front Desk Check-In
            </h1>
            <p className="text-[12px] text-muted-foreground">
              Select an incoming patient or enter details manually
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-[12px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${isLiveMode ? "bg-emerald-500" : "bg-amber-500"}`} />
            {isLiveMode ? "Live API" : "Degraded live sync"}
          </span>
          {syncError && <span className="text-red-500 truncate max-w-[220px]">{syncError}</span>}
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-indigo-500" />
            {todayActive} active
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            {todayCompleted} completed
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-5 items-start">
        <div className="space-y-5">
          {/* ── Lobby (compact, at top) ── */}
          <Card className="border-0 shadow-sm overflow-hidden">
            <div className="h-1" style={{ background: `linear-gradient(to right, ${statusColors.Lobby}, #818cf8)` }} />
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2.5">
                <Users className="w-4 h-4" style={{ color: statusColors.Lobby }} />
                <span className="text-[13px]" style={{ fontWeight: 600 }}>In Lobby</span>
                <Badge
                  className="border-0 text-[10px] px-2 h-5 ml-1"
                  style={{ backgroundColor: `${statusColors.Lobby}15`, color: statusColors.Lobby }}
                >
                  {lobbyPatients.length} waiting
                </Badge>
              </div>

              {lobbyPatients.length === 0 ? (
                <div className="text-center py-4">
                  <Users className="w-6 h-6 text-gray-200 mx-auto mb-1" />
                  <p className="text-[12px] text-muted-foreground">No patients in lobby</p>
                </div>
      ) : (
                <div className="-mx-2 px-2 py-1 overflow-x-auto">
                  <div className="flex gap-2 pb-1">
                    {lobbyPatients.map((e) => {
                      const isAlert = e.alertLevel !== "Green";
                      const isSelectedLobby = selectedLobbyEncounterId === e.id;
                      return (
                        <button
                          type="button"
                          key={e.id}
                          onClick={() => setSelectedLobbyEncounterId(e.id)}
                          className={`shrink-0 rounded-lg border px-3 py-2.5 min-w-[200px] text-left flex items-center gap-2.5 transition-colors ${
                            isSelectedLobby
                              ? "ring-2 ring-indigo-200"
                              : ""
                          } ${
                            isAlert
                              ? e.alertLevel === "Red"
                                ? "border-red-200 bg-red-50/40"
                                : "border-amber-200 bg-amber-50/40"
                              : "border-gray-100 bg-white hover:border-indigo-200"
                          }`}
                        >
                          <div
                            className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[10px] shrink-0"
                            style={{ backgroundColor: statusColors.Lobby, fontWeight: 600 }}
                          >
                            {e.patientInitials}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[12px] truncate" style={{ fontWeight: 500 }}>{e.patientId}</span>
                              {e.walkIn && (
                                <Badge className="bg-orange-100 text-orange-600 border-0 text-[8px] px-1 h-3.5">Walk-in</Badge>
                              )}
                            </div>
                            <div className="text-[10px] text-muted-foreground truncate">
                              {e.provider} · {e.visitType}
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="flex items-center gap-1">
                              {isAlert && (
                                <AlertTriangle
                                  className="w-3 h-3"
                                  style={{ color: e.alertLevel === "Red" ? "#ef4444" : "#f59e0b" }}
                                />
                              )}
                              <span
                                className="text-[14px] tabular-nums"
                                style={{
                                  fontWeight: 700,
                                  color: e.alertLevel === "Red" ? "#ef4444" : e.alertLevel === "Yellow" ? "#f59e0b" : "#10b981",
                                }}
                              >
                                {e.minutesInStage}m
                              </span>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Patient Check-In Card (contains form + template + button) ── */}
          <Card className="border-0 shadow-sm overflow-hidden">
        <div className="h-1 bg-gradient-to-r from-indigo-500 to-violet-400" />
        <CardContent className="p-6">
          <div className="flex items-center gap-2 mb-5">
            <div className="w-8 h-8 rounded-lg bg-indigo-100 flex items-center justify-center">
              <ClipboardCheck className="w-4 h-4 text-indigo-600" />
            </div>
            <span className="text-[14px]" style={{ fontWeight: 600 }}>Patient Check-In</span>
            {selectedIncoming && (
              <Badge className="bg-indigo-100 text-indigo-600 border-0 text-[10px] h-5 ml-1">
                Auto-filled from queue
              </Badge>
            )}
          </div>

          {/* Incoming Patient dropdown */}
          <div className="mb-5">
            <FormField label="Incoming Patient" icon={Inbox}>
              <select
                value={selectedIncoming}
                onChange={(e) => handleSelectIncoming(e.target.value)}
                className="w-full h-10 pl-10 pr-4 rounded-lg border border-gray-200 bg-white text-[13px] appearance-none focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
              >
                <option value="">Select from incoming queue ({incomingPatients.length})...</option>
                {sortedIncomingPatients.map((enc) => (
                  <option key={enc.id} value={enc.id}>
                    {enc.patientId} — {enc.provider} · {enc.visitType} · {enc.checkinTime} [{enc.clinicShortCode}]
                  </option>
                ))}
              </select>
            </FormField>
          </div>

          {/* Divider */}
          <div className="flex items-center gap-3 mb-5">
            <div className="flex-1 h-px bg-gray-100" />
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Patient Details</span>
            <div className="flex-1 h-px bg-gray-100" />
          </div>

          {/* Row 1: Patient ID + Clinic */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Patient ID" required icon={User}>
              <input
                type="text"
                placeholder="PT-XXXX"
                value={patientId}
                onChange={(e) => setPatientId(e.target.value)}
                className="w-full h-10 pl-10 pr-4 rounded-lg border border-gray-200 bg-white text-[13px] focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
              />
            </FormField>
            <FormField label="Clinic" required icon={CircleDot}>
              <select
                value={selectedClinic}
                onChange={(e) => setSelectedClinic(e.target.value)}
                className="w-full h-10 pl-10 pr-4 rounded-lg border border-gray-200 bg-white text-[13px] appearance-none focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
              >
                <option value="">Select clinic...</option>
                {clinics.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </FormField>
          </div>

          {/* Row 2: Provider + Appointment Time */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
            <FormField label="Provider" required={providerRequired} icon={Stethoscope}>
              <select
                value={selectedProvider}
                onChange={(e) => setSelectedProvider(e.target.value)}
                className="w-full h-10 pl-10 pr-4 rounded-lg border border-gray-200 bg-white text-[13px] appearance-none focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
              >
                <option value="">{providerRequired ? "Select provider..." : "Use clinic assignment"}</option>
                {providerOptions.map((p) => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
            </FormField>
            {isWalkIn ? (
              <div>
                <label className="text-[11px] text-muted-foreground mb-1.5 block uppercase tracking-wider" style={{ fontWeight: 500 }}>
                  Appointment Time
                </label>
                <div className="h-10 px-4 rounded-lg border border-dashed border-orange-200 bg-orange-50 text-[13px] text-orange-700 flex items-center gap-2">
                  <Footprints className="w-4 h-4" />
                  Walk-In
                </div>
              </div>
            ) : (
              <FormField label="Appointment Time" icon={Clock}>
                <input
                  type="time"
                  value={appointmentTime}
                  onChange={(e) => setAppointmentTime(e.target.value)}
                  className="w-full h-10 pl-10 pr-4 rounded-lg border border-gray-200 bg-white text-[13px] focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                />
              </FormField>
            )}
          </div>

          {/* Row 3: Visit Reason */}
          <div className="mt-4">
            <FormField label="Visit Reason" required icon={FileCheck}>
              <select
                value={selectedReason}
                onChange={(e) => {
                  setSelectedReason(e.target.value);
                  setTemplateValues({});
                }}
                className="w-full h-10 pl-10 pr-4 rounded-lg border border-gray-200 bg-white text-[13px] appearance-none focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
              >
                <option value="">Select visit reason...</option>
                {reasonOptions.map((vr) => (
                  <option key={vr.id} value={vr.id}>
                    {vr.name} ({reasonCodeFromName(vr.name)})
                  </option>
                ))}
              </select>
            </FormField>
          </div>

          {/* Toggles */}
          <div className="flex items-center gap-6 mt-5 pt-4 border-t border-gray-100">
            <label className="flex items-center gap-2.5 cursor-pointer">
              <Switch checked={isWalkIn} onCheckedChange={setIsWalkIn} />
              <span className="flex items-center gap-1.5 text-[12px] text-gray-600">
                <Footprints className="w-3.5 h-3.5 text-gray-400" /> Walk-in
              </span>
            </label>
            <label className="flex items-center gap-2.5 cursor-pointer">
              <Switch checked={insuranceVerified} onCheckedChange={setInsuranceVerified} />
              <span className="flex items-center gap-1.5 text-[12px] text-gray-600">
                <Shield className="w-3.5 h-3.5 text-gray-400" /> Insurance Verified
              </span>
            </label>
          </div>

          {/* ── Template Fields (inline, inside same card) ── */}
          {reason && templateFields.length > 0 && (
            <div className="mt-6 rounded-xl border border-purple-100 bg-purple-50/50 overflow-hidden">
              {/* Template header bar */}
              <div className="px-5 py-3.5 border-b border-purple-100 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-purple-100 flex items-center justify-center">
                    <LayoutTemplate className="w-3.5 h-3.5 text-purple-600" />
                  </div>
                  <div>
                    <span className="text-[13px]" style={{ fontWeight: 600 }}>
                      Check-In Template
                    </span>
                    <span className="text-[11px] text-muted-foreground ml-2">
                      {reason.name} ({reasonCodeFromName(reason.name)})
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

              {/* Template fields */}
              <div className="p-5 space-y-3">
                {templateFields.map((field, idx) => (
                  <TemplateFieldInput
                    key={`${selectedReason}-${idx}`}
                    field={field}
                    value={templateValues[field.key]}
                    onChange={(val) => setFieldValue(field.key, val)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Empty state: reason selected but no template */}
          {reason && templateFields.length === 0 && (
            <div className="mt-6 rounded-xl border border-dashed border-gray-200 bg-gray-50/50 p-6 text-center">
              <LayoutTemplate className="w-7 h-7 text-gray-300 mx-auto mb-1.5" />
              <p className="text-[12px] text-muted-foreground" style={{ fontWeight: 500 }}>
                No check-in template for {reason.name}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Create one in Admin Console → Reasons &amp; Templates
              </p>
            </div>
          )}

          {/* ── Check In Button (inside the card) ── */}
          <button
            onClick={handleCheckIn}
            className="w-full h-12 mt-6 bg-indigo-600 text-white rounded-xl text-[14px] hover:bg-indigo-700 active:bg-indigo-800 transition-colors flex items-center justify-center gap-2 shadow-sm"
            style={{ fontWeight: 500 }}
          >
            <CheckCircle2 className="w-5 h-5" />
            Check In Patient
            <ArrowRight className="w-4 h-4 ml-1" />
          </button>
        </CardContent>
          </Card>
        </div>

        <div className="space-y-5">
          <Card className="border-0 shadow-sm overflow-hidden">
            <div className="h-1 bg-gradient-to-r from-sky-500 to-indigo-500" />
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <Inbox className="w-4 h-4 text-sky-600" />
                <span className="text-[13px]" style={{ fontWeight: 600 }}>Incoming Patients Today</span>
                <Badge className="bg-sky-100 text-sky-700 border-0 text-[10px] h-5">{sortedIncomingPatients.length}</Badge>
              </div>
              {sortedIncomingPatients.length === 0 ? (
                <p className="text-[12px] text-muted-foreground py-4 text-center">
                  No incoming patients in queue for today.
                </p>
              ) : (
                <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                  {sortedIncomingPatients.map((encounter) => (
                    <div
                      key={encounter.id}
                      className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                        selectedIncoming === encounter.id
                          ? "border-indigo-300 bg-indigo-50"
                          : "border-gray-100 bg-white hover:border-indigo-200"
                      }`}
                    >
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => handleSelectIncoming(encounter.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            handleSelectIncoming(encounter.id);
                          }
                        }}
                        className="outline-none"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[12px]" style={{ fontWeight: 600 }}>{encounter.patientId}</span>
                          <span className="text-[11px] text-muted-foreground tabular-nums">{encounter.walkIn ? "Walk-In" : encounter.checkinTime || "--:--"}</span>
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5 truncate">
                          {encounter.clinicName} · {encounter.provider} · {encounter.visitType}
                        </div>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        {editingIncomingId === encounter.id ? (
                          <>
                            <div className="grid flex-1 grid-cols-2 gap-2">
                              <div>
                                <label className="text-[10px] text-muted-foreground block mb-1">Appointment Day</label>
                                <div className="relative">
                                  <CalendarDays className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                                  <input
                                    type="date"
                                    value={incomingDraft.dateOfService}
                                    onChange={(event) => setIncomingDraft((prev) => ({ ...prev, dateOfService: event.target.value }))}
                                    className="h-8 w-full pl-8 pr-2 rounded-lg border border-gray-200 bg-white text-[11px]"
                                  />
                                </div>
                              </div>
                              <div>
                                <label className="text-[10px] text-muted-foreground block mb-1">Appointment Time</label>
                                <div className="relative">
                                  <Clock className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                                  <input
                                    type="time"
                                    value={incomingDraft.appointmentTime}
                                    onChange={(event) => setIncomingDraft((prev) => ({ ...prev, appointmentTime: event.target.value }))}
                                    className="h-8 w-full pl-8 pr-2 rounded-lg border border-gray-200 bg-white text-[11px]"
                                  />
                                </div>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                saveIncomingEdit(encounter.id).catch(() => undefined);
                              }}
                              className="h-8 px-2.5 rounded-lg bg-indigo-600 text-white text-[11px] hover:bg-indigo-700 transition-colors flex items-center gap-1"
                              style={{ fontWeight: 500 }}
                              disabled={savingIncomingId === encounter.id}
                            >
                              <Save className="w-3 h-3" />
                              {savingIncomingId === encounter.id ? "Saving" : "Save"}
                            </button>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                cancelIncomingEdit();
                              }}
                              className="h-8 px-2.5 rounded-lg border border-gray-200 text-[11px] text-gray-600 hover:bg-gray-50 transition-colors flex items-center gap-1"
                              style={{ fontWeight: 500 }}
                            >
                              <X className="w-3 h-3" />
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              startIncomingEdit(encounter.id);
                            }}
                            className="h-7 px-2.5 rounded-lg border border-gray-200 bg-white text-[11px] text-gray-600 hover:bg-gray-50 transition-colors flex items-center gap-1"
                            style={{ fontWeight: 500 }}
                          >
                            <Pencil className="w-3 h-3" />
                            Edit day/time
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-0 shadow-sm overflow-hidden">
            <div className="h-1 bg-gradient-to-r from-violet-500 to-fuchsia-500" />
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <FileCheck className="w-4 h-4 text-violet-600" />
                <span className="text-[13px]" style={{ fontWeight: 600 }}>Lobby Patient Readout</span>
              </div>
              {!selectedLobbyEncounter ? (
                <p className="text-[12px] text-muted-foreground">
                  Select a lobby patient card to review appointment details and captured check-in information.
                </p>
              ) : (
                <div className="space-y-3">
                  <div className="rounded-lg border border-gray-100 bg-gray-50/60 px-3 py-2.5">
                    <p className="text-[12px]" style={{ fontWeight: 600 }}>{selectedLobbyEncounter.patientId}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {selectedLobbyEncounter.clinicName} · {selectedLobbyEncounter.provider}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    <ReadoutRow label="Visit Reason" value={selectedLobbyEncounter.visitType} />
                    <ReadoutRow label="Scheduled/Check-In" value={selectedLobbyEncounter.checkinTime || "--:--"} />
                    <ReadoutRow label="Stage" value={selectedLobbyEncounter.status} />
                    <ReadoutRow label="Room" value={selectedLobbyEncounter.roomNumber || "Not assigned"} />
                    <ReadoutRow label="Walk-In" value={selectedLobbyEncounter.walkIn ? "Yes" : "No"} />
                    <ReadoutRow label="Insurance Verified" value={selectedLobbyEncounter.insuranceVerified ? "Yes" : "No"} />
                  </div>
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Collected So Far</p>
                    {selectedLobbyEncounter.intakeData && Object.keys(selectedLobbyEncounter.intakeData).length > 0 ? (
                      <div className="rounded-lg border border-gray-100 bg-white p-2 max-h-[180px] overflow-auto">
                        {Object.entries(selectedLobbyEncounter.intakeData).map(([key, value]) => (
                          <div key={key} className="flex items-center justify-between gap-2 text-[11px] py-1 border-b border-gray-50 last:border-b-0">
                            <span className="text-muted-foreground">{key}</span>
                            <span className="text-right">{String(value)}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[11px] text-muted-foreground">No captured intake fields yet.</p>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ── Reusable helpers ──

function FormField({
  label,
  required,
  icon: Icon,
  children,
}: {
  label: string;
  required?: boolean;
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-[11px] text-muted-foreground mb-1.5 block uppercase tracking-wider" style={{ fontWeight: 500 }}>
        {label}{required && " *"}
      </label>
      <div className="relative">
        <Icon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        {children}
      </div>
    </div>
  );
}

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
      <label className="flex items-center gap-3 px-4 py-2.5 rounded-lg border border-purple-200/80 bg-white shadow-sm hover:border-purple-300 hover:shadow cursor-pointer transition-all">
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked)}
          className="w-4 h-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
        />
        <span className="text-[13px] text-gray-700 flex-1">{field.label}</span>
        {field.required && (
          <span className="text-[9px] text-red-400 uppercase tracking-wider" style={{ fontWeight: 600 }}>Required</span>
        )}
      </label>
    );
  }

  if (field.type === "textarea") {
    return (
      <div>
        <label className="text-[11px] text-muted-foreground mb-1.5 flex items-center gap-1 uppercase tracking-wider" style={{ fontWeight: 500 }}>
          {field.label}
          {field.required && <span className="text-red-400">*</span>}
        </label>
        <textarea
          rows={2}
          placeholder={field.label}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-purple-200/80 bg-white shadow-sm text-[13px] focus:outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-100 resize-none"
        />
      </div>
    );
  }

  if (field.type === "select") {
    return (
      <div>
        <label className="text-[11px] text-muted-foreground mb-1.5 flex items-center gap-1 uppercase tracking-wider" style={{ fontWeight: 500 }}>
          {field.label}
          {field.required && <span className="text-red-400">*</span>}
        </label>
        <select
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          className="w-full h-10 px-3 rounded-lg border border-purple-200/80 bg-white shadow-sm text-[13px] appearance-none focus:outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-100"
        >
          <option value="">Select...</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      </div>
    );
  }

  if (field.type === "radio") {
    return (
      <div>
        <label className="text-[11px] text-muted-foreground mb-1.5 flex items-center gap-1 uppercase tracking-wider" style={{ fontWeight: 500 }}>
          {field.label}
          {field.required && <span className="text-red-400">*</span>}
        </label>
        <div className="flex flex-wrap gap-2">
          {(field.options ?? []).map((opt) => (
            <label key={opt} className="h-8 px-3 rounded-lg border border-purple-200/80 bg-white text-[12px] flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name={`checkin-${field.key}`}
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
        <label className="text-[11px] text-muted-foreground mb-1.5 flex items-center gap-1 uppercase tracking-wider" style={{ fontWeight: 500 }}>
          {field.label}
          {field.required && <span className="text-red-400">*</span>}
        </label>
        <input
          type={field.type}
          placeholder={field.label}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          className="w-full h-10 px-3 rounded-lg border border-purple-200/80 bg-white shadow-sm text-[13px] focus:outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-100"
        />
      </div>
    );
  }

  return (
    <div>
      <label className="text-[11px] text-muted-foreground mb-1.5 flex items-center gap-1 uppercase tracking-wider" style={{ fontWeight: 500 }}>
        {field.label}
        {field.required && <span className="text-red-400">*</span>}
      </label>
      <input
        type="text"
        placeholder={field.label}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-10 px-3 rounded-lg border border-purple-200/80 bg-white shadow-sm text-[13px] focus:outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-100"
      />
    </div>
  );
}

function ReadoutRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-100 bg-white px-2.5 py-2">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-[11px]" style={{ fontWeight: 500 }}>{value}</p>
    </div>
  );
}
