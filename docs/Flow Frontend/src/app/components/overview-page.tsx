import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  Activity,
  AlertTriangle,
  Bell,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock,
  CreditCard,
  DoorOpen,
  Inbox,
  ShieldAlert,
  Stethoscope,
  Timer,
  Users,
} from "lucide-react";
import { Card, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { statusColors, statusLabels, type EncounterStatus } from "./mock-data";
import { useEncounters } from "./encounter-context";
import { admin, alerts as alertsApi, auth, tasks as tasksApi } from "./api-client";
import { loadSession } from "./auth-session";
import { ADMIN_REFRESH_EVENT, FACILITY_CONTEXT_CHANGED_EVENT, SESSION_CHANGED_EVENT } from "./app-events";
import { labelUserName } from "./display-names";

const pipelineStages: EncounterStatus[] = [
  "Incoming",
  "Lobby",
  "Rooming",
  "ReadyForProvider",
  "Optimizing",
  "CheckOut",
  "Optimized",
];

function formatInTimeZone(date: Date, timezone: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    ...options,
  }).format(date);
}

function safeLower(value: string | undefined | null) {
  return String(value || "").trim().toLowerCase();
}

function summarizeClinicOwner(assignment: any) {
  if (!assignment) return "Unassigned";
  if (assignment.maRun) {
    return labelUserName(assignment.maUserName, assignment.maUserStatus) || "Unassigned MA";
  }
  return labelUserName(assignment?.providerUserName, assignment?.providerUserStatus) || "Unassigned Provider";
}

export function OverviewPage() {
  const navigate = useNavigate();
  const { encounters, isLiveMode, syncError } = useEncounters();
  const [now, setNow] = useState(() => new Date());
  const [facilityName, setFacilityName] = useState("Facility");
  const [facilityTimezone, setFacilityTimezone] = useState("America/New_York");
  const [activeRole, setActiveRole] = useState<string>(loadSession()?.role || "Admin");
  const [currentUserName, setCurrentUserName] = useState("Current User");
  const [rooms, setRooms] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [assignments, setAssignments] = useState<any[]>([]);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [tasks, setTasks] = useState<any[]>([]);

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let mounted = true;
    const loadOverview = async () => {
      const session = loadSession();
      const facilityId = session?.facilityId;
      const role = session?.role || "Admin";
      const tasksRequest = role === "Admin"
        ? tasksApi.list({ includeCompleted: false })
        : tasksApi.list({ mine: true, includeCompleted: false });
      const [contextResult, roomsResult, usersResult, assignmentsResult, alertsResult, tasksResult] = await Promise.allSettled([
        auth.getContext(),
        admin.listRooms({ facilityId, includeInactive: true }),
        admin.listUsers(facilityId),
        admin.listAssignments(facilityId),
        alertsApi.list({ tab: "active", limit: 50 }),
        tasksRequest,
      ]);
      if (!mounted) return;

      setActiveRole(role);
      if (contextResult.status === "fulfilled") {
        const context = contextResult.value;
        const activeFacility = context.availableFacilities.find((entry) => entry.id === (context.activeFacilityId || context.facilityId || facilityId));
        setFacilityName(activeFacility?.name || facilityName);
        setFacilityTimezone(activeFacility?.timezone || "America/New_York");
        const currentUser = usersResult.status === "fulfilled"
          ? (usersResult.value as any[]).find((entry) => entry.id === context.userId)
          : null;
        setCurrentUserName(currentUser?.name || currentUserName);
      }
      if (roomsResult.status === "fulfilled") setRooms(roomsResult.value as any[]);
      if (usersResult.status === "fulfilled") {
        const nextUsers = usersResult.value as any[];
        setUsers(nextUsers);
        const sessionUserId = session?.userId;
        const currentUser = nextUsers.find((entry) => entry.id === sessionUserId);
        if (currentUser?.name) setCurrentUserName(currentUser.name);
      }
      if (assignmentsResult.status === "fulfilled") setAssignments(assignmentsResult.value as any[]);
      if (alertsResult.status === "fulfilled") setAlerts((alertsResult.value as any).items || []);
      if (tasksResult.status === "fulfilled") setTasks(tasksResult.value as any[]);
    };

    loadOverview().catch(() => undefined);
    const onRefresh = () => {
      loadOverview().catch(() => undefined);
    };
    if (typeof window !== "undefined") {
      window.addEventListener(ADMIN_REFRESH_EVENT, onRefresh);
      window.addEventListener(FACILITY_CONTEXT_CHANGED_EVENT, onRefresh);
      window.addEventListener(SESSION_CHANGED_EVENT, onRefresh);
    }
    return () => {
      mounted = false;
      if (typeof window !== "undefined") {
        window.removeEventListener(ADMIN_REFRESH_EVENT, onRefresh);
        window.removeEventListener(FACILITY_CONTEXT_CHANGED_EVENT, onRefresh);
        window.removeEventListener(SESSION_CHANGED_EVENT, onRefresh);
      }
    };
  }, []);

  const activeEncounters = useMemo(
    () => encounters.filter((encounter) => encounter.status !== "Optimized"),
    [encounters],
  );
  const completedToday = useMemo(
    () => encounters.filter((encounter) => encounter.status === "Optimized"),
    [encounters],
  );
  const occupiedRoomNames = useMemo(
    () => new Set(activeEncounters.map((encounter) => encounter.roomNumber).filter(Boolean)),
    [activeEncounters],
  );
  const activeRooms = useMemo(
    () => rooms.filter((room) => String(room.status || "active") !== "archived"),
    [rooms],
  );
  const liveRoomSummary = useMemo(() => {
    const activeRoomRows = activeRooms.filter((room) => String(room.status || "active") === "active");
    const occupied = activeRoomRows.filter((room) => occupiedRoomNames.has(room.name));
    return {
      active: activeRoomRows.length,
      occupied: occupied.length,
      inactive: activeRooms.filter((room) => String(room.status) === "inactive").length,
    };
  }, [activeRooms, occupiedRoomNames]);
  const activeUserCount = useMemo(
    () => users.filter((user) => String(user.status || "active").toLowerCase() === "active").length,
    [users],
  );
  const maRunClinicCount = useMemo(
    () => assignments.filter((assignment) => Boolean(assignment.maRun)).length,
    [assignments],
  );
  const providerRunClinicCount = Math.max(assignments.length - maRunClinicCount, 0);

  const myScopedEncounters = useMemo(() => {
    const currentName = safeLower(currentUserName);
    if (activeRole === "MA") {
      return encounters.filter((encounter) => safeLower(encounter.assignedMA) === currentName);
    }
    if (activeRole === "Clinician") {
      return encounters.filter((encounter) => safeLower(encounter.provider) === currentName);
    }
    if (activeRole === "FrontDeskCheckIn") {
      return encounters.filter((encounter) => encounter.status === "Incoming" || encounter.status === "Lobby");
    }
    if (activeRole === "FrontDeskCheckOut") {
      return encounters.filter((encounter) => encounter.status === "CheckOut");
    }
    if (activeRole === "RevenueCycle") {
      return encounters.filter((encounter) => encounter.status === "Optimized" || encounter.status === "CheckOut");
    }
    return encounters;
  }, [activeRole, currentUserName, encounters]);

  const stageCounts = useMemo(() => {
    const counts = new Map<EncounterStatus, number>();
    pipelineStages.forEach((stage) => counts.set(stage, 0));
    encounters.forEach((encounter) => {
      counts.set(encounter.status, (counts.get(encounter.status) || 0) + 1);
    });
    return counts;
  }, [encounters]);

  const clinicSummaries = useMemo(() => {
    const map = new Map<string, { clinicId: string; clinicName: string; clinicShortCode: string; color: string; active: number; incoming: number; checkout: number; owner: string }>();
    encounters.forEach((encounter) => {
      if (!map.has(encounter.clinicId)) {
        const assignment = assignments.find((entry) => entry.clinicId === encounter.clinicId);
        map.set(encounter.clinicId, {
          clinicId: encounter.clinicId,
          clinicName: encounter.clinicName,
          clinicShortCode: encounter.clinicShortCode,
          color: encounter.clinicColor,
          active: 0,
          incoming: 0,
          checkout: 0,
          owner: summarizeClinicOwner(assignment),
        });
      }
      const target = map.get(encounter.clinicId)!;
      if (encounter.status === "Incoming") target.incoming += 1;
      else if (encounter.status === "CheckOut") target.checkout += 1;
      else if (encounter.status !== "Optimized") target.active += 1;
    });
    return Array.from(map.values()).sort((a, b) => a.clinicName.localeCompare(b.clinicName));
  }, [assignments, encounters]);

  const displayDate = formatInTimeZone(now, facilityTimezone, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const displayTime = formatInTimeZone(now, facilityTimezone, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

  return (
    <div className="p-6 space-y-5 max-w-[1400px] mx-auto">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground uppercase tracking-wider" style={{ fontWeight: 600 }}>
            <CalendarDays className="w-3.5 h-3.5 text-indigo-500" />
            {displayDate}
            <span className="text-gray-300">•</span>
            {displayTime}
          </div>
          <h1 className="text-[24px] tracking-tight mt-1" style={{ fontWeight: 700 }}>
            {facilityName} Overview
          </h1>
          <p className="text-[13px] text-muted-foreground mt-1">
            Live facility view for {activeRole === "Admin" ? "administrative operations" : `${currentUserName || activeRole} (${activeRole})`}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <Badge className={`border-0 ${isLiveMode ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
            {isLiveMode ? "Live API" : "Degraded sync"}
          </Badge>
          {syncError && <span className="text-red-500 max-w-[320px] truncate">{syncError}</span>}
          <Badge className="border-0 bg-sky-100 text-sky-700">{activeRole}</Badge>
        </div>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-6 gap-3">
        <StatCard label="In Flow" value={activeEncounters.length} hint="Not yet optimized" icon={Activity} color="bg-indigo-500" />
        <StatCard label="Completed" value={completedToday.length} hint="Finished today" icon={CheckCircle2} color="bg-emerald-500" />
        <StatCard label="Alerts" value={alerts.length} hint="Active inbox alerts" icon={Bell} color="bg-amber-500" />
        <StatCard label="Open Tasks" value={tasks.length} hint="Visible in current scope" icon={ClipboardList} color="bg-violet-500" />
        <StatCard label="Rooms" value={`${liveRoomSummary.occupied}/${liveRoomSummary.active}`} hint={`${liveRoomSummary.inactive} inactive`} icon={DoorOpen} color="bg-sky-500" />
        <StatCard label="Staff" value={activeUserCount} hint={`${maRunClinicCount} MA-run · ${providerRunClinicCount} provider-run`} icon={Users} color="bg-fuchsia-500" />
      </div>

      <Card className="border-0 shadow-sm overflow-hidden">
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-indigo-500" />
              <span className="text-[13px]" style={{ fontWeight: 600 }}>Facility Pipeline</span>
            </div>
            <span className="text-[11px] text-muted-foreground">Tap a stage to open the matching workflow view</span>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-7 gap-3">
            {pipelineStages.map((stage) => {
              const count = stageCounts.get(stage) || 0;
              const color = statusColors[stage];
              const route =
                stage === "Incoming" || stage === "Lobby"
                  ? "/checkin"
                  : stage === "Rooming"
                    ? "/ma-board"
                    : stage === "ReadyForProvider" || stage === "Optimizing"
                      ? "/clinician"
                      : "/checkout";
              return (
                <button
                  key={stage}
                  type="button"
                  onClick={() => navigate(route)}
                  className="rounded-xl border p-4 text-left transition-colors hover:bg-gray-50"
                  style={{ borderColor: `${color}30`, backgroundColor: `${color}10` }}
                >
                  <div className="text-[24px]" style={{ fontWeight: 700, color }}>{count}</div>
                  <div className="text-[11px] uppercase tracking-wider mt-1" style={{ fontWeight: 600, color }}>
                    {statusLabels[stage]}
                  </div>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_0.9fr] gap-4">
        <Card className="border-0 shadow-sm overflow-hidden">
          <CardContent className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-sky-500" />
                <span className="text-[13px]" style={{ fontWeight: 600 }}>Clinic Snapshot</span>
              </div>
              <span className="text-[11px] text-muted-foreground">Current facility day-of-operations</span>
            </div>
            <div className="space-y-3">
              {clinicSummaries.length === 0 ? (
                <EmptyState message="No clinic activity yet for the selected facility." icon={Inbox} />
              ) : (
                clinicSummaries.map((clinic) => (
                  <div key={clinic.clinicId} className="rounded-xl border border-gray-100 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: clinic.color }} />
                          <span className="text-[13px] truncate" style={{ fontWeight: 600 }}>{clinic.clinicName}</span>
                          <Badge className="border-0 text-[10px]" style={{ backgroundColor: `${clinic.color}15`, color: clinic.color }}>{clinic.clinicShortCode}</Badge>
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-1">Assigned owner: {clinic.owner}</div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-gray-300 shrink-0" />
                    </div>
                    <div className="grid grid-cols-3 gap-2 mt-3">
                      <MiniStat label="Incoming" value={clinic.incoming} />
                      <MiniStat label="Active" value={clinic.active} />
                      <MiniStat label="Checkout" value={clinic.checkout} />
                    </div>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="border-0 shadow-sm overflow-hidden">
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {activeRole === "Clinician" ? <Stethoscope className="w-4 h-4 text-emerald-500" /> : activeRole === "FrontDeskCheckOut" ? <CreditCard className="w-4 h-4 text-emerald-500" /> : <Timer className="w-4 h-4 text-emerald-500" />}
                  <span className="text-[13px]" style={{ fontWeight: 600 }}>My Workload</span>
                </div>
                <Badge className="border-0 bg-emerald-100 text-emerald-700">{myScopedEncounters.length} encounters</Badge>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <MiniStat label="Incoming / Lobby" value={myScopedEncounters.filter((entry) => entry.status === "Incoming" || entry.status === "Lobby").length} />
                <MiniStat label="Rooming" value={myScopedEncounters.filter((entry) => entry.status === "Rooming").length} />
                <MiniStat label="Ready / Visit" value={myScopedEncounters.filter((entry) => entry.status === "ReadyForProvider" || entry.status === "Optimizing").length} />
                <MiniStat label="Checkout" value={myScopedEncounters.filter((entry) => entry.status === "CheckOut").length} />
              </div>
              <div className="rounded-lg border border-gray-100 bg-gray-50/60 p-3 text-[12px] text-muted-foreground">
                {activeRole === "Admin"
                  ? "Admin view is aggregating the whole facility. Non-admin roles see work scoped to their operational handoff."
                  : `This panel is scoped to ${currentUserName || activeRole} and updates as assignments, tasks, and encounter ownership change.`}
              </div>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-sm overflow-hidden">
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-500" />
                  <span className="text-[13px]" style={{ fontWeight: 600 }}>Active Alerts</span>
                </div>
                <Badge className="border-0 bg-amber-100 text-amber-700">{alerts.length}</Badge>
              </div>
              {alerts.length === 0 ? (
                <EmptyState message="No active alerts in the inbox." icon={Bell} />
              ) : (
                <div className="space-y-2">
                  {alerts.slice(0, 5).map((alert) => (
                    <div key={alert.id} className="rounded-lg border border-amber-100 bg-amber-50/40 p-3">
                      <div className="text-[12px]" style={{ fontWeight: 600 }}>{alert.title}</div>
                      <div className="text-[11px] text-muted-foreground mt-1">{alert.message}</div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-0 shadow-sm overflow-hidden">
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ClipboardList className="w-4 h-4 text-violet-500" />
                  <span className="text-[13px]" style={{ fontWeight: 600 }}>Open Tasks</span>
                </div>
                <Badge className="border-0 bg-violet-100 text-violet-700">{tasks.length}</Badge>
              </div>
              {tasks.length === 0 ? (
                <EmptyState message="No open tasks in the current scope." icon={ClipboardList} />
              ) : (
                <div className="space-y-2">
                  {tasks.slice(0, 6).map((task) => (
                    <div key={task.id} className="rounded-lg border border-gray-100 p-3">
                      <div className="flex items-center gap-2">
                        <span className="text-[12px]" style={{ fontWeight: 600 }}>{task.description}</span>
                        {task.blocking && <Badge className="border-0 bg-amber-100 text-amber-700 text-[9px]">Blocking</Badge>}
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-1">
                        {task.taskType} · {task.encounter?.patientId || task.patientId || "Encounter"}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  color,
}: {
  label: string;
  value: string | number;
  hint: string;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <Card className="border-0 shadow-sm overflow-hidden">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] text-muted-foreground uppercase tracking-wider" style={{ fontWeight: 600 }}>{label}</div>
            <div className="text-[24px] mt-1" style={{ fontWeight: 700, lineHeight: 1 }}>{value}</div>
            <div className="text-[11px] text-muted-foreground mt-1">{hint}</div>
          </div>
          <div className={`w-10 h-10 rounded-xl ${color} text-white flex items-center justify-center shrink-0`}>
            <Icon className="w-5 h-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50/60 px-3 py-2.5">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider" style={{ fontWeight: 600 }}>{label}</div>
      <div className="text-[18px] mt-1" style={{ fontWeight: 700, lineHeight: 1 }}>{value}</div>
    </div>
  );
}

function EmptyState({ message, icon: Icon }: { message: string; icon: React.ElementType }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50/60 p-4 text-center text-muted-foreground">
      <Icon className="w-5 h-5 text-gray-300 mx-auto mb-2" />
      <p className="text-[12px]">{message}</p>
    </div>
  );
}
