import { useCallback, useEffect, useMemo, useState, type ElementType } from "react";
import { useNavigate, useSearchParams } from "react-router";
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

const statusStyles: Record<RoomOperationalStatus, { label: string; color: string; bg: string; border: string; bar: string }> = {
  Ready: { label: "Ready", color: "text-emerald-700", bg: "bg-emerald-50", border: "border-emerald-200", bar: "bg-emerald-500" },
  NotReady: { label: "Not ready", color: "text-slate-700", bg: "bg-slate-100", border: "border-slate-200", bar: "bg-slate-400" },
  Occupied: { label: "Occupied", color: "text-blue-700", bg: "bg-blue-50", border: "border-blue-200", bar: "bg-blue-500" },
  NeedsTurnover: { label: "Needs turnover", color: "text-amber-700", bg: "bg-amber-50", border: "border-amber-200", bar: "bg-amber-500" },
  Hold: { label: "Hold", color: "text-rose-700", bg: "bg-rose-50", border: "border-rose-200", bar: "bg-rose-500" }
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
  "No room left in turnover or occupied",
  "Open issues acknowledged or placed on hold",
  "Office manager follow-up tasks created",
  "Room reset for tomorrow"
];

function checklistItems(kind: RoomChecklistKind) {
  return kind === "DayStart" ? dayStartItems : dayEndItems;
}

function checklistTitle(kind: RoomChecklistKind) {
  return kind === "DayStart" ? "Day Start" : "Day End";
}

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

function actionLabel(room: RoomLiveCard) {
  if (room.operationalStatus === "NeedsTurnover") return "Mark ready";
  if (room.operationalStatus === "NotReady") return "Run Day Start";
  if (room.operationalStatus === "Hold") return "Clear hold";
  if (room.operationalStatus === "Occupied") return "View encounter";
  return "Details";
}

function RoomCard({
  room,
  onOpen,
  onAction,
  onChecklist
}: {
  room: RoomLiveCard;
  onOpen: () => void;
  onAction: () => void;
  onChecklist: (kind: RoomChecklistKind) => void;
}) {
  const style = statusStyles[room.operationalStatus];
  return (
    <Card className={`border shadow-sm overflow-hidden ${style.border}`}>
      <div className={`h-1 ${style.bar}`} />
      <CardContent className="p-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className={`w-8 h-8 rounded-xl ${style.bg} flex items-center justify-center shrink-0`}>
              <DoorOpen className={`w-4 h-4 ${style.color}`} />
            </div>
            <div className="min-w-0">
              <h3 className="text-[15px] leading-tight truncate" style={{ fontWeight: 700 }}>{room.name}</h3>
              <p className="text-[11px] text-muted-foreground truncate">{room.clinicName}</p>
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
          {!room.assignable && room.readinessBlockedReason && <Badge className="border-0 bg-slate-100 text-slate-600 text-[10px] h-5">{room.readinessBlockedReason}</Badge>}
          <Badge className="border border-dashed border-gray-200 bg-white text-gray-400 text-[10px] h-5">Supply slot</Badge>
          <Badge className="border border-dashed border-gray-200 bg-white text-gray-400 text-[10px] h-5">Audit slot</Badge>
        </div>

        {room.holdNote && <p className="text-[11px] text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">{room.holdNote}</p>}

        <div className="grid grid-cols-2 gap-2 pt-1">
          <button onClick={onAction} className="h-9 px-3 rounded-lg bg-slate-900 text-white text-[12px] hover:bg-slate-800 transition-colors" style={{ fontWeight: 600 }}>
            {actionLabel(room)}
          </button>
          <button onClick={onOpen} className="h-9 px-3 rounded-lg border border-gray-200 text-[12px] text-gray-700 hover:bg-gray-50 transition-colors">
            Room detail
          </button>
          <button onClick={() => onChecklist("DayStart")} className="h-8 px-3 rounded-lg border border-emerald-100 bg-emerald-50 text-[11px] text-emerald-700 hover:bg-emerald-100 transition-colors">
            Day Start
          </button>
          <button onClick={() => onChecklist("DayEnd")} className="h-8 px-3 rounded-lg border border-slate-200 bg-slate-50 text-[11px] text-slate-700 hover:bg-slate-100 transition-colors">
            Day End
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

function ComingLater({ title, body, icon: Icon }: { title: string; body: string; icon: ElementType }) {
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
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(searchParams.get("tab") || "live");
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
  const [checklistRoomId, setChecklistRoomId] = useState(searchParams.get("roomId") || "");
  const [checklistKind, setChecklistKind] = useState<RoomChecklistKind>((searchParams.get("kind") as RoomChecklistKind) || "DayStart");
  const [checkedItems, setCheckedItems] = useState<Record<string, boolean>>({});

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
    const nextTab = searchParams.get("tab") || "live";
    const nextRoomId = searchParams.get("roomId") || "";
    const nextKind = (searchParams.get("kind") as RoomChecklistKind) || "DayStart";
    setTab(nextTab);
    if (nextRoomId) setChecklistRoomId(nextRoomId);
    if (nextKind === "DayStart" || nextKind === "DayEnd") setChecklistKind(nextKind);
  }, [searchParams]);

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
    const base: Record<RoomOperationalStatus, number> = { Ready: 0, NotReady: 0, Occupied: 0, NeedsTurnover: 0, Hold: 0 };
    roomCards.forEach((room) => {
      base[room.operationalStatus] += 1;
    });
    return base;
  }, [roomCards]);

  const selectedChecklistRoom = useMemo(
    () => roomCards.find((room) => room.id === checklistRoomId || room.roomId === checklistRoomId) || roomCards[0] || null,
    [checklistRoomId, roomCards]
  );

  const currentChecklistLabels = checklistItems(checklistKind);
  const allChecklistItemsChecked = currentChecklistLabels.every((label) => checkedItems[label]);

  useEffect(() => {
    const room = selectedChecklistRoom;
    if (!room) return;
    const alreadyComplete = checklistKind === "DayStart" ? room.dayStartCompleted : room.dayEndCompleted;
    setCheckedItems(
      Object.fromEntries(currentChecklistLabels.map((label) => [label, alreadyComplete]))
    );
  }, [checklistKind, selectedChecklistRoom?.id]);

  function openChecklist(room: RoomLiveCard, kind: RoomChecklistKind) {
    setSelectedRoom(null);
    setTab("open-close");
    setChecklistRoomId(room.id);
    setChecklistKind(kind);
    setSearchParams({ tab: "open-close", roomId: room.roomId, kind });
  }

  async function runRoomAction(room: RoomLiveCard) {
    if (room.operationalStatus === "Occupied" && room.currentEncounter?.id) {
      navigate(`/encounter/${room.currentEncounter.id}`);
      return;
    }
    if (room.operationalStatus === "NotReady") {
      openChecklist(room, "DayStart");
      return;
    }
    setBusyAction(room.roomId);
    try {
      if (room.operationalStatus === "NeedsTurnover") {
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
    if (!allChecklistItemsChecked) {
      toast.error("Checklist incomplete", { description: "Check each item before completing this room." });
      return;
    }
    setBusyAction(`${kind}:${room.roomId}`);
    try {
      const items = checklistItems(kind).map((label, index) => ({
        key: `${kind.toLowerCase()}_${index + 1}`,
        label,
        completed: true
      }));
      await roomsApi.submitChecklist(kind, { roomId: room.roomId, clinicId: room.clinicId, items, completed: true });
      toast.success(`${checklistTitle(kind)} completed for ${room.name}`);
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
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <div className="w-11 h-11 rounded-2xl bg-slate-900 text-white flex items-center justify-center mb-3">
              <DoorOpen className="w-5 h-5" />
            </div>
            <h1 className="text-[26px] tracking-tight" style={{ fontWeight: 800 }}>Rooms</h1>
            <p className="text-[13px] text-muted-foreground mt-1 max-w-2xl">
              Live room readiness, turnover, holds, and Office Manager follow-up tasks. Day Start controls whether a room is assignable today.
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

      <Tabs value={tab} onValueChange={(value) => { setTab(value); setSearchParams(value === "live" ? {} : { tab: value }); }}>
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
                  <RoomCard
                    room={room}
                    onOpen={() => setSelectedRoom(room)}
                    onAction={() => runRoomAction(room).catch(() => undefined)}
                    onChecklist={(kind) => openChecklist(room, kind)}
                  />
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="open-close" className="mt-4">
          <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4">
            <Card className="border-0 shadow-sm">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-[15px]" style={{ fontWeight: 700 }}>Room checklist</h2>
                    <p className="text-[12px] text-muted-foreground">Choose a room, then check each item before completing.</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {(["DayStart", "DayEnd"] as RoomChecklistKind[]).map((kind) => (
                    <button
                      key={kind}
                      onClick={() => setChecklistKind(kind)}
                      className={`h-9 rounded-lg border text-[12px] ${checklistKind === kind ? "border-slate-900 bg-slate-900 text-white" : "border-gray-200 bg-white text-slate-700 hover:bg-gray-50"}`}
                    >
                      {checklistTitle(kind)}
                    </button>
                  ))}
                </div>
                <div className="space-y-2 max-h-[520px] overflow-auto pr-1">
                  {roomCards.map((room) => {
                    const complete = checklistKind === "DayStart" ? room.dayStartCompleted : room.dayEndCompleted;
                    const selected = selectedChecklistRoom?.id === room.id;
                    return (
                      <button
                        key={room.id}
                        onClick={() => setChecklistRoomId(room.id)}
                        className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${selected ? "border-slate-900 bg-slate-50" : "border-gray-200 hover:bg-gray-50"}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[12px]" style={{ fontWeight: 700 }}>{room.name}</span>
                          {complete ? <Badge className="border-0 bg-emerald-100 text-emerald-700 text-[10px] h-5">Done</Badge> : statusBadge(room.operationalStatus)}
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">{room.clinicName}</div>
                      </button>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            <Card className="border-0 shadow-sm">
              <CardContent className="p-5 space-y-5">
                {!selectedChecklistRoom ? (
                  <div className="p-8 text-center text-[13px] text-muted-foreground">Select a room to begin.</div>
                ) : (
                  <>
                    <div className="flex flex-col md:flex-row md:items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          {checklistKind === "DayStart" ? <ShieldCheck className="w-5 h-5 text-emerald-600" /> : <ClipboardCheck className="w-5 h-5 text-slate-700" />}
                          <h2 className="text-[17px]" style={{ fontWeight: 800 }}>{checklistTitle(checklistKind)}: {selectedChecklistRoom.name}</h2>
                        </div>
                        <p className="text-[12px] text-muted-foreground mt-1">{selectedChecklistRoom.clinicName}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {statusBadge(selectedChecklistRoom.operationalStatus)}
                        {(checklistKind === "DayStart" ? selectedChecklistRoom.dayStartCompleted : selectedChecklistRoom.dayEndCompleted) && (
                          <Badge className="border-0 bg-emerald-100 text-emerald-700 text-[10px] h-5">Completed today</Badge>
                        )}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4 space-y-3">
                      {currentChecklistLabels.map((label, index) => (
                        <label key={label} className="flex items-start gap-3 rounded-xl border border-white bg-white px-3 py-3 text-[13px] shadow-sm cursor-pointer">
                          <input
                            type="checkbox"
                            checked={!!checkedItems[label]}
                            onChange={(event) => setCheckedItems((current) => ({ ...current, [label]: event.target.checked }))}
                            className="mt-0.5 h-4 w-4 rounded border-gray-300"
                          />
                          <span><span className="text-muted-foreground mr-1">{index + 1}.</span>{label}</span>
                        </label>
                      ))}
                    </div>

                    {checklistKind === "DayStart" && selectedChecklistRoom.operationalStatus === "NotReady" && (
                      <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-[12px] text-amber-800">
                        This room cannot be used for rooming until Day Start is completed today.
                      </div>
                    )}

                    <button
                      onClick={() => completeChecklist(selectedChecklistRoom, checklistKind).catch(() => undefined)}
                      disabled={!allChecklistItemsChecked || busyAction === `${checklistKind}:${selectedChecklistRoom.roomId}`}
                      className="h-10 px-4 rounded-xl bg-slate-900 text-white text-[12px] disabled:opacity-50 flex items-center justify-center gap-2"
                      style={{ fontWeight: 700 }}
                    >
                      {busyAction === `${checklistKind}:${selectedChecklistRoom.roomId}` && <Loader2 className="w-4 h-4 animate-spin" />}
                      Complete {checklistTitle(checklistKind)}
                    </button>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="issues" className="mt-4">
          <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-4">
            <Card className="border-0 shadow-sm">
              <CardContent className="p-5 space-y-4">
                <h2 className="text-[15px]" style={{ fontWeight: 700 }}>Report issue</h2>
                <select aria-label="Issue room" value={issueRoom?.id || ""} onChange={(event) => setIssueRoom(roomCards.find((room) => room.id === event.target.value) || null)} className="w-full h-10 rounded-lg border border-gray-200 px-3 text-[12px] bg-white">
                  <option value="">Select room...</option>
                  {roomCards.map((room) => <option key={room.id} value={room.id}>{room.name} - {room.clinicName}</option>)}
                </select>
                <select aria-label="Issue type" value={issueType} onChange={(event) => setIssueType(event.target.value as RoomIssueType)} className="w-full h-10 rounded-lg border border-gray-200 px-3 text-[12px] bg-white">
                  {issueTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                </select>
                <input aria-label="Issue title" value={issueTitle} onChange={(event) => setIssueTitle(event.target.value)} placeholder="Issue title" className="w-full h-10 rounded-lg border border-gray-200 px-3 text-[12px]" />
                <textarea aria-label="Issue note" value={issueDescription} onChange={(event) => setIssueDescription(event.target.value)} placeholder="Optional note" className="w-full min-h-[88px] rounded-lg border border-gray-200 px-3 py-2 text-[12px]" />
                <label className="flex items-center gap-2 text-[12px]"><input aria-label="Place room on hold" type="checkbox" checked={issueHold} onChange={(event) => setIssueHold(event.target.checked)} /> Place room on hold</label>
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
                  <div className="flex items-center justify-between">{statusBadge(selectedRoom?.operationalStatus || detail.operationalState.currentStatus)}<span className="text-[11px] text-muted-foreground">Since {formatDateTime(detail.operationalState.statusSinceAt)}</span></div>
                  {detail.operationalState.occupiedEncounter && (
                    <button onClick={() => navigate(`/encounter/${detail.operationalState.occupiedEncounter?.id}`)} className="w-full h-10 rounded-lg bg-blue-50 border border-blue-100 text-blue-700 text-[12px] flex items-center justify-center gap-2"><Stethoscope className="w-4 h-4" /> View linked encounter {detail.operationalState.occupiedEncounter.patientId}</button>
                  )}
                  {detail.operationalState.holdNote && <div className="rounded-lg bg-rose-50 border border-rose-100 px-3 py-2 text-[12px] text-rose-700">{detail.operationalState.holdNote}</div>}
                </CardContent>
              </Card>

              {selectedRoom && (
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => openChecklist(selectedRoom, "DayStart")} className="h-10 rounded-lg border border-gray-200 text-[12px] hover:bg-gray-50">Open Day Start</button>
                  <button onClick={() => openChecklist(selectedRoom, "DayEnd")} className="h-10 rounded-lg border border-gray-200 text-[12px] hover:bg-gray-50">Open Day End</button>
                </div>
              )}

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
