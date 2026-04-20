import { useState, useEffect, useMemo, type ElementType } from "react";
import {
  Stethoscope,
  Play,
  Clock,
  DoorOpen,
  User,
  FileText,
  ChevronRight,
  CheckCircle2,
  Activity,
  ClipboardCheck,
  ClipboardList,
  Heart,
  Thermometer,
  Gauge,
  AlertTriangle,
  Footprints,
  Timer,
  X,
} from "lucide-react";
import { useNavigate } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";
import {
  statusColors,
  statusLabels,
  defaultThresholds,
  type Encounter,
} from "./mock-data";
import { useEncounters } from "./encounter-context";
import { admin } from "./api-client";
import { loadSession } from "./auth-session";
import { labelUserName } from "./display-names";
import { ADMIN_REFRESH_EVENT, FACILITY_CONTEXT_CHANGED_EVENT } from "./app-events";
import { getEncounterStageSeconds } from "./encounter-timers";

// ── Mock captured data for the preview ──
// In a real app this would come from shared state / API

type MockCheckinData = {
  demographicsConfirmed: boolean;
  insuranceCardScanned: boolean;
  copayCollected: boolean;
  copayAmount: string;
  chiefComplaint: string;
  arrivalNotes: string;
};

type RoomingData = {
  reasonForVisit: string;
  bloodPressure: string;
  pulse: string;
  temperature: string;
  weight: string;
  height: string;
  o2Sat: string;
  confirmPharmacy: boolean;
  confirmLab: boolean;
  allergiesReviewed: boolean;
  medsReconciled: boolean;
  socialHistoryReviewed: boolean;
  phq2Completed: boolean;
  fallScaleCompleted: boolean;
  qualityMeasuresReviewed: boolean;
  reviewOfProblems: string;
};

function getMockCheckinData(enc: Encounter): MockCheckinData {
  // Generate plausible mock check-in data
  return {
    demographicsConfirmed: true,
    insuranceCardScanned: !!enc.insuranceVerified,
    copayCollected: true,
    copayAmount: enc.visitType === "Annual Physical" ? "$0" : "$25",
    chiefComplaint:
      enc.visitType === "Follow-up"
        ? "Follow-up on lab results"
        : enc.visitType === "Annual Physical"
          ? "Annual wellness exam"
          : enc.visitType === "Sick Visit"
            ? "Sore throat, cough × 3 days"
            : enc.visitType === "New Patient"
              ? "New patient check-in, establish care"
              : enc.visitType === "Procedure"
                ? "Scheduled procedure"
                : "Lab order follow-up",
    arrivalNotes: enc.arrivalNotes || "",
  };
}

function parseBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return ["true", "yes", "y", "1", "done", "completed"].includes(normalized);
  }
  return false;
}

function firstString(data: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = data[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value);
    }
  }
  return "";
}

function deriveRoomingData(enc: Encounter): RoomingData | null {
  const source = enc.roomingData && typeof enc.roomingData === "object"
    ? (enc.roomingData as Record<string, unknown>)
    : null;
  if (!source) {
    return null;
  }

  return {
    reasonForVisit: firstString(source, "reason_for_visit", "Reason for Visit") || enc.visitType,
    bloodPressure: firstString(source, "bp", "BP", "blood_pressure", "Blood Pressure"),
    pulse: firstString(source, "pulse", "Pulse", "heart_rate", "Heart Rate"),
    temperature: firstString(source, "temperature", "Temperature"),
    weight: firstString(source, "weight", "Weight"),
    height: firstString(source, "height", "Height"),
    o2Sat: firstString(source, "oxygen_saturation", "Oxygen Saturation", "o2_saturation", "O2 Saturation"),
    confirmPharmacy: parseBoolean(source.confirm_pharmacy ?? source["Confirm Pharmacy"]),
    confirmLab: parseBoolean(source.confirm_lab ?? source["Confirm Lab"]),
    allergiesReviewed: parseBoolean(source.allergy_review ?? source["Allergy Review"]),
    medsReconciled: parseBoolean(source.medication_reconciliation ?? source["Medication Reconciliation"]),
    socialHistoryReviewed: parseBoolean(source.social_history_review ?? source["Social History (smoking, drinking, exercise)"]),
    phq2Completed: parseBoolean(source.phq2_completed ?? source["PHQ-2 Completed"]),
    fallScaleCompleted: parseBoolean(source.fall_scale_completed ?? source["Fall Scale (if applicable)"]),
    qualityMeasuresReviewed: parseBoolean(source.quality_measures_reviewed ?? source["Quality Measures"]),
    reviewOfProblems: firstString(source, "review_of_problems", "Review of Problems"),
  };
}

// ── Component ──

export function ClinicianView() {
  const navigate = useNavigate();
  const { encounters } = useEncounters();
  const [selectedOwner, setSelectedOwner] = useState("");
  const [ownerOptions, setOwnerOptions] = useState<Array<{ name: string; kind: "provider" | "ma" }>>([]);
  const [maRunClinicIds, setMaRunClinicIds] = useState<Set<string>>(new Set());
  const [selectedEncId, setSelectedEncId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let mounted = true;
    const loadOwners = async () => {
      try {
        const facilityId = loadSession()?.facilityId;
        const rows = await admin.listAssignments(facilityId);
        if (!mounted) return;
        const owners = new Map<string, { name: string; kind: "provider" | "ma" }>();
        const maRunIds = new Set<string>();
        (rows as any[]).forEach((row) => {
          if (row.maRun) {
            maRunIds.add(String(row.clinicId));
            const maStatus = String(row.maUserStatus || "").toLowerCase();
            const maName = labelUserName(String(row.maUserName || "").trim(), row.maUserStatus);
            if (maName && (!maStatus || maStatus === "active")) {
              owners.set(`ma:${maName.toLowerCase()}`, { name: maName, kind: "ma" });
            }
            return;
          }
          const providerStatus = String(row.providerUserStatus || "").toLowerCase();
          const providerName = labelUserName(String(row.providerUserName || "").trim(), row.providerUserStatus);
          if (providerName && (!providerStatus || providerStatus === "active")) {
            owners.set(`provider:${providerName.toLowerCase()}`, { name: providerName, kind: "provider" });
          }
        });
        setMaRunClinicIds(maRunIds);
        setOwnerOptions(Array.from(owners.values()).sort((a, b) => a.name.localeCompare(b.name)));
      } catch {
        const fallbackOwners = new Map<string, { name: string; kind: "provider" | "ma" }>();
        encounters.forEach((encounter) => {
          const ownerName = encounter.assignedMA || encounter.provider;
          if (!ownerName) return;
          fallbackOwners.set(ownerName.toLowerCase(), {
            name: ownerName,
            kind: encounter.assignedMA ? "ma" : "provider",
          });
        });
        if (mounted) setOwnerOptions(Array.from(fallbackOwners.values()).sort((a, b) => a.name.localeCompare(b.name)));
      }
    };

    loadOwners().catch(() => undefined);
    const onRefresh = () => {
      loadOwners().catch(() => undefined);
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

  useEffect(() => {
    if (ownerOptions.length === 0) return;
    if (!selectedOwner || !ownerOptions.some((option) => option.name === selectedOwner)) {
      setSelectedOwner(ownerOptions[0]?.name || "");
    }
  }, [ownerOptions, selectedOwner]);

  const selectedOwnerNormalized = selectedOwner.trim().toLowerCase();
  const ownerMatchesEncounter = (encounter: Encounter) =>
    maRunClinicIds.has(encounter.clinicId)
      ? encounter.assignedMA?.trim().toLowerCase() === selectedOwnerNormalized
      : encounter.provider.trim().toLowerCase() === selectedOwnerNormalized;
  const myReady = useMemo(
    () =>
      encounters.filter(
        (e) =>
          e.status === "ReadyForProvider" &&
          ownerMatchesEncounter(e),
      ),
    [encounters, selectedOwnerNormalized, maRunClinicIds],
  );
  const myActive = useMemo(
    () =>
      encounters.filter(
        (e) =>
          e.status === "Optimizing" &&
          ownerMatchesEncounter(e),
      ),
    [encounters, selectedOwnerNormalized, maRunClinicIds],
  );

  const providerEncounters = useMemo(
    () =>
      encounters.filter(
        (e) => ownerMatchesEncounter(e),
      ),
    [encounters, selectedOwnerNormalized, maRunClinicIds],
  );

  const providerStats = useMemo(() => {
    const activeStatuses = new Set(["ReadyForProvider", "Optimizing", "CheckOut"]);
    const activeEncounters = providerEncounters.filter((e) => activeStatuses.has(e.status)).length;
    const completedToday = providerEncounters.filter((e) => e.status === "Optimized").length;
    const avgCycleTime =
      providerEncounters.length === 0
        ? 0
        : Math.round(
            providerEncounters.reduce((sum, encounter) => sum + Math.max(0, encounter.minutesInStage), 0) /
              providerEncounters.length,
          );
    const utilization =
      providerEncounters.length === 0
        ? 0
        : Math.round((activeEncounters / providerEncounters.length) * 100);

    return {
      activeEncounters,
      completedToday,
      avgCycleTime,
      utilization,
    };
  }, [providerEncounters]);

  const waitSecondsByEncounterId = useMemo(() => {
    const map = new Map<string, number>();
    [...myReady, ...myActive].forEach((encounter) => {
      map.set(encounter.id, getEncounterStageSeconds(encounter, nowMs));
    });
    return map;
  }, [myReady, myActive, nowMs]);

  const selectedEnc = useMemo(
    () => [...myReady, ...myActive].find((e) => e.id === selectedEncId) ?? null,
    [myReady, myActive, selectedEncId],
  );

  // Auto-select first ready patient if nothing selected
  useEffect(() => {
    if (!selectedEnc && myReady.length > 0) {
      setSelectedEncId(myReady[0].id);
    }
  }, [selectedEnc, myReady]);

  // Clear selection if provider changes
  useEffect(() => {
    setSelectedEncId(null);
  }, [selectedOwner]);

  const isSelectedReady = selectedEnc
    ? selectedEnc.status === "ReadyForProvider"
    : false;

  function handleStartVisit() {
    if (!selectedEnc) return;
    navigate(`/encounter/${selectedEnc.id}?startVisit=true`);
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ── Header ── */}
      <div className="shrink-0 px-6 pt-6 pb-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[22px] tracking-tight" style={{ fontWeight: 700 }}>
              <Stethoscope className="w-6 h-6 inline-block mr-2 text-emerald-500 -mt-1" />
              Clinician Board
            </h1>
            <p className="text-[13px] text-muted-foreground mt-0.5">
              Review patient data and manage your visits
            </p>
          </div>
          <select
            className="h-10 px-4 rounded-lg border border-gray-200 bg-gray-50 text-[13px] focus:outline-none focus:border-indigo-300"
            value={selectedOwner}
            onChange={(e) => setSelectedOwner(e.target.value)}
          >
            {ownerOptions.map((owner) => (
              <option key={`${owner.kind}-${owner.name}`} value={owner.name}>
                {owner.name} {owner.kind === "ma" ? "(MA Run)" : "(Provider Run)"}
              </option>
            ))}
          </select>
        </div>

        {/* Provider stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
          {selectedOwner && (
              <div key={selectedOwner} className="contents">
                <Card className="border-0 shadow-sm">
                  <CardContent className="p-4 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center">
                      <Activity className="w-5 h-5 text-indigo-500" />
                    </div>
                    <div>
                      <p className="text-[22px]" style={{ fontWeight: 700, lineHeight: 1.1 }}>
                        {providerStats.activeEncounters}
                      </p>
                      <p className="text-[11px] text-muted-foreground">Active</p>
                    </div>
                  </CardContent>
                </Card>
                <Card className="border-0 shadow-sm">
                  <CardContent className="p-4 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center">
                      <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                    </div>
                    <div>
                      <p className="text-[22px]" style={{ fontWeight: 700, lineHeight: 1.1 }}>
                        {providerStats.completedToday}
                      </p>
                      <p className="text-[11px] text-muted-foreground">Completed</p>
                    </div>
                  </CardContent>
                </Card>
                <Card className="border-0 shadow-sm">
                  <CardContent className="p-4 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-purple-50 flex items-center justify-center">
                      <Clock className="w-5 h-5 text-purple-500" />
                    </div>
                    <div>
                      <p className="text-[22px]" style={{ fontWeight: 700, lineHeight: 1.1 }}>
                        {providerStats.avgCycleTime}m
                      </p>
                      <p className="text-[11px] text-muted-foreground">Avg Cycle</p>
                    </div>
                  </CardContent>
                </Card>
                <Card className="border-0 shadow-sm">
                  <CardContent className="p-4 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center">
                      <User className="w-5 h-5 text-amber-500" />
                    </div>
                    <div>
                      <p className="text-[22px]" style={{ fontWeight: 700, lineHeight: 1.1 }}>
                        {providerStats.utilization}%
                      </p>
                      <p className="text-[11px] text-muted-foreground">Utilization</p>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}
        </div>
      </div>

      {/* ── Main content: Patient list (left) + Preview (right) ── */}
      <div className="flex-1 overflow-hidden flex px-6 pb-6 gap-5">
        {/* ── Left column: Patient queues ── */}
        <div className="w-[420px] min-w-[380px] flex flex-col gap-5 overflow-y-auto">
          {/* Ready for Provider */}
          <Card className="border-0 shadow-sm shrink-0">
            <CardHeader className="pb-3 pt-5 px-5 border-b border-gray-100">
              <CardTitle className="text-[14px] flex items-center gap-2">
                <div
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: statusColors.ReadyForProvider }}
                />
                Ready for Provider
                <Badge className="bg-amber-100 text-amber-700 border-0 text-[10px] px-1.5 h-5">
                  {myReady.length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {myReady.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <CheckCircle2 className="w-8 h-8 text-gray-200 mx-auto mb-2" />
                  <p className="text-[13px]" style={{ fontWeight: 500 }}>
                    No patients ready
                  </p>
                  <p className="text-[12px] mt-0.5">
                    Patients will appear here when rooming is complete
                  </p>
                </div>
              ) : (
                myReady.map((e, i) => (
                  <PatientRow
                    key={e.id}
                    encounter={e}
                    isLast={i === myReady.length - 1}
                    isSelected={selectedEncId === e.id}
                    waitSec={waitSecondsByEncounterId.get(e.id) || e.minutesInStage * 60}
                    onSelect={() => setSelectedEncId(e.id)}
                  />
                ))
              )}
            </CardContent>
          </Card>

          {/* Currently Optimizing */}
          <Card className="border-0 shadow-sm shrink-0">
            <CardHeader className="pb-3 pt-5 px-5 border-b border-gray-100">
              <CardTitle className="text-[14px] flex items-center gap-2">
                <div
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: statusColors.Optimizing }}
                />
                Currently Optimizing
                <Badge className="bg-purple-100 text-purple-700 border-0 text-[10px] px-1.5 h-5">
                  {myActive.length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {myActive.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Stethoscope className="w-8 h-8 text-gray-200 mx-auto mb-2" />
                  <p className="text-[13px]" style={{ fontWeight: 500 }}>
                    No active visits
                  </p>
                  <p className="text-[12px] mt-0.5">Start a visit from the Ready queue</p>
                </div>
              ) : (
                myActive.map((e, i) => (
                  <PatientRow
                    key={e.id}
                    encounter={e}
                    isLast={i === myActive.length - 1}
                    isSelected={selectedEncId === e.id}
                    waitSec={waitSecondsByEncounterId.get(e.id) || e.minutesInStage * 60}
                    onSelect={() => setSelectedEncId(e.id)}
                  />
                ))
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Right column: Preview panel ── */}
        <div className="flex-1 overflow-hidden">
          {selectedEnc ? (
            <PatientPreviewPanel
              key={selectedEnc.id}
              encounter={selectedEnc}
              isReady={isSelectedReady}
              onStartVisit={handleStartVisit}
              onViewEncounter={() => navigate(`/encounter/${selectedEnc.id}`)}
              onClose={() => setSelectedEncId(null)}
              waitSec={waitSecondsByEncounterId.get(selectedEnc.id) || selectedEnc.minutesInStage * 60}
            />
          ) : (
            <div className="h-full flex items-center justify-center rounded-xl border border-dashed border-gray-200 bg-gray-50/50">
              <div className="text-center">
                <FileText className="w-10 h-10 text-gray-200 mx-auto mb-2" />
                <p className="text-[14px] text-gray-400" style={{ fontWeight: 500 }}>
                  Select a patient to preview
                </p>
                <p className="text-[12px] text-gray-300 mt-0.5">
                  Click any row from the patient queues
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Patient Row (clickable, selectable) ──

function PatientRow({
  encounter: e,
  isLast,
  isSelected,
  waitSec,
  onSelect,
}: {
  encounter: Encounter;
  isLast: boolean;
  isSelected: boolean;
  waitSec: number;
  onSelect: () => void;
}) {
  const color = statusColors[e.status];
  const isReady = e.status === "ReadyForProvider";
  return (
    <button
      onClick={onSelect}
      aria-label={`Open clinician preview for ${e.patientId} in ${e.status === "ReadyForProvider" ? "Ready for Provider" : e.status}`}
      className={`w-full text-left px-5 py-4 flex items-center gap-4 transition-colors cursor-pointer ${
        !isLast ? "border-b border-gray-50" : ""
      } ${
        isSelected
          ? "bg-indigo-50/60 border-l-[3px] border-l-indigo-500"
          : "hover:bg-gray-50/50 border-l-[3px] border-l-transparent"
      }`}
    >
      <div
        className="w-10 h-10 rounded-full flex items-center justify-center text-white text-[13px] shrink-0"
        style={{ backgroundColor: color, fontWeight: 600 }}
      >
        {e.patientInitials}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[14px]" style={{ fontWeight: 500 }}>
            {e.patientId}
          </span>
          <Badge className="bg-gray-100 text-gray-600 border-0 text-[10px]">{e.visitType}</Badge>
          {e.safetyActive && (
            <Badge className="bg-red-100 text-red-700 border-0 text-[10px]">Safety</Badge>
          )}
        </div>
        <div className="flex items-center gap-3 mt-1 text-[12px] text-muted-foreground">
          {e.roomNumber && (
            <span className="flex items-center gap-1">
              <DoorOpen className="w-3 h-3" />
              {e.roomNumber}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {isReady ? "Waiting" : "In visit"} {Math.floor(waitSec / 60)}m
          </span>
          {e.assignedMA && (
            <span className="flex items-center gap-1">
              <User className="w-3 h-3" />
              {e.assignedMA}
            </span>
          )}
        </div>
      </div>
      <ChevronRight className="w-4 h-4 text-gray-300 shrink-0" />
    </button>
  );
}

// ── Patient Preview Panel ──

function PatientPreviewPanel({
  encounter: e,
  isReady,
  onStartVisit,
  onViewEncounter,
  onClose,
  waitSec,
}: {
  encounter: Encounter;
  isReady: boolean;
  onStartVisit: () => void;
  onViewEncounter: () => void;
  onClose: () => void;
  waitSec: number;
}) {
  const checkinData = useMemo(() => getMockCheckinData(e), [e]);
  const roomingData = useMemo(() => deriveRoomingData(e), [e]);
  const statusColor = statusColors[e.status];

  const threshold = defaultThresholds.find((t) => t.status === e.status);
  const waitMin = Math.floor(waitSec / 60);
  const alertColor =
    threshold && waitMin >= threshold.redMinutes
      ? "#ef4444"
      : threshold && waitMin >= threshold.yellowMinutes
        ? "#f59e0b"
        : statusColor;

  return (
    <div className="h-full shadow-sm rounded-xl bg-white overflow-hidden flex flex-col">
      <div className="h-1" style={{ background: `linear-gradient(to right, ${statusColor}, ${statusColor}88)` }} />

      {/* Panel header */}
      <div className="shrink-0 px-6 py-4 border-b border-gray-100 flex items-center gap-3">
        <div
          className="w-11 h-11 rounded-full flex items-center justify-center text-white text-[14px] shrink-0"
          style={{ backgroundColor: statusColor, fontWeight: 600 }}
        >
          {e.patientInitials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[16px]" style={{ fontWeight: 600 }}>
              {e.patientId}
            </span>
            <Badge
              className="border-0 text-[10px] px-2 h-5"
              style={{ backgroundColor: `${statusColor}15`, color: statusColor, fontWeight: 600 }}
            >
              {statusLabels[e.status]}
            </Badge>
            {e.walkIn && (
              <Badge className="bg-orange-50 text-orange-500 border-0 text-[10px] h-5">
                <Footprints className="w-3 h-3 mr-0.5" />
                Walk-in
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-[12px] text-muted-foreground">
            <span>{e.visitType}</span>
            <span>·</span>
            <span>{e.provider}</span>
            {e.roomNumber && (
              <>
                <span>·</span>
                <span className="flex items-center gap-1">
                  <DoorOpen className="w-3 h-3" />
                  {e.roomNumber}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Timer */}
        <div className="shrink-0 text-right">
          <div className="flex items-center gap-1.5 justify-end">
            <Timer className="w-3.5 h-3.5" style={{ color: alertColor }} />
            <span
              className="text-[18px] tabular-nums"
              style={{ fontWeight: 700, color: alertColor, lineHeight: 1 }}
            >
              {Math.floor(waitSec / 60)}:{String(waitSec % 60).padStart(2, "0")}
            </span>
          </div>
          <span className="text-[10px] text-muted-foreground">
            {isReady ? "waiting" : "in visit"}
          </span>
        </div>

        <button
          onClick={onClose}
          aria-label={`Close clinician preview for ${e.patientId}`}
          className="shrink-0 w-8 h-8 rounded-lg hover:bg-gray-100 flex items-center justify-center transition-colors ml-1"
        >
          <X className="w-4 h-4 text-gray-400" />
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-6 space-y-5">
          {/* ── Front Desk Check-In Summary ── */}
          <div className="rounded-xl border border-indigo-100 bg-indigo-50/30 overflow-hidden">
            <div className="px-5 py-3 border-b border-indigo-100/80 flex items-center gap-2">
              <div className="w-6 h-6 rounded-md bg-indigo-100 flex items-center justify-center">
                <ClipboardCheck className="w-3.5 h-3.5 text-indigo-600" />
              </div>
              <span className="text-[13px]" style={{ fontWeight: 600 }}>
                Front Desk Check-In
              </span>
              <span className="text-[11px] text-muted-foreground">
                Checked in {e.checkinTime}
              </span>
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 ml-auto" />
            </div>
            <div className="p-5 space-y-3">
              {/* Chief Complaint */}
              {checkinData.chiefComplaint && (
                <div className="rounded-lg bg-white border border-indigo-100/60 p-3">
                  <span
                    className="text-[9px] uppercase tracking-wider text-indigo-500"
                    style={{ fontWeight: 600 }}
                  >
                    Chief Complaint
                  </span>
                  <p className="text-[13px] text-gray-700 mt-0.5" style={{ fontWeight: 500 }}>
                    {checkinData.chiefComplaint}
                  </p>
                </div>
              )}

              {/* Checklist items */}
              <div className="grid grid-cols-2 gap-2">
                <CheckItem
                  label="Demographics Confirmed"
                  checked={checkinData.demographicsConfirmed}
                />
                <CheckItem
                  label="Insurance Card Scanned"
                  checked={checkinData.insuranceCardScanned}
                />
                <CheckItem
                  label="Copay Collected"
                  checked={checkinData.copayCollected}
                  detail={checkinData.copayAmount}
                />
                <CheckItem
                  label="Insurance Verified"
                  checked={!!e.insuranceVerified}
                />
              </div>

              {/* Arrival notes */}
              {checkinData.arrivalNotes && (
                <div className="rounded-lg bg-amber-50 border border-amber-100 p-3">
                  <span
                    className="text-[9px] uppercase tracking-wider text-amber-600"
                    style={{ fontWeight: 600 }}
                  >
                    Arrival Notes
                  </span>
                  <p className="text-[12px] text-gray-600 mt-0.5">{checkinData.arrivalNotes}</p>
                </div>
              )}
            </div>
          </div>

          {/* ── MA Rooming Summary ── */}
          <div className="rounded-xl border border-violet-100 bg-violet-50/30 overflow-hidden">
            <div className="px-5 py-3 border-b border-violet-100/80 flex items-center gap-2">
              <div className="w-6 h-6 rounded-md bg-violet-100 flex items-center justify-center">
                <ClipboardList className="w-3.5 h-3.5 text-violet-600" />
              </div>
              <span className="text-[13px]" style={{ fontWeight: 600 }}>
                MA Rooming
              </span>
              {e.assignedMA && (
                <span className="text-[11px] text-muted-foreground">
                  by {e.assignedMA}
                </span>
              )}
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 ml-auto" />
            </div>
            <div className="p-5 space-y-4">
              {roomingData ? (
                <>
                  <div>
                    <div className="flex items-center gap-1.5 mb-2.5">
                      <Heart className="w-3.5 h-3.5 text-rose-400" />
                      <span
                        className="text-[11px] uppercase tracking-wider text-rose-500"
                        style={{ fontWeight: 600 }}
                      >
                        Vitals
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <VitalCard icon={Gauge} label="BP" value={roomingData.bloodPressure || "—"} />
                      <VitalCard icon={Heart} label="Pulse" value={roomingData.pulse ? `${roomingData.pulse} bpm` : "—"} />
                      <VitalCard
                        icon={Thermometer}
                        label="Temp"
                        value={roomingData.temperature ? `${roomingData.temperature}°F` : "—"}
                      />
                      <VitalCard icon={Activity} label="Weight" value={roomingData.weight || "—"} />
                      <VitalCard icon={Activity} label="Height" value={roomingData.height || "—"} />
                      <VitalCard icon={Activity} label="O₂ Sat" value={roomingData.o2Sat || "—"} />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <CheckItem label="Confirm Pharmacy" checked={roomingData.confirmPharmacy} />
                    <CheckItem label="Confirm Lab" checked={roomingData.confirmLab} />
                    <CheckItem label="Allergies Reviewed" checked={roomingData.allergiesReviewed} />
                    <CheckItem label="Medications Reconciled" checked={roomingData.medsReconciled} />
                    <CheckItem label="Social History Review" checked={roomingData.socialHistoryReviewed} />
                    <CheckItem label="PHQ-2 Completed" checked={roomingData.phq2Completed} />
                    <CheckItem label="Fall Scale Completed" checked={roomingData.fallScaleCompleted} />
                    <CheckItem label="Quality Measures" checked={roomingData.qualityMeasuresReviewed} />
                  </div>

                  {roomingData.reviewOfProblems && (
                    <div className="rounded-lg bg-white border border-violet-100/60 p-3">
                      <span
                        className="text-[9px] uppercase tracking-wider text-violet-500"
                        style={{ fontWeight: 600 }}
                      >
                        Review of Problems
                      </span>
                      <p className="text-[13px] text-gray-700 mt-0.5" style={{ fontWeight: 500 }}>
                        {roomingData.reviewOfProblems}
                      </p>
                    </div>
                  )}
                </>
              ) : (
                <div className="rounded-lg border border-dashed border-violet-200 bg-white/80 p-5 text-center">
                  <ClipboardList className="w-6 h-6 text-violet-200 mx-auto mb-2" />
                  <p className="text-[12px] text-gray-600" style={{ fontWeight: 600 }}>
                    No saved rooming data yet
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    This preview will populate once the MA captures rooming details in the encounter workflow.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* ── Encounter Info ── */}
          <div className="rounded-xl border border-gray-100 bg-white overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
              <div className="w-6 h-6 rounded-md bg-gray-100 flex items-center justify-center">
                <FileText className="w-3.5 h-3.5 text-gray-500" />
              </div>
              <span className="text-[13px]" style={{ fontWeight: 600 }}>
                Encounter Info
              </span>
            </div>
            <div className="p-5">
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-[12px]">
                <InfoRow label="Encounter ID" value={e.id} />
                <InfoRow label="Visit Type" value={e.visitType} />
                <InfoRow label="Provider" value={e.provider} />
                <InfoRow label="Room" value={e.roomNumber || "—"} />
                <InfoRow label="Clinic" value={e.clinicName} />
                <InfoRow label="Check-In Time" value={e.checkinTime} />
                {e.assignedMA && <InfoRow label="Assigned MA" value={e.assignedMA} />}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Bottom action bar ── */}
      <div className="shrink-0 px-6 py-4 border-t border-gray-100 bg-white">
        {isReady ? (
          <button
            onClick={onStartVisit}
            className="w-full h-12 rounded-xl bg-emerald-600 text-white text-[14px] flex items-center justify-center gap-2 shadow-sm hover:bg-emerald-700 active:bg-emerald-800 transition-colors"
            style={{ fontWeight: 600 }}
          >
            <Play className="w-5 h-5" />
            Start Visit
            <ChevronRight className="w-4 h-4 ml-1" />
          </button>
        ) : (
          <button
            onClick={onViewEncounter}
            className="w-full h-12 rounded-xl text-white text-[14px] flex items-center justify-center gap-2 shadow-sm hover:brightness-110 transition-all"
            style={{ fontWeight: 600, backgroundColor: statusColors.Optimizing }}
          >
            <FileText className="w-5 h-5" />
            View Encounter
            <ChevronRight className="w-4 h-4 ml-1" />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Helper components ──

function CheckItem({
  label,
  checked,
  detail,
}: {
  label: string;
  checked: boolean;
  detail?: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-white border border-gray-100 px-3 py-2">
      <div
        className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 ${
          checked ? "bg-emerald-100" : "bg-gray-100"
        }`}
      >
        {checked ? (
          <CheckCircle2 className="w-3 h-3 text-emerald-600" />
        ) : (
          <X className="w-2.5 h-2.5 text-gray-400" />
        )}
      </div>
      <span className="text-[11px] text-gray-600 flex-1">{label}</span>
      {detail && (
        <span className="text-[10px] text-gray-500" style={{ fontWeight: 600 }}>
          {detail}
        </span>
      )}
    </div>
  );
}

function VitalCard({
  icon: Icon,
  label,
  value,
  highlight,
}: {
  icon: ElementType;
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 flex items-center gap-2 ${
        highlight ? "border-amber-200 bg-amber-50/50" : "border-gray-100 bg-white"
      }`}
    >
      <Icon
        className="w-3.5 h-3.5 shrink-0"
        style={{ color: highlight ? "#f59e0b" : "#94a3b8" }}
      />
      <div className="min-w-0">
        <p className="text-[9px] text-muted-foreground uppercase tracking-wider">{label}</p>
        <p
          className="text-[13px] tabular-nums"
          style={{ fontWeight: 600, color: highlight ? "#d97706" : "#374151" }}
        >
          {value}
        </p>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-[10px] text-muted-foreground uppercase tracking-wider" style={{ fontWeight: 500 }}>
        {label}
      </span>
      <p className="text-[13px] text-gray-700 mt-0.5" style={{ fontWeight: 500 }}>
        {value}
      </p>
    </div>
  );
}
