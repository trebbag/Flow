import { useEffect, useState, useMemo } from "react";
import { toast } from "sonner";
import {
  Moon,
  Clock,
  AlertTriangle,
  CheckCircle2,
  ShieldAlert,
  Users,
  DoorOpen,
  Building2,
  ArrowRight,
  ChevronDown,
  Search,
  X,
  Filter,
  RotateCcw,
  Activity,
  Play,
  Square,
  Eye,
  Flag,
  XCircle,
  ArrowUpRight,
  Stethoscope,
  BarChart3,
  Send,
  FileWarning,
} from "lucide-react";
import { Card, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import {
  closeoutRows,
  statusLabels,
  statusColors,
  clinics,
  rooms,
  type EncounterStatus,
  type Encounter,
  type AlertLevel,
  type CloseoutRow,
} from "./mock-data";
import { useEncounters } from "./encounter-context";
import { compactClinicBadgeLabel } from "./display-names";
import { rooms as roomsApi, type RoomLiveCard } from "./api-client";
import { dispatchAdminRefresh } from "./app-events";

function msToMinutes(ms: number): number {
  return Math.round(ms / 60000);
}

function alertBadge(level: AlertLevel) {
  switch (level) {
    case "Red":
      return "bg-red-100 text-red-700";
    case "Yellow":
      return "bg-amber-100 text-amber-700";
    default:
      return "bg-emerald-100 text-emerald-700";
  }
}

function statusOrder(s: EncounterStatus): number {
  const order: Record<EncounterStatus, number> = {
    Incoming: 0,
    Lobby: 1,
    Rooming: 2,
    ReadyForProvider: 3,
    Optimizing: 4,
    CheckOut: 5,
    Optimized: 6,
  };
  return order[s] ?? 99;
}

function csvCell(value: unknown) {
  const raw = String(value ?? "");
  if (raw.includes(",") || raw.includes("\"") || raw.includes("\n")) {
    return `"${raw.replace(/"/g, "\"\"")}"`;
  }
  return raw;
}

function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function CloseoutView() {
  const { encounters } = useEncounters();
  const [roomCards, setRoomCards] = useState<RoomLiveCard[]>([]);
  const [roomLoading, setRoomLoading] = useState(false);
  const [roomBusyId, setRoomBusyId] = useState<string | null>(null);

  const activeEncounters = encounters.filter(
    (e) => e.status !== "Optimized" && e.status !== "Incoming"
  );

  const extendedCloseoutRows: CloseoutRow[] = useMemo(() => [
    ...closeoutRows,
    ...activeEncounters
      .filter((e) => !closeoutRows.find((cr) => cr.encounterId === e.id))
      .map((e) => ({
        encounterId: e.id,
        patientId: e.patientId,
        clinicName: e.clinicName,
        clinicColor: e.clinicColor,
        currentStatus: e.status,
        version: e.version,
        providerName: e.provider,
        assignedMaName: e.assignedMA || null,
        roomName: e.roomNumber || null,
        alertLevel: e.alertLevel,
        enteredStatusAt: e.currentStageStart,
        statusElapsedMs: e.minutesInStage * 60000,
        safetyActive: e.safetyActive || false,
      })),
  ], [activeEncounters]);

  const optimizedToday = encounters.filter(
    (e) => e.status === "Optimized"
  ).length;

  const [search, setSearch] = useState("");
  const [clinicFilter, setClinicFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [alertFilter, setAlertFilter] = useState("all");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [forceCloseDialog, setForceCloseDialog] = useState<string | null>(null);

  const loadRooms = async () => {
    setRoomLoading(true);
    try {
      setRoomCards(await roomsApi.live({ mine: true }));
    } catch {
      setRoomCards([]);
    } finally {
      setRoomLoading(false);
    }
  };

  useEffect(() => {
    loadRooms().catch(() => undefined);
  }, []);

  const dayEndIncompleteRooms = roomCards.filter((room) => !room.dayEndCompleted);
  const unresolvedRoomStateRooms = roomCards.filter((room) =>
    ["NeedsTurnover", "Occupied", "Hold", "NotReady"].includes(room.operationalStatus)
  );

  async function completeRoomDayEnd(room: RoomLiveCard) {
    setRoomBusyId(room.id);
    try {
      await roomsApi.submitChecklist("DayEnd", {
        roomId: room.roomId,
        clinicId: room.clinicId,
        completed: true,
        items: [
          { key: "no_turnover", label: "No room left in turnover or occupied", completed: true },
          { key: "issues_handled", label: "Open issues acknowledged or placed on hold", completed: true },
          { key: "tasks_created", label: "Office manager follow-up tasks created", completed: true },
          { key: "reset", label: "Room reset for tomorrow", completed: true },
        ],
      });
      toast.success(`Day End completed for ${room.name}`);
      dispatchAdminRefresh();
      await loadRooms();
    } catch (error) {
      toast.error("Room Day End failed", { description: (error as Error).message });
    } finally {
      setRoomBusyId(null);
    }
  }

  const filtered = useMemo(() => {
    return extendedCloseoutRows
      .filter((r) => {
        if (search) {
          const s = search.toLowerCase();
          if (
            !r.encounterId.toLowerCase().includes(s) &&
            !r.patientId.toLowerCase().includes(s) &&
            !r.providerName.toLowerCase().includes(s)
          )
            return false;
        }
        if (clinicFilter !== "all" && r.clinicName !== clinicFilter)
          return false;
        if (statusFilter !== "all" && r.currentStatus !== statusFilter)
          return false;
        if (alertFilter !== "all" && r.alertLevel !== alertFilter)
          return false;
        return true;
      })
      .sort((a, b) => {
        // Safety first, then by alert level, then by status
        if (a.safetyActive !== b.safetyActive)
          return a.safetyActive ? -1 : 1;
        const alertOrder = { Red: 0, Yellow: 1, Green: 2 };
        const aAlert = alertOrder[a.alertLevel] ?? 2;
        const bAlert = alertOrder[b.alertLevel] ?? 2;
        if (aAlert !== bAlert) return aAlert - bAlert;
        return statusOrder(a.currentStatus) - statusOrder(b.currentStatus);
      });
  }, [search, clinicFilter, statusFilter, alertFilter]);

  const stats = useMemo(() => {
    const total = extendedCloseoutRows.length;
    const safetyCount = extendedCloseoutRows.filter(
      (r) => r.safetyActive
    ).length;
    const redCount = extendedCloseoutRows.filter(
      (r) => r.alertLevel === "Red"
    ).length;
    const yellowCount = extendedCloseoutRows.filter(
      (r) => r.alertLevel === "Yellow"
    ).length;
    const inRoom = extendedCloseoutRows.filter((r) => r.roomName).length;
    return { total, safetyCount, redCount, yellowCount, inRoom };
  }, []);

  const statusBreakdown = useMemo(() => {
    const counts: Partial<Record<EncounterStatus, number>> = {};
    extendedCloseoutRows.forEach((r) => {
      counts[r.currentStatus] = (counts[r.currentStatus] || 0) + 1;
    });
    return counts;
  }, []);

  const uniqueStatuses = [
    ...new Set(extendedCloseoutRows.map((r) => r.currentStatus)),
  ];

  return (
    <TooltipProvider>
      <div className="p-4 sm:p-6 space-y-6 max-w-[1200px] mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-slate-700 to-slate-900 flex items-center justify-center">
              <Moon className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1
                className="text-[20px] tracking-tight"
                style={{ fontWeight: 700 }}
              >
                End-of-Day Closeout
              </h1>
              <p className="text-[12px] text-muted-foreground">
                Review and resolve all open encounters before closing the day
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                const now = new Date();
                const dateLabel = now.toISOString().slice(0, 10);
                const rows: string[][] = [
                  [
                    "Encounter ID",
                    "Patient ID",
                    "Clinic",
                    "Provider",
                    "MA",
                    "Room",
                    "Status",
                    "Alert Level",
                    "Safety Active",
                    "Minutes In Status",
                    "Entered Status At",
                  ],
                  ...extendedCloseoutRows.map((row) => [
                    row.encounterId,
                    row.patientId,
                    row.clinicName,
                    row.providerName || "",
                    row.assignedMaName || "",
                    row.roomName || "",
                    row.currentStatus,
                    row.alertLevel,
                    row.safetyActive ? "Yes" : "No",
                    String(msToMinutes(row.statusElapsedMs || 0)),
                    row.enteredStatusAt || "",
                  ]),
                ];
                downloadCsv(`closeout-report-${dateLabel}.csv`, rows);
                toast.success("End-of-day report exported");
              }}
              className="h-9 px-4 rounded-lg border border-gray-200 text-[12px] text-gray-600 hover:bg-gray-50 transition-colors flex items-center gap-1.5"
              style={{ fontWeight: 500 }}
            >
              <BarChart3 className="w-3.5 h-3.5" /> Generate Report
            </button>
            <button
              onClick={() => {
                if (stats.total === 0 && dayEndIncompleteRooms.length === 0 && unresolvedRoomStateRooms.length === 0) {
                  toast.success("Day closed successfully!");
                } else {
                  toast.warning("Closeout blockers remain", {
                    description: `${stats.total} encounters open, ${dayEndIncompleteRooms.length} room Day End incomplete, ${unresolvedRoomStateRooms.length} room state issue${unresolvedRoomStateRooms.length === 1 ? "" : "s"}.`,
                  });
                }
              }}
              className={`h-9 px-4 rounded-lg text-[12px] transition-colors flex items-center gap-1.5 ${
                stats.total === 0 && dayEndIncompleteRooms.length === 0 && unresolvedRoomStateRooms.length === 0
                  ? "bg-emerald-600 text-white hover:bg-emerald-700"
                  : "bg-slate-700 text-white hover:bg-slate-800"
              }`}
              style={{ fontWeight: 500 }}
            >
              <Moon className="w-3.5 h-3.5" /> Close Day
            </button>
          </div>
        </div>

        {/* Summary stats */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <div className="rounded-lg border border-gray-100 p-3 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-slate-700 flex items-center justify-center shrink-0">
              <Activity className="w-4 h-4 text-white" />
            </div>
            <div>
              <div className="text-[16px]" style={{ fontWeight: 600 }}>
                {stats.total}
              </div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                Still Open
              </div>
            </div>
          </div>
          <div className="rounded-lg border border-gray-100 p-3 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center shrink-0">
              <CheckCircle2 className="w-4 h-4 text-white" />
            </div>
            <div>
              <div className="text-[16px]" style={{ fontWeight: 600 }}>
                {optimizedToday}
              </div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                Completed
              </div>
            </div>
          </div>
          <div className="rounded-lg border border-gray-100 p-3 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-red-500 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-4 h-4 text-white" />
            </div>
            <div>
              <div className="text-[16px]" style={{ fontWeight: 600 }}>
                {stats.redCount}
              </div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                Red Alerts
              </div>
            </div>
          </div>
          <div className="rounded-lg border border-gray-100 p-3 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-amber-500 flex items-center justify-center shrink-0">
              <Clock className="w-4 h-4 text-white" />
            </div>
            <div>
              <div className="text-[16px]" style={{ fontWeight: 600 }}>
                {stats.yellowCount}
              </div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                Yellow Alerts
              </div>
            </div>
          </div>
          <div className="rounded-lg border border-gray-100 p-3 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-red-600 flex items-center justify-center shrink-0">
              <ShieldAlert className="w-4 h-4 text-white" />
            </div>
            <div>
              <div className="text-[16px]" style={{ fontWeight: 600 }}>
                {stats.safetyCount}
              </div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                Safety Active
              </div>
            </div>
          </div>
        </div>

        {/* Status pipeline breakdown */}
        <Card className="border-0 shadow-sm overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-slate-600 via-indigo-500 to-emerald-500" />
          <CardContent className="p-5">
            <div className="flex items-center gap-2 mb-4">
              <Activity className="w-4 h-4 text-slate-600" />
              <span className="text-[13px]" style={{ fontWeight: 600 }}>
                Open Encounters by Status
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {(
                [
                  "Lobby",
                  "Rooming",
                  "ReadyForProvider",
                  "Optimizing",
                  "CheckOut",
                ] as EncounterStatus[]
              ).map((s) => {
                const count = statusBreakdown[s] || 0;
                const color = statusColors[s];
                return (
                  <div
                    key={s}
                    className="rounded-lg border px-4 py-3 min-w-[110px] text-center transition-all hover:scale-105 cursor-pointer"
                    style={{
                      borderColor: count > 0 ? `${color}40` : "#e5e7eb",
                      backgroundColor: count > 0 ? `${color}10` : "#f9fafb",
                    }}
                    onClick={() =>
                      setStatusFilter(statusFilter === s ? "all" : s)
                    }
                  >
                    <div
                      className="text-[20px]"
                      style={{
                        fontWeight: 700,
                        color: count > 0 ? color : "#9ca3af",
                      }}
                    >
                      {count}
                    </div>
                    <div
                      className="text-[10px] uppercase tracking-wider"
                      style={{ color: count > 0 ? color : "#9ca3af" }}
                    >
                      {statusLabels[s]}
                    </div>
                  </div>
                );
              })}
              <ArrowRight className="w-4 h-4 text-gray-300" />
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 min-w-[110px] text-center">
                <div
                  className="text-[20px] text-emerald-600"
                  style={{ fontWeight: 700 }}
                >
                  {optimizedToday}
                </div>
                <div className="text-[10px] text-emerald-600 uppercase tracking-wider">
                  Optimized
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-amber-500 to-emerald-500" />
          <CardContent className="p-5">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-2">
                <DoorOpen className="w-4 h-4 text-amber-600" />
                <span className="text-[13px]" style={{ fontWeight: 700 }}>Room Day End</span>
                <Badge className="border-0 bg-amber-100 text-amber-700 text-[10px] h-5">
                  {dayEndIncompleteRooms.length} incomplete
                </Badge>
              </div>
              <button
                onClick={() => loadRooms().catch(() => undefined)}
                className="h-8 px-3 rounded-lg border border-gray-200 text-[11px] text-gray-600 hover:bg-gray-50"
              >
                Refresh rooms
              </button>
            </div>
            {roomLoading ? (
              <div className="text-[12px] text-muted-foreground">Loading rooms...</div>
            ) : roomCards.length === 0 ? (
              <div className="text-[12px] text-muted-foreground">No rooms are available in your scope.</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {roomCards.map((room) => {
                  const stateBlocked = ["NeedsTurnover", "Occupied", "Hold", "NotReady"].includes(room.operationalStatus);
                  return (
                    <div key={room.id} className="rounded-xl border border-gray-100 p-3 bg-white">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-[13px]" style={{ fontWeight: 700 }}>{room.name}</div>
                          <div className="text-[11px] text-muted-foreground">{room.clinicName}</div>
                        </div>
                        <Badge className={`border-0 text-[10px] h-5 ${room.dayEndCompleted ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                          {room.dayEndCompleted ? "Day End done" : "Day End open"}
                        </Badge>
                      </div>
                      {stateBlocked && (
                        <div className="mt-2 rounded-lg bg-rose-50 border border-rose-100 px-2.5 py-1.5 text-[11px] text-rose-700">
                          Resolve room status before close: {room.operationalStatus}
                        </div>
                      )}
                      <button
                        onClick={() => completeRoomDayEnd(room).catch(() => undefined)}
                        disabled={room.dayEndCompleted || roomBusyId === room.id}
                        className="mt-3 h-8 px-3 rounded-lg bg-slate-800 text-white text-[11px] disabled:opacity-50"
                      >
                        {roomBusyId === room.id ? "Completing..." : "Complete Day End"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-64">
            <Search className="w-3.5 h-3.5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search encounter, patient, provider..."
              className="h-8 pl-9 pr-3 w-full rounded-lg border border-gray-200 bg-white text-[12px] focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 transition-all"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          <select
            value={clinicFilter}
            onChange={(e) => setClinicFilter(e.target.value)}
            className="h-8 px-3 rounded-lg border border-gray-200 bg-white text-[12px]"
          >
            <option value="all">All Clinics</option>
            {clinics.map((c) => (
              <option key={c.id} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-8 px-3 rounded-lg border border-gray-200 bg-white text-[12px]"
          >
            <option value="all">All Statuses</option>
            {uniqueStatuses.map((s) => (
              <option key={s} value={s}>
                {statusLabels[s]}
              </option>
            ))}
          </select>
          <select
            value={alertFilter}
            onChange={(e) => setAlertFilter(e.target.value)}
            className="h-8 px-3 rounded-lg border border-gray-200 bg-white text-[12px]"
          >
            <option value="all">All Alert Levels</option>
            <option value="Red">Red</option>
            <option value="Yellow">Yellow</option>
            <option value="Green">Green</option>
          </select>
          {(search ||
            clinicFilter !== "all" ||
            statusFilter !== "all" ||
            alertFilter !== "all") && (
            <button
              onClick={() => {
                setSearch("");
                setClinicFilter("all");
                setStatusFilter("all");
                setAlertFilter("all");
              }}
              className="text-[11px] text-indigo-600 hover:text-indigo-800"
              style={{ fontWeight: 500 }}
            >
              Clear Filters
            </button>
          )}
          <span className="text-[11px] text-muted-foreground ml-auto">
            {filtered.length} open encounters
          </span>
        </div>

        {/* Encounter list */}
        <Card className="border-0 shadow-sm">
          <CardContent className="p-5">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="w-14 h-14 rounded-xl bg-emerald-100 flex items-center justify-center mb-3">
                  <CheckCircle2 className="w-6 h-6 text-emerald-500" />
                </div>
                <p
                  className="text-[15px] text-emerald-700 mb-1"
                  style={{ fontWeight: 600 }}
                >
                  All Clear!
                </p>
                <p className="text-[13px] text-muted-foreground">
                  No open encounters match your filters. Ready to close the
                  day.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {filtered.map((row) => {
                  const sColor = statusColors[row.currentStatus];
                  const mins = msToMinutes(row.statusElapsedMs);
                  const isExpanded = expandedRow === row.encounterId;

                  return (
                    <div key={row.encounterId}>
                      <div
                        className={`rounded-lg border p-4 flex items-center gap-4 transition-colors cursor-pointer ${
                          row.safetyActive
                            ? "border-red-200 bg-red-50/30"
                            : row.alertLevel === "Red"
                              ? "border-orange-200 bg-orange-50/20"
                              : row.alertLevel === "Yellow"
                                ? "border-amber-200 bg-amber-50/20"
                                : "border-gray-100 hover:border-gray-200"
                        }`}
                        onClick={() =>
                          setExpandedRow(
                            isExpanded ? null : row.encounterId
                          )
                        }
                      >
                        {/* Safety / Alert indicator */}
                        <div className="relative shrink-0">
                          <div
                            className="w-10 h-10 rounded-lg flex items-center justify-center"
                            style={{ backgroundColor: `${sColor}15` }}
                          >
                            {row.safetyActive ? (
                              <ShieldAlert
                                className="w-5 h-5 text-red-600"
                              />
                            ) : (
                              <Clock
                                className="w-4.5 h-4.5"
                                style={{ color: sColor }}
                              />
                            )}
                          </div>
                          {row.safetyActive && (
                            <span className="absolute -top-1 -right-1 flex h-3 w-3">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                              <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
                            </span>
                          )}
                        </div>

                        {/* Main info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span
                              className="text-[13px]"
                              style={{ fontWeight: 500 }}
                            >
                              {row.encounterId}
                            </span>
                            <Badge
                              className="border-0 text-[10px] h-5"
                              style={{
                                backgroundColor: `${sColor}15`,
                                color: sColor,
                              }}
                            >
                              {statusLabels[row.currentStatus]}
                            </Badge>
                            <Badge
                              className={`border-0 text-[9px] h-4 ${alertBadge(row.alertLevel)}`}
                            >
                              {row.alertLevel}
                            </Badge>
                            {row.safetyActive && (
                              <Badge className="bg-red-100 text-red-700 border-0 text-[9px] h-4 animate-pulse">
                                SAFETY
                              </Badge>
                            )}
                          </div>
                          <div className="text-[11px] text-muted-foreground flex items-center gap-2 mt-0.5">
                            <span>{row.patientId}</span>
                            <span className="text-gray-300">|</span>
                            <span>{row.providerName}</span>
                            {row.assignedMaName && (
                              <>
                                <span className="text-gray-300">|</span>
                                <span>MA: {row.assignedMaName}</span>
                              </>
                            )}
                            {row.roomName && (
                              <>
                                <span className="text-gray-300">|</span>
                                <span className="flex items-center gap-0.5">
                                  <DoorOpen className="w-3 h-3" />{" "}
                                  {row.roomName}
                                </span>
                              </>
                            )}
                          </div>
                        </div>

                        {/* Clinic badge */}
                        <Badge
                          className="border-0 text-[10px] h-5 shrink-0"
                          style={{
                            backgroundColor: `${row.clinicColor}15`,
                            color: row.clinicColor,
                          }}
                        >
                          {compactClinicBadgeLabel(row.clinicName)}
                        </Badge>

                        {/* Time in status */}
                        <div className="text-right shrink-0 min-w-[70px]">
                          <div
                            className={`text-[14px] ${
                              row.alertLevel === "Red"
                                ? "text-red-600"
                                : row.alertLevel === "Yellow"
                                  ? "text-amber-600"
                                  : "text-gray-700"
                            }`}
                            style={{ fontWeight: 600 }}
                          >
                            {mins}m
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            in status
                          </div>
                        </div>

                        <ChevronDown
                          className={`w-4 h-4 text-gray-400 transition-transform shrink-0 ${isExpanded ? "rotate-180" : ""}`}
                        />
                      </div>

                      {/* Expanded detail */}
                      {isExpanded && (
                        <div className="ml-14 mt-1 mb-2 p-4 rounded-lg bg-gray-50 border border-gray-100 space-y-4">
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            <div className="rounded-lg bg-white border border-gray-100 p-3">
                              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
                                Current Status
                              </div>
                              <Badge
                                className="border-0 text-[11px]"
                                style={{
                                  backgroundColor: `${sColor}15`,
                                  color: sColor,
                                }}
                              >
                                {statusLabels[row.currentStatus]}
                              </Badge>
                            </div>
                            <div className="rounded-lg bg-white border border-gray-100 p-3">
                              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
                                Version
                              </div>
                              <div
                                className="text-[13px]"
                                style={{ fontWeight: 500 }}
                              >
                                v{row.version}
                              </div>
                            </div>
                            <div className="rounded-lg bg-white border border-gray-100 p-3">
                              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
                                Entered Status At
                              </div>
                              <div
                                className="text-[13px]"
                                style={{ fontWeight: 500 }}
                              >
                                {row.enteredStatusAt}
                              </div>
                            </div>
                            <div className="rounded-lg bg-white border border-gray-100 p-3">
                              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
                                Elapsed
                              </div>
                              <div
                                className={`text-[13px] ${
                                  row.alertLevel !== "Green"
                                    ? "text-red-600"
                                    : ""
                                }`}
                                style={{ fontWeight: 500 }}
                              >
                                {mins} minutes
                              </div>
                            </div>
                          </div>

                          {row.safetyActive && (
                            <div className="rounded-lg bg-red-50 border border-red-200 p-3 flex items-center gap-2">
                              <ShieldAlert className="w-4 h-4 text-red-600" />
                              <span className="text-[12px] text-red-700" style={{ fontWeight: 500 }}>
                                Safety Assist is active for this encounter.
                                Do not close without proper resolution.
                              </span>
                            </div>
                          )}

                          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-gray-100">
                            {row.currentStatus === "CheckOut" && (
                              <button
                                onClick={() =>
                                  toast.success(
                                    `${row.encounterId} advanced to Optimized`
                                  )
                                }
                                className="h-7 px-3 rounded-lg bg-emerald-600 text-white text-[11px] hover:bg-emerald-700 transition-colors flex items-center gap-1.5"
                                style={{ fontWeight: 500 }}
                              >
                                <CheckCircle2 className="w-3 h-3" />{" "}
                                Complete Checkout
                              </button>
                            )}
                            {row.currentStatus !== "CheckOut" && (
                              <button
                                onClick={() =>
                                  toast.success(
                                    `${row.encounterId} advanced to next status`
                                  )
                                }
                                className="h-7 px-3 rounded-lg bg-indigo-600 text-white text-[11px] hover:bg-indigo-700 transition-colors flex items-center gap-1.5"
                                style={{ fontWeight: 500 }}
                              >
                                <ArrowRight className="w-3 h-3" /> Advance
                                Status
                              </button>
                            )}
                            <button
                              onClick={() =>
                                toast.info("Opening encounter detail...")
                              }
                              className="h-7 px-3 rounded-lg border border-gray-200 text-gray-600 text-[11px] hover:bg-white transition-colors flex items-center gap-1.5"
                              style={{ fontWeight: 500 }}
                            >
                              <Eye className="w-3 h-3" /> View Full
                              Encounter
                            </button>
                            <button
                              onClick={() =>
                                toast.info(
                                  `Paging provider ${row.providerName}...`
                                )
                              }
                              className="h-7 px-3 rounded-lg border border-teal-200 text-teal-600 text-[11px] hover:bg-teal-50 transition-colors flex items-center gap-1.5"
                              style={{ fontWeight: 500 }}
                            >
                              <Stethoscope className="w-3 h-3" /> Page
                              Provider
                            </button>
                            <button
                              onClick={() =>
                                setForceCloseDialog(row.encounterId)
                              }
                              className="h-7 px-3 rounded-lg border border-red-200 text-red-600 text-[11px] hover:bg-red-50 transition-colors flex items-center gap-1.5 ml-auto"
                              style={{ fontWeight: 500 }}
                            >
                              <XCircle className="w-3 h-3" /> Force Close
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Force Close Confirmation */}
        <AlertDialog
          open={!!forceCloseDialog}
          onOpenChange={(v) => !v && setForceCloseDialog(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="text-[15px] flex items-center gap-2">
                <AlertTriangle className="w-4.5 h-4.5 text-red-500" />{" "}
                Force Close Encounter
              </AlertDialogTitle>
              <AlertDialogDescription className="text-[13px]">
                Force-closing{" "}
                <span style={{ fontWeight: 600 }}>{forceCloseDialog}</span>{" "}
                will mark it as Optimized without completing the normal
                workflow. This action is logged in the audit trail. Are you
                sure?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="py-2">
              <label className="text-[12px] text-muted-foreground mb-1 block">
                Reason for force close (required)
              </label>
              <select className="w-full h-8 px-3 rounded-lg border border-gray-200 bg-white text-[12px]">
                <option>Select a reason...</option>
                <option>Patient left without being seen (LWBS)</option>
                <option>Provider finished — paperwork pending</option>
                <option>Duplicate encounter</option>
                <option>System error — encounter stuck</option>
                <option>Other (add note below)</option>
              </select>
              <textarea
                placeholder="Optional additional notes..."
                className="w-full mt-2 h-16 rounded-lg border border-gray-200 p-2 text-[12px] focus:outline-none focus:border-red-300 focus:ring-2 focus:ring-red-100 resize-none"
              />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel className="h-9 text-[13px]">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  toast.success(
                    `${forceCloseDialog} force-closed and logged`
                  );
                  setForceCloseDialog(null);
                }}
                className="h-9 text-[13px] bg-red-600 hover:bg-red-700"
              >
                Force Close
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
}
