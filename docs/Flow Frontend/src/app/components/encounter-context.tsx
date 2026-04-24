import { createContext, useContext, useState, useCallback, useMemo, useEffect, useRef, type ReactNode } from "react";
import {
  type Encounter,
  type EncounterStatus,
  type MATask,
} from "./mock-data";
import {
  admin,
  encounters as encounterApi,
  incoming as incomingApi,
  openAuthenticatedEventStream,
  safety as safetyApi,
  tasks as tasksApi,
  type IncomingRow,
  type BackendTask
} from "./api-client";
import type { Role } from "./types";
import { loadSession } from "./auth-session";
import { labelClinicName, labelProviderName, labelReasonName, labelRoomName, labelUserName } from "./display-names";
import { ADMIN_REFRESH_EVENT, FACILITY_CONTEXT_CHANGED_EVENT } from "./app-events";
import { readEncounterBoardSnapshot, writeEncounterBoardSnapshot } from "./encounter-board-storage";

export type CreatedTask = {
  id: string;
  encounterId: string;
  patientId: string;
  taskType: string;
  description: string;
  assignedToRole: string;
  priority: number;
  blocking: boolean;
  createdAt: string;
};

export type CompletedCheckout = {
  encounterId: string;
  encounter: Encounter;
  checkedItems: string[];
  templateValues: Record<string, string | boolean>;
  completedAt: string;
};

type LiveUser = {
  id: string;
  name: string;
  role: string;
  status?: string;
  clinicId?: string;
  facilityId?: string;
};

type LiveClinic = {
  id: string;
  name: string;
  shortCode?: string;
  cardColor?: string;
  timezone?: string;
  maRun?: boolean;
};

type LiveReason = {
  id: string;
  name: string;
};

type LiveRoom = {
  id: string;
  name: string;
  clinicId?: string;
};

interface EncounterContextType {
  encounters: Encounter[];
  getEncounter: (id: string) => Encounter | undefined;
  fetchEncounter: (id: string, options?: { force?: boolean }) => Promise<Encounter | undefined>;
  getAvailableRoomsForClinic: (clinicId: string) => Array<{ id: string; name: string }>;
  advanceStatus: (id: string, newStatus: EncounterStatus, extras?: Partial<Encounter>) => Promise<Encounter | undefined>;
  updateEncounter: (id: string, overrides: Partial<Encounter>) => void;

  maTasks: MATask[];
  createdTasks: CreatedTask[];
  addTask: (task: Omit<CreatedTask, "id" | "createdAt">) => CreatedTask;
  removeTask: (taskId: string) => void;
  getTasksForEncounter: (encounterId: string) => { maTasks: MATask[]; createdTasks: CreatedTask[] };

  completedCheckouts: CompletedCheckout[];
  completeCheckout: (data: CompletedCheckout) => Promise<Encounter | undefined>;
  getCheckoutData: (encounterId: string) => CompletedCheckout | undefined;

  isLiveMode: boolean;
  isBoardSnapshotStale: boolean;
  syncError: string | null;
  refreshData: () => Promise<void>;
  checkInPatient: (input: {
    patientId: string;
    clinicId: string;
    providerName?: string;
    reasonForVisitId?: string;
    reasonForVisit?: string;
    incomingId?: string;
    walkIn?: boolean;
    insuranceVerified?: boolean;
    intakeData?: Record<string, unknown>;
  }) => Promise<void>;
  activateSafety: (input: { encounterId: string; confirmationWord: string; location?: string }) => Promise<void>;
  resolveSafety: (input: { encounterId: string; confirmationWord: string; resolutionNote?: string }) => Promise<void>;
}

const EncounterContext = createContext<EncounterContextType | null>(null);

function timeFromIso(value?: string | null) {
  if (!value) return "--:--";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "--:--";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function minutesSinceIso(value?: string | null) {
  if (!value) return 0;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 0;
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
}

function initials(input: string) {
  const parts = input.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "--";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] || ""}${parts[1]![0] || ""}`.toUpperCase();
}

function colorFromText(input: string) {
  const palette = ["#6366f1", "#10b981", "#f59e0b", "#ec4899", "#0ea5e9", "#8b5cf6"];
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return palette[Math.abs(hash) % palette.length] || "#6366f1";
}

function normalizeStatus(raw: unknown): EncounterStatus {
  const value = String(raw || "Incoming") as EncounterStatus;
  const allowed: EncounterStatus[] = ["Incoming", "Lobby", "Rooming", "ReadyForProvider", "Optimizing", "CheckOut", "Optimized"];
  return allowed.includes(value) ? value : "Incoming";
}

function normalizeOptionalStatus(raw: unknown): EncounterStatus | null {
  if (!raw) return null;
  const value = String(raw) as EncounterStatus;
  const allowed: EncounterStatus[] = ["Incoming", "Lobby", "Rooming", "ReadyForProvider", "Optimizing", "CheckOut", "Optimized"];
  return allowed.includes(value) ? value : null;
}

function mapTaskType(raw: string): MATask["taskType"] {
  const normalized = raw.toLowerCase();
  if (normalized.includes("room")) return "rooming";
  if (normalized.includes("vital")) return "vitals";
  if (normalized.includes("service")) return "service_capture";
  if (normalized.includes("prep")) return "prep";
  if (normalized.includes("alert")) return "alert_ack";
  if (normalized.includes("assign")) return "reassignment";
  return "followup";
}

function mapTaskStatus(raw: string, completedAt: string | null): MATask["status"] {
  if (completedAt || raw.toLowerCase() === "completed") return "done";
  if (raw.toLowerCase() === "in_progress") return "in_progress";
  return "pending";
}

function mapTaskPriority(raw: number): MATask["priority"] {
  if (raw <= 1) return 1;
  if (raw <= 3) return 2;
  return 3;
}

function isRole(value?: string): value is Role {
  return ["FrontDeskCheckIn", "MA", "Clinician", "FrontDeskCheckOut", "OfficeManager", "Admin", "RevenueCycle"].includes(value || "");
}

function todayIsoDate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function resolveBoardSnapshotScope() {
  const session = loadSession();
  const facilityId = session?.facilityId || "unknown-facility";
  const roleScope = session?.role || "unknown-role";
  const dateKey = todayIsoDate();
  return {
    facilityId,
    roleScope,
    dateKey,
    key: `${facilityId}:${dateKey}:${roleScope}`,
  };
}

export function EncounterProvider({ children }: { children: ReactNode }) {
  const [encounters, setEncounters] = useState<Encounter[]>([]);
  const [maTasks, setMaTasks] = useState<MATask[]>([]);
  const [createdTasks, setCreatedTasks] = useState<CreatedTask[]>([]);
  const [completedCheckouts, setCompletedCheckouts] = useState<CompletedCheckout[]>([]);
  const [isLiveMode, setIsLiveMode] = useState(false);
  const [isBoardSnapshotStale, setIsBoardSnapshotStale] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [encounterCacheVersion, setEncounterCacheVersion] = useState(0);

  const clinicsRef = useRef<Record<string, LiveClinic>>({});
  const reasonsRef = useRef<Record<string, LiveReason>>({});
  const roomsByClinicRef = useRef<Record<string, LiveRoom[]>>({});
  const roomsByIdRef = useRef<Record<string, LiveRoom>>({});
  const usersByIdRef = useRef<Record<string, LiveUser>>({});
  const usersByNameRef = useRef<Record<string, LiveUser>>({});
  const encountersRef = useRef<Encounter[]>([]);
  const maTasksRef = useRef<MATask[]>([]);
  const encounterCacheRef = useRef<Record<string, Encounter>>({});
  const createdTasksRef = useRef<CreatedTask[]>([]);
  const completedCheckoutsRef = useRef<CompletedCheckout[]>([]);
  const snapshotScopeKeyRef = useRef<string | null>(null);
  const liveBoardHydratedRef = useRef(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    encountersRef.current = encounters;
  }, [encounters]);

  useEffect(() => {
    maTasksRef.current = maTasks;
  }, [maTasks]);

  useEffect(() => {
    createdTasksRef.current = createdTasks;
  }, [createdTasks]);

  useEffect(() => {
    completedCheckoutsRef.current = completedCheckouts;
  }, [completedCheckouts]);

  const mapBackendEncounter = useCallback((raw: any): Encounter => {
    const cachedEncounter =
      encounterCacheRef.current[String(raw.id || "")] ||
      encountersRef.current.find((entry) => entry.id === String(raw.id || ""));
    const clinicId = raw.clinicId || raw.clinic?.id || "";
    const reasonId = raw.reasonForVisitId || raw.reason?.id || "";
    const roomId = raw.roomId || raw.room?.id || "";

    const clinic = raw.clinic || clinicsRef.current[clinicId] || null;
    const providerName = labelProviderName(
      raw.providerName || raw.provider?.name || cachedEncounter?.provider || "Unassigned",
      raw.provider?.active,
    );
    const reasonName = labelReasonName(
      raw.reasonForVisit || raw.reasonText || raw.reason?.name || reasonsRef.current[reasonId]?.name || cachedEncounter?.visitType || "Visit",
      raw.reason?.status,
    );
    const assignedMaUser = usersByIdRef.current[raw.assignedMaUserId || ""];
    const assignedMaName = labelUserName(
      raw.maName || raw.assignedMaName || assignedMaUser?.name || "",
      raw.assignedMaStatus || assignedMaUser?.status,
    );
    const roomName = labelRoomName(
      raw.roomName || raw.room?.name || roomsByIdRef.current[roomId]?.name || cachedEncounter?.roomNumber || "",
      raw.room?.status,
    );
    const alertLevel = (raw.alertLevel || raw.alertState?.currentAlertLevel || "Green") as Encounter["alertLevel"];
    const stageStartIso = raw.alertState?.enteredStatusAt || raw.checkInAt || raw.createdAt || null;
    const completedAtIso = raw.checkoutCompleteAt || raw.closedAt || null;
    const statusEvents = Array.isArray(raw.statusEvents)
      ? raw.statusEvents
          .map((event: any) => {
            const toStatus = normalizeOptionalStatus(event?.toStatus);
            const changedAt = event?.changedAt ? String(event.changedAt) : "";
            if (!toStatus || !changedAt) return null;
            return {
              fromStatus: normalizeOptionalStatus(event?.fromStatus),
              toStatus,
              changedAt,
              reasonCode: event?.reasonCode || null,
            };
          })
          .filter(Boolean) as Encounter["statusEvents"]
      : [];

    const safeClinicColor = clinic?.cardColor || colorFromText(clinic?.name || clinicId || "clinic");

    return {
      id: String(raw.id),
      patientId: String(raw.patientId || "UNKNOWN"),
      patientInitials: initials(String(raw.patientId || "PT")),
      clinicId,
      clinicName: labelClinicName(raw.clinicName || clinic?.name || "Clinic", raw.clinic?.status),
      clinicShortCode: clinic?.shortCode || clinic?.name?.slice(0, 2)?.toUpperCase() || "CL",
      clinicColor: safeClinicColor,
      maRun: Boolean(raw.clinic?.maRun ?? clinic?.maRun),
      provider: providerName,
      providerInitials: initials(providerName),
      visitType: reasonName,
      status: normalizeStatus(raw.status || raw.currentStatus),
      version: Number(raw.version || 0),
      checkinTime: timeFromIso(raw.checkInAt || raw.checkinTime),
      appointmentTime: raw.appointmentTime || undefined,
      currentStageStart: timeFromIso(stageStartIso),
      checkInAtIso: raw.checkInAt || raw.checkinTime || null,
      currentStageStartAtIso: stageStartIso,
      completedAtIso,
      minutesInStage: minutesSinceIso(stageStartIso),
      alertLevel: alertLevel === "Red" || alertLevel === "Yellow" ? alertLevel : "Green",
      assignedMA: assignedMaName || undefined,
      maColor: assignedMaName ? colorFromText(assignedMaName) : undefined,
      safetyActive: Array.isArray(raw.safetyEvents) ? raw.safetyEvents.length > 0 : Boolean(raw.safetyActive),
      roomNumber: roomName || undefined,
      walkIn: Boolean(raw.walkIn),
      insuranceVerified: Boolean(raw.insuranceVerified),
      arrivalNotes: raw.arrivalNotes || undefined,
      intakeData: raw.intakeData || null,
      roomingData: raw.roomingData || null,
      clinicianData: raw.clinicianData || null,
      checkoutData: raw.checkoutData || null,
      statusEvents,
      closureType: raw.closureType || undefined,
      cardTags: Array.isArray(clinic?.cardTags) ? clinic.cardTags : undefined,
    };
  }, []);

  const setEncounterCacheEntry = useCallback((encounter: Encounter) => {
    encounterCacheRef.current = {
      ...encounterCacheRef.current,
      [encounter.id]: encounter,
    };
    setEncounterCacheVersion((value) => value + 1);
  }, []);

  const mapIncomingRow = useCallback((row: IncomingRow): Encounter => {
    const clinic = row.clinic || clinicsRef.current[row.clinicId] || null;
    const providerName = labelProviderName(
      row.providerName || row.provider?.name || row.providerLastName || "Unassigned",
      row.provider?.active,
    );
    const reasonName = labelReasonName(row.reasonText || row.reason?.name || "Visit", row.reason?.status);

    const appointmentIso = row.appointmentAt || null;
    const minutes = appointmentIso ? Math.max(0, Math.round((Date.now() - new Date(appointmentIso).getTime()) / 60000)) : 0;
    const alertLevel: Encounter["alertLevel"] = minutes > 25 ? "Red" : minutes > 15 ? "Yellow" : "Green";

    return {
      id: row.id,
      patientId: row.patientId,
      patientInitials: initials(row.patientId),
      clinicId: row.clinicId,
      clinicName: labelClinicName(clinic?.name || "Clinic", row.clinic?.status),
      clinicShortCode: clinic?.shortCode || clinic?.name?.slice(0, 2)?.toUpperCase() || "CL",
      clinicColor: clinic?.cardColor || colorFromText(clinic?.name || row.clinicId),
      maRun: Boolean(clinic?.maRun),
      provider: providerName,
      providerInitials: initials(providerName),
      visitType: reasonName,
      status: "Incoming",
      version: 0,
      checkinTime: row.appointmentTime || timeFromIso(appointmentIso),
      appointmentTime: row.appointmentTime || undefined,
      currentStageStart: row.appointmentTime || timeFromIso(appointmentIso),
      checkInAtIso: appointmentIso,
      currentStageStartAtIso: appointmentIso,
      completedAtIso: null,
      minutesInStage: minutes,
      alertLevel,
      safetyActive: false,
      walkIn: false,
      insuranceVerified: false,
      arrivalNotes: undefined,
      closureType: undefined,
      roomingData: null,
      statusEvents: appointmentIso ? [{ fromStatus: null, toStatus: "Incoming", changedAt: appointmentIso }] : [],
      cardTags: undefined,
    };
  }, []);

  const mapBackendTask = useCallback((task: BackendTask): MATask => {
    const assignedUser = task.assignedToUserId ? usersByIdRef.current[task.assignedToUserId] : null;
    const fallbackName = task.assignedToRole ? String(task.assignedToRole) : "Unassigned";
    const encounter = encountersRef.current.find((entry) => entry.id === task.encounterId);

    return {
      id: task.id,
      encounterId: task.encounterId,
      patientId: task.encounter?.patientId || encounter?.patientId || "Unknown",
      taskType: mapTaskType(task.taskType),
      description: task.description,
      assignedMA: assignedUser ? labelUserName(assignedUser.name, assignedUser.status) : fallbackName,
      priority: mapTaskPriority(task.priority),
      blocking: task.blocking,
      status: mapTaskStatus(task.status, task.completedAt),
      createdAt: timeFromIso(task.createdAt),
    };
  }, []);

  const hydrateBoardSnapshot = useCallback(async () => {
    const scope = resolveBoardSnapshotScope();
    snapshotScopeKeyRef.current = scope.key;
    const snapshot = await readEncounterBoardSnapshot(scope);
    if (liveBoardHydratedRef.current) {
      return;
    }

    if (!snapshot) {
      setIsBoardSnapshotStale(false);
      setEncounters([]);
      encountersRef.current = [];
      setMaTasks([]);
      setCreatedTasks([]);
      setCompletedCheckouts([]);
      return;
    }

    setEncounters(snapshot.encounters);
    encountersRef.current = snapshot.encounters;
    setMaTasks(snapshot.maTasks);
    setCreatedTasks(snapshot.createdTasks);
    setCompletedCheckouts(snapshot.completedCheckouts);
    setIsBoardSnapshotStale(true);
    setIsLiveMode(true);
  }, []);

  const persistBoardSnapshot = useCallback(async (params: {
    encounters: Encounter[];
    maTasks: MATask[];
    createdTasks?: CreatedTask[];
    completedCheckouts?: CompletedCheckout[];
  }) => {
    const scope = resolveBoardSnapshotScope();
    snapshotScopeKeyRef.current = scope.key;
    await writeEncounterBoardSnapshot({
      facilityId: scope.facilityId,
      roleScope: scope.roleScope,
      dateKey: scope.dateKey,
      fetchedAt: new Date().toISOString(),
      encounters: params.encounters,
      maTasks: params.maTasks,
      createdTasks: params.createdTasks || createdTasksRef.current,
      completedCheckouts: params.completedCheckouts || completedCheckoutsRef.current,
    });
  }, []);

  const refreshData = useCallback(async () => {
    setSyncError(null);
    const session = loadSession();
    const facilityId = session?.facilityId;
    const canReadUsers = session?.role === "Admin";

    const [
      clinicRowsResult,
      reasonRowsResult,
      roomRowsResult,
      userRowsResult,
      encounterRowsResult,
      incomingRowsResult,
      taskRowsResult,
    ] = await Promise.allSettled([
      admin.listClinics({ facilityId }),
      admin.listReasons({ facilityId }),
      admin.listRooms({ facilityId }),
      canReadUsers ? admin.listUsers(facilityId) : Promise.resolve([]),
      encounterApi.list({ date: todayIsoDate() }),
      incomingApi.list({ date: todayIsoDate() }),
      tasksApi.list(),
    ]);

    const errors: string[] = [];

    if (clinicRowsResult.status === "fulfilled") {
      clinicsRef.current = Object.fromEntries(
        clinicRowsResult.value.map((c: any) => [c.id, { id: c.id, name: c.name, shortCode: c.shortCode, cardColor: c.cardColor, timezone: c.timezone, maRun: Boolean(c.maRun) }]),
      );
    } else {
      errors.push(`Clinics: ${clinicRowsResult.reason instanceof Error ? clinicRowsResult.reason.message : "failed to load"}`);
    }

    if (reasonRowsResult.status === "fulfilled") {
      reasonsRef.current = Object.fromEntries(
        reasonRowsResult.value.map((r: any) => [r.id, { id: r.id, name: r.name }]),
      );
    } else {
      errors.push(`Visit reasons: ${reasonRowsResult.reason instanceof Error ? reasonRowsResult.reason.message : "failed to load"}`);
    }

    if (roomRowsResult.status === "fulfilled") {
      const roomMap: Record<string, LiveRoom> = {};
      const roomsByClinic: Record<string, LiveRoom[]> = {};
      roomRowsResult.value.forEach((r: any) => {
        const clinicIds = Array.isArray(r.clinicIds) ? r.clinicIds : [];
        const baseRoom = { id: r.id, name: r.name, clinicId: clinicIds[0] };
        roomMap[baseRoom.id] = baseRoom;
        clinicIds.forEach((clinicId: string) => {
          const row = { id: r.id, name: r.name, clinicId };
          if (!roomsByClinic[clinicId]) roomsByClinic[clinicId] = [];
          roomsByClinic[clinicId]!.push(row);
        });
      });
      roomsByIdRef.current = roomMap;
      roomsByClinicRef.current = roomsByClinic;
    } else {
      errors.push(`Rooms: ${roomRowsResult.reason instanceof Error ? roomRowsResult.reason.message : "failed to load"}`);
    }

    if (userRowsResult.status === "fulfilled") {
      const usersById: Record<string, LiveUser> = {};
      const usersByName: Record<string, LiveUser> = {};
      userRowsResult.value.forEach((user: any) => {
        const roleEntry = Array.isArray(user.roles) && user.roles.length > 0 ? user.roles[0] : null;
        const mapped: LiveUser = {
          id: user.id,
          name: user.name,
          status: user.status || "active",
          role: roleEntry?.role || "User",
          clinicId: roleEntry?.clinicId,
          facilityId: roleEntry?.facilityId,
        };
        usersById[mapped.id] = mapped;
        usersByName[mapped.name] = mapped;
      });
      usersByIdRef.current = usersById;
      usersByNameRef.current = usersByName;
    } else {
      errors.push(`Users: ${userRowsResult.reason instanceof Error ? userRowsResult.reason.message : "failed to load"}`);
    }

    if (encounterRowsResult.status === "fulfilled" || incomingRowsResult.status === "fulfilled") {
      const mappedEncounters =
        encounterRowsResult.status === "fulfilled"
          ? (encounterRowsResult.value as any[]).map((row) => mapBackendEncounter(row))
          : [];
      const mappedIncoming =
        incomingRowsResult.status === "fulfilled"
          ? (incomingRowsResult.value as any[])
              .filter((row) => !row.checkedInAt && !row.dispositionAt)
              .map((row) => mapIncomingRow(row as IncomingRow))
          : [];
      const allEncounterRows = [...mappedEncounters, ...mappedIncoming];
      setEncounters(allEncounterRows);
      encountersRef.current = allEncounterRows;
      const cacheEntries = Object.entries(encounterCacheRef.current);
      if (cacheEntries.length > 0) {
        let changed = false;
        const nextCache = { ...encounterCacheRef.current };
        for (const row of allEncounterRows) {
          if (nextCache[row.id]) {
            nextCache[row.id] = row;
            changed = true;
          }
        }
        if (changed) {
          encounterCacheRef.current = nextCache;
          setEncounterCacheVersion((value) => value + 1);
        }
      }
    }
    if (encounterRowsResult.status === "rejected") {
      errors.push(`Encounters: ${encounterRowsResult.reason instanceof Error ? encounterRowsResult.reason.message : "failed to load"}`);
    }
    if (incomingRowsResult.status === "rejected") {
      errors.push(`Incoming schedule: ${incomingRowsResult.reason instanceof Error ? incomingRowsResult.reason.message : "failed to load"}`);
    }

    const nextMaTasks =
      taskRowsResult.status === "fulfilled"
        ? (taskRowsResult.value as BackendTask[]).map(mapBackendTask)
        : null;
    if (nextMaTasks) {
      setMaTasks(nextMaTasks);
    } else {
      errors.push(`Tasks: ${taskRowsResult.reason instanceof Error ? taskRowsResult.reason.message : "failed to load"}`);
    }

    const criticalSucceeded =
      encounterRowsResult.status === "fulfilled" || incomingRowsResult.status === "fulfilled";

    setIsLiveMode(criticalSucceeded);
    if (criticalSucceeded) {
      liveBoardHydratedRef.current = true;
      setIsBoardSnapshotStale(false);
    }
    setSyncError(errors.length > 0 ? errors.join(" | ") : null);

    if (criticalSucceeded && nextMaTasks && (encounterRowsResult.status === "fulfilled" || incomingRowsResult.status === "fulfilled")) {
      const mappedEncounters =
        encounterRowsResult.status === "fulfilled"
          ? (encounterRowsResult.value as any[]).map((row) => mapBackendEncounter(row))
          : [];
      const mappedIncoming =
        incomingRowsResult.status === "fulfilled"
          ? (incomingRowsResult.value as any[])
              .filter((row) => !row.checkedInAt && !row.dispositionAt)
              .map((row) => mapIncomingRow(row as IncomingRow))
          : [];
      const allEncounterRows = [...mappedEncounters, ...mappedIncoming];
      await persistBoardSnapshot({
        encounters: allEncounterRows,
        maTasks: nextMaTasks,
      });
    }
  }, [mapBackendEncounter, mapBackendTask, mapIncomingRow, persistBoardSnapshot]);

  const scheduleRefreshData = useCallback((delayMs = 300) => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      refreshData().catch(() => undefined);
    }, delayMs);
  }, [refreshData]);

  useEffect(() => {
    liveBoardHydratedRef.current = false;
    hydrateBoardSnapshot().catch(() => undefined);
    refreshData().catch(() => undefined);

    const poll = setInterval(() => {
      refreshData().catch(() => undefined);
    }, 30000);

    let cancelled = false;
    let streamCloser: (() => void) | null = null;
    let streamAbortController: AbortController | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    const eventStreamEnabled =
      String(
        ((typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_ENABLE_EVENT_STREAM) ?? "true"),
      ).toLowerCase() !== "false";
    const session = loadSession();
    const scheduleReconnect = () => {
      if (cancelled || reconnectTimeout) return;
      reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        connectStream().catch(() => undefined);
      }, 15_000);
    };
    const connectStream = async () => {
      if (!eventStreamEnabled || !session) return;
      streamAbortController?.abort();
      const controller = new AbortController();
      streamAbortController = controller;
      try {
        const stream = await openAuthenticatedEventStream({
          signal: controller.signal,
          onEvent: ({ event }) => {
            if (event !== "connected") {
              scheduleRefreshData();
            }
          },
        });
        streamCloser = stream.close;
        stream.completed.finally(() => {
          if (!cancelled && !controller.signal.aborted) {
            scheduleReconnect();
          }
        });
      } catch {
        if (!controller.signal.aborted) {
          scheduleReconnect();
        }
      }
    };
    connectStream().catch(() => undefined);

    const onExternalRefresh = () => {
      liveBoardHydratedRef.current = false;
      hydrateBoardSnapshot().catch(() => undefined);
      scheduleRefreshData();
    };
    if (typeof window !== "undefined") {
      window.addEventListener(ADMIN_REFRESH_EVENT, onExternalRefresh);
      window.addEventListener(FACILITY_CONTEXT_CHANGED_EVENT, onExternalRefresh);
    }

    return () => {
      cancelled = true;
      clearInterval(poll);
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      streamCloser?.();
      streamAbortController?.abort();
      if (typeof window !== "undefined") {
        window.removeEventListener(ADMIN_REFRESH_EVENT, onExternalRefresh);
        window.removeEventListener(FACILITY_CONTEXT_CHANGED_EVENT, onExternalRefresh);
      }
    };
  }, [hydrateBoardSnapshot, refreshData, scheduleRefreshData]);

  useEffect(() => {
    if (!liveBoardHydratedRef.current || !snapshotScopeKeyRef.current) {
      return;
    }
    void persistBoardSnapshot({
      encounters,
      maTasks,
      createdTasks,
      completedCheckouts,
    });
  }, [completedCheckouts, createdTasks, encounters, maTasks, persistBoardSnapshot]);

  const fetchEncounter = useCallback(
    async (id: string, options?: { force?: boolean }) => {
      const existing =
        encountersRef.current.find((entry) => entry.id === id) ||
        encounterCacheRef.current[id];
      if (existing && !options?.force) {
        return existing;
      }
      const raw = await encounterApi.get(id);
      const mapped = mapBackendEncounter(raw as any);
      setEncounterCacheEntry(mapped);
      return mapped;
    },
    [mapBackendEncounter, setEncounterCacheEntry],
  );

  const getEncounter = useCallback(
    (id: string) => encounters.find((entry) => entry.id === id) || encounterCacheRef.current[id],
    [encounters, encounterCacheVersion],
  );

  const getAvailableRoomsForClinic = useCallback((clinicId: string) => {
    return (roomsByClinicRef.current[clinicId] || []).map((room) => ({ id: room.id, name: room.name }));
  }, []);

  const applyEncounterMutationResult = useCallback((raw: any) => {
    const mapped = mapBackendEncounter(raw as any);
    setEncounters((prev) => prev.map((entry) => (entry.id === mapped.id ? mapped : entry)));
    setEncounterCacheEntry(mapped);
    return mapped;
  }, [mapBackendEncounter, setEncounterCacheEntry]);

  const advanceStatus = useCallback(
    async (id: string, newStatus: EncounterStatus, extras?: Partial<Encounter>) => {
      const current = encountersRef.current.find((entry) => entry.id === id) || encounterCacheRef.current[id];
      if (!current) return undefined;

      const roomId = extras?.roomNumber
        ? (roomsByClinicRef.current[current.clinicId] || []).find((room) => room.name === extras.roomNumber)?.id
        : undefined;
      const roomingPayload = extras?.roomingData && typeof extras.roomingData === "object"
        ? (extras.roomingData as Record<string, unknown>)
        : undefined;
      const clinicianPayload = extras?.clinicianData && typeof extras.clinicianData === "object"
        ? (extras.clinicianData as Record<string, unknown>)
        : undefined;

      if (extras?.roomNumber && !roomId) {
        throw new Error("Selected room could not be resolved. Pick a room again and retry.");
      }

      let workingEncounter = current;
      let latestPersisted: Encounter | undefined;

      try {
        if (roomId || roomingPayload) {
          latestPersisted = applyEncounterMutationResult(await encounterApi.updateRooming(id, {
            version: workingEncounter.version,
            ...(roomId ? { roomId } : {}),
            ...(roomingPayload ? { data: roomingPayload } : {}),
          }));
          workingEncounter = latestPersisted;
        }

        const updated =
          current.status === "ReadyForProvider" && newStatus === "Optimizing"
            ? await encounterApi.startVisit(id, { version: workingEncounter.version })
            : current.status === "Optimizing" && newStatus === "CheckOut"
              ? await encounterApi.endVisit(id, {
                  version: workingEncounter.version,
                  ...(clinicianPayload ? { data: clinicianPayload } : {}),
                })
              : await encounterApi.updateStatus(id, {
                  toStatus: newStatus,
                  version: workingEncounter.version,
                });

        latestPersisted = applyEncounterMutationResult(updated);
        refreshData().catch(() => undefined);
        return latestPersisted;
      } catch (error) {
        refreshData().catch(() => undefined);
        throw error;
      }
    },
    [applyEncounterMutationResult, refreshData],
  );

  const updateEncounter = useCallback(
    (id: string, overrides: Partial<Encounter>) => {
      const current = encountersRef.current.find((entry) => entry.id === id) || encounterCacheRef.current[id];
      if (!current) return;

      setEncounters((prev) => prev.map((entry) => (entry.id === id ? { ...entry, ...overrides } : entry)));
      setEncounterCacheEntry({ ...current, ...overrides });

      (async () => {
        try {
          let version = current.version;

          if (overrides.assignedMA) {
            const assignee = usersByNameRef.current[overrides.assignedMA];
            if (assignee) {
              const updated = await encounterApi.assign(id, {
                assignedMaUserId: assignee.id,
                version,
              });
              version = Number((updated as any).version || version + 1);
            }
          }

          if (overrides.roomNumber) {
            const room = (roomsByClinicRef.current[current.clinicId] || []).find((entry) => entry.name === overrides.roomNumber);
            if (room) {
              const updated = await encounterApi.updateRooming(id, { roomId: room.id, version });
              version = Number((updated as any).version || version + 1);
            }
          }

          await refreshData();
        } catch {
          refreshData().catch(() => undefined);
        }
      })();
    },
    [refreshData, setEncounterCacheEntry],
  );

  const addTask = useCallback(
    (task: Omit<CreatedTask, "id" | "createdAt">): CreatedTask => {
      const nowIso = new Date().toISOString();
      const optimistic: CreatedTask = {
        ...task,
        id: crypto.randomUUID(),
        createdAt: timeFromIso(nowIso),
      };

      setCreatedTasks((prev) => [optimistic, ...prev]);

      (async () => {
        try {
          const role = isRole(task.assignedToRole) ? task.assignedToRole : undefined;
          await tasksApi.create({
            encounterId: task.encounterId,
            taskType: task.taskType,
            description: task.description,
            assignedToRole: role,
            priority: task.priority,
            blocking: task.blocking,
          });

          setCreatedTasks((prev) => prev.filter((entry) => entry.id !== optimistic.id));
          await refreshData();
        } catch {
          // Keep optimistic task visible; retry can be manual.
        }
      })();

      return optimistic;
    },
    [refreshData],
  );

  const removeTask = useCallback((taskId: string) => {
    setCreatedTasks((prev) => prev.filter((entry) => entry.id !== taskId));
    setMaTasks((prev) => prev.filter((entry) => entry.id !== taskId));

    (async () => {
      try {
        await tasksApi.remove(taskId);
      } catch {
        // ignore delete errors for locally-created tasks
      }
    })();
  }, []);

  const getTasksForEncounter = useCallback(
    (encounterId: string) => {
      const activeTasks = maTasks.filter((task) => task.encounterId === encounterId && task.status !== "done");
      const activeTaskIds = new Set(activeTasks.map((task) => task.id));
      return {
        maTasks: activeTasks,
        createdTasks: createdTasks.filter((task) => task.encounterId === encounterId && !activeTaskIds.has(task.id)),
      };
    },
    [createdTasks, maTasks],
  );

  const completeCheckout = useCallback(
    async (data: CompletedCheckout) => {
      const completedAtIso = new Date().toISOString();
      const current =
        encountersRef.current.find((entry) => entry.id === data.encounterId) ||
        encounterCacheRef.current[data.encounterId];
      if (!current) return undefined;

      const updated = await encounterApi.completeCheckout(data.encounterId, {
        version: current.version,
        checkoutData: data.templateValues,
      });
      const mapped = applyEncounterMutationResult(updated);
      setCompletedCheckouts((prev) => [
        {
          ...data,
          encounter: mapped,
          completedAt: timeFromIso(completedAtIso),
        },
        ...prev.filter((entry) => entry.encounterId !== data.encounterId),
      ]);
      refreshData().catch(() => undefined);
      return mapped;
    },
    [applyEncounterMutationResult, refreshData],
  );

  const getCheckoutData = useCallback(
    (encounterId: string) => completedCheckouts.find((entry) => entry.encounterId === encounterId),
    [completedCheckouts],
  );

  const checkInPatient = useCallback(
    async (input: {
      patientId: string;
      clinicId: string;
      providerName?: string;
      reasonForVisitId?: string;
      reasonForVisit?: string;
      incomingId?: string;
      walkIn?: boolean;
      insuranceVerified?: boolean;
      intakeData?: Record<string, unknown>;
    }) => {
      const created = await incomingApi.createEncounter({
        patientId: input.patientId,
        clinicId: input.clinicId,
        incomingId: input.incomingId,
        providerName: input.providerName,
        reasonForVisitId: input.reasonForVisitId,
        reasonForVisit: input.reasonForVisit,
        walkIn: input.walkIn,
        insuranceVerified: input.insuranceVerified,
        intakeData: input.intakeData,
      });

      const mapped = mapBackendEncounter(created as any);
      setEncounters((prev) => {
        const withoutIncoming = input.incomingId ? prev.filter((entry) => entry.id !== input.incomingId) : prev;
        return [mapped, ...withoutIncoming.filter((entry) => entry.id !== mapped.id)];
      });

      refreshData().catch(() => undefined);
    },
    [mapBackendEncounter, refreshData],
  );

  const activateSafety = useCallback(
    async (input: { encounterId: string; confirmationWord: string; location?: string }) => {
      const previous =
        encountersRef.current.find((entry) => entry.id === input.encounterId) ||
        encounterCacheRef.current[input.encounterId];
      if (!previous) return;
      setEncounters((prev) =>
        prev.map((entry) =>
          entry.id === input.encounterId
            ? {
                ...entry,
                safetyActive: true,
                alertLevel: "Red",
              }
            : entry,
        ),
      );
      setEncounterCacheEntry({
        ...previous,
        safetyActive: true,
        alertLevel: "Red",
      });
      try {
        await safetyApi.activate(input.encounterId, {
          confirmationWord: input.confirmationWord,
          location: input.location,
        });
        await refreshData();
      } catch (error) {
        await refreshData();
        throw error;
      }
    },
    [refreshData, setEncounterCacheEntry],
  );

  const resolveSafety = useCallback(
    async (input: { encounterId: string; confirmationWord: string; resolutionNote?: string }) => {
      const previous =
        encountersRef.current.find((entry) => entry.id === input.encounterId) ||
        encounterCacheRef.current[input.encounterId];
      if (!previous) return;
      setEncounters((prev) =>
        prev.map((entry) =>
          entry.id === input.encounterId
            ? {
                ...entry,
                safetyActive: false,
              }
            : entry,
        ),
      );
      setEncounterCacheEntry({
        ...previous,
        safetyActive: false,
      });
      try {
        await safetyApi.resolve(input.encounterId, {
          confirmationWord: input.confirmationWord,
          resolutionNote: input.resolutionNote,
        });
        await refreshData();
      } catch (error) {
        await refreshData();
        throw error;
      }
    },
    [refreshData, setEncounterCacheEntry],
  );

  const value = useMemo<EncounterContextType>(
    () => ({
      encounters,
      getEncounter,
      fetchEncounter,
      getAvailableRoomsForClinic,
      advanceStatus,
      updateEncounter,
      maTasks,
      createdTasks,
      addTask,
      removeTask,
      getTasksForEncounter,
      completedCheckouts,
      completeCheckout,
      getCheckoutData,
      isLiveMode,
      isBoardSnapshotStale,
      syncError,
      refreshData,
      checkInPatient,
      activateSafety,
      resolveSafety,
    }),
    [
      encounters,
      getEncounter,
      fetchEncounter,
      getAvailableRoomsForClinic,
      advanceStatus,
      updateEncounter,
      maTasks,
      createdTasks,
      addTask,
      removeTask,
      getTasksForEncounter,
      completedCheckouts,
      completeCheckout,
      getCheckoutData,
      isLiveMode,
      isBoardSnapshotStale,
      syncError,
      refreshData,
      checkInPatient,
      activateSafety,
      resolveSafety,
    ],
  );

  return <EncounterContext.Provider value={value}>{children}</EncounterContext.Provider>;
}

export function useEncounters() {
  const ctx = useContext(EncounterContext);
  if (!ctx) {
    throw new Error("useEncounters must be used within an EncounterProvider");
  }
  return ctx;
}
