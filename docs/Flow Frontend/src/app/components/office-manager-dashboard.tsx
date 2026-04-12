import { useEffect, useMemo, useState } from "react";
import {
  Users,
  Clock,
  TrendingUp,
  AlertTriangle,
  CheckCircle2,
  ArrowRight,
  ArrowUpRight,
  ArrowDownRight,
  Timer,
  ShieldAlert,
  Eye,
  DoorOpen,
  Building2,
  Filter,
  Wifi,
  ClipboardCheck,
  Stethoscope,
  CreditCard,
  Activity,
  Heart,
  Thermometer,
  Gauge,
  FileText,
  User,
  Calendar,
  Printer,
  X,
  ChevronRight,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Cell,
  PieChart,
  Pie,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import {
  statusLabels,
  statusColors,
  type EncounterStatus,
  type Encounter,
  type Provider as ProviderCardRow,
  type StageMetric as StageMetricRow,
  type HourlyVolume as HourlyVolumePoint,
  type Alert as AlertRow,
  type Room as RoomCensusRow,
} from "./mock-data";
import { useEncounters } from "./encounter-context";
import { admin } from "./api-client";
import { loadSession } from "./auth-session";
import { labelClinicName, labelProviderName, labelRoomName, labelUserName } from "./display-names";
import { ADMIN_REFRESH_EVENT, FACILITY_CONTEXT_CHANGED_EVENT } from "./app-events";

// ── Pipeline summary ──
const pipelineStages: EncounterStatus[] = [
  "Incoming", "Lobby", "Rooming", "ReadyForProvider", "Optimizing", "CheckOut", "Optimized",
];

const fallbackStageTargets: Record<EncounterStatus, number> = {
  Incoming: 0,
  Lobby: 15,
  Rooming: 12,
  ReadyForProvider: 10,
  Optimizing: 25,
  CheckOut: 8,
  Optimized: 0,
};

const stagePalette: Record<EncounterStatus, string> = {
  Incoming: "#94a3b8",
  Lobby: "#6366f1",
  Rooming: "#8b5cf6",
  ReadyForProvider: "#f59e0b",
  Optimizing: "#a855f7",
  CheckOut: "#10b981",
  Optimized: "#06b6d4",
};

function colorFromText(input: string) {
  const palette = ["#6366f1", "#10b981", "#f59e0b", "#ec4899", "#0ea5e9", "#8b5cf6"];
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return palette[Math.abs(hash) % palette.length] || "#6366f1";
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "--";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] || ""}${parts[1]![0] || ""}`.toUpperCase();
}

function stageLabelForMetric(status: EncounterStatus) {
  switch (status) {
    case "ReadyForProvider":
      return "Ready";
    case "CheckOut":
      return "Checkout";
    default:
      return status;
  }
}

function formatHourLabel(hour24: number) {
  const hour = hour24 % 12 || 12;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  return `${hour} ${suffix}`;
}

function elapsedSecondsFromClockTime(clockValue: string | undefined, nowMs: number, fallbackMinutes = 0) {
  const match = (clockValue || "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return Math.max(0, fallbackMinutes * 60);

  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return Math.max(0, fallbackMinutes * 60);

  const anchor = new Date(nowMs);
  anchor.setHours(hh, mm, 0, 0);
  let delta = nowMs - anchor.getTime();
  if (delta < 0) {
    delta += 24 * 60 * 60 * 1000;
  }
  return Math.max(0, Math.floor(delta / 1000));
}

function minutesFromIso(iso: string | undefined, nowMs: number) {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((nowMs - parsed) / 60000));
}

function liveStageMinutes(encounter: Encounter, nowMs: number) {
  const isoMinutes = minutesFromIso(encounter.currentStageStartAtIso, nowMs);
  if (isoMinutes !== null) return isoMinutes;
  return Math.floor(
    elapsedSecondsFromClockTime(encounter.currentStageStart, nowMs, encounter.minutesInStage) / 60,
  );
}

// ── KPI Cards ──
function KpiCard({ icon: Icon, label, value, subtext, trend, trendDir, color }: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  subtext: string;
  trend?: string;
  trendDir?: "up" | "down" | "flat";
  color: string;
}) {
  return (
    <Card className="relative overflow-hidden border-0 shadow-sm bg-white">
      <div className="absolute top-0 left-0 w-1 h-full" style={{ backgroundColor: color }} />
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">{label}</p>
            <p className="text-[28px] tracking-tight" style={{ fontWeight: 700, lineHeight: 1.1 }}>{value}</p>
            <p className="text-[12px] text-muted-foreground mt-1">{subtext}</p>
          </div>
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${color}15` }}>
            <Icon className="w-5 h-5" style={{ color }} />
          </div>
        </div>
        {trend && (
          <div className="flex items-center gap-1 mt-3 text-[12px]" style={{ color: trendDir === "up" ? "#10b981" : trendDir === "down" ? "#ef4444" : "#94a3b8" }}>
            {trendDir === "up" ? <ArrowUpRight className="w-3.5 h-3.5" /> : trendDir === "down" ? <ArrowDownRight className="w-3.5 h-3.5" /> : null}
            <span style={{ fontWeight: 500 }}>{trend}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Patient Flow Pipeline ──
function FlowPipeline({ encounters }: { encounters: Encounter[] }) {
  function countByStatus(status: EncounterStatus) {
    return encounters.filter((e) => e.status === status).length;
  }

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-2 pt-5 px-5">
        <CardTitle className="text-[14px] flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-indigo-500" />
          Patient Flow Pipeline
        </CardTitle>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        <div className="flex items-center gap-1">
          {pipelineStages.map((stage, i) => {
            const count = countByStatus(stage);
            const color = statusColors[stage];
            const isLast = i === pipelineStages.length - 1;
            return (
              <div key={stage} className="flex items-center flex-1 min-w-0">
                <div className="flex-1 min-w-0">
                  <div
                    className="rounded-lg px-2 py-3 text-center transition-all hover:scale-[1.02]"
                    style={{ backgroundColor: `${color}12`, border: `1px solid ${color}30` }}
                  >
                    <div className="text-[20px]" style={{ fontWeight: 700, color, lineHeight: 1.2 }}>{count}</div>
                    <div className="text-[9px] mt-1 truncate" style={{ color, fontWeight: 500, opacity: 0.8 }}>
                      {statusLabels[stage]}
                    </div>
                  </div>
                </div>
                {!isLast && (
                  <ArrowRight className="w-3.5 h-3.5 text-gray-300 mx-0.5 shrink-0" />
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-4 flex gap-1 h-2 rounded-full overflow-hidden">
          {pipelineStages.map((stage) => {
            const count = countByStatus(stage);
            const total = encounters.length;
            const pct = total > 0 ? (count / total) * 100 : 0;
            return (
              <div
                key={stage}
                style={{ width: `${pct}%`, backgroundColor: statusColors[stage] }}
                className="transition-all rounded-full"
              />
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Stage Performance ──
function StagePerformance({ stageMetrics }: { stageMetrics: StageMetricRow[] }) {
  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-2 pt-5 px-5">
        <CardTitle className="text-[14px] flex items-center gap-2">
          <Timer className="w-4 h-4 text-purple-500" />
          Stage Performance
        </CardTitle>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        <div className="space-y-3">
          {stageMetrics.map((m) => {
            const pct = Math.min((m.avgMinutes / m.target) * 100, 100);
            const isOver = m.avgMinutes > m.target;
            return (
              <div key={m.stage}>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: m.color }} />
                    <span className="text-[13px]" style={{ fontWeight: 500 }}>{m.stage}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-[12px] text-muted-foreground">{m.count} active</span>
                    <span className="text-[13px]" style={{ fontWeight: 600, color: isOver ? "#ef4444" : "#10b981" }}>
                      {m.avgMinutes}m
                    </span>
                    <span className="text-[11px] text-muted-foreground">/ {m.target}m</span>
                  </div>
                </div>
                <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${pct}%`, backgroundColor: isOver ? "#ef4444" : m.color }}
                  />
                </div>
                <div className="flex justify-end mt-1">
                  <span className="text-[10px]" style={{
                    fontWeight: 500,
                    color: m.slaCompliance >= 90 ? "#10b981" : m.slaCompliance >= 80 ? "#f59e0b" : "#ef4444"
                  }}>
                    {m.slaCompliance}% SLA
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Hourly Volume Chart ──
function HourlyVolumeChart({ hourlyVolume }: { hourlyVolume: HourlyVolumePoint[] }) {
  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-2 pt-5 px-5">
        <CardTitle className="text-[14px] flex items-center gap-2">
          <Clock className="w-4 h-4 text-cyan-500" />
          Hourly Volume
        </CardTitle>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        <div className="h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={hourlyVolume} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="colorCheckins" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="colorCompleted" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="hour" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
              <RechartsTooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e2e8f0", boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }} />
              <Area type="monotone" dataKey="checkins" stroke="#6366f1" strokeWidth={2} fill="url(#colorCheckins)" name="Check-ins" />
              <Area type="monotone" dataKey="completed" stroke="#10b981" strokeWidth={2} fill="url(#colorCompleted)" name="Completed" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="flex items-center justify-center gap-6 mt-3">
          <div className="flex items-center gap-2">
            <div className="w-3 h-1.5 rounded-full bg-indigo-500" />
            <span className="text-[11px] text-muted-foreground">Check-ins</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-1.5 rounded-full bg-emerald-500" />
            <span className="text-[11px] text-muted-foreground">Completed</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Room Census ──
function RoomCensus({ rooms }: { rooms: RoomCensusRow[] }) {
  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-2 pt-5 px-5">
        <CardTitle className="text-[14px] flex items-center gap-2">
          <DoorOpen className="w-4 h-4 text-teal-500" />
          Room Census
          <Badge className="bg-teal-100 text-teal-700 border-0 text-[10px] px-1.5 h-5">
            {rooms.filter(r => r.occupied).length}/{rooms.filter(r => r.active).length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        <div className="grid grid-cols-2 gap-2">
          {rooms.filter(r => r.active).map((room) => {
            const bg = room.safetyActive
              ? "bg-red-50 border-red-300"
              : room.occupied
              ? room.alertLevel === "Yellow"
                ? "bg-amber-50/50 border-amber-200"
                : room.alertLevel === "Red"
                ? "bg-red-50/50 border-red-200"
                : "bg-white border-gray-200"
              : "bg-gray-50 border-gray-100";
            return (
              <div key={room.id} className={`rounded-lg border p-2.5 ${bg} transition-all`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[12px]" style={{ fontWeight: 600 }}>{room.name}</span>
                  {room.safetyActive && <ShieldAlert className="w-3 h-3 text-red-600" />}
                  {room.occupied && room.status && !room.safetyActive && (
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: statusColors[room.status] }} />
                  )}
                </div>
                {room.occupied ? (
                  <div className="text-[10px] text-muted-foreground truncate">
                    {room.patientId} &middot; {labelProviderName(room.providerName || "Unassigned", true)}
                  </div>
                ) : (
                  <div className="text-[10px] text-gray-400">Available</div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Provider Cards ──
function ProviderUtilization({ providers }: { providers: ProviderCardRow[] }) {
  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-2 pt-5 px-5">
        <CardTitle className="text-[14px] flex items-center gap-2">
          <Users className="w-4 h-4 text-amber-500" />
          Provider Utilization
        </CardTitle>
      </CardHeader>
      <CardContent className="px-5 pb-5 space-y-3">
        {providers.map((p) => (
          <div key={p.name} className="rounded-lg border border-gray-100 p-3 hover:border-gray-200 transition-colors">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[11px]" style={{ backgroundColor: p.avatarColor, fontWeight: 600 }}>
                {p.initials}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] truncate" style={{ fontWeight: 500 }}>{p.name}</div>
                <div className="text-[11px] text-muted-foreground">{p.specialty}</div>
              </div>
              <div className="text-right">
                <div className="text-[15px]" style={{ fontWeight: 700 }}>{p.utilization}%</div>
              </div>
            </div>
            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all" style={{ width: `${p.utilization}%`, backgroundColor: p.utilization >= 85 ? "#10b981" : p.utilization >= 70 ? "#f59e0b" : "#94a3b8" }} />
            </div>
            <div className="flex items-center justify-between mt-2 text-[11px] text-muted-foreground">
              <span>{p.activeEncounters} active &middot; {p.completedToday} done</span>
              <span>Avg {p.avgCycleTime}m cycle</span>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ── Alerts Panel ──
function AlertsPanel({ alerts }: { alerts: AlertRow[] }) {
  const sortedAlerts = [...alerts].sort((a, b) => {
    const priority = { safety: 0, Red: 1, Yellow: 2 };
    return (priority[a.type] ?? 3) - (priority[b.type] ?? 3);
  });

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-2 pt-5 px-5">
        <CardTitle className="text-[14px] flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-red-500" />
          Active Alerts
          <Badge className="bg-red-100 text-red-700 border-0 text-[10px] px-1.5 h-5">
            {alerts.filter(a => !a.acknowledged).length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        <div className="space-y-2">
          {sortedAlerts.map((a) => (
            <div
              key={a.id}
              className={`rounded-lg p-3 border transition-all ${
                a.type === "safety"
                  ? "bg-red-50 border-red-200"
                  : a.type === "Red"
                  ? "bg-orange-50 border-orange-200"
                  : "bg-amber-50 border-amber-200"
              } ${a.acknowledged ? "opacity-50" : ""}`}
            >
              <div className="flex items-start gap-2">
                {a.type === "safety" ? (
                  <ShieldAlert className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
                ) : a.type === "Red" ? (
                  <AlertTriangle className="w-4 h-4 text-orange-600 mt-0.5 shrink-0" />
                ) : (
                  <Clock className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-[12px]" style={{ fontWeight: 500 }}>{a.message}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[10px] text-muted-foreground">{a.timestamp}</span>
                    {a.acknowledged && (
                      <Badge className="bg-gray-100 text-gray-500 border-0 text-[9px] px-1 h-4">ACK by {a.acknowledgedBy}</Badge>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Mock workflow data generators ──
// These simulate data collected at each stage. In production, this comes from the API.

const statusFlowOrder: EncounterStatus[] = [
  "Incoming", "Lobby", "Rooming", "ReadyForProvider", "Optimizing", "CheckOut", "Optimized",
];

function stageIndex(s: EncounterStatus) {
  return statusFlowOrder.indexOf(s);
}

function getMockIncomingData(e: Encounter) {
  return {
    patientId: e.patientId,
    scheduledTime: e.checkinTime,
    visitType: e.visitType,
    provider: labelProviderName(e.provider, true),
    clinic: labelClinicName(e.clinicName),
    insuranceOnFile: e.insuranceVerified ?? false,
    walkIn: e.walkIn ?? false,
    preVisitFormsCompleted: !e.walkIn,
    preferredPharmacy: e.clinicId === "c1" ? "CVS #4821 — Main St" : "Walgreens #107 — Eastside",
    emergencyContactOnFile: true,
  };
}

function getMockCheckinData(e: Encounter) {
  return {
    demographicsConfirmed: true,
    insuranceCardScanned: !!e.insuranceVerified,
    copayCollected: true,
    copayAmount: e.visitType === "Annual Physical" ? "$0" : "$25",
    consentFormsSigned: true,
    chiefComplaint:
      e.visitType === "Follow-up" ? "Follow-up on lab results"
        : e.visitType === "Annual Physical" ? "Annual wellness exam"
        : e.visitType === "Sick Visit" ? "Sore throat, cough × 3 days"
        : e.visitType === "New Patient" ? "New patient check-in, establish care"
        : e.visitType === "Procedure" ? "Scheduled procedure"
        : "Lab order follow-up",
    arrivalNotes: e.arrivalNotes || "",
    checkedInAt: e.checkinTime,
    checkedInBy: "Front Desk",
  };
}

function getMockRoomingData(e: Encounter) {
  const seed = e.patientId.charCodeAt(3) || 65;
  return {
    roomAssigned: e.roomNumber || "—",
    assignedMA: labelUserName(e.assignedMA) || "—",
    bloodPressure: `${118 + (seed % 20)}/${72 + (seed % 15)}`,
    heartRate: `${68 + (seed % 18)} bpm`,
    temperature: `${(97.2 + (seed % 20) / 10).toFixed(1)}°F`,
    weight: `${145 + (seed % 40)} lbs`,
    o2Saturation: `${96 + (seed % 3)}%`,
    painLevel: `${seed % 5}/10`,
    allergiesReviewed: true,
    medicationsReconciled: true,
    chiefComplaintExpanded:
      e.visitType === "Sick Visit"
        ? "Sore throat, cough × 3 days, low-grade fever. No known COVID exposure."
        : e.visitType === "Follow-up"
        ? "Follow-up on lab results — lipid panel and A1c"
        : "See visit type",
    roomingNotes: "",
  };
}

function getMockProviderData(e: Encounter) {
  return {
    visitStarted: "08:" + String(10 + (e.patientId.charCodeAt(4) % 20)).padStart(2, "0"),
    assessmentPreview:
      e.visitType === "Sick Visit" ? "URI symptoms, likely viral. Supportive care."
        : e.visitType === "Follow-up" ? "Labs reviewed — LDL improved, continue current regimen."
        : e.visitType === "Annual Physical" ? "Routine wellness, age-appropriate screenings ordered."
        : "Assessment in progress",
    ordersEntered: e.visitType === "Sick Visit" ? 1 : e.visitType === "Annual Physical" ? 3 : 2,
    referralsMade: e.visitType === "New Patient" ? 1 : 0,
    tasksCreated: 0,
  };
}

function getMockCheckoutData(e: Encounter) {
  return {
    followUpScheduled: true,
    followUpInterval: e.visitType === "Sick Visit" ? "If worsens" : "3 months",
    visitSummaryPrinted: false,
    referralsProcessed: e.visitType === "New Patient",
    billingCodesVerified: false,
    prescriptionsSent: e.visitType === "Sick Visit",
  };
}

// ── Workflow stage icons + colors ──

const stageConfig: Record<string, { icon: React.ElementType; color: string; label: string }> = {
  Incoming: { icon: Clock, color: "#94a3b8", label: "Pre-Arrival" },
  Lobby: { icon: ClipboardCheck, color: "#6366f1", label: "Front Desk Check-In" },
  Rooming: { icon: Activity, color: "#8b5cf6", label: "MA / Rooming" },
  ReadyForProvider: { icon: Stethoscope, color: "#f59e0b", label: "Ready for Provider" },
  Optimizing: { icon: Stethoscope, color: "#a855f7", label: "Provider Visit" },
  CheckOut: { icon: CreditCard, color: "#10b981", label: "Front Desk Check-Out" },
};

// ── Live Encounter Feed (with selection + detail panel) ──
function LiveEncounterFeed({ encounters }: { encounters: Encounter[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const active = encounters
    .filter((e) => e.status !== "Optimized")
    .sort((a, b) => {
      if (a.safetyActive && !b.safetyActive) return -1;
      if (!a.safetyActive && b.safetyActive) return 1;
      const alertPriority = { Red: 0, Yellow: 1, Green: 2 };
      const ap = alertPriority[a.alertLevel] ?? 2;
      const bp = alertPriority[b.alertLevel] ?? 2;
      if (ap !== bp) return ap - bp;
      return b.minutesInStage - a.minutesInStage;
    });

  const selectedEnc = selectedId ? active.find((e) => e.id === selectedId) ?? null : null;

  return (
    <div className="space-y-4">
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-2 pt-5 px-5">
          <CardTitle className="text-[14px] flex items-center gap-2">
            <Eye className="w-4 h-4 text-indigo-500" />
            Live Encounters
            <Badge className="bg-indigo-100 text-indigo-700 border-0 text-[10px] px-1.5 h-5">
              {active.length}
            </Badge>
            {selectedEnc && (
              <span className="ml-auto text-[11px] text-muted-foreground" style={{ fontWeight: 400 }}>
                Click a row to inspect workflow data
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-2">
          <ScrollArea className="h-[300px]">
            <div className="px-5 space-y-1.5">
              {active.map((enc) => (
                <EncounterRow
                  key={enc.id}
                  encounter={enc}
                  isSelected={enc.id === selectedId}
                  onSelect={() => setSelectedId(enc.id === selectedId ? null : enc.id)}
                />
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* ── Workflow Detail Panel ── */}
      {selectedEnc && (
        <EncounterWorkflowPanel
          encounter={selectedEnc}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

function EncounterRow({ encounter: e, isSelected, onSelect }: {
  encounter: Encounter;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const alertBg =
    e.safetyActive
      ? "bg-red-50 border-red-300 ring-1 ring-red-200"
      : isSelected
      ? "bg-indigo-50 border-indigo-300 ring-1 ring-indigo-200"
      : e.alertLevel === "Red"
      ? "bg-red-50/50 border-red-100"
      : e.alertLevel === "Yellow"
      ? "bg-amber-50/50 border-amber-100"
      : "bg-white border-gray-100";

  return (
    <div
      className={`rounded-lg border p-3 flex items-center gap-3 transition-all cursor-pointer hover:shadow-sm ${alertBg}`}
      onClick={onSelect}
    >
      {e.safetyActive && (
        <div className="absolute -top-0.5 left-2 right-2 h-0.5 bg-red-500 rounded-full" />
      )}
      <div className="w-1 h-8 rounded-full shrink-0" style={{ backgroundColor: e.clinicColor }} />
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[11px] shrink-0"
        style={{ backgroundColor: statusColors[e.status], fontWeight: 600 }}
      >
        {e.patientInitials}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] truncate" style={{ fontWeight: 500 }}>{e.patientId}</span>
          {e.safetyActive && <ShieldAlert className="w-3.5 h-3.5 text-red-600 shrink-0" />}
          {e.walkIn && (
            <Badge className="bg-orange-100 text-orange-600 border-0 text-[9px] px-1 h-4">Walk-in</Badge>
          )}
          {e.insuranceVerified && (
            <Badge className="bg-emerald-100 text-emerald-600 border-0 text-[9px] px-1 h-4">Ins&nbsp;&#x2713;</Badge>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground truncate">
          {labelProviderName(e.provider, true)} &middot; {e.visitType} &middot; {e.clinicShortCode || labelClinicName(e.clinicName)}
        </div>
      </div>
      <Badge
        className="text-[10px] px-2 h-5 border-0 shrink-0"
        style={{ backgroundColor: `${statusColors[e.status]}18`, color: statusColors[e.status] }}
      >
        {statusLabels[e.status]}
      </Badge>
      <div className="text-right shrink-0 min-w-[44px]">
        <div
          className="text-[13px] tabular-nums"
          style={{
            fontWeight: 600,
            color: e.alertLevel === "Red" ? "#ef4444" : e.alertLevel === "Yellow" ? "#f59e0b" : "#10b981",
          }}
        >
          {e.minutesInStage}m
        </div>
      </div>
      {isSelected && <ChevronRight className="w-4 h-4 text-indigo-400 shrink-0" />}
    </div>
  );
}

// ── Encounter Workflow Detail Panel ──

function EncounterWorkflowPanel({ encounter: e, onClose }: {
  encounter: Encounter;
  onClose: () => void;
}) {
  const currentStageIdx = stageIndex(e.status);
  const { getCheckoutData } = useEncounters();
  const checkoutData = getCheckoutData(e.id);

  // Build which stages to show: all completed + current in-progress
  const stagesToShow = statusFlowOrder.filter((s) => {
    const idx = stageIndex(s);
    if (s === "Optimized") return false;
    return idx <= currentStageIdx;
  });

  const incoming = getMockIncomingData(e);
  const checkin = currentStageIdx >= stageIndex("Lobby") ? getMockCheckinData(e) : null;
  const rooming = currentStageIdx >= stageIndex("Rooming") ? getMockRoomingData(e) : null;
  const provider = currentStageIdx >= stageIndex("Optimizing") ? getMockProviderData(e) : null;
  const checkout = currentStageIdx >= stageIndex("CheckOut") ? getMockCheckoutData(e) : null;

  // Progress bar
  const totalStages = 6; // Incoming through CheckOut
  const progress = Math.round(((currentStageIdx + 1) / totalStages) * 100);

  return (
    <Card className="border-0 shadow-sm overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-indigo-500 via-purple-500 to-emerald-500" />

      {/* Panel header */}
      <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center text-white text-[13px] shrink-0"
          style={{ backgroundColor: statusColors[e.status], fontWeight: 600 }}
        >
          {e.patientInitials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[15px]" style={{ fontWeight: 600 }}>{e.patientId}</span>
            <Badge className="border-0 text-[10px] h-5" style={{ backgroundColor: `${statusColors[e.status]}15`, color: statusColors[e.status] }}>
              {statusLabels[e.status]}
            </Badge>
            {e.safetyActive && (
              <Badge className="bg-red-100 text-red-700 border-0 text-[9px] h-4 animate-pulse">SAFETY</Badge>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[11px] text-muted-foreground">
            <span>{e.visitType}</span>
            <span className="text-gray-300">|</span>
            <span>{labelProviderName(e.provider, true)}</span>
            <span className="text-gray-300">|</span>
            <span>{labelClinicName(e.clinicName)}</span>
            {e.roomNumber && (
              <span className="contents">
                <span className="text-gray-300">|</span>
                <span>{e.roomNumber}</span>
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

      {/* Progress tracker */}
      <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-3">
        <span className="text-[11px] text-muted-foreground shrink-0" style={{ fontWeight: 500 }}>
          Workflow Progress
        </span>
        <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${progress}%`, background: "linear-gradient(90deg, #6366f1, #8b5cf6, #a855f7, #10b981)" }}
          />
        </div>
        <span className="text-[11px]" style={{ fontWeight: 600, color: statusColors[e.status] }}>
          {progress}%
        </span>
      </div>

      {/* Stage sections */}
      <div className="p-5 space-y-4">
        {/* ── Incoming / Pre-Arrival ── */}
        <WorkflowSection
          stage="Incoming"
          isCurrent={e.status === "Incoming"}
          isCompleted={currentStageIdx > stageIndex("Incoming")}
        >
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-5 gap-y-2.5">
            <DataField label="Patient ID" value={incoming.patientId} />
            <DataField label="Visit Type" value={incoming.visitType} />
            <DataField label="Provider" value={incoming.provider} />
            <DataField label="Clinic" value={incoming.clinic} />
            <DataField label="Scheduled Time" value={incoming.scheduledTime} />
            <DataField label="Insurance on File" value={incoming.insuranceOnFile ? "Yes" : "No"} ok={incoming.insuranceOnFile} />
            <DataField label="Walk-In" value={incoming.walkIn ? "Yes" : "No"} />
            <DataField label="Pre-Visit Forms" value={incoming.preVisitFormsCompleted ? "Completed" : "Pending"} ok={incoming.preVisitFormsCompleted} />
            <DataField label="Preferred Pharmacy" value={incoming.preferredPharmacy} />
            <DataField label="Emergency Contact" value={incoming.emergencyContactOnFile ? "On file" : "Missing"} ok={incoming.emergencyContactOnFile} />
          </div>
          {e.status === "Incoming" && (
            <div className="mt-3 rounded-lg bg-slate-50 border border-slate-200 px-3.5 py-2.5 text-[11px] text-slate-600 flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span>These fields will auto-populate the Check-In form when the patient arrives.</span>
            </div>
          )}
        </WorkflowSection>

        {/* ── Check-In ── */}
        {checkin && (
          <WorkflowSection
            stage="Lobby"
            isCurrent={e.status === "Lobby"}
            isCompleted={currentStageIdx > stageIndex("Lobby")}
          >
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-5 gap-y-2.5">
              <DataField label="Demographics Confirmed" value={checkin.demographicsConfirmed ? "Yes" : "No"} ok={checkin.demographicsConfirmed} />
              <DataField label="Insurance Card Scanned" value={checkin.insuranceCardScanned ? "Yes" : "No"} ok={checkin.insuranceCardScanned} />
              <DataField label="Copay Collected" value={checkin.copayCollected ? checkin.copayAmount : "No"} ok={checkin.copayCollected} />
              <DataField label="Consent Forms" value={checkin.consentFormsSigned ? "Signed" : "Pending"} ok={checkin.consentFormsSigned} />
              <DataField label="Checked In At" value={checkin.checkedInAt} />
              <DataField label="Checked In By" value={checkin.checkedInBy} />
            </div>
            {checkin.chiefComplaint && (
              <div className="mt-3">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider" style={{ fontWeight: 500 }}>Chief Complaint</span>
                <p className="text-[12px] text-gray-700 mt-0.5 bg-white rounded-lg border border-gray-100 px-3 py-2">{checkin.chiefComplaint}</p>
              </div>
            )}
            {checkin.arrivalNotes && (
              <div className="mt-2">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider" style={{ fontWeight: 500 }}>Arrival Notes</span>
                <p className="text-[12px] text-gray-700 mt-0.5">{checkin.arrivalNotes}</p>
              </div>
            )}
          </WorkflowSection>
        )}

        {/* ── Rooming / MA ── */}
        {rooming && (
          <WorkflowSection
            stage="Rooming"
            isCurrent={e.status === "Rooming"}
            isCompleted={currentStageIdx > stageIndex("Rooming")}
          >
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-5 gap-y-2.5 mb-3">
              <DataField label="Room" value={rooming.roomAssigned} />
              <DataField label="Assigned MA" value={rooming.assignedMA} />
            </div>
            {/* Vitals grid */}
            <div className="rounded-lg border border-purple-100 bg-purple-50/30 p-3.5">
              <div className="flex items-center gap-2 mb-2.5">
                <Heart className="w-3.5 h-3.5 text-purple-500" />
                <span className="text-[11px] uppercase tracking-wider" style={{ fontWeight: 600, color: "#8b5cf6" }}>Vitals</span>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2.5">
                <VitalChip label="BP" value={rooming.bloodPressure} icon={Gauge} />
                <VitalChip label="HR" value={rooming.heartRate} icon={Heart} />
                <VitalChip label="Temp" value={rooming.temperature} icon={Thermometer} />
                <VitalChip label="Weight" value={rooming.weight} icon={User} />
                <VitalChip label="SpO2" value={rooming.o2Saturation} icon={Activity} />
                <VitalChip label="Pain" value={rooming.painLevel} icon={AlertTriangle} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-5 gap-y-2.5 mt-3">
              <DataField label="Allergies Reviewed" value={rooming.allergiesReviewed ? "Yes" : "No"} ok={rooming.allergiesReviewed} />
              <DataField label="Meds Reconciled" value={rooming.medicationsReconciled ? "Yes" : "No"} ok={rooming.medicationsReconciled} />
            </div>
            {rooming.chiefComplaintExpanded && rooming.chiefComplaintExpanded !== "See visit type" && (
              <div className="mt-3">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider" style={{ fontWeight: 500 }}>Chief Complaint (Expanded)</span>
                <p className="text-[12px] text-gray-700 mt-0.5 bg-white rounded-lg border border-gray-100 px-3 py-2">{rooming.chiefComplaintExpanded}</p>
              </div>
            )}
          </WorkflowSection>
        )}

        {/* ── Ready for Provider (handoff note) ── */}
        {currentStageIdx >= stageIndex("ReadyForProvider") && (
          <WorkflowSection
            stage="ReadyForProvider"
            isCurrent={e.status === "ReadyForProvider"}
            isCompleted={currentStageIdx > stageIndex("ReadyForProvider")}
          >
            <div className="rounded-lg bg-amber-50/50 border border-amber-100 p-3.5">
              <div className="flex items-center gap-2 mb-2">
                <Stethoscope className="w-3.5 h-3.5 text-amber-600" />
                <span className="text-[11px] uppercase tracking-wider" style={{ fontWeight: 600, color: "#d97706" }}>MA Handoff</span>
              </div>
              <p className="text-[12px] text-gray-700">
                Patient roomed and vitals complete. {e.visitType === "Sick Visit" ? "Presenting with URI symptoms — 3 days duration." : e.visitType === "Follow-up" ? "Here for lab follow-up. Lipid panel and A1c results ready." : "Ready for provider evaluation."}
              </p>
            </div>
            {e.status === "ReadyForProvider" && (
              <p className="text-[11px] text-amber-600 mt-2 flex items-center gap-1.5">
                <Clock className="w-3 h-3" />
                Waiting for provider — {e.minutesInStage}m elapsed
              </p>
            )}
          </WorkflowSection>
        )}

        {/* ── Provider Visit ── */}
        {provider && (
          <WorkflowSection
            stage="Optimizing"
            isCurrent={e.status === "Optimizing"}
            isCompleted={currentStageIdx > stageIndex("Optimizing")}
          >
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-5 gap-y-2.5">
              <DataField label="Visit Started" value={provider.visitStarted} />
              <DataField label="Orders Entered" value={String(provider.ordersEntered)} />
              <DataField label="Referrals Made" value={String(provider.referralsMade)} />
            </div>
            {provider.assessmentPreview && (
              <div className="mt-3">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider" style={{ fontWeight: 500 }}>Assessment Preview</span>
                <p className="text-[12px] text-gray-700 mt-0.5 bg-white rounded-lg border border-gray-100 px-3 py-2">{provider.assessmentPreview}</p>
              </div>
            )}
            {e.status === "Optimizing" && (
              <p className="text-[11px] text-purple-600 mt-2 flex items-center gap-1.5">
                <Activity className="w-3 h-3" />
                Visit in progress — {e.minutesInStage}m elapsed
              </p>
            )}
          </WorkflowSection>
        )}

        {/* ── Check-Out ── */}
        {checkout && (
          <WorkflowSection
            stage="CheckOut"
            isCurrent={e.status === "CheckOut"}
            isCompleted={false}
          >
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-5 gap-y-2.5">
              <DataField label="Follow-Up Scheduled" value={checkout.followUpScheduled ? checkout.followUpInterval : "No"} ok={checkout.followUpScheduled} />
              <DataField label="Visit Summary Printed" value={checkout.visitSummaryPrinted ? "Yes" : "Pending"} ok={checkout.visitSummaryPrinted} />
              <DataField label="Referrals Processed" value={checkout.referralsProcessed ? "Yes" : "N/A"} />
              <DataField label="Billing Codes Verified" value={checkout.billingCodesVerified ? "Yes" : "Pending"} ok={checkout.billingCodesVerified} />
              <DataField label="Prescriptions Sent" value={checkout.prescriptionsSent ? "Yes" : "N/A"} />
            </div>
            {checkoutData && (
              <div className="mt-3 rounded-lg bg-emerald-50/50 border border-emerald-200 p-3">
                <div className="flex items-center gap-2 mb-1">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                  <span className="text-[11px] text-emerald-700" style={{ fontWeight: 600 }}>Checkout Completed</span>
                  <span className="text-[10px] text-emerald-600 ml-auto">{checkoutData.completedAt}</span>
                </div>
                <p className="text-[11px] text-emerald-700">
                  {checkoutData.checkedItems.length} checklist items completed, {Object.keys(checkoutData.templateValues).length} template fields recorded.
                </p>
              </div>
            )}
            {e.status === "CheckOut" && !checkoutData && (
              <p className="text-[11px] text-emerald-600 mt-2 flex items-center gap-1.5">
                <CreditCard className="w-3 h-3" />
                Checkout in progress — {e.minutesInStage}m elapsed
              </p>
            )}
          </WorkflowSection>
        )}
      </div>
    </Card>
  );
}

// ── Workflow Section wrapper ──

function WorkflowSection({ stage, isCurrent, isCompleted, children }: {
  stage: EncounterStatus;
  isCurrent: boolean;
  isCompleted: boolean;
  children: React.ReactNode;
}) {
  const config = stageConfig[stage];
  if (!config) return null;
  const StIcon = config.icon;

  return (
    <div className={`rounded-xl border p-4 transition-all ${
      isCurrent
        ? "border-2 bg-white shadow-sm"
        : isCompleted
        ? "border-gray-100 bg-gray-50/40"
        : "border-gray-100 bg-white"
    }`}
    style={isCurrent ? { borderColor: `${config.color}60` } : undefined}
    >
      <div className="flex items-center gap-2.5 mb-3">
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: `${config.color}15` }}
        >
          <StIcon className="w-3.5 h-3.5" style={{ color: config.color }} />
        </div>
        <span className="text-[13px]" style={{ fontWeight: 600 }}>{config.label}</span>
        {isCompleted && (
          <Badge className="bg-emerald-100 text-emerald-700 border-0 text-[9px] h-4 px-1.5 ml-auto">
            <CheckCircle2 className="w-2.5 h-2.5 mr-0.5" /> Complete
          </Badge>
        )}
        {isCurrent && (
          <Badge className="border-0 text-[9px] h-4 px-1.5 ml-auto animate-pulse" style={{ backgroundColor: `${config.color}15`, color: config.color }}>
            In Progress
          </Badge>
        )}
      </div>
      {children}
    </div>
  );
}

// ── Data Field (key/value pair) ──

function DataField({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div>
      <span className="text-[9px] text-muted-foreground uppercase tracking-wider block" style={{ fontWeight: 500 }}>{label}</span>
      <div className="flex items-center gap-1.5 mt-0.5">
        {ok !== undefined && (
          <div className={`w-3 h-3 rounded-full flex items-center justify-center shrink-0 ${ok ? "bg-emerald-100" : "bg-amber-100"}`}>
            {ok ? (
              <CheckCircle2 className="w-2 h-2 text-emerald-600" />
            ) : (
              <Clock className="w-2 h-2 text-amber-500" />
            )}
          </div>
        )}
        <span className="text-[12px] text-gray-700" style={{ fontWeight: 500 }}>{value}</span>
      </div>
    </div>
  );
}

// ── Vital Chip ──

function VitalChip({ label, value, icon: Icon }: { label: string; value: string; icon: React.ElementType }) {
  return (
    <div className="rounded-lg bg-white border border-purple-100 px-2.5 py-2 text-center">
      <Icon className="w-3 h-3 text-purple-400 mx-auto mb-1" />
      <div className="text-[12px] text-gray-700" style={{ fontWeight: 600 }}>{value}</div>
      <div className="text-[9px] text-muted-foreground uppercase tracking-wider">{label}</div>
    </div>
  );
}

// ── SLA Donut ──
function SlaDonut({ stageMetrics }: { stageMetrics: StageMetricRow[] }) {
  const avgSla = Math.round(stageMetrics.reduce((sum, m) => sum + m.slaCompliance, 0) / stageMetrics.length);
  const data = [
    { name: "Compliant", value: avgSla },
    { name: "Non-compliant", value: 100 - avgSla },
  ];

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-0 pt-5 px-5">
        <CardTitle className="text-[14px] flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          Overall SLA
        </CardTitle>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        <div className="flex items-center justify-center relative h-[140px]">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={data} cx="50%" cy="50%" innerRadius={44} outerRadius={60} startAngle={90} endAngle={-270} dataKey="value" strokeWidth={0}>
                <Cell fill="#10b981" />
                <Cell fill="#f1f5f9" />
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[26px]" style={{ fontWeight: 700, lineHeight: 1 }}>{avgSla}%</span>
            <span className="text-[11px] text-muted-foreground mt-1">Compliance</span>
          </div>
        </div>
        <div className="space-y-1.5 mt-1">
          {stageMetrics.map((m) => (
            <div key={m.stage} className="flex items-center justify-between text-[11px]">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: m.color }} />
                <span className="text-muted-foreground">{m.stage}</span>
              </div>
              <span style={{ fontWeight: 500, color: m.slaCompliance >= 90 ? "#10b981" : m.slaCompliance >= 80 ? "#f59e0b" : "#ef4444" }}>
                {m.slaCompliance}%
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main Dashboard ──
export function OfficeManagerDashboard() {
  const [selectedClinic, setSelectedClinic] = useState("all");
  const { encounters } = useEncounters();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [clinics, setClinics] = useState<Array<{ id: string; name: string; shortCode?: string; color: string }>>([]);
  const [providers, setProviders] = useState<Array<{ id: string; name: string; specialty?: string; clinicId?: string; active: boolean }>>([]);
  const [rooms, setRooms] = useState<Array<{ id: string; clinicIds: string[]; name: string; active: boolean; sortOrder?: number }>>([]);
  const [thresholdRows, setThresholdRows] = useState<Array<{
    clinicId?: string | null;
    metric?: string;
    status?: string | null;
    yellowAtMin?: number;
    redAtMin?: number;
  }>>([]);
  const [lastSync, setLastSync] = useState("--:--:--");

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const facilityId = loadSession()?.facilityId;
        const [clinicRows, assignmentRows, roomRows, thresholdApiRows] = await Promise.all([
          admin.listClinics({ facilityId }),
          admin.listAssignments(facilityId),
          admin.listRooms({ facilityId }),
          admin.listThresholds(facilityId),
        ]);
        if (!active) return;

        setClinics(
          (clinicRows as any[]).map((clinic) => ({
            id: clinic.id,
            name: labelClinicName(clinic.name, clinic.status),
            shortCode: clinic.shortCode,
            color: clinic.cardColor || colorFromText(clinic.name || clinic.id),
          })),
        );

        setProviders(
          (assignmentRows as any[])
            .filter((assignment) => String(assignment.providerUserName || "").trim().length > 0)
            .map((assignment) => ({
              id: String(assignment.providerUserId || assignment.providerUserName),
              name: labelUserName(
                String(assignment.providerUserName || ""),
                String(assignment.providerUserStatus || ""),
              ),
              specialty: "General Medicine",
              clinicId: assignment.clinicId ? String(assignment.clinicId) : undefined,
              active: assignment.providerUserStatus === "active",
            })),
        );

        setRooms(
          (roomRows as any[]).map((room) => ({
            id: room.id,
            clinicIds: Array.isArray(room.clinicIds)
              ? room.clinicIds
              : room.clinicId
              ? [room.clinicId]
              : [],
            name: labelRoomName(room.name, room.status || (room.active === false ? "inactive" : "active")),
            active: room.status ? room.status === "active" : room.active !== false,
            sortOrder: room.roomNumber ?? room.sortOrder ?? 0,
          })),
        );
        setThresholdRows(Array.isArray(thresholdApiRows) ? (thresholdApiRows as any[]) : []);
        setLastSync(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      } catch {
        // EncounterContext still provides live encounter data as the primary source.
      }
    };

    load().catch(() => undefined);
    const interval = setInterval(() => {
      load().catch(() => undefined);
    }, 30000);
    const onRefresh = () => {
      load().catch(() => undefined);
    };
    if (typeof window !== "undefined") {
      window.addEventListener(ADMIN_REFRESH_EVENT, onRefresh);
      window.addEventListener(FACILITY_CONTEXT_CHANGED_EVENT, onRefresh);
    }

    return () => {
      active = false;
      clearInterval(interval);
      if (typeof window !== "undefined") {
        window.removeEventListener(ADMIN_REFRESH_EVENT, onRefresh);
        window.removeEventListener(FACILITY_CONTEXT_CHANGED_EVENT, onRefresh);
      }
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 15000);
    return () => clearInterval(interval);
  }, []);

  const clinicOptions = useMemo(() => {
    if (clinics.length > 0) return clinics;
    const seen = new Map<string, { id: string; name: string; shortCode?: string; color: string }>();
    encounters.forEach((encounter) => {
      if (!seen.has(encounter.clinicId)) {
        seen.set(encounter.clinicId, {
          id: encounter.clinicId,
          name: labelClinicName(encounter.clinicName),
          shortCode: encounter.clinicShortCode,
          color: encounter.clinicColor,
        });
      }
    });
    return Array.from(seen.values());
  }, [clinics, encounters]);

  const scopedEncounters = useMemo(
    () =>
      selectedClinic === "all"
        ? encounters
        : encounters.filter((encounter) => encounter.clinicId === selectedClinic),
    [encounters, selectedClinic],
  );

  const timedScopedEncounters = useMemo(
    () =>
      scopedEncounters.map((encounter) => ({
        ...encounter,
        minutesInStage: liveStageMinutes(encounter, nowMs),
      })),
    [nowMs, scopedEncounters],
  );

  const stageTargetByStatus = useMemo(() => {
    const monitored: EncounterStatus[] = ["Lobby", "Rooming", "ReadyForProvider", "Optimizing", "CheckOut"];
    const map: Partial<Record<EncounterStatus, number>> = {
      Lobby: fallbackStageTargets.Lobby,
      Rooming: fallbackStageTargets.Rooming,
      ReadyForProvider: fallbackStageTargets.ReadyForProvider,
      Optimizing: fallbackStageTargets.Optimizing,
      CheckOut: fallbackStageTargets.CheckOut,
    };

    monitored.forEach((status) => {
      const statusRows = thresholdRows.filter(
        (row) => String(row.metric || "stage") === "stage" && String(row.status || "") === status,
      );
      const clinicOverride =
        selectedClinic !== "all"
          ? statusRows.find((row) => String(row.clinicId || "") === selectedClinic)
          : null;
      const facilityDefault = statusRows.find((row) => !row.clinicId);
      const effective = clinicOverride || facilityDefault;
      if (effective && Number.isFinite(Number(effective.yellowAtMin))) {
        map[status] = Number(effective.yellowAtMin);
      }
    });

    return map as Record<EncounterStatus, number>;
  }, [selectedClinic, thresholdRows]);

  const stageMetrics = useMemo<StageMetricRow[]>(() => {
    const monitored: EncounterStatus[] = ["Lobby", "Rooming", "ReadyForProvider", "Optimizing", "CheckOut"];
    return monitored.map((status) => {
      const rows = timedScopedEncounters.filter((encounter) => encounter.status === status);
      const target = stageTargetByStatus[status] || fallbackStageTargets[status];
      const average = rows.length === 0 ? 0 : Math.round(rows.reduce((sum, row) => sum + row.minutesInStage, 0) / rows.length);
      const compliant =
        rows.length === 0
          ? 100
          : Math.round((rows.filter((row) => row.minutesInStage <= target).length / rows.length) * 100);
      return {
        stage: stageLabelForMetric(status),
        avgMinutes: average,
        target,
        count: rows.length,
        slaCompliance: compliant,
        color: stagePalette[status],
      };
    });
  }, [stageTargetByStatus, timedScopedEncounters]);

  const hourlyVolume = useMemo<HourlyVolumePoint[]>(() => {
    const baseHour = 7;
    const buckets = Array.from({ length: 10 }, (_, index) => baseHour + index);
    return buckets.map((hour) => {
      const inBucket = timedScopedEncounters.filter((encounter) => {
        const [hourStr] = encounter.checkinTime.split(":");
        const parsed = Number(hourStr);
        return Number.isFinite(parsed) && parsed === hour;
      });
      return {
        hour: formatHourLabel(hour),
        checkins: inBucket.length,
        completed: inBucket.filter((encounter) => encounter.status === "Optimized").length,
        inProgress: inBucket.filter((encounter) => encounter.status !== "Optimized").length,
      };
    });
  }, [timedScopedEncounters]);

  const alerts = useMemo<AlertRow[]>(() => {
    const mapped: AlertRow[] = [];
    timedScopedEncounters.forEach((encounter) => {
      if (encounter.safetyActive) {
        mapped.push({
          id: `safety-${encounter.id}`,
          type: "safety",
          message: `Safety Assist active for ${encounter.patientId} (${encounter.clinicShortCode})`,
          encounterId: encounter.id,
          timestamp: encounter.currentStageStart || encounter.checkinTime,
          acknowledged: false,
        });
        return;
      }
      if (encounter.alertLevel === "Red" || encounter.alertLevel === "Yellow") {
        mapped.push({
          id: `alert-${encounter.id}`,
          type: encounter.alertLevel,
          message: `${encounter.patientId} in ${statusLabels[encounter.status]} for ${encounter.minutesInStage}m`,
          encounterId: encounter.id,
          timestamp: encounter.currentStageStart || encounter.checkinTime,
          acknowledged: false,
        });
      }
    });
    return mapped.sort((a, b) => {
      const priority: Record<AlertRow["type"], number> = { safety: 0, Red: 1, Yellow: 2 };
      return priority[a.type] - priority[b.type];
    });
  }, [timedScopedEncounters]);

  const roomCensus = useMemo<RoomCensusRow[]>(() => {
    const encounterByRoom = new Map<string, Encounter>();
    timedScopedEncounters
      .filter((encounter) => encounter.roomNumber && encounter.status !== "Optimized")
      .forEach((encounter) => {
        if (encounter.roomNumber && !encounterByRoom.has(encounter.roomNumber)) {
          encounterByRoom.set(encounter.roomNumber, encounter);
        }
      });

    if (rooms.length === 0) {
      return Array.from(encounterByRoom.entries()).map(([roomName, encounter], index) => ({
        id: `derived-room-${index + 1}`,
        clinicId: encounter.clinicId,
        clinicName: labelClinicName(encounter.clinicName),
        name: roomName,
        active: true,
        occupied: true,
        encounterId: encounter.id,
        patientId: encounter.patientId,
        status: encounter.status,
        providerName: labelProviderName(encounter.provider, true),
        assignedMaName: labelUserName(encounter.assignedMA),
        alertLevel: encounter.alertLevel,
        safetyActive: Boolean(encounter.safetyActive),
      }));
    }

    const clinicById = new Map(clinicOptions.map((clinic) => [clinic.id, clinic]));
    return rooms
      .filter((room) => selectedClinic === "all" || room.clinicIds.includes(selectedClinic))
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
      .map((room) => {
        const encounter = encounterByRoom.get(room.name);
        const clinicId =
          selectedClinic !== "all"
            ? selectedClinic
            : room.clinicIds[0] || encounter?.clinicId || "";
        return {
          id: room.id,
          clinicId,
          clinicName: labelClinicName(encounter?.clinicName || clinicById.get(clinicId)?.name || "Clinic"),
          name: room.name,
          active: room.active,
          occupied: Boolean(encounter),
          encounterId: encounter?.id,
          patientId: encounter?.patientId,
          status: encounter?.status,
          providerName: labelProviderName(encounter?.provider, true),
          assignedMaName: labelUserName(encounter?.assignedMA),
          alertLevel: encounter?.alertLevel,
          safetyActive: Boolean(encounter?.safetyActive),
        };
      });
  }, [clinicOptions, rooms, timedScopedEncounters, selectedClinic]);

  const providerCards = useMemo<ProviderCardRow[]>(() => {
    const grouped = new Map<string, { id: string; name: string; specialty: string; clinicIds: Set<string>; active: boolean }>();

    providers.forEach((provider) => {
      const key = provider.name.toLowerCase();
      if (!grouped.has(key)) {
        grouped.set(key, {
          id: provider.id,
          name: provider.name,
          specialty: provider.specialty || "General Medicine",
          clinicIds: new Set(provider.clinicId ? [provider.clinicId] : []),
          active: provider.active,
        });
      } else {
        const current = grouped.get(key)!;
        if (provider.clinicId) current.clinicIds.add(provider.clinicId);
        current.active = current.active || provider.active;
      }
    });

    if (grouped.size === 0) {
      timedScopedEncounters.forEach((encounter) => {
        const key = encounter.provider.toLowerCase();
        if (!grouped.has(key)) {
          grouped.set(key, {
            id: key,
            name: encounter.provider,
            specialty: "General Medicine",
            clinicIds: new Set([encounter.clinicId]),
            active: true,
          });
        } else {
          grouped.get(key)!.clinicIds.add(encounter.clinicId);
        }
      });
    }

    return Array.from(grouped.values())
      .map((provider) => {
        const activeEncounters = timedScopedEncounters.filter(
          (encounter) => encounter.provider === provider.name && encounter.status !== "Optimized",
        ).length;
        const completedToday = timedScopedEncounters.filter(
          (encounter) => encounter.provider === provider.name && encounter.status === "Optimized",
        ).length;
        const providerRows = timedScopedEncounters.filter((encounter) => encounter.provider === provider.name);
        const avgCycleTime =
          providerRows.length === 0
            ? 0
            : Math.round(providerRows.reduce((sum, encounter) => sum + encounter.minutesInStage, 0) / providerRows.length);
        const utilization = Math.min(100, Math.max(8, Math.round(((activeEncounters * 2) + completedToday) / 8 * 100)));
        return {
          name: provider.name,
          initials: initials(provider.name),
          specialty: provider.specialty,
          activeEncounters,
          completedToday,
          avgCycleTime,
          utilization,
          avatarColor: colorFromText(provider.name),
        };
      })
      .sort((a, b) => b.activeEncounters + b.completedToday - (a.activeEncounters + a.completedToday));
  }, [providers, timedScopedEncounters]);

  const totalActive = timedScopedEncounters.filter((encounter) => encounter.status !== "Optimized").length;
  const totalCompleted = timedScopedEncounters.filter((encounter) => encounter.status === "Optimized").length;
  const yellowAlerts = alerts.filter((alert) => alert.type === "Yellow" && !alert.acknowledged).length;
  const redAlerts = alerts.filter((alert) => (alert.type === "Red" || alert.type === "safety") && !alert.acknowledged).length;
  const avgCycleTime = stageMetrics.find((metric) => metric.stage === "Optimizing")?.avgMinutes || 0;

  return (
    <div className="p-6 space-y-6 max-w-[1440px] mx-auto">
      {/* Connection banner */}
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-[12px] text-emerald-700">
        <Wifi className="w-3.5 h-3.5" />
        <span style={{ fontWeight: 500 }}>Connected</span>
        <span className="text-emerald-600/70">
          &middot; Real-time updates active &middot; Last sync: {lastSync}
        </span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[22px] tracking-tight" style={{ fontWeight: 700 }}>Office Manager</h1>
          <p className="text-[13px] text-muted-foreground mt-0.5">
            Real-time overview of patient flow and clinic operations
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Clinic filter */}
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-muted-foreground" />
            <select
              value={selectedClinic}
              onChange={(e) => setSelectedClinic(e.target.value)}
              className="h-8 px-3 rounded-lg border border-gray-200 bg-white text-[12px] focus:outline-none focus:border-indigo-300"
            >
              <option value="all">All Clinics</option>
              {clinicOptions.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-[12px] text-emerald-700" style={{ fontWeight: 500 }}>Live</span>
          </div>
        </div>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard icon={Users} label="Active Encounters" value={totalActive} subtext="patients in flow" trend="+3 from this time yesterday" trendDir="up" color="#6366f1" />
        <KpiCard icon={CheckCircle2} label="Completed Today" value={totalCompleted} subtext="encounters optimized" trend="On pace for 24 total" trendDir="up" color="#10b981" />
        <KpiCard icon={Clock} label="Avg Cycle Time" value={`${avgCycleTime}m`} subtext="target: 50m" trend="4m faster than avg" trendDir="up" color="#8b5cf6" />
        <KpiCard icon={AlertTriangle} label="Active Alerts" value={yellowAlerts + redAlerts} subtext={`${redAlerts} critical, ${yellowAlerts} warning`} trend={redAlerts > 0 ? "Requires attention" : "All under control"} trendDir={redAlerts > 0 ? "down" : "up"} color={redAlerts > 0 ? "#ef4444" : "#f59e0b"} />
      </div>

      {/* Pipeline */}
          <FlowPipeline encounters={timedScopedEncounters} />

      {/* Main content grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <HourlyVolumeChart hourlyVolume={hourlyVolume} />
            <StagePerformance stageMetrics={stageMetrics} />
          </div>
          <LiveEncounterFeed encounters={timedScopedEncounters} />
        </div>
        <div className="space-y-4">
          <SlaDonut stageMetrics={stageMetrics} />
          <RoomCensus rooms={roomCensus} />
          <ProviderUtilization providers={providerCards} />
          <AlertsPanel alerts={alerts} />
        </div>
      </div>
    </div>
  );
}
