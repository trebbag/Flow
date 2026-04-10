import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  DollarSign,
  Clock,
  AlertTriangle,
  FileText,
  Users,
  CheckCircle2,
  ArrowRight,
  Search,
  X,
  ChevronDown,
  ChevronRight,
  Filter,
  Send,
  MessageSquare,
  Pencil,
  Eye,
  Flag,
  RotateCcw,
  Activity,
  Building2,
  Clipboard,
  ExternalLink,
  CircleDot,
  HelpCircle,
  ShieldAlert,
  Inbox,
} from "lucide-react";
import { Card, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { Switch } from "./ui/switch";
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
  revenueCycleLabels,
  revenueCycleColors,
  type RevenueCycleStatus,
  type RevenueCycleRow,
} from "./mock-data";
import { useEncounters } from "./encounter-context";
import { admin, dashboards, tasks as tasksApi, type BackendTask } from "./api-client";
import { loadSession } from "./auth-session";
import { compactClinicBadgeLabel, labelClinicName } from "./display-names";
import { ADMIN_REFRESH_EVENT, FACILITY_CONTEXT_CHANGED_EVENT } from "./app-events";

type RevenueDashboardSnapshot = {
  optimizedCount: number;
  collectionReadyCount: number;
  avgCycleMins: number;
  checkoutQueueCount: number;
  optimizingQueueCount: number;
  openRevenueTaskCount: number;
};

function deriveRevenueStatusFromTasks(tasks: BackendTask[]): RevenueCycleStatus {
  const statusText = tasks.map((task) => `${task.taskType} ${task.description} ${task.status}`.toLowerCase()).join(" ");
  if (statusText.includes("hold") || statusText.includes("exception")) return "HoldException";
  if (statusText.includes("clarification") || statusText.includes("query")) return "ProviderClarificationNeeded";
  if (statusText.includes("submit") && tasks.some((task) => task.status.toLowerCase() === "completed")) return "Submitted";
  if (statusText.includes("submit") || statusText.includes("ready")) return "ReadyToSubmit";
  if (statusText.includes("coding") || statusText.includes("code")) return "CodingInProgress";
  return "ChargeCapturePending";
}

function parseMinutesFromClock(clock: string) {
  const [hoursPart, minutesPart] = clock.split(":");
  const hours = Number(hoursPart);
  const minutes = Number(minutesPart);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
  return hours * 60 + minutes;
}

function dueAtFromCheckin(checkinTime: string, offsetHours: number) {
  const now = new Date();
  const minutes = parseMinutesFromClock(checkinTime);
  const due = new Date(now);
  due.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  due.setHours(due.getHours() + offsetHours);
  return due.toISOString();
}

const allStatuses: RevenueCycleStatus[] = [
  "ChargeCapturePending",
  "CodingInProgress",
  "ProviderClarificationNeeded",
  "ReadyToSubmit",
  "Submitted",
  "HoldException",
];

const priorityLabels: Record<number, { label: string; color: string }> = {
  1: { label: "Urgent", color: "bg-red-100 text-red-700" },
  2: { label: "High", color: "bg-orange-100 text-orange-700" },
  3: { label: "Normal", color: "bg-blue-100 text-blue-700" },
  4: { label: "Low", color: "bg-gray-100 text-gray-500" },
};

function timeUntilDue(dueAt: string | null): { label: string; urgent: boolean } {
  if (!dueAt) return { label: "No deadline", urgent: false };
  const diff = new Date(dueAt).getTime() - Date.now();
  if (diff < 0) return { label: "Overdue", urgent: true };
  const hrs = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (hrs < 2) return { label: `${hrs}h ${mins}m left`, urgent: true };
  return { label: `${hrs}h ${mins}m left`, urgent: false };
}

function StatusPipeline({ rows }: { rows: RevenueCycleRow[] }) {
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    allStatuses.forEach((s) => {
      c[s] = rows.filter((r) => r.status === s).length;
    });
    return c;
  }, [rows]);

  return (
    <div className="flex items-center gap-1">
      {allStatuses.map((s, i) => {
        const count = counts[s];
        const color = revenueCycleColors[s];
        return (
          <div key={s} className="flex items-center gap-1">
            <div className="flex flex-col items-center">
              <div
                className="rounded-lg px-3 py-2 min-w-[100px] text-center border transition-all hover:scale-105 cursor-default"
                style={{
                  backgroundColor: count > 0 ? `${color}15` : "#f9fafb",
                  borderColor: count > 0 ? `${color}40` : "#e5e7eb",
                }}
              >
                <div
                  className="text-[18px]"
                  style={{ fontWeight: 700, color: count > 0 ? color : "#9ca3af" }}
                >
                  {count}
                </div>
                <div
                  className="text-[9px] uppercase tracking-wider mt-0.5"
                  style={{ color: count > 0 ? color : "#9ca3af" }}
                >
                  {revenueCycleLabels[s].split(" ").slice(0, 2).join(" ")}
                </div>
              </div>
            </div>
            {i < allStatuses.length - 1 && (
              <ArrowRight className="w-3.5 h-3.5 text-gray-300 shrink-0" />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function RevenueCycleView() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [clinicFilter, setClinicFilter] = useState<string>("all");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [queryDialog, setQueryDialog] = useState<string | null>(null);
  const [showOnlyUnassigned, setShowOnlyUnassigned] = useState(false);
  const { encounters } = useEncounters();
  const [liveRows, setLiveRows] = useState<RevenueCycleRow[]>([]);
  const [clinicOptions, setClinicOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [dashboardStats, setDashboardStats] = useState<RevenueDashboardSnapshot | null>(null);

  const refreshPipeline = async () => {
    try {
      const facilityId = loadSession()?.facilityId;
      const [taskRows, clinicRows, revenueDashboard] = await Promise.all([
        tasksApi.list({ assignedToRole: "RevenueCycle" }),
        admin.listClinics({ facilityId, includeInactive: true, includeArchived: true }),
        dashboards.revenueCycle(),
      ]);

      const clinicsById = new Map(
        (clinicRows as any[]).map((clinic) => [
          clinic.id,
          {
            name: labelClinicName(clinic.name as string, clinic.status as string | undefined),
            color: (clinic.cardColor as string) || "#6366f1",
          },
        ]),
      );

      setClinicOptions(
        (clinicRows as any[]).map((clinic) => ({
          id: clinic.id,
          name: labelClinicName(clinic.name as string, clinic.status as string | undefined),
        })),
      );
      setDashboardStats({
        optimizedCount: Number((revenueDashboard as any)?.optimizedCount || 0),
        collectionReadyCount: Number((revenueDashboard as any)?.collectionReadyCount || 0),
        avgCycleMins: Number((revenueDashboard as any)?.avgCycleMins || 0),
        checkoutQueueCount: Number((revenueDashboard as any)?.checkoutQueueCount || 0),
        optimizingQueueCount: Number((revenueDashboard as any)?.optimizingQueueCount || 0),
        openRevenueTaskCount: Number((revenueDashboard as any)?.openRevenueTaskCount || 0),
      });

      const tasksByEncounter = new Map<string, BackendTask[]>();
      (taskRows as BackendTask[]).forEach((task) => {
        if (!tasksByEncounter.has(task.encounterId)) {
          tasksByEncounter.set(task.encounterId, []);
        }
        tasksByEncounter.get(task.encounterId)!.push(task);
      });

      const rows = encounters
        .filter((encounter) => encounter.status === "Optimized" || encounter.status === "CheckOut" || encounter.status === "Optimizing")
        .map((encounter) => {
          const encounterTasks = tasksByEncounter.get(encounter.id) || [];
          const status = deriveRevenueStatusFromTasks(encounterTasks);
          const openQueries = encounterTasks.filter((task) => {
            const text = `${task.taskType} ${task.description}`.toLowerCase();
            return text.includes("query") || text.includes("clarification");
          }).length;
          const activeTask = encounterTasks.find((task) => task.status.toLowerCase() !== "completed") || encounterTasks[0];
          const priority = Math.min(
            4,
            Math.max(
              1,
              activeTask?.priority
                ? activeTask.priority
                : encounter.alertLevel === "Red"
                ? 1
                : encounter.alertLevel === "Yellow"
                ? 2
                : 3,
            ),
          );
          const holdTask = encounterTasks.find((task) => {
            const text = `${task.taskType} ${task.description}`.toLowerCase();
            return text.includes("hold") || text.includes("exception");
          });
          const reviewedTask = encounterTasks.find((task) => task.completedAt);
          const clinic = clinicsById.get(encounter.clinicId);
          return {
            encounterId: encounter.id,
            patientId: encounter.patientId,
            clinicName: encounter.clinicName || clinic?.name || "Clinic",
            clinicColor: clinic?.color || encounter.clinicColor,
            providerName: encounter.provider,
            status,
            assigneeName: activeTask?.assignedToUserId ? "Revenue Staff" : activeTask?.assignedToRole || null,
            dueAt: dueAtFromCheckin(encounter.checkinTime, priority <= 2 ? 6 : 10),
            priority,
            notes: activeTask?.description || null,
            holdReason: holdTask?.description || null,
            reviewedAt: reviewedTask?.completedAt || null,
            optimizedAt: dueAtFromCheckin(encounter.checkinTime, -1),
            providerQueryOpenCount: openQueries,
          } satisfies RevenueCycleRow;
        })
        .sort((a, b) => a.priority - b.priority);

      setLiveRows(rows);
    } catch {
      // Keep previously loaded rows.
    }
  };

  useEffect(() => {
    refreshPipeline().catch(() => undefined);
    const interval = setInterval(() => {
      refreshPipeline().catch(() => undefined);
    }, 30000);
    const onRefresh = () => {
      refreshPipeline().catch(() => undefined);
    };
    if (typeof window !== "undefined") {
      window.addEventListener(ADMIN_REFRESH_EVENT, onRefresh);
      window.addEventListener(FACILITY_CONTEXT_CHANGED_EVENT, onRefresh);
    }
    return () => {
      clearInterval(interval);
      if (typeof window !== "undefined") {
        window.removeEventListener(ADMIN_REFRESH_EVENT, onRefresh);
        window.removeEventListener(FACILITY_CONTEXT_CHANGED_EVENT, onRefresh);
      }
    };
  }, [encounters]);

  const filtered = useMemo(() => {
    return liveRows
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
        if (statusFilter !== "all" && r.status !== statusFilter) return false;
        if (clinicFilter !== "all" && r.clinicName !== clinicFilter) return false;
        if (showOnlyUnassigned && r.assigneeName) return false;
        return true;
      })
      .sort((a, b) => a.priority - b.priority);
  }, [clinicFilter, liveRows, search, showOnlyUnassigned, statusFilter]);

  const stats = useMemo(() => {
    const pending = liveRows.filter(
      (r) => r.status !== "Submitted"
    ).length;
    const urgent = liveRows.filter((r) => r.priority === 1).length;
    const queries = liveRows.reduce(
      (s, r) => s + r.providerQueryOpenCount,
      0
    );
    const unassigned = liveRows.filter((r) => !r.assigneeName).length;
    return {
      pending: dashboardStats?.optimizedCount || pending,
      urgent,
      queries: dashboardStats?.openRevenueTaskCount || queries,
      unassigned: dashboardStats?.checkoutQueueCount || unassigned,
    };
  }, [dashboardStats, liveRows]);

  return (
    <TooltipProvider>
      <div className="p-4 sm:p-6 space-y-6 max-w-[1200px] mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
              <DollarSign className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1
                className="text-[20px] tracking-tight"
                style={{ fontWeight: 700 }}
              >
                Revenue Cycle Workbench
              </h1>
              <p className="text-[12px] text-muted-foreground">
                Post-visit charge capture, coding, and submission pipeline
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => {
                    toast.info("Refreshing pipeline...");
                    refreshPipeline().catch(() => undefined);
                  }}
                  className="w-9 h-9 rounded-lg border border-gray-200 flex items-center justify-center text-gray-500 hover:text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-[11px]">Refresh</p>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-lg border border-gray-100 p-3 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-amber-500 flex items-center justify-center shrink-0">
              <Inbox className="w-4 h-4 text-white" />
            </div>
            <div>
              <div className="text-[16px]" style={{ fontWeight: 600 }}>
                {stats.pending}
              </div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                Pending
              </div>
            </div>
          </div>
          <div className="rounded-lg border border-gray-100 p-3 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-red-500 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-4 h-4 text-white" />
            </div>
            <div>
              <div className="text-[16px]" style={{ fontWeight: 600 }}>
                {stats.urgent}
              </div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                Urgent
              </div>
            </div>
          </div>
          <div className="rounded-lg border border-gray-100 p-3 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-purple-500 flex items-center justify-center shrink-0">
              <MessageSquare className="w-4 h-4 text-white" />
            </div>
            <div>
              <div className="text-[16px]" style={{ fontWeight: 600 }}>
                {stats.queries}
              </div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                Open Queries
              </div>
            </div>
          </div>
          <div className="rounded-lg border border-gray-100 p-3 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-500 flex items-center justify-center shrink-0">
              <Users className="w-4 h-4 text-white" />
            </div>
            <div>
              <div className="text-[16px]" style={{ fontWeight: 600 }}>
                {stats.unassigned}
              </div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                Unassigned
              </div>
            </div>
          </div>
        </div>

        {/* Pipeline visualization */}
        <Card className="border-0 shadow-sm overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-amber-400 via-indigo-500 to-emerald-500" />
          <CardContent className="p-5">
            <div className="flex items-center gap-2 mb-4">
              <Activity className="w-4 h-4 text-indigo-500" />
              <span className="text-[13px]" style={{ fontWeight: 600 }}>
                Pipeline Overview
              </span>
            </div>
            <div className="overflow-x-auto pb-2">
              <StatusPipeline rows={liveRows} />
            </div>
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
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-8 px-3 rounded-lg border border-gray-200 bg-white text-[12px]"
          >
            <option value="all">All Statuses</option>
            {allStatuses.map((s) => (
              <option key={s} value={s}>
                {revenueCycleLabels[s]}
              </option>
            ))}
          </select>
          <select
            value={clinicFilter}
            onChange={(e) => setClinicFilter(e.target.value)}
            className="h-8 px-3 rounded-lg border border-gray-200 bg-white text-[12px]"
          >
            <option value="all">All Clinics</option>
            {clinicOptions.map((clinic) => (
              <option key={clinic.id} value={clinic.name}>
                {clinic.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
            <Switch
              checked={showOnlyUnassigned}
              onCheckedChange={setShowOnlyUnassigned}
            />
            Unassigned only
          </label>
          {(search ||
            statusFilter !== "all" ||
            clinicFilter !== "all" ||
            showOnlyUnassigned) && (
            <button
              onClick={() => {
                setSearch("");
                setStatusFilter("all");
                setClinicFilter("all");
                setShowOnlyUnassigned(false);
              }}
              className="text-[11px] text-indigo-600 hover:text-indigo-800"
              style={{ fontWeight: 500 }}
            >
              Clear Filters
            </button>
          )}
          <span className="text-[11px] text-muted-foreground ml-auto">
            {filtered.length} of {liveRows.length} encounters
          </span>
        </div>

        {/* Encounter list */}
        <Card className="border-0 shadow-sm">
          <CardContent className="p-5">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="w-14 h-14 rounded-xl bg-gray-100 flex items-center justify-center mb-3">
                  <DollarSign className="w-6 h-6 text-gray-400" />
                </div>
                <p className="text-[13px] text-muted-foreground">
                  No encounters match your filters
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {filtered.map((row) => {
                  const statusColor = revenueCycleColors[row.status];
                  const due = timeUntilDue(row.dueAt);
                  const prio = priorityLabels[row.priority] || priorityLabels[3];
                  const isExpanded = expandedRow === row.encounterId;

                  return (
                    <div key={row.encounterId}>
                      <div
                        className="rounded-lg border border-gray-100 p-4 flex items-center gap-4 hover:border-gray-200 transition-colors cursor-pointer"
                        onClick={() =>
                          setExpandedRow(isExpanded ? null : row.encounterId)
                        }
                      >
                        {/* Status indicator */}
                        <div
                          className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                          style={{ backgroundColor: `${statusColor}15` }}
                        >
                          {row.status === "ChargeCapturePending" && (
                            <Clipboard
                              className="w-4.5 h-4.5"
                              style={{ color: statusColor }}
                            />
                          )}
                          {row.status === "CodingInProgress" && (
                            <FileText
                              className="w-4.5 h-4.5"
                              style={{ color: statusColor }}
                            />
                          )}
                          {row.status === "ProviderClarificationNeeded" && (
                            <HelpCircle
                              className="w-4.5 h-4.5"
                              style={{ color: statusColor }}
                            />
                          )}
                          {row.status === "ReadyToSubmit" && (
                            <Send
                              className="w-4.5 h-4.5"
                              style={{ color: statusColor }}
                            />
                          )}
                          {row.status === "Submitted" && (
                            <CheckCircle2
                              className="w-4.5 h-4.5"
                              style={{ color: statusColor }}
                            />
                          )}
                          {row.status === "HoldException" && (
                            <ShieldAlert
                              className="w-4.5 h-4.5"
                              style={{ color: statusColor }}
                            />
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
                                backgroundColor: `${statusColor}15`,
                                color: statusColor,
                              }}
                            >
                              {revenueCycleLabels[row.status]}
                            </Badge>
                            <Badge className={`border-0 text-[9px] h-4 ${prio.color}`}>
                              {prio.label}
                            </Badge>
                            {row.providerQueryOpenCount > 0 && (
                              <Badge className="bg-purple-100 text-purple-700 border-0 text-[9px] h-4">
                                {row.providerQueryOpenCount} query
                              </Badge>
                            )}
                            {row.holdReason && (
                              <Badge className="bg-red-100 text-red-700 border-0 text-[9px] h-4">
                                HOLD
                              </Badge>
                            )}
                          </div>
                          <div className="text-[11px] text-muted-foreground flex items-center gap-2 mt-0.5">
                            <span>{row.patientId}</span>
                            <span className="text-gray-300">|</span>
                            <span>{row.providerName}</span>
                            <span className="text-gray-300">|</span>
                            <Badge
                              className="border-0 text-[9px] h-4"
                              style={{
                                backgroundColor: `${row.clinicColor}15`,
                                color: row.clinicColor,
                              }}
                            >
                              {compactClinicBadgeLabel(row.clinicName)}
                            </Badge>
                          </div>
                        </div>

                        {/* Assignee */}
                        <div className="text-right shrink-0">
                          {row.assigneeName ? (
                            <div className="flex items-center gap-1.5">
                              <div className="w-6 h-6 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white text-[9px]" style={{ fontWeight: 600 }}>
                                {row.assigneeName
                                  .split(" ")
                                  .map((n) => n[0])
                                  .join("")
                                  .slice(0, 2)}
                              </div>
                              <span className="text-[11px]" style={{ fontWeight: 500 }}>
                                {row.assigneeName}
                              </span>
                            </div>
                          ) : (
                            <Badge className="bg-gray-100 text-gray-500 border-0 text-[10px] h-5">
                              Unassigned
                            </Badge>
                          )}
                        </div>

                        {/* Due time */}
                        <div className="text-right shrink-0 min-w-[80px]">
                          <div
                            className={`text-[11px] flex items-center gap-1 justify-end ${due.urgent ? "text-red-600" : "text-muted-foreground"}`}
                            style={due.urgent ? { fontWeight: 500 } : {}}
                          >
                            <Clock className="w-3 h-3" />
                            {due.label}
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
                                Optimized At
                              </div>
                              <div
                                className="text-[13px]"
                                style={{ fontWeight: 500 }}
                              >
                                {new Date(row.optimizedAt).toLocaleTimeString(
                                  [],
                                  {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  }
                                )}
                              </div>
                            </div>
                            <div className="rounded-lg bg-white border border-gray-100 p-3">
                              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
                                Due
                              </div>
                              <div
                                className={`text-[13px] ${due.urgent ? "text-red-600" : ""}`}
                                style={{ fontWeight: 500 }}
                              >
                                {row.dueAt
                                  ? new Date(row.dueAt).toLocaleTimeString([], {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })
                                  : "—"}
                              </div>
                            </div>
                            <div className="rounded-lg bg-white border border-gray-100 p-3">
                              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
                                Priority
                              </div>
                              <Badge className={`${prio.color} border-0 text-[10px]`}>
                                {prio.label}
                              </Badge>
                            </div>
                            <div className="rounded-lg bg-white border border-gray-100 p-3">
                              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
                                Open Queries
                              </div>
                              <div
                                className="text-[13px]"
                                style={{ fontWeight: 500 }}
                              >
                                {row.providerQueryOpenCount}
                              </div>
                            </div>
                          </div>

                          {row.notes && (
                            <div className="rounded-lg bg-white border border-gray-100 p-3">
                              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
                                Notes
                              </div>
                              <div className="text-[12px]">{row.notes}</div>
                            </div>
                          )}

                          {row.holdReason && (
                            <div className="rounded-lg bg-red-50 border border-red-100 p-3">
                              <div className="text-[10px] text-red-600 uppercase tracking-wider mb-1 flex items-center gap-1">
                                <AlertTriangle className="w-3 h-3" /> Hold
                                Reason
                              </div>
                              <div className="text-[12px] text-red-700">
                                {row.holdReason}
                              </div>
                            </div>
                          )}

                          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-gray-100">
                            {row.status !== "Submitted" && (
                              <button
                                onClick={() =>
                                  toast.success(
                                    `${row.encounterId} assigned to you`
                                  )
                                }
                                className="h-7 px-3 rounded-lg bg-indigo-600 text-white text-[11px] hover:bg-indigo-700 transition-colors flex items-center gap-1.5"
                                style={{ fontWeight: 500 }}
                              >
                                <Users className="w-3 h-3" /> Claim
                              </button>
                            )}
                            {row.status === "ReadyToSubmit" && (
                              <button
                                onClick={() =>
                                  toast.success(
                                    `${row.encounterId} submitted`
                                  )
                                }
                                className="h-7 px-3 rounded-lg bg-emerald-600 text-white text-[11px] hover:bg-emerald-700 transition-colors flex items-center gap-1.5"
                                style={{ fontWeight: 500 }}
                              >
                                <Send className="w-3 h-3" /> Submit
                              </button>
                            )}
                            <button
                              onClick={() =>
                                setQueryDialog(row.encounterId)
                              }
                              className="h-7 px-3 rounded-lg border border-purple-200 text-purple-600 text-[11px] hover:bg-purple-50 transition-colors flex items-center gap-1.5"
                              style={{ fontWeight: 500 }}
                            >
                              <MessageSquare className="w-3 h-3" /> Query
                              Provider
                            </button>
                            <button
                              onClick={() =>
                                toast.info("Opening encounter detail...")
                              }
                              className="h-7 px-3 rounded-lg border border-gray-200 text-gray-600 text-[11px] hover:bg-gray-50 transition-colors flex items-center gap-1.5"
                              style={{ fontWeight: 500 }}
                            >
                              <Eye className="w-3 h-3" /> View Encounter
                            </button>
                            {row.status === "HoldException" && (
                              <button
                                onClick={() =>
                                  toast.success("Hold released")
                                }
                                className="h-7 px-3 rounded-lg border border-amber-200 text-amber-700 text-[11px] hover:bg-amber-50 transition-colors flex items-center gap-1.5 ml-auto"
                                style={{ fontWeight: 500 }}
                              >
                                <RotateCcw className="w-3 h-3" /> Release Hold
                              </button>
                            )}
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

        {/* Query Provider Dialog */}
        <AlertDialog
          open={!!queryDialog}
          onOpenChange={(v) => !v && setQueryDialog(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="text-[15px] flex items-center gap-2">
                <MessageSquare className="w-4.5 h-4.5 text-purple-500" />{" "}
                Query Provider
              </AlertDialogTitle>
              <AlertDialogDescription className="text-[13px]">
                Send a clarification query to the provider for encounter{" "}
                <span style={{ fontWeight: 600 }}>{queryDialog}</span>.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="py-3">
              <textarea
                placeholder="Describe what clarification is needed..."
                className="w-full h-24 rounded-lg border border-gray-200 p-3 text-[13px] focus:outline-none focus:border-purple-300 focus:ring-2 focus:ring-purple-100 resize-none"
              />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel className="h-9 text-[13px]">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  toast.success("Query sent to provider");
                  setQueryDialog(null);
                }}
                className="h-9 text-[13px] bg-purple-600 hover:bg-purple-700"
              >
                Send Query
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
}
