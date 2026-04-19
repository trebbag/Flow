import { useState, useMemo, useEffect, useCallback } from "react";
import {
  Users,
  ShieldAlert,
  Stethoscope,
  DoorOpen,
  AlertTriangle,
  ChevronRight,
  Footprints,
  Shield,
  Activity,
  CheckCircle2,
  Timer,
  Maximize2,
  Minimize2,
  CircleDot,
  ClipboardList,
  Clock,
} from "lucide-react";
import { Card, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { useNavigate } from "react-router";
import {
  statusLabels,
  statusColors,
  defaultThresholds,
  type Encounter,
  type EncounterStatus,
} from "./mock-data";
import { useEncounters } from "./encounter-context";
import { SafetyAssistModal } from "./safety-assist-modal";
import { getEncounterStageSeconds, getEncounterTotalSeconds } from "./encounter-timers";
import { rooms as roomsApi, type PreRoomingCheckResult } from "./api-client";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { toast } from "sonner";

// ── Full workflow columns ──

const kanbanStatuses: EncounterStatus[] = [
  "Lobby",
  "Rooming",
  "ReadyForProvider",
  "Optimizing",
  "CheckOut",
  "Optimized",
];

// Step metadata per column
const stepMeta: Record<string, { step: number; verb: string; icon: React.ElementType }> = {
  Lobby: { step: 1, verb: "Waiting for MA", icon: Users },
  Rooming: { step: 2, verb: "MA actively rooming", icon: ClipboardList },
  ReadyForProvider: { step: 3, verb: "Handed off to clinician", icon: Stethoscope },
  Optimizing: { step: 4, verb: "Clinician visit in progress", icon: Activity },
  CheckOut: { step: 5, verb: "Wrapping up at front desk", icon: CheckCircle2 },
  Optimized: { step: 6, verb: "Completed for the day", icon: CheckCircle2 },
};

function fmtTimer(totalSec: number): string {
  if (totalSec < 0) return "0:00";
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ── MA derivation ──

function deriveMAs(encs: Encounter[]) {
  const map = new Map<string, { name: string; color: string; count: number; statuses: Record<string, number> }>();
  encs.forEach((e) => {
    if (!e.assignedMA) return;
    const existing = map.get(e.assignedMA);
    if (existing) {
      existing.count++;
      existing.statuses[e.status] = (existing.statuses[e.status] || 0) + 1;
    } else {
      map.set(e.assignedMA, { name: e.assignedMA, color: e.maColor || "#94a3b8", count: 1, statuses: { [e.status]: 1 } });
    }
  });
  return Array.from(map.values());
}

// ══════════════════════════════════════════════════════════
// ── CSS keyframes for Safety Assist pulse (injected once) ──
// ══════════════════════════════════════════════════════════
const SAFETY_STYLE_ID = "clinops-safety-pulse";
if (typeof document !== "undefined" && !document.getElementById(SAFETY_STYLE_ID)) {
  const style = document.createElement("style");
  style.id = SAFETY_STYLE_ID;
  style.textContent = `
    @keyframes safetyPulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.5), inset 0 0 0 0 rgba(220, 38, 38, 0.05); }
      50% { box-shadow: 0 0 0 6px rgba(220, 38, 38, 0), inset 0 0 12px 0 rgba(220, 38, 38, 0.08); }
    }
    @keyframes safetyStripe {
      0% { background-position: 0 0; }
      100% { background-position: 20px 0; }
    }
  `;
  document.head.appendChild(style);
}

// ══════════════════════════════════════════════════════════
// ── Main Component ──
// ══════════════════════════════════════════════════════════

export function MABoardView() {
  const navigate = useNavigate();
  const [safetyModalEncounter, setSafetyModalEncounter] = useState<string | null>(null);
  const [clinicFilter, setClinicFilter] = useState<string>("all");
  const [wallMode, setWallMode] = useState(false);
  const [checkingEncounterId, setCheckingEncounterId] = useState<string | null>(null);
  const [blockedRooming, setBlockedRooming] = useState<PreRoomingCheckResult | null>(null);
  const { encounters } = useEncounters();

  // Live tick
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const filteredEncounters = useMemo(() => {
    if (clinicFilter === "all") return encounters;
    return encounters.filter((e) => e.clinicId === clinicFilter);
  }, [encounters, clinicFilter]);

  const clinicOptions = useMemo(() => {
    const unique = new Map<string, { id: string; name: string }>();
    encounters.forEach((encounter) => {
      if (!unique.has(encounter.clinicId)) {
        unique.set(encounter.clinicId, {
          id: encounter.clinicId,
          name: encounter.clinicName || encounter.clinicId,
        });
      }
    });
    return Array.from(unique.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [encounters]);

  const timers = useMemo(() => {
    const m = new Map<string, { stageSec: number; totalSec: number }>();
    filteredEncounters.forEach((e) => {
      m.set(e.id, {
        stageSec: getEncounterStageSeconds(e, nowMs),
        totalSec: getEncounterTotalSeconds(e, nowMs),
      });
    });
    return m;
  }, [filteredEncounters, nowMs]);

  const maList = useMemo(() => deriveMAs(filteredEncounters), [filteredEncounters]);

  const getEncountersByStatus = useCallback(
    (status: EncounterStatus) =>
      filteredEncounters
        .filter((e) => e.status === status)
        .sort((a, b) => b.minutesInStage - a.minutesInStage),
    [filteredEncounters],
  );

  const activeEncounters = filteredEncounters.filter((e) => kanbanStatuses.includes(e.status));
  const yellowAlertCount = activeEncounters.filter((e) => e.alertLevel === "Yellow").length;
  const redAlertCount = activeEncounters.filter((e) => e.alertLevel === "Red").length;
  const safetyCount = activeEncounters.filter((e) => e.safetyActive).length;

  async function handleSelectCard(encounter: Encounter) {
    if (encounter.status === "Lobby") {
      setCheckingEncounterId(encounter.id);
      try {
        const result = await roomsApi.preRoomingCheck(encounter.id);
        if (result.blocked) {
          setBlockedRooming(result);
          return;
        }
        const qs = new URLSearchParams({ startRooming: "true" });
        if (result.preferredRoomId) qs.set("preferredRoomId", result.preferredRoomId);
        if (result.lastReadyRoom) qs.set("lastReadyRoom", "true");
        navigate(`/encounter/${encounter.id}?${qs.toString()}`);
      } catch (error) {
        toast.error("Room availability check failed", {
          description: (error as Error).message || "Unable to verify ready rooms",
        });
      } finally {
        setCheckingEncounterId(null);
      }
      return;
    }
    navigate(`/encounter/${encounter.id}`);
  }

  return (
    <div className={`h-full flex flex-col ${wallMode ? "p-3" : "p-6"} space-y-3`}>
      {/* ═══ Header ═══ */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center">
            <Users className="w-5 h-5 text-purple-600" />
          </div>
          <div>
            <h1 className={`tracking-tight ${wallMode ? "text-[16px]" : "text-[20px]"}`} style={{ fontWeight: 700 }}>MA Board</h1>
            <p className="text-[11px] text-muted-foreground">
              {kanbanStatuses.length}-step pipeline &middot; Lobby → Optimized
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Stats */}
          <div className="flex items-center gap-3 text-[12px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-purple-500" />
              {activeEncounters.length} active
            </span>
            {yellowAlertCount > 0 && (
              <span className="flex items-center gap-1.5 text-amber-600">
                <AlertTriangle className="w-3.5 h-3.5" />
                {yellowAlertCount}
              </span>
            )}
            {redAlertCount > 0 && (
              <span className="flex items-center gap-1.5 text-red-600">
                <AlertTriangle className="w-3.5 h-3.5" />
                {redAlertCount}
              </span>
            )}
            {safetyCount > 0 && (
              <span className="flex items-center gap-1.5 text-red-600 animate-pulse">
                <ShieldAlert className="w-3.5 h-3.5" />
                {safetyCount} SAFETY
              </span>
            )}
          </div>
          {/* Clinic filter */}
          <select
            value={clinicFilter}
            onChange={(e) => setClinicFilter(e.target.value)}
            className="h-8 px-3 rounded-lg border border-gray-200 bg-white text-[12px] appearance-none focus:outline-none focus:border-purple-300 focus:ring-2 focus:ring-purple-100"
          >
            <option value="all">All Clinics</option>
            {clinicOptions.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {/* Wall mode toggle */}
          <button
            onClick={() => setWallMode(!wallMode)}
            className="w-8 h-8 rounded-lg border border-gray-200 bg-white flex items-center justify-center text-gray-500 hover:text-purple-600 hover:border-purple-200 transition-colors"
            title={wallMode ? "Exit Wall Mode" : "Enter Wall Mode"}
          >
            {wallMode ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* ═══ Kanban + Detail Panel ═══ */}
      <div className="flex-1 flex gap-3 min-h-0 overflow-hidden">
        {/* Kanban Columns — scrolls as one unit, all lanes stretch to tallest */}
        <div className="overflow-y-auto overflow-x-auto w-full">
          <div className="flex gap-2.5 items-stretch min-h-full">
          {kanbanStatuses.map((status) => {
            const items = getEncountersByStatus(status);
            const color = statusColors[status];
            const meta = stepMeta[status];
            const hasAlerts = items.some((e) => e.alertLevel !== "Green");
            const hasSafety = items.some((e) => e.safetyActive);
            const threshold = defaultThresholds.find((t) => t.status === status);

            return (
              <div
                key={status}
                data-status-column={status}
                className="flex flex-col flex-1 min-w-[280px]"
              >
                {/* Column header */}
                <div className="bg-white rounded-t-xl border border-b-0 border-gray-100 shadow-sm overflow-hidden shrink-0">
                  <div className="h-1" style={{ background: `linear-gradient(to right, ${color}, ${color}88)` }} />
                  <div className="px-3.5 py-2.5">
                    <div className="flex items-center justify-between mb-0.5">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-5 h-5 rounded-md flex items-center justify-center"
                          style={{ backgroundColor: `${color}15` }}
                        >
                          <span className="text-[10px] tabular-nums" style={{ fontWeight: 700, color }}>{meta?.step}</span>
                        </div>
                        <span className="text-[12px]" style={{ fontWeight: 600 }}>{statusLabels[status]}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        {hasSafety && <ShieldAlert className="w-3.5 h-3.5 text-red-600 animate-pulse" />}
                        {hasAlerts && !hasSafety && <AlertTriangle className="w-3 h-3 text-amber-500" />}
                        <Badge className="border-0 text-[10px] px-1.5 h-5" style={{ backgroundColor: `${color}15`, color }}>
                          {items.length}
                        </Badge>
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] text-muted-foreground">{meta?.verb}</span>
                      {threshold && (
                        <span className="text-[8px] text-gray-400">
                          <span className="text-amber-500">{threshold.yellowMinutes}m</span>
                          {" / "}
                          <span className="text-red-500">{threshold.redMinutes}m</span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Cards */}
                <div className="flex-1 bg-gray-50/60 rounded-b-xl border border-t-0 border-gray-100 shadow-sm">
                  <div className="p-2 space-y-2">
                    {items.map((e) => {
                      const t = timers.get(e.id) || { stageSec: e.minutesInStage * 60, totalSec: 0 };
                      return (
                        <EncounterCard
                          key={e.id}
                          encounter={e}
                          stageSec={t.stageSec}
                          totalSec={t.totalSec}
                          compact={wallMode}
                          checking={checkingEncounterId === e.id}
                          onSelect={() => {
                            void handleSelectCard(e);
                          }}
                          onSafetyTrigger={(id) => setSafetyModalEncounter(id)}
                        />
                      );
                    })}
                    {items.length === 0 && (
                      <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                        <CircleDot className="w-5 h-5 mb-1 text-gray-200" />
                        <p className="text-[10px]">No patients</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          </div>
        </div>
      </div>

      {/* Safety Assist Modal */}
      {safetyModalEncounter && (
        <SafetyAssistModal
          encounterId={safetyModalEncounter}
          onClose={() => setSafetyModalEncounter(null)}
          onActivated={() => setSafetyModalEncounter(null)}
        />
      )}

      <Dialog open={!!blockedRooming} onOpenChange={(open) => !open && setBlockedRooming(null)}>
        <DialogContent className="max-w-[520px]">
          <DialogHeader>
            <DialogTitle>No rooms available for rooming</DialogTitle>
            <DialogDescription>None of your rooms are ready right now.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-[280px] overflow-auto">
            {(blockedRooming?.rooms || []).map((room) => (
              <div key={room.id} className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 flex items-center justify-between gap-3">
                <div>
                  <div className="text-[13px]" style={{ fontWeight: 700 }}>{room.name}</div>
                  <div className="text-[11px] text-muted-foreground">{room.clinicName}</div>
                </div>
                <div className="text-right">
                  <Badge className="border-0 bg-amber-100 text-amber-700 text-[10px] h-5">{room.operationalStatus}</Badge>
                  <div className="text-[10px] text-muted-foreground mt-1">{room.timerLabel}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-end gap-2 pt-2">
            <button onClick={() => setBlockedRooming(null)} className="h-9 px-3 rounded-lg border border-gray-200 text-[12px] text-gray-700 hover:bg-gray-50">
              Close
            </button>
            <button onClick={() => navigate("/rooms")} className="h-9 px-3 rounded-lg bg-slate-900 text-white text-[12px] hover:bg-slate-800">
              Open Rooms
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// ── Encounter Card (redesigned — no circles) ──
// ══════════════════════════════════════════════════════════

function EncounterCard({
  encounter: e,
  stageSec,
  totalSec,
  compact,
  checking,
  onSelect,
  onSafetyTrigger,
}: {
  encounter: Encounter;
  stageSec: number;
  totalSec: number;
  compact: boolean;
  checking?: boolean;
  onSelect: () => void;
  onSafetyTrigger: (id: string) => void;
}) {
  const isSafety = !!e.safetyActive;
  const cColor = e.clinicColor || "#94a3b8";
  const appointmentLabel = e.walkIn ? "Walk-In" : e.appointmentTime || "--:--";
  const checkInLabel = e.checkinTime || "--:--";

  // ── Clinic gradient: white → pale clinic colour (stronger) ──
  const clinicBg = `linear-gradient(135deg, #ffffff 0%, ${cColor}22 100%)`;

  // ── Alert threshold styles (operational) ──
  const alertBorderColor =
    e.alertLevel === "Red" ? "#ef4444" : e.alertLevel === "Yellow" ? "#f59e0b" : `${cColor}25`;

  const stageColor =
    e.alertLevel === "Red" ? "#ef4444" : e.alertLevel === "Yellow" ? "#f59e0b" : "#64748b";

  // ── Safety Assist: completely different, emphatic emergency treatment ──
  if (isSafety) {
    return (
      <div
        data-encounter-card={e.id}
        data-encounter-patient-id={e.patientId}
        onClick={onSelect}
        className={`rounded-xl overflow-hidden cursor-pointer transition-all hover:shadow-lg ${checking ? "opacity-70 pointer-events-none" : ""}`}
        style={{
          animation: "safetyPulse 2s ease-in-out infinite",
          border: "2px solid #dc2626",
        }}
      >
        {/* Emergency header stripe */}
        <div
          className="px-3 py-1.5 flex items-center gap-2"
          style={{
            background: "repeating-linear-gradient(45deg, #dc2626, #dc2626 10px, #b91c1c 10px, #b91c1c 20px)",
            backgroundSize: "28px 28px",
            animation: "safetyStripe 1s linear infinite",
          }}
        >
          <ShieldAlert className="w-4 h-4 text-white" />
          <span className="text-[11px] text-white tracking-wider" style={{ fontWeight: 700 }}>
            SAFETY ASSIST — ACTIVE
          </span>
        </div>

        <div className="bg-red-50 px-3.5 py-3">
          {/* Identity row */}
          <div className="flex items-center justify-between mb-2">
            <div>
              <span className="text-[14px]" style={{ fontWeight: 700 }}>{e.patientId}</span>
              <span className="text-[10px] text-muted-foreground ml-1.5">
                {e.visitType}
              </span>
            </div>
            <div className="text-right">
              <div className="text-[15px] tabular-nums text-red-600" style={{ fontWeight: 700, lineHeight: 1.1 }}>
                {fmtTimer(stageSec)}
              </div>
              <div className="text-[8px] text-red-400" style={{ fontWeight: 500 }}>IN STAGE</div>
            </div>
          </div>

          {/* Details */}
          <div className="flex items-center gap-2 text-[11px] text-gray-600 mb-1.5">
            <Stethoscope className="w-3 h-3 shrink-0" />
            <span className="truncate">{e.provider}</span>
            {e.roomNumber && (
              <><span className="text-gray-300">|</span><DoorOpen className="w-3 h-3 shrink-0" /><span>{e.roomNumber}</span></>
            )}
          </div>
          <div className="text-[10px] text-gray-500 mb-2">
            Appt {appointmentLabel} &middot; Checked in {checkInLabel}
          </div>

          {/* Total timer */}
          <div className="flex items-center gap-1.5 mb-2.5 px-2 py-1 rounded-md bg-red-100/80">
            <Timer className="w-3 h-3 text-red-400" />
            <span className="text-[10px] text-red-600 tabular-nums" style={{ fontWeight: 600 }}>{fmtTimer(totalSec)} total</span>
          </div>

          {/* MA + Safety trigger note */}
          <div className="flex items-center justify-between">
            {e.assignedMA ? (
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: e.maColor || "#94a3b8" }} />
                <span className="text-[10px] text-gray-600">{e.assignedMA}</span>
              </div>
            ) : (
              <span className="text-[10px] text-gray-400 italic">Unassigned</span>
            )}
            <span className="text-[9px] text-red-500" style={{ fontWeight: 500 }}>Admin resolve required</span>
          </div>
        </div>
      </div>
    );
  }

  // ── Normal card (non-safety) ──
  return (
    <div
      data-encounter-card={e.id}
      data-encounter-patient-id={e.patientId}
      onClick={onSelect}
      className={`rounded-xl overflow-hidden border transition-all hover:shadow-md cursor-pointer ${checking ? "opacity-70 pointer-events-none" : ""}`}
      style={{
        background: clinicBg,
        borderColor: alertBorderColor,
        borderWidth: e.alertLevel !== "Green" ? "2px" : "1px",
      }}
    >
      {/* Top accent bar — uses alert color when in Yellow/Red, clinic color otherwise */}
      <div
        className="h-1"
        style={{
          background: e.alertLevel === "Red"
            ? "linear-gradient(to right, #ef4444, #dc2626)"
            : e.alertLevel === "Yellow"
              ? "linear-gradient(to right, #f59e0b, #d97706)"
              : cColor,
        }}
      />

        <div className={`px-3.5 ${compact ? "py-2" : "py-3"}`}>
          {checking && <div className="mb-2 text-[10px] text-purple-700 bg-purple-50 rounded-md px-2 py-1">Checking ready rooms...</div>}
        {/* Top row: identity + stage timer */}
        <div className="flex items-center justify-between mb-1.5">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className={`${compact ? "text-[12px]" : "text-[13px]"}`} style={{ fontWeight: 600 }}>
                {e.patientId}
              </span>
              <Badge
                className="border-0 text-[8px] px-1.5 h-[16px]"
                style={{ backgroundColor: `${cColor}18`, color: cColor }}
              >
                {e.clinicShortCode}
              </Badge>
              {e.alertLevel !== "Green" && (
                <Badge
                  className="border-0 text-[8px] px-1.5 h-[16px] flex items-center gap-0.5"
                  style={{
                    backgroundColor: e.alertLevel === "Red" ? "#fef2f2" : "#fffbeb",
                    color: e.alertLevel === "Red" ? "#dc2626" : "#d97706",
                  }}
                >
                  <AlertTriangle className="w-2.5 h-2.5" />
                  {e.alertLevel}
                </Badge>
              )}
            </div>
              <span className="text-[9px] text-muted-foreground">
                {e.visitType}
              </span>
            </div>
          <div className="text-right shrink-0 ml-2">
            <div
              className={`tabular-nums ${compact ? "text-[14px]" : "text-[16px]"}`}
              style={{ fontWeight: 700, color: stageColor, lineHeight: 1.1 }}
            >
              {fmtTimer(stageSec)}
            </div>
            <div className="text-[8px] text-muted-foreground" style={{ fontWeight: 500 }}>STAGE</div>
          </div>
        </div>

        {/* Details */}
        <div className={`space-y-0.5 ${compact ? "mb-1.5" : "mb-2"}`}>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Clock className="w-3 h-3 shrink-0" />
            <span>Appt {appointmentLabel}</span>
            <span className="text-gray-300">|</span>
            <span>Checked in {checkInLabel}</span>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Stethoscope className="w-3 h-3 shrink-0" />
            <span className="truncate">{e.provider}</span>
          </div>
          {e.roomNumber && (
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <DoorOpen className="w-3 h-3 shrink-0" />
              <span>{e.roomNumber}</span>
            </div>
          )}
        </div>

        {/* Total encounter timer */}
        <div className="flex items-center gap-1.5 mb-2 px-2 py-1 rounded-md bg-white/70 border border-gray-100">
          <Clock className="w-3 h-3 text-gray-400" />
          <span className="text-[10px] text-gray-500 tabular-nums" style={{ fontWeight: 600 }}>{fmtTimer(totalSec)}</span>
          <span className="text-[8px] text-muted-foreground">total</span>
        </div>

        {/* Tags */}
        {(e.walkIn || e.insuranceVerified || (e.cardTags && e.cardTags.length > 0)) && (
          <div className="flex gap-1 flex-wrap mb-2">
            {e.walkIn && (
              <Badge className="bg-orange-50 text-orange-500 border-0 text-[8px] px-1.5 h-[16px]">
                <Footprints className="w-2.5 h-2.5 mr-0.5" /> Walk-in
              </Badge>
            )}
            {e.insuranceVerified && (
              <Badge className="bg-emerald-50 text-emerald-500 border-0 text-[8px] px-1.5 h-[16px]">
                <Shield className="w-2.5 h-2.5 mr-0.5" /> Ins ✓
              </Badge>
            )}
            {e.cardTags?.map((tag) => (
              <Badge key={tag} className="bg-gray-100 text-gray-500 border-0 text-[8px] px-1.5 h-[16px]">{tag}</Badge>
            ))}
          </div>
        )}

        {/* Footer: MA + actions */}
        <div className="pt-2 border-t flex items-center justify-between" style={{ borderColor: `${cColor}15` }}>
          <div className="flex items-center gap-1.5">
            {e.assignedMA ? (
              <>
                <div className="w-2 h-5 rounded-full shrink-0" style={{ backgroundColor: e.maColor || "#94a3b8" }} />
                <span className="text-[10px] text-muted-foreground">{e.assignedMA}</span>
              </>
            ) : (
              <span className="text-[10px] text-gray-300 italic">Unassigned</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={(ev) => { ev.stopPropagation(); onSafetyTrigger(e.id); }}
              className="w-7 h-7 rounded-lg flex items-center justify-center bg-red-50 text-red-500 border border-red-200 hover:bg-red-100 hover:text-red-600 shadow-sm transition-colors"
              title="Activate Safety Assist"
            >
              <ShieldAlert className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
