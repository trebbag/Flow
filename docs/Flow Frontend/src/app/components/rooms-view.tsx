import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  BadgeCheck,
  ClipboardCheck,
  Clock3,
  DoorOpen,
  Loader2,
  Lock,
  PackageOpen,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Stethoscope,
} from "lucide-react";
import { toast } from "sonner";
import {
  rooms as roomsApi,
  type RoomChecklistKind,
  type RoomDetail,
  type RoomIssue,
  type RoomIssueType,
  type RoomLiveCard,
  type RoomOperationalStatus
} from "./api-client";
import { ADMIN_REFRESH_EVENT, FACILITY_CONTEXT_CHANGED_EVENT, dispatchAdminRefresh } from "./app-events";
import { Badge } from "./ui/badge";
import { Card, CardContent } from "./ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "./ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

const statusStyles: Record<RoomOperationalStatus, { label: string; color: string; bg: string; border: string }> = {
  Ready: { label: "Ready", color: "text-emerald-700", bg: "bg-emerald-50", border: "border-emerald-200" },
  Occupied: { label: "Occupied", color: "text-blue-700", bg: "bg-blue-50", border: "border-blue-200" },
  NeedsTurnover: { label: "Needs turnover", color: "text-amber-700", bg: "bg-amber-50", border: "border-amber-200" },
  Cleaning: { label: "Cleaning", color: "text-cyan-700", bg: "bg-cyan-50", border: "border-cyan-200" },
  Hold: { label: "Hold", color: "text-rose-700", bg: "bg-rose-50", border: "border-rose-200" }
};

const issueTypes: Array<{ value: RoomIssueType; label: string }> = [
  { value: "Equipment", label: "Equipment" },
  { value: "Maintenance", label: "Maintenance" },
  { value: "General", label: "General" }
];

const dayStartItems = [
  "Room visually ready",
  "Supplies and equipment baseline present",
  "No unresolved prior-day hold",
  "Room status set appropriately"
];

const dayEndItems = [
  "No room left in turnover or cleaning",
  "Open issues acknowledged or placed on hold",
  "Office manager follow-up tasks created",
  "Room reset for tomorrow"
];

function statusBadge(status: RoomOperationalStatus) {
  const style = statusStyles[status];
  return <Badge className={`border ${style.border} ${style.bg} ${style.color} text-[10px] h-5`}>{style.label}</Badge>;
}

function formatDateTime(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function actionLabel(status: RoomOperationalStatus) {
  if (status === "NeedsTurnover") return "Start cleaning";
  if (status === "Cleaning") return "Mark ready";
  if (status === "Hold") return "Clear hold";
  if (status === "Occupied") return "View encounter";
  return "Details";
}

function RoomCard({ room, onOpen, onAction }: { room: RoomLiveCard; onOpen: () => void; onAction: () => void }) {
  const style = statusStyles[room.operationalStatus];
  return (
    <Card className={`border shadow-sm overflow-hidden ${style.border}`}>
      <div className={`h-1 ${room.operationalStatus === "Ready" ? "bg-emerald-500" : room.operationalStatus === "Hold" ? "bg-rose-500" : "bg-slate-800"}`} />
      <CardContent className="p-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <div className={`w-8 h-8 rounded-xl ${style.bg} flex items-center justify-center`}>
                <DoorOpen className={`w-4 h-4 ${style.color}`} />
              </div>
              <div>
                <h3 className="text-[15px] leading-tight" style={{ fontWeight: 700 }}>{room.name}</h3>
                <p className="text-[11px] text-muted-foreground">{room.clinicName}</p>
              </div>
            </div>
          </div>
          {statusBadge(room.operationalStatus)}
        </div>

        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
            <div className="text-muted-foreground">In status</div>
            <div className="mt-0.5 flex items-center gap-1 text-gray-800" style={{ fontWeight: 600 }}>
              <Clock3 className="w-3 h-3" /> {room.timerLabel}
            </div>
          </div>
          <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
            <div className="text-muted-foreground">Patient</div>
            <div className="mt-0.5 truncate text-gray-800" style={{ fontWeight: 600 }}>
              {room.currentEncounter?.patientId || "None"}
            </div>
          </div>
        </div>

        <div className="min-h-6 flex flex-wrap gap-1.5">
          {room.hasOpenIssue && <Badge className="border-0 bg-amber-100 text-amber-700 text-[10px] h-5">{room.issueCount} issue{room.issueCount === 1 ? "" : "s"}</Badge>}
          {room.operationalStatus === "Hold" && <Badge className="border-0 bg-rose-100 text-rose-700 text-[10px] h-5">Hold</Badge>}
          {!room.dayStartCompleted && <Badge className="border-0 bg-slate-100 text-slate-600 text-[10px] h-5">Day start open</Badge>}
          {!room.dayEndCompleted && <Badge className="border-0 bg-slate-100 text-slate-600 text-[10px] h-5">Day end open</Badge>}
          <Badge className="border border-dashed border-gray-200 bg-white text-gray-400 text-[10px] h-5">Supply slot</Badge>
          <Badge className="border border-dashed border-gray-200 bg-white text-gray-400 text-[10px] h-5">Audit slot</Badge>
        </div>

        {room.holdNote && <p className="text-[11px] text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">{room.holdNote}</p>}

        <div className="flex items-center gap-2 pt-1">
          <button onClick={onAction} className="h-9 px-3 rounded-lg bg-slate-900 text-white text-[12px] hover:bg-slate-800 transition-colors" style={{ fontWeight: 600 }}>
            {actionLabel(room.operationalStatus)}
          </button>
          <button onClick={onOpen} className="h-9 px-3 rounded-lg border border-gray-200 text-[12px] text-gray-700 hover:bg-gray-50 transition-colors">
            Open drawer
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

function ComingLater({ title, body, icon: Icon }: { title: string; body: string; icon: React.ElementType }) {
  return (
    <Card className="border-dashed border-gray-200 shadow-none bg-white/70">
      <CardContent className="p-10 text-center">
        <div className="w-12 h-12 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-3">
          <Icon className="w-5 h-5 text-slate-500" />
        </div>
        <h3 className="text-[15px]" style={{ fontWeight: 700 }}>{title}</h3>
        <p className="text-[12px] text-muted-foreground max-w-md mx-auto mt-1">{body}</p>
      </CardContent>
    </Card>
  );
}

export function RoomsView() {
  const navigate = useNavigate();
  const [tab, setTab] = useState("live");
  const [roomCards, setRoomCards] = useState<RoomLiveCard[]>([]);
  const [issues, setIssues] = useState<RoomIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRoom, setSelectedRoom] = useState<RoomLiveCard | null>(null);
  const [detail, setDetail] = useState<RoomDetail | null>(null);
  const [issueRoom, setIssueRoom] = useState<RoomLiveCard | null>(null);
  const [issueType, setIssueType] = useState<RoomIssueType>("General");
  const [issueTitle, setIssueTitle] = useState("");
  const [issueDescription, setIssueDescription] = useState("");
  const [issueHold, setIssueHold] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cards, issueRows] = await Promise.all([
        roomsApi.live({ mine: true }),
        roomsApi.listIssues()
      ]);
      setRoomCards(cards || []);
      setIssues(issueRows || []);
    } catch (error) {
      toast.error("Failed to load Rooms", { description: (error as Error).message });
      setRoomCards([]);
      setIssues([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  useEffect(() => {
    const onRefresh = () => load().catch(() => undefined);
    window.addEventListener(ADMIN_REFRESH_EVENT, onRefresh);
    window.addEventListener(FACILITY_CONTEXT_CHANGED_EVENT, onRefresh);
    return () => {
      window.removeEventListener(ADMIN_REFRESH_EVENT, onRefresh);
      window.removeEventListener(FACILITY_CONTEXT_CHANGED_EVENT, onRefresh);
    };
  }, [load]);

  useEffect(() => {
    let active = true;
    if (!selectedRoom) {
      setDetail(null);
      return;
    }
    roomsApi.detail(selectedRoom.roomId, { clinicId: selectedRoom.clinicId })
      .then((payload) => {
        if (active) setDetail(payload);
      })
      .catch((error) => {
        if (active) toast.error("Failed to load room detail", { description: (error as Error).message });
      });
    return () => {
      active = false;
    };
  }, [selectedRoom]);

  const counts = useMemo(() => {
    const base: Record<RoomOperationalStatus, number> = { Ready: 0, Occupied: 0, NeedsTurnover: 0, Cleaning: 0, Hold: 0 };
    roomCards.forEach((room) => {
      base[room.operationalStatus] += 1;
    });
    return base;
  }, [roomCards]);

  async function runRoomAction(room: RoomLiveCard) {
    if (room.operationalStatus === "Occupied" && room.currentEncounter?.id) {
      navigate(`/encounter/${room.currentEncounter.id}`);
      return;
    }
    setBusyAction(room.roomId);
    try {
      if (room.operationalStatus === "NeedsTurnover") {
        await roomsApi.startCleaning(room.roomId, { clinicId: room.clinicId });
        toast.success(`${room.name} cleaning started`);
      } else if (room.operationalStatus === "Cleaning") {
        await roomsApi.markReady(room.roomId, { clinicId: room.clinicId });
        toast.success(`${room.name} marked ready`);
      } else if (room.operationalStatus === "Hold") {
        await roomsApi.clearHold(room.roomId, { clinicId: room.clinicId, targetStatus: "Ready" });
        toast.success(`${room.name} hold cleared`);
      } else {
        setSelectedRoom(room);
      }
      dispatchAdminRefresh();
      await load();
    } catch (error) {
      toast.error("Room action failed", { description: (error as Error).message });
    } finally {
      setBusyAction(null);
    }
  }

  async function submitIssue() {
    if (!issueRoom || !issueTitle.trim()) return;
    setBusyAction(`issue:${issueRoom.roomId}`);
    try {
      await roomsApi.createIssue(issueRoom.roomId, {
        clinicId: issueRoom.clinicId,
        issueType,
        title: issueTitle.trim(),
        description: issueDescription.trim() || undefined,
        placesRoomOnHold: issueHold,
        severity: issueHold ? 3 : 1
      });
      toast.success("Room issue created", { description: "Office Manager task generated" });
      setIssueRoom(null);
      setIssueTitle("");
      setIssueDescription("");
      setIssueHold(false);
      setIssueType("General");
      dispatchAdminRefresh();
      await load();
    } catch (error) {
      toast.error("Unable to create room issue", { description: (error as Error).message });
    } finally {
      setBusyAction(null);
    }
  }

  async function completeChecklist(room: RoomLiveCard, kind: RoomChecklistKind) {
    setBusyAction(`${kind}:${room.roomId}`);
    try {
      const items = (kind === "DayStart" ? dayStartItems : dayEndItems).map((label, index) => ({
        key: `${kind.toLowerCase()}_${index + 1}`,
        label,
        completed: true
      }));
      await roomsApi.submitChecklist(kind, { roomId: room.roomId, clinicId: room.clinicId, items, completed: true });
      toast.success(`${kind === "DayStart" ? "Day Start" : "Day End"} completed for ${room.name}`);
      dispatchAdminRefresh();
      await load();
    } catch (error) {
      toast.error("Checklist failed", { description: (error as Error).message });
    } finally {
      setBusyAction(null);
    }
  }

  async function resolveIssue(issue: RoomIssue) {
    setBusyAction(`resolve:${issue.id}`);
    try {
      await roomsApi.updateIssue(issue.id, { status: "Resolved", resolutionNote: "Resolved from Rooms console" });
      toast.success("Issue resolved");
      dispatchAdminRefresh();
      await load();
    } catch (error) {
      toast.error("Unable to resolve issue", { description: (error as Error).message });
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="p-6 space-y-5 max-w-[1320px] mx-auto">
      <div className="relative overflow-hidden rounded-3xl border border-slate-200 bg-[radial-gradient(circle_at_top_left,#dbeafe,transparent_32%),linear-gradient(135deg,#ffffff,#f8fafc)] p-6 shadow-sm">
        <div className="absolute right-6 top-5 hidden md:flex items-center gap-2 text-[11px] text-slate-500">
          <Sparkles className="w-3.5 h-3.5" /> Designed from Figma Rooms MVP
        </div>
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <div className="w-11 h-11 rounded-2xl bg-slate-900 text-white flex items-center justify-center mb-3">
              <DoorOpen className="w-5 h-5" />
            </div>
            <h1 className="text-[26px] tracking-tight" style={{ fontWeight: 800 }}>Rooms</h1>
            <p className="text-[13px] text-muted-foreground mt-1 max-w-2xl">
              Live room readiness, turnover, holds, day start/day end, and Office Manager follow-up tasks.
            </p>
          </div>
          <button onClick={() => load().catch(() => undefined)} className="h-10 px-4 rounded-xl border border-slate-200 bg-white text-[12px] text-slate-700 hover:bg-slate-50 flex items-center gap-2">
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mt-6">
          {(Object.keys(statusStyles) as RoomOperationalStatus[]).map((status) => (
            <div key={status} className={`rounded-2xl border ${statusStyles[status].border} ${statusStyles[status].bg} px-4 py-3`}>
              <div className={`text-[20px] ${statusStyles[status].color}`} style={{ fontWeight: 800 }}>{counts[status]}</div>
              <div className="text-[11px] text-slate-600">{statusStyles[status].label}</div>
            </div>
          ))}
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="bg-white border border-gray-200 p-1 rounded-2xl h-auto gap-1 flex-wrap">
          <TabsTrigger value="live" className="text-[12px] rounded-xl px-4 py-2">Live</TabsTrigger>
          <TabsTrigger value="open-close" className="text-[12px] rounded-xl px-4 py-2">Open / Close</TabsTrigger>
          <TabsTrigger value="issues" className="text-[12px] rounded-xl px-4 py-2">Issues</TabsTrigger>
          <TabsTrigger value="supplies" className="text-[12px] rounded-xl px-4 py-2">Supplies</TabsTrigger>
          <TabsTrigger value="audits" className="text-[12px] rounded-xl px-4 py-2">Audits</TabsTrigger>
        </TabsList>

        <TabsContent value="live" className="mt-4">
          {loading ? (
            <Card className="border-0 shadow-sm"><CardContent className="p-10 text-center text-[13px] text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />Loading rooms...</CardContent></Card>
          ) : roomCards.length === 0 ? (
            <Card className="border-0 shadow-sm"><CardContent className="p-10 text-center text-[13px] text-muted-foreground">No rooms are available in your scope.</CardContent></Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {roomCards.map((room) => (
                <div key={room.id} className={busyAction === room.roomId ? "opacity-70 pointer-events-none" : ""}>
                  <RoomCard room={room} onOpen={() => setSelectedRoom(room)} onAction={() => runRoomAction(room).catch(() => undefined)} />
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="open-close" className="mt-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card className="border-0 shadow-sm">
              <CardContent className="p-5 space-y-4">
                <div className="flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-emerald-600" /><h2 className="text-[15px]" style={{ fontWeight: 700 }}>Day Start</h2></div>
                <div className="space-y-2">{dayStartItems.map((item) => <div key={item} className="text-[12px] rounded-lg bg-emerald-50 border border-emerald-100 px-3 py-2">{item}</div>)}</div>
                <div className="space-y-2 max-h-[360px] overflow-auto">
                  {roomCards.map((room) => (
                    <button key={room.id} onClick={() => completeChecklist(room, "DayStart").catch(() => undefined)} disabled={room.dayStartCompleted} className="w-full h-10 rounded-lg border border-gray-200 px-3 text-[12px] text-left hover:bg-gray-50 disabled:bg-emerald-50 disabled:text-emerald-700">
                      {room.dayStartCompleted ? "Completed" : "Complete"} - {room.name} / {room.clinicName}
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
            <Card className="border-0 shadow-sm">
              <CardContent className="p-5 space-y-4">
                <div className="flex items-center gap-2"><ClipboardCheck className="w-5 h-5 text-slate-700" /><h2 className="text-[15px]" style={{ fontWeight: 700 }}>Day End</h2></div>
                <div className="space-y-2">{dayEndItems.map((item) => <div key={item} className="text-[12px] rounded-lg bg-slate-50 border border-slate-100 px-3 py-2">{item}</div>)}</div>
                <div className="space-y-2 max-h-[360px] overflow-auto">
                  {roomCards.map((room) => (
                    <button key={room.id} onClick={() => completeChecklist(room, "DayEnd").catch(() => undefined)} disabled={room.dayEndCompleted} className="w-full h-10 rounded-lg border border-gray-200 px-3 text-[12px] text-left hover:bg-gray-50 disabled:bg-emerald-50 disabled:text-emerald-700">
                      {room.dayEndCompleted ? "Completed" : "Complete"} - {room.name} / {room.clinicName}
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="issues" className="mt-4">
          <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-4">
            <Card className="border-0 shadow-sm">
              <CardContent className="p-5 space-y-4">
                <h2 className="text-[15px]" style={{ fontWeight: 700 }}>Report issue</h2>
                <select value={issueRoom?.id || ""} onChange={(event) => setIssueRoom(roomCards.find((room) => room.id === event.target.value) || null)} className="w-full h-10 rounded-lg border border-gray-200 px-3 text-[12px] bg-white">
                  <option value="">Select room...</option>
                  {roomCards.map((room) => <option key={room.id} value={room.id}>{room.name} - {room.clinicName}</option>)}
                </select>
                <select value={issueType} onChange={(event) => setIssueType(event.target.value as RoomIssueType)} className="w-full h-10 rounded-lg border border-gray-200 px-3 text-[12px] bg-white">
                  {issueTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                </select>
                <input value={issueTitle} onChange={(event) => setIssueTitle(event.target.value)} placeholder="Issue title" className="w-full h-10 rounded-lg border border-gray-200 px-3 text-[12px]" />
                <textarea value={issueDescription} onChange={(event) => setIssueDescription(event.target.value)} placeholder="Optional note" className="w-full min-h-[88px] rounded-lg border border-gray-200 px-3 py-2 text-[12px]" />
                <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={issueHold} onChange={(event) => setIssueHold(event.target.checked)} /> Place room on hold</label>
                <button onClick={() => submitIssue().catch(() => undefined)} disabled={!issueRoom || !issueTitle.trim()} className="w-full h-10 rounded-lg bg-slate-900 text-white text-[12px] disabled:opacity-50">Create Office Manager task</button>
              </CardContent>
            </Card>
            <div className="space-y-2">
              {issues.length === 0 ? <Card className="border-0 shadow-sm"><CardContent className="p-8 text-center text-[13px] text-muted-foreground">No open room issues.</CardContent></Card> : issues.map((issue) => (
                <Card key={issue.id} className="border-0 shadow-sm">
                  <CardContent className="p-4 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge className="border-0 bg-amber-100 text-amber-700 text-[10px] h-5">{issue.issueType}</Badge>
                        {issue.placesRoomOnHold && <Badge className="border-0 bg-rose-100 text-rose-700 text-[10px] h-5">Hold</Badge>}
                        <Badge className="border-0 bg-slate-100 text-slate-600 text-[10px] h-5">Task {issue.taskId ? "created" : "missing"}</Badge>
                      </div>
                      <p className="text-[13px]" style={{ fontWeight: 700 }}>{issue.title}</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">{issue.room?.name || issue.roomId} - {formatDateTime(issue.createdAt)}</p>
                      {issue.description && <p className="text-[12px] text-gray-600 mt-2">{issue.description}</p>}
                    </div>
                    <button onClick={() => resolveIssue(issue).catch(() => undefined)} className="h-8 px-3 rounded-lg border border-gray-200 text-[11px] text-gray-700 hover:bg-gray-50">Resolve</button>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="supplies" className="mt-4"><ComingLater title="Supplies coming later" body="The card badges and drawer section are reserved now. Phase 2 adds OK / Low / Out stock actions and Office Manager restock tasks." icon={PackageOpen} /></TabsContent>
        <TabsContent value="audits" className="mt-4"><ComingLater title="Audits coming later" body="The Rooms shell already reserves audit badges and drawer space for fluorescent marker workflows and surface-by-surface results." icon={BadgeCheck} /></TabsContent>
      </Tabs>

      <Sheet open={!!selectedRoom} onOpenChange={(open) => !open && setSelectedRoom(null)}>
        <SheetContent className="sm:max-w-[520px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{selectedRoom?.name || "Room detail"}</SheetTitle>
            <p className="text-[12px] text-muted-foreground">{selectedRoom?.clinicName}</p>
          </SheetHeader>
          {!detail ? (
            <div className="p-6 text-center text-[13px] text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />Loading detail...</div>
          ) : (
            <div className="px-4 pb-6 space-y-4">
              <Card className="border-0 shadow-sm bg-slate-50">
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center justify-between">{statusBadge(detail.operationalState.currentStatus)}<span className="text-[11px] text-muted-foreground">Since {formatDateTime(detail.operationalState.statusSinceAt)}</span></div>
                  {detail.operationalState.occupiedEncounter && (
                    <button onClick={() => navigate(`/encounter/${detail.operationalState.occupiedEncounter?.id}`)} className="w-full h-10 rounded-lg bg-blue-50 border border-blue-100 text-blue-700 text-[12px] flex items-center justify-center gap-2"><Stethoscope className="w-4 h-4" /> View linked encounter {detail.operationalState.occupiedEncounter.patientId}</button>
                  )}
                  {detail.operationalState.holdNote && <div className="rounded-lg bg-rose-50 border border-rose-100 px-3 py-2 text-[12px] text-rose-700">{detail.operationalState.holdNote}</div>}
                </CardContent>
              </Card>

              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => selectedRoom && completeChecklist(selectedRoom, "DayStart").catch(() => undefined)} className="h-10 rounded-lg border border-gray-200 text-[12px] hover:bg-gray-50">Day Start</button>
                <button onClick={() => selectedRoom && completeChecklist(selectedRoom, "DayEnd").catch(() => undefined)} className="h-10 rounded-lg border border-gray-200 text-[12px] hover:bg-gray-50">Day End</button>
              </div>

              <section>
                <h3 className="text-[12px] uppercase tracking-wider text-muted-foreground mb-2" style={{ fontWeight: 700 }}>Open issues</h3>
                <div className="space-y-2">
                  {detail.issues.length === 0 ? <p className="text-[12px] text-muted-foreground">No issues recorded.</p> : detail.issues.slice(0, 5).map((issue) => (
                    <div key={issue.id} className="rounded-lg border border-gray-100 px-3 py-2 text-[12px]"><div style={{ fontWeight: 700 }}>{issue.title}</div><div className="text-muted-foreground">{issue.status} - {issue.issueType}</div></div>
                  ))}
                </div>
              </section>

              <section>
                <h3 className="text-[12px] uppercase tracking-wider text-muted-foreground mb-2" style={{ fontWeight: 700 }}>Timeline</h3>
                <div className="space-y-2">
                  {detail.events.length === 0 ? <p className="text-[12px] text-muted-foreground">No room events yet.</p> : detail.events.map((event) => (
                    <div key={event.id} className="rounded-xl border border-gray-100 bg-white px-3 py-2">
                      <div className="flex items-center justify-between gap-2"><span className="text-[12px]" style={{ fontWeight: 700 }}>{event.eventType}</span><span className="text-[10px] text-muted-foreground">{formatDateTime(event.occurredAt)}</span></div>
                      <p className="text-[11px] text-muted-foreground mt-0.5">{event.fromStatus || "-"} to {event.toStatus || "-"}</p>
                      {event.note && <p className="text-[11px] text-gray-600 mt-1">{event.note}</p>}
                    </div>
                  ))}
                </div>
              </section>

              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl border border-dashed border-gray-200 p-3 text-[12px] text-muted-foreground"><PackageOpen className="w-4 h-4 mb-1" />Supplies: coming later</div>
                <div className="rounded-xl border border-dashed border-gray-200 p-3 text-[12px] text-muted-foreground"><Lock className="w-4 h-4 mb-1" />Audits: coming later</div>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
