// ══════════════════════════════════════════════════════════════════════
// Flow — API Client
// Maps to the NestJS API at apps/api (codex/office-manager branch)
// ══════════════════════════════════════════════════════════════════════
//
// This module provides a typed fetch wrapper matching every backend
// controller endpoint. In the Figma Make prototype, these functions
// are NOT called — views consume mock data from encounter-context.tsx.
//
// When wiring to the real backend, replace the EncounterContext with
// calls to these functions (or wrap them in React Query / SWR hooks).
// ══════════════════════════════════════════════════════════════════════

import type {
  EncounterBase,
  EncounterStatus,
  Task,
  Facility,
  Clinic,
  Reason,
  Room,
  StaffUser,
  DirectoryUser,
  Template,
  AlertThreshold,
  NotificationPolicy,
  ClinicAssignment,
  AdminEncounterRecoveryRow,
  ReasonStatus,
  TemplateStatus,
  TemplateFieldDefinition,
  CreateEncounterRequest,
  UpdateStatusRequest,
  UpdateRoomingRequest,
  StartVisitRequest,
  EndVisitRequest,
  CompleteCheckoutRequest,
  CancelEncounterRequest,
  AssignEncounterRequest,
  ActivateSafetyRequest,
  ResolveSafetyRequest,
  SafetyEvent,
  Role,
  RevenueDashboardSnapshot,
  RevenueDailyHistoryRollup,
  RevenueHistorySummary,
  RevenueDayBucket,
  RevenueWorkQueue,
  RevenueCaseDetail,
  RevenueStatus,
  FinancialEligibilityStatus,
  FinancialRequirementStatus,
  CollectionOutcome,
  CodingStage,
  RevenueProcedureLine,
  RevenueSettings,
  OwnerAnalyticsSnapshot,
} from "./types";
export type { AdminEncounterRecoveryRow } from "./types";
import { buildHeaders, getCurrentSession } from "./auth-session";
import { acquireMicrosoftAccessToken } from "./microsoft-auth";
import {
  ADMIN_REFRESH_EVENT,
  FACILITY_CONTEXT_CHANGED_EVENT,
  SESSION_CHANGED_EVENT,
} from "./app-events";

// ── Base fetch ───────────────────────────────────────────────────────

const BASE_URL =
  (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_API_BASE_URL) ||
  (typeof import.meta !== "undefined" && (import.meta as any).env?.NEXT_PUBLIC_API_URL) ||
  (typeof process !== "undefined" && (process as any).env?.NEXT_PUBLIC_API_URL) ||
  "http://localhost:4000";

const defaultDevHeaders: Record<string, string> = {};
const viteEnv = (typeof import.meta !== "undefined" && (import.meta as any).env) || {};
const nodeEnv = (typeof process !== "undefined" && (process as any).env) || {};
const isProductionRuntime = Boolean(viteEnv.PROD) || String(nodeEnv.NODE_ENV || "").toLowerCase() === "production";
const devUserId =
  viteEnv.VITE_DEV_USER_ID ||
  nodeEnv.VITE_DEV_USER_ID;
const devRole =
  viteEnv.VITE_DEV_ROLE ||
  nodeEnv.VITE_DEV_ROLE;
const enableDevHeadersRaw = viteEnv.VITE_ENABLE_DEV_HEADERS ?? nodeEnv.VITE_ENABLE_DEV_HEADERS;
const enableDevHeaders =
  String(enableDevHeadersRaw ?? (!isProductionRuntime || Boolean(devUserId) ? "true" : "false")).toLowerCase() === "true";
if (enableDevHeaders) {
  if (devUserId) defaultDevHeaders["x-dev-user-id"] = devUserId;
  if (devRole) defaultDevHeaders["x-dev-role"] = devRole;
}

type CachedGetEntry = {
  expiresAt: number;
  value: unknown;
};

type ApiFetchOptions = RequestInit & {
  cacheTtlMs?: number;
  cacheKey?: string;
  timeoutMs?: number;
};

type EventStreamMessage = {
  event: string;
  data: unknown;
};

export type AuthContextSummary = {
  userId: string;
  name: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  role: string;
  roles: string[];
  clinicId: string | null;
  facilityId: string | null;
  activeFacilityId: string | null;
  availableFacilities: Array<{
    id: string;
    name: string;
    shortCode?: string | null;
    timezone?: string;
    status?: string;
  }>;
};

export type OverviewBootstrapSnapshot = {
  facilityId: string;
  role: string;
  rooms: any[];
  users: any[];
  assignments: any[];
  alerts: any[];
  tasks: any[];
  errors: string[];
};

const getCache = new Map<string, CachedGetEntry>();
const inflightGets = new Map<string, Promise<unknown>>();

function currentSessionFingerprint() {
  const session = getCurrentSession();
  if (!session) return "anon";
  return [
    session.mode,
    session.userId || "",
    session.role || "",
    session.facilityId || "",
    session.accountHomeId || "",
    session.username || "",
  ].join("|");
}

function getCacheKey(path: string, options: ApiFetchOptions, headers: Record<string, string>) {
  const method = String(options.method || "GET").toUpperCase();
  const facilityHeader = headers["x-facility-id"] || "";
  return options.cacheKey || `${currentSessionFingerprint()}::${method}::${path}::${facilityHeader}`;
}

function clearGetCache() {
  getCache.clear();
  inflightGets.clear();
}

if (typeof window !== "undefined") {
  const resetOnEvent = () => clearGetCache();
  window.addEventListener(ADMIN_REFRESH_EVENT, resetOnEvent);
  window.addEventListener(FACILITY_CONTEXT_CHANGED_EVENT, resetOnEvent);
  window.addEventListener(SESSION_CHANGED_EVENT, resetOnEvent);
}

async function resolveAuthHeaders(extraHeaders?: Record<string, string>) {
  const session = getCurrentSession();
  const headers: Record<string, string> = {
    ...(session ? buildHeaders(session) : defaultDevHeaders),
    ...(extraHeaders || {}),
  };

  if (session?.mode === "microsoft" && !headers.Authorization) {
    const token = await acquireMicrosoftAccessToken();
    if (!token) {
      throw new Error("Microsoft session is missing an access token. Sign in again.");
    }
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const headers = await resolveAuthHeaders((options.headers as Record<string, string>) || {});
  const hasJsonBody = options.body !== undefined && options.body !== null && !(options.body instanceof FormData);
  if (hasJsonBody && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const method = String(options.method || "GET").toUpperCase();
  const cacheTtlMs = Number(options.cacheTtlMs || 0);
  const timeoutMs = Number(options.timeoutMs || (method === "GET" ? 20_000 : 15_000));
  const shouldCache = method === "GET" && cacheTtlMs > 0;
  const cacheKey = shouldCache ? getCacheKey(path, options, headers) : null;

  if (cacheKey) {
    const cached = getCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value as T;
    }
    const inflight = inflightGets.get(cacheKey);
    if (inflight) {
      return (await inflight) as T;
    }
  } else if (method !== "GET") {
    clearGetCache();
  }

  const performFetch = async () => {
    let res: Response;
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;
    const callerSignal = options.signal;
    const forwardAbort = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) {
        forwardAbort();
      } else {
        callerSignal.addEventListener("abort", forwardAbort, { once: true });
      }
    }
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        ...options,
        headers,
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId);
      if (callerSignal) callerSignal.removeEventListener("abort", forwardAbort);
      if (error instanceof DOMException && error.name === "AbortError" && timedOut) {
        throw new Error(
          `Request timed out after ${Math.max(1, Math.round(timeoutMs / 1000))}s. Flow will recheck the encounter state so you can retry safely.`,
        );
      }
      if (error instanceof TypeError) {
        throw new Error("Network/CORS request failed. Verify API server and CORS settings.");
      }
      throw error;
    }
    if (timeoutId) clearTimeout(timeoutId);
    if (callerSignal) callerSignal.removeEventListener("abort", forwardAbort);

    if (!res.ok) {
      const text = await res.text();
      let message = text || "Request failed";
      try {
        const parsed = JSON.parse(text);
        if (parsed?.message) {
          message = Array.isArray(parsed.message)
            ? parsed.message.join(", ")
            : parsed.message;
        }
      } catch {
        // keep raw text
      }
      throw new Error(message);
    }

    return (await res.json()) as T;
  };

  if (!cacheKey) {
    return performFetch();
  }

  const request = performFetch()
    .then((value) => {
      getCache.set(cacheKey, {
        expiresAt: Date.now() + cacheTtlMs,
        value,
      });
      return value;
    })
    .finally(() => {
      inflightGets.delete(cacheKey);
    });

  inflightGets.set(cacheKey, request as Promise<unknown>);
  return request;
}

export async function openAuthenticatedEventStream(options: {
  path?: string;
  onEvent: (message: EventStreamMessage) => void;
  onError?: (error: Error) => void;
  signal?: AbortSignal;
}) {
  const path = options.path || "/events/stream";
  const headers = await resolveAuthHeaders();
  const controller = new AbortController();
  const callerSignal = options.signal;
  const forwardAbort = () => controller.abort();

  if (callerSignal) {
    if (callerSignal.aborted) {
      forwardAbort();
    } else {
      callerSignal.addEventListener("abort", forwardAbort, { once: true });
    }
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method: "GET",
    headers: {
      ...headers,
      Accept: "text/event-stream",
    },
    cache: "no-store",
    signal: controller.signal,
  });

  if (!response.ok || !response.body) {
    if (callerSignal) callerSignal.removeEventListener("abort", forwardAbort);
    throw new Error(`Event stream request failed with ${response.status} ${response.statusText}.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let closed = false;

  const emitMessage = (rawMessage: string) => {
    const lines = rawMessage.split(/\r?\n/);
    let eventName = "message";
    const dataLines: string[] = [];

    for (const line of lines) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim() || "message";
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }

    if (dataLines.length === 0) return;
    const rawData = dataLines.join("\n");
    let parsed: unknown = rawData;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      // Keep the raw string payload for non-JSON events.
    }
    options.onEvent({ event: eventName, data: parsed });
  };

  const close = () => {
    if (closed) return;
    closed = true;
    controller.abort();
    if (callerSignal) callerSignal.removeEventListener("abort", forwardAbort);
  };

  const pump = (async () => {
    try {
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundaryIndex = buffer.indexOf("\n\n");
        while (boundaryIndex >= 0) {
          const rawMessage = buffer.slice(0, boundaryIndex).trim();
          buffer = buffer.slice(boundaryIndex + 2);
          if (rawMessage) emitMessage(rawMessage);
          boundaryIndex = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!closed) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      close();
    }
  })();

  return {
    close,
    completed: pump,
  };
}

// ── Encounters Controller (/encounters) ──────────────────────────────

export const encounters = {
  list(params?: {
    clinicId?: string;
    status?: EncounterStatus;
    assignedMaUserId?: string;
    date?: string;
  }) {
    const qs = new URLSearchParams();
    if (params?.clinicId) qs.set("clinicId", params.clinicId);
    if (params?.status) qs.set("status", params.status);
    if (params?.assignedMaUserId) qs.set("assignedMaUserId", params.assignedMaUserId);
    if (params?.date) qs.set("date", params.date);
    const q = qs.toString();
    return apiFetch<EncounterBase[]>(`/encounters${q ? `?${q}` : ""}`);
  },

  get(id: string) {
    return apiFetch<EncounterBase>(`/encounters/${id}`);
  },

  create(dto: CreateEncounterRequest) {
    return apiFetch<EncounterBase>("/encounters", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },

  updateStatus(id: string, dto: UpdateStatusRequest) {
    return apiFetch<EncounterBase>(`/encounters/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify(dto),
    });
  },

  updateRooming(id: string, dto: UpdateRoomingRequest) {
    return apiFetch<EncounterBase>(`/encounters/${id}/rooming`, {
      method: "PATCH",
      body: JSON.stringify(dto),
    });
  },

  assign(id: string, dto: AssignEncounterRequest) {
    return apiFetch<EncounterBase>(`/encounters/${id}/assign`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },

  startVisit(id: string, dto: StartVisitRequest) {
    return apiFetch<EncounterBase>(`/encounters/${id}/visit/start`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },

  endVisit(id: string, dto: EndVisitRequest) {
    return apiFetch<EncounterBase>(`/encounters/${id}/visit/end`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },

  completeCheckout(id: string, dto: CompleteCheckoutRequest) {
    return apiFetch<EncounterBase>(`/encounters/${id}/checkout/complete`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },

  cancel(id: string, dto: CancelEncounterRequest) {
    return apiFetch<EncounterBase>(`/encounters/${id}/cancel`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
};

// ── Incoming Controller (/incoming) ──────────────────────────────────

export type IncomingRow = {
  id: string;
  clinicId: string;
  dateOfService?: string | null;
  patientId: string;
  appointmentTime?: string | null;
  appointmentAt?: string | null;
  providerId?: string | null;
  providerLastName?: string | null;
  providerName?: string | null;
  reasonForVisitId?: string | null;
  reasonText?: string | null;
  intakeData?: Record<string, unknown> | null;
  validationErrors?: unknown;
  checkedInAt?: string | null;
  checkedInEncounterId?: string | null;
  dispositionType?: string | null;
  dispositionNote?: string | null;
  dispositionAt?: string | null;
  dispositionEncounterId?: string | null;
  source?: string | null;
  importBatchId?: string | null;
  isValid: boolean;
  clinic?: { id: string; name: string; shortCode?: string; cardColor?: string; status?: string };
  provider?: { id: string; name: string; active?: boolean } | null;
  reason?: { id: string; name: string } | null;
};

export const incomingDispositionReasons = [
  "no_show",
  "left_without_being_seen",
  "arrived_late",
  "telehealth_fail",
  "late_cancel",
  "provider_out",
  "emergency",
  "scheduling_error",
  "administrative_block",
  "other",
] as const;

export type IncomingDispositionReason = (typeof incomingDispositionReasons)[number];

export type IncomingImportBatch = {
  id: string;
  facilityId: string;
  clinicId: string | null;
  date: string;
  source: "manual" | "csv" | "fhir" | "ehr";
  fileName?: string | null;
  rowCount: number;
  acceptedRowCount: number;
  pendingRowCount: number;
  status: "processed" | "pending_review" | string;
  createdAt: string;
};

export type IncomingImportIssue = {
  id: string;
  batchId: string;
  facilityId: string;
  clinicId: string | null;
  dateOfService: string;
  rawPayloadJson: Record<string, unknown>;
  normalizedJson?: Record<string, unknown> | null;
  validationErrors: string[];
  status: "pending" | "error" | "resolved" | string;
  retryCount: number;
  resolvedIncomingId?: string | null;
  createdAt: string;
  updatedAt: string;
  clinic?: { id: string; name: string; shortCode?: string } | null;
  batch?: { id: string; source: string; fileName?: string | null; createdAt: string; status: string } | null;
};

export type IncomingReferencePayload = {
  facilityId: string;
  clinicId: string | null;
  requiredHeaders: Array<{
    key: string;
    label: string;
    required: boolean;
    format: string;
    aliases: string[];
  }>;
  samples: {
    clinics: Array<{ id: string; name: string; shortCode?: string | null; aliases?: string[] }>;
    providerLastNames: string[];
    reasonNames: string[];
  };
};

export type IncomingImportResult = {
  acceptedRows: IncomingRow[];
  pendingIssues: IncomingImportIssue[];
  acceptedCount: number;
  pendingCount: number;
};

export const incoming = {
  list(params?: {
    clinicId?: string;
    date?: string;
    includeCheckedIn?: boolean;
    includeInvalid?: boolean;
  }) {
    const qs = new URLSearchParams();
    if (params?.clinicId) qs.set("clinicId", params.clinicId);
    if (params?.date) qs.set("date", params.date);
    if (params?.includeCheckedIn) qs.set("includeCheckedIn", "true");
    if (params?.includeInvalid) qs.set("includeInvalid", "true");
    const q = qs.toString();
    return apiFetch<IncomingRow[]>(`/incoming${q ? `?${q}` : ""}`);
  },
  importSchedule(dto: {
    clinicId?: string;
    dateOfService?: string;
    csvText: string;
    fileName?: string;
    source?: "manual" | "csv" | "fhir" | "ehr";
    facilityId?: string;
  }) {
    return apiFetch<IncomingImportResult>("/incoming/import", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  reference(params?: { facilityId?: string; clinicId?: string }) {
    const qs = new URLSearchParams();
    if (params?.facilityId) qs.set("facilityId", params.facilityId);
    if (params?.clinicId) qs.set("clinicId", params.clinicId);
    const q = qs.toString();
    return apiFetch<IncomingReferencePayload>(`/incoming/reference${q ? `?${q}` : ""}`);
  },
  listPending(params?: { facilityId?: string; clinicId?: string; date?: string }) {
    const qs = new URLSearchParams();
    if (params?.facilityId) qs.set("facilityId", params.facilityId);
    if (params?.clinicId) qs.set("clinicId", params.clinicId);
    if (params?.date) qs.set("date", params.date);
    const q = qs.toString();
    return apiFetch<IncomingImportIssue[]>(`/incoming/pending${q ? `?${q}` : ""}`);
  },
  retryPending(
    id: string,
    dto: {
      clinicId?: string;
      patientId?: string;
      dateOfService?: string;
      appointmentTime?: string | null;
      providerLastName?: string | null;
      reasonText?: string | null;
    },
  ) {
    return apiFetch<{
      status: "accepted" | "pending";
      row?: IncomingRow;
      issue: IncomingImportIssue;
    }>(`/incoming/pending/${id}/retry`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  listBatches(params?: {
    clinicId?: string;
    date?: string;
  }) {
    const qs = new URLSearchParams();
    if (params?.clinicId) qs.set("clinicId", params.clinicId);
    if (params?.date) qs.set("date", params.date);
    const q = qs.toString();
    return apiFetch<IncomingImportBatch[]>(`/incoming/batches${q ? `?${q}` : ""}`);
  },
  updateRow(
    id: string,
    dto: {
      patientId?: string;
      dateOfService?: string;
      appointmentTime?: string | null;
      providerLastName?: string | null;
      reasonText?: string | null;
    },
  ) {
    return apiFetch<IncomingRow>(`/incoming/${id}`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  dispositionRow(id: string, dto: { reason: IncomingDispositionReason; note?: string }) {
    return apiFetch<{
      encounterId: string;
      status: string;
      closureType: IncomingDispositionReason;
      resolvedIncomingId: string;
    }>(`/incoming/${id}/disposition`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  createEncounter(dto: CreateEncounterRequest) {
    return encounters.create(dto);
  },
};

// ── Tasks Controller (/tasks) ────────────────────────────────────────

export type BackendTask = {
  id: string;
  facilityId?: string | null;
  clinicId?: string | null;
  encounterId: string | null;
  revenueCaseId?: string | null;
  roomId?: string | null;
  sourceType?: "Encounter" | "RoomIssue" | "RoomSupplyFlag" | "RoomAudit" | "RevenueCase" | "ProviderClarification" | null;
  sourceId?: string | null;
  taskCategory?: string | null;
  taskType: string;
  description: string;
  assignedToRole: Role | null;
  assignedToUserId: string | null;
  status: string;
  priority: number;
  blocking: boolean;
  dueAt?: string | null;
  createdAt: string;
  createdBy: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  completedAt: string | null;
  completedBy: string | null;
  notes: string | null;
  updatedAt?: string;
  encounter?: {
    id: string;
    patientId: string;
    clinicId: string;
    currentStatus: string;
    checkInAt: string | null;
  } | null;
  room?: {
    id: string;
    name: string;
    roomNumber?: number | null;
    roomType?: string | null;
  } | null;
};

export type RoomOperationalStatus = "Ready" | "NotReady" | "Occupied" | "NeedsTurnover" | "Hold";
export type RoomIssueStatus = "Open" | "Acknowledged" | "Resolved" | "Dismissed";
export type RoomIssueType = "Equipment" | "Maintenance" | "General" | "SupplyLow" | "SupplyOut" | "AuditFailure";
export type RoomChecklistKind = "DayStart" | "DayEnd";

export type RoomLiveCard = {
  id: string;
  roomId: string;
  name: string;
  roomNumber?: number | null;
  roomType?: string | null;
  clinicId: string;
  clinicName: string;
  facilityId?: string | null;
  operationalStatus: RoomOperationalStatus;
  actualOperationalStatus?: RoomOperationalStatus;
  statusSinceAt: string;
  minutesInStatus: number;
  timerLabel: string;
  currentEncounter: { id: string; patientId: string; currentStatus: string } | null;
  issueCount: number;
  hasOpenIssue: boolean;
  holdReason: string | null;
  holdNote: string | null;
  dayStartCompleted: boolean;
  dayEndCompleted: boolean;
  assignable: boolean;
  readinessBlockedReason: string | null;
  lowStock: boolean;
  auditDue: boolean;
};

export type RoomDetail = {
  room: {
    id: string;
    name: string;
    roomNumber?: number | null;
    roomType?: string | null;
    facilityId: string;
    clinicId: string;
    clinicName: string;
  };
  operationalState: {
    roomId: string;
    currentStatus: RoomOperationalStatus;
    statusSinceAt: string;
    occupiedEncounterId: string | null;
    activeCleanerUserId: string | null;
    holdReason: string | null;
    holdNote: string | null;
    lastReadyAt: string | null;
    lastOccupiedAt: string | null;
    lastTurnoverAt: string | null;
    occupiedEncounter?: { id: string; patientId: string; currentStatus: string } | null;
  };
  events: Array<{
    id: string;
    eventType: string;
    fromStatus: RoomOperationalStatus | null;
    toStatus: RoomOperationalStatus | null;
    note: string | null;
    occurredAt: string;
    createdByUserId: string | null;
  }>;
  issues: RoomIssue[];
  checklistRuns: RoomChecklistRun[];
  dayStartCompleted?: boolean;
  dayEndCompleted?: boolean;
  placeholders: { supplies: string; audits: string };
};

export type RoomIssue = {
  id: string;
  roomId: string;
  clinicId: string;
  facilityId: string;
  encounterId: string | null;
  issueType: RoomIssueType;
  status: RoomIssueStatus;
  severity: number;
  title: string;
  description: string | null;
  placesRoomOnHold: boolean;
  taskId: string | null;
  createdAt: string;
  createdByUserId: string;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  resolutionNote: string | null;
  room?: { id: string; name: string; roomNumber?: number | null };
  task?: { id: string; status: string; assignedToRole: Role | null; assignedToUserId: string | null } | null;
};

export type RoomChecklistRun = {
  id: string;
  roomId: string;
  clinicId: string;
  facilityId: string;
  kind: RoomChecklistKind;
  dateKey: string;
  itemsJson: unknown;
  completed: boolean;
  startedAt: string;
  completedAt: string | null;
  completedByUserId: string | null;
  note: string | null;
};

export type RoomDailyHistoryRollup = {
  date: string;
  roomCount: number;
  dayStartCompletedCount: number;
  dayEndCompletedCount: number;
  turnoverCount: number;
  holdCount: number;
  issueCount: number;
  resolvedIssueCount: number;
  avgOccupiedMins: number;
  avgTurnoverMins: number;
  statusMinutes: Record<RoomOperationalStatus, number>;
  issueRollups: Array<{
    issueType: RoomIssueType;
    count: number;
    openCount: number;
    resolvedCount: number;
    avgResolutionMins: number;
  }>;
  roomRollups: Array<{
    roomId: string;
    roomName: string;
    roomNumber: number | null;
    occupiedMinutes: number;
    turnoverMinutes: number;
    holdMinutes: number;
    notReadyMinutes: number;
    turnoverCount: number;
    holdCount: number;
    issueCount: number;
    dayStartCompleted: boolean;
    dayEndCompleted: boolean;
    avgOccupiedMins: number;
    avgTurnoverMins: number;
  }>;
};

export type TemporaryClinicAssignmentOverride = {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  userStatus: string;
  role: Role;
  clinicId: string;
  clinicName: string;
  clinicShortCode?: string | null;
  clinicStatus: string;
  facilityId: string;
  facilityName: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  createdAt: string;
  createdByUserId: string;
  createdByName: string;
  revokedAt: string | null;
  revokedByUserId: string | null;
  revokedByName: string | null;
  state: "active" | "upcoming" | "expired" | "revoked";
};

export type PreRoomingCheckResult = {
  encounterId: string;
  readyCount: number;
  preferredRoomId: string | null;
  lastReadyRoom: boolean;
  blocked: boolean;
  rooms: RoomLiveCard[];
};

export type AlertInboxItem = {
  id: string;
  userId: string;
  facilityId: string;
  clinicId: string | null;
  kind: "threshold" | "safety" | "task";
  sourceId: string;
  sourceVersionKey: string;
  title: string;
  message: string;
  payload?: Record<string, unknown> | null;
  status: "active" | "archived";
  createdAt: string;
  acknowledgedAt: string | null;
  archivedAt: string | null;
};

export const tasks = {
  list(params?: {
    encounterId?: string;
    roomId?: string;
    assignedToUserId?: string;
    assignedToRole?: Role;
    mine?: boolean;
    includeCompleted?: boolean;
  }) {
    const qs = new URLSearchParams();
    if (params?.encounterId) qs.set("encounterId", params.encounterId);
    if (params?.roomId) qs.set("roomId", params.roomId);
    if (params?.assignedToUserId) qs.set("assignedToUserId", params.assignedToUserId);
    if (params?.assignedToRole) qs.set("assignedToRole", params.assignedToRole);
    if (params?.mine) qs.set("mine", "true");
    if (params?.includeCompleted !== undefined) qs.set("includeCompleted", params.includeCompleted ? "true" : "false");
    const q = qs.toString();
    return apiFetch<BackendTask[]>(`/tasks${q ? `?${q}` : ""}`, { cacheTtlMs: 10_000 });
  },
  create(dto: {
    facilityId?: string;
    clinicId?: string;
    encounterId?: string;
    roomId?: string;
    sourceType?: "Encounter" | "RoomIssue" | "RoomSupplyFlag" | "RoomAudit";
    sourceId?: string;
    taskType: string;
    description: string;
    assignedToRole?: Role;
    assignedToUserId?: string;
    status?: string;
    priority?: number;
    blocking?: boolean;
  }) {
    return apiFetch<BackendTask>("/tasks", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  update(id: string, dto: {
    assignedToRole?: Role;
    assignedToUserId?: string;
    acknowledged?: boolean;
    notes?: string;
    status?: string;
    priority?: number;
    completed?: boolean;
  }) {
    return apiFetch<BackendTask>(`/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(dto),
    });
  },
  remove(id: string) {
    return apiFetch<void>(`/tasks/${id}`, { method: "DELETE" });
  },
};

export const rooms = {
  live(params?: { mine?: boolean; clinicId?: string }) {
    const qs = new URLSearchParams();
    if (params?.mine) qs.set("mine", "true");
    if (params?.clinicId) qs.set("clinicId", params.clinicId);
    const q = qs.toString();
    return apiFetch<RoomLiveCard[]>(`/rooms/live${q ? `?${q}` : ""}`, { cacheTtlMs: 5_000 });
  },
  detail(roomId: string, params?: { clinicId?: string }) {
    const qs = new URLSearchParams();
    if (params?.clinicId) qs.set("clinicId", params.clinicId);
    const q = qs.toString();
    return apiFetch<RoomDetail>(`/rooms/${roomId}${q ? `?${q}` : ""}`, { cacheTtlMs: 5_000 });
  },
  preRoomingCheck(encounterId: string) {
    return apiFetch<PreRoomingCheckResult>("/rooms/pre-rooming-check", {
      method: "POST",
      body: JSON.stringify({ encounterId }),
    });
  },
  markReady(roomId: string, dto?: { clinicId?: string; note?: string }) {
    return apiFetch(`/rooms/${roomId}/actions/mark-ready`, {
      method: "POST",
      body: JSON.stringify(dto || {}),
    });
  },
  placeHold(roomId: string, dto: { clinicId?: string; reason?: string; note?: string }) {
    return apiFetch(`/rooms/${roomId}/actions/place-hold`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  clearHold(roomId: string, dto?: { clinicId?: string; targetStatus?: "Ready" | "NeedsTurnover"; note?: string }) {
    return apiFetch(`/rooms/${roomId}/actions/clear-hold`, {
      method: "POST",
      body: JSON.stringify(dto || {}),
    });
  },
  createIssue(roomId: string, dto: {
    clinicId?: string;
    encounterId?: string;
    issueType?: RoomIssueType;
    severity?: number;
    title: string;
    description?: string;
    placesRoomOnHold?: boolean;
  }) {
    return apiFetch<{ issue: RoomIssue; task: BackendTask }>(`/rooms/${roomId}/issues`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  updateIssue(issueId: string, dto: {
    status?: RoomIssueStatus;
    severity?: number;
    title?: string;
    description?: string | null;
    resolutionNote?: string;
  }) {
    return apiFetch<RoomIssue>(`/rooms/issues/${issueId}`, {
      method: "PATCH",
      body: JSON.stringify(dto),
    });
  },
  listIssues(params?: { roomId?: string; clinicId?: string; status?: RoomIssueStatus; includeResolved?: boolean }) {
    const qs = new URLSearchParams();
    if (params?.roomId) qs.set("roomId", params.roomId);
    if (params?.clinicId) qs.set("clinicId", params.clinicId);
    if (params?.status) qs.set("status", params.status);
    if (params?.includeResolved) qs.set("includeResolved", "true");
    const q = qs.toString();
    return apiFetch<RoomIssue[]>(`/rooms/issues${q ? `?${q}` : ""}`, { cacheTtlMs: 5_000 });
  },
  submitChecklist(kind: RoomChecklistKind, dto: {
    roomId: string;
    clinicId?: string;
    dateKey?: string;
    items?: Array<Record<string, unknown>>;
    completed?: boolean;
    note?: string;
  }) {
    const path = kind === "DayStart" ? "/rooms/checklists/day-start" : "/rooms/checklists/day-end";
    return apiFetch<RoomChecklistRun>(path, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
};

export const alerts = {
  list(params?: { tab?: "active" | "archived"; limit?: number }) {
    const qs = new URLSearchParams();
    if (params?.tab) qs.set("tab", params.tab);
    if (params?.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return apiFetch<{ tab: "active" | "archived"; total: number; items: AlertInboxItem[] }>(`/alerts${q ? `?${q}` : ""}`, { cacheTtlMs: 10_000 });
  },
  acknowledge(id: string) {
    return apiFetch<{ status: "archived"; id: string }>(`/alerts/${id}/acknowledge`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },
  unarchive(id: string) {
    return apiFetch<{ status: "active"; id: string }>(`/alerts/${id}/unarchive`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },
};

// ── Safety Controller (/safety) ──────────────────────────────────────

export const safety = {
  getWord() {
    return apiFetch<{ word: string }>("/safety/word");
  },

  activate(encounterId: string, dto: ActivateSafetyRequest) {
    return apiFetch<SafetyEvent>(`/safety/${encounterId}/activate`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },

  resolve(encounterId: string, dto: ResolveSafetyRequest) {
    return apiFetch<SafetyEvent>(`/safety/${encounterId}/resolve`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
};

// ── Admin Controller (/admin) ────────────────────────────────────────

export const admin = {
  // Facilities
  listFacilities() {
    return apiFetch<Facility[]>("/admin/facilities", { cacheTtlMs: 30_000 });
  },
  createFacility(dto: { name: string; shortCode?: string; address?: string; phone?: string; timezone?: string }) {
    return apiFetch<Facility>("/admin/facilities", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  updateFacility(id: string, dto: Partial<Facility>) {
    return apiFetch<Facility>(`/admin/facilities/${id}`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  getFacilityProfile(facilityId?: string) {
    const qs = new URLSearchParams();
    if (facilityId) qs.set("facilityId", facilityId);
    const q = qs.toString();
    return apiFetch<Facility>(`/admin/facility-profile${q ? `?${q}` : ""}`, { cacheTtlMs: 30_000 });
  },

  // Clinics
  listClinics(params?: { facilityId?: string; includeInactive?: boolean; includeArchived?: boolean } | string) {
    const qs = new URLSearchParams();
    if (typeof params === "string") {
      qs.set("facilityId", params);
    } else if (params) {
      if (params.facilityId) qs.set("facilityId", params.facilityId);
      if (params.includeInactive) qs.set("includeInactive", "true");
      if (params.includeArchived) qs.set("includeArchived", "true");
    }
    const q = qs.toString();
    return apiFetch<Clinic[]>(`/admin/clinics${q ? `?${q}` : ""}`, { cacheTtlMs: 20_000 });
  },
  createClinic(dto: Partial<Clinic> & { name: string }) {
    return apiFetch<Clinic>("/admin/clinics", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  updateClinic(id: string, dto: Partial<Clinic>) {
    return apiFetch<Clinic>(`/admin/clinics/${id}`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  deleteClinic(id: string) {
    return apiFetch<{ status: "deleted" | "archived"; clinicId?: string; clinic?: Clinic }>(`/admin/clinics/${id}`, {
      method: "DELETE",
    });
  },
  restoreClinic(id: string) {
    return apiFetch<Clinic>(`/admin/clinics/${id}/restore`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  // Reasons for Visit
  listReasons(
    params?: {
      clinicId?: string;
      facilityId?: string;
      includeInactive?: boolean;
      includeArchived?: boolean;
    } | string,
  ) {
    const qs = new URLSearchParams();
    if (typeof params === "string") {
      qs.set("clinicId", params);
    } else if (params) {
      if (params.clinicId) qs.set("clinicId", params.clinicId);
      if (params.facilityId) qs.set("facilityId", params.facilityId);
      if (params.includeInactive) qs.set("includeInactive", "true");
      if (params.includeArchived) qs.set("includeArchived", "true");
    }
    const q = qs.toString();
    return apiFetch<Reason[]>(`/admin/reasons${q ? `?${q}` : ""}`, { cacheTtlMs: 20_000 });
  },
  createReason(dto: {
    name: string;
    facilityId?: string;
    appointmentLengthMinutes: number;
    clinicIds: string[];
    status?: ReasonStatus;
  }) {
    return apiFetch<Reason>("/admin/reasons", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  updateReason(
    id: string,
    dto: {
      name?: string;
      appointmentLengthMinutes?: number;
      clinicIds?: string[];
      status?: ReasonStatus;
    },
  ) {
    return apiFetch<Reason>(`/admin/reasons/${id}`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  deleteReason(id: string) {
    return apiFetch<{ status: "archived"; reason: Reason }>(`/admin/reasons/${id}`, { method: "DELETE" });
  },

  // Rooms
  listRooms(params?: { facilityId?: string; clinicId?: string; includeInactive?: boolean; includeArchived?: boolean } | string) {
    const qs = new URLSearchParams();
    if (typeof params === "string") {
      qs.set("clinicId", params);
    } else if (params) {
      if (params.facilityId) qs.set("facilityId", params.facilityId);
      if (params.clinicId) qs.set("clinicId", params.clinicId);
      if (params.includeInactive) qs.set("includeInactive", "true");
      if (params.includeArchived) qs.set("includeArchived", "true");
    }
    const q = qs.toString();
    return apiFetch<Room[]>(`/admin/rooms${q ? `?${q}` : ""}`, { cacheTtlMs: 15_000 });
  },
  createRoom(dto: { facilityId?: string; name: string; roomType: string; status?: "active" | "inactive" | "archived" }) {
    return apiFetch<Room>("/admin/rooms", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  reorderRooms(dto: { facilityId?: string; roomIds: string[] }) {
    return apiFetch<Room[]>("/admin/rooms/reorder", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  updateRoom(id: string, dto: Partial<Room>) {
    return apiFetch<Room>(`/admin/rooms/${id}`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  deleteRoom(id: string) {
    return apiFetch<{ status: "deleted" | "archived"; room?: Room }>(`/admin/rooms/${id}`, { method: "DELETE" });
  },
  restoreRoom(id: string) {
    return apiFetch<Room>(`/admin/rooms/${id}/restore`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  // Templates
  listTemplates(params?: {
    facilityId?: string;
    clinicId?: string;
    reasonForVisitId?: string;
    reasonId?: string;
    type?: string;
    includeInactive?: boolean;
    includeArchived?: boolean;
    definitionsOnly?: boolean;
  }) {
    const qs = new URLSearchParams();
    if (params?.facilityId) qs.set("facilityId", params.facilityId);
    if (params?.clinicId) qs.set("clinicId", params.clinicId);
    if (params?.reasonId) qs.set("reasonId", params.reasonId);
    if (params?.reasonForVisitId) qs.set("reasonForVisitId", params.reasonForVisitId);
    if (params?.type) qs.set("type", params.type);
    if (params?.includeInactive) qs.set("includeInactive", "true");
    if (params?.includeArchived) qs.set("includeArchived", "true");
    if (params?.definitionsOnly) qs.set("definitionsOnly", "true");
    const q = qs.toString();
    return apiFetch<Template[]>(`/admin/templates${q ? `?${q}` : ""}`, { cacheTtlMs: 20_000 });
  },
  createTemplate(dto: {
    facilityId?: string;
    name: string;
    type: string;
    status?: TemplateStatus;
    reasonIds: string[];
    fields: TemplateFieldDefinition[];
    active?: boolean;
    reasonForVisitId?: string;
    jsonSchema?: Record<string, unknown>;
    uiSchema?: Record<string, unknown>;
    requiredFields?: string[];
  }) {
    return apiFetch<Template>("/admin/templates", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  updateTemplate(
    id: string,
    dto: {
      facilityId?: string;
      name?: string;
      type?: string;
      status?: TemplateStatus;
      reasonIds?: string[];
      fields?: TemplateFieldDefinition[];
      active?: boolean;
      reasonForVisitId?: string;
      jsonSchema?: Record<string, unknown>;
      uiSchema?: Record<string, unknown>;
      requiredFields?: string[];
    },
  ) {
    return apiFetch<Template>(`/admin/templates/${id}`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  deleteTemplate(id: string) {
    return apiFetch<{ status: "archived"; template: Template }>(`/admin/templates/${id}`, { method: "DELETE" });
  },

  // Thresholds
  listThresholds(facilityId?: string) {
    const qs = new URLSearchParams();
    if (facilityId) qs.set("facilityId", facilityId);
    const q = qs.toString();
    return apiFetch<AlertThreshold[]>(`/admin/thresholds${q ? `?${q}` : ""}`, { cacheTtlMs: 20_000 });
  },
  createThreshold(dto: Omit<AlertThreshold, "id">) {
    return apiFetch<AlertThreshold>("/admin/thresholds", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  updateThreshold(id: string, dto: Omit<AlertThreshold, "id">) {
    return apiFetch<AlertThreshold>(`/admin/thresholds/${id}`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  bulkUpdateThresholds(dto: {
    facilityId?: string;
    rows: Array<{
      id: string;
      clinicId?: string | null;
      metric?: "stage" | "overall_visit";
      status?: string | null;
      yellowAtMin: number;
      redAtMin: number;
      escalation2Min?: number | null;
    }>;
  }) {
    return apiFetch<AlertThreshold[]>("/admin/thresholds/bulk", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  deleteThreshold(id: string) {
    return apiFetch<void>(`/admin/thresholds/${id}`, { method: "DELETE" });
  },

  // Notification Policies
  listNotificationPolicies(facilityId?: string) {
    const qs = new URLSearchParams();
    if (facilityId) qs.set("facilityId", facilityId);
    const q = qs.toString();
    return apiFetch<NotificationPolicy[]>(`/admin/notifications${q ? `?${q}` : ""}`, { cacheTtlMs: 20_000 });
  },
  createNotificationPolicy(dto: Omit<NotificationPolicy, "id">) {
    return apiFetch<NotificationPolicy>("/admin/notifications", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  updateNotificationPolicy(id: string, dto: Omit<NotificationPolicy, "id">) {
    return apiFetch<NotificationPolicy>(`/admin/notifications/${id}`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  deleteNotificationPolicy(id: string) {
    return apiFetch<void>(`/admin/notifications/${id}`, { method: "DELETE" });
  },
  testNotificationPolicy(id: string) {
    return apiFetch<{
      policyId: string;
      status: "completed";
      results: Array<{
        channel: "in_app" | "email" | "sms" | string;
        status: "sent" | "skipped";
        recipientCount: number;
        message: string;
      }>;
    }>(`/admin/notifications/${id}/test`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  // Users
  listUsers(facilityId?: string) {
    const qs = new URLSearchParams();
    if (facilityId) qs.set("facilityId", facilityId);
    const q = qs.toString();
    return apiFetch<StaffUser[]>(`/admin/users${q ? `?${q}` : ""}`, { cacheTtlMs: 15_000 });
  },
  searchDirectoryUsers(query: string) {
    const qs = new URLSearchParams({ query });
    return apiFetch<DirectoryUser[]>(`/admin/directory-users?${qs.toString()}`, { cacheTtlMs: 10_000 });
  },
  provisionUser(dto: {
    objectId: string;
    role: Role;
    facilityIds?: string[];
    facilityId?: string;
    clinicId?: string;
  }) {
    return apiFetch<StaffUser>("/admin/users/provision", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  createUser(dto: {
    email: string;
    name?: string;
    firstName?: string;
    lastName?: string;
    credential?: string;
    role?: Role;
    facilityIds?: string[];
    clinicId?: string;
    facilityId?: string;
    phone?: string;
  }) {
    return apiFetch<StaffUser>("/admin/users", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  updateUser(id: string, dto: { email?: string; name?: string; firstName?: string; lastName?: string; credential?: string; status?: string; phone?: string }) {
    return apiFetch<
      StaffUser & {
        impact?: {
          impactedClinicCount: number;
          operationalClinicCount: number;
          nonOperationalClinicCount: number;
          clinics: Array<{
            clinicId: string;
            clinicName: string;
            clinicShortCode?: string | null;
            clinicStatus: string;
            maRun: boolean;
            roomCount: number;
            isOperational: boolean;
          }>;
        };
      }
    >(`/admin/users/${id}`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  resyncUser(id: string) {
    return apiFetch<StaffUser>(`/admin/users/${id}/resync`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },
  deleteUser(id: string) {
    return apiFetch<{ status: "archived"; userId: string }>(`/admin/users/${id}`, {
      method: "DELETE",
    });
  },
  assignRole(userId: string, dto: { role: Role; clinicId?: string; facilityId?: string }) {
    return apiFetch<StaffUser>(`/admin/users/${userId}/roles`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  removeRole(userId: string, dto: { role: Role; clinicId?: string; facilityId?: string }) {
    return apiFetch<StaffUser>(`/admin/users/${userId}/roles/remove`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },

  listAssignments(facilityId?: string) {
    const qs = new URLSearchParams();
    if (facilityId) qs.set("facilityId", facilityId);
    const q = qs.toString();
    return apiFetch<ClinicAssignment[]>(`/admin/assignments${q ? `?${q}` : ""}`, { cacheTtlMs: 15_000 });
  },
  listArchivedEncounters(params?: {
    facilityId?: string;
    clinicId?: string;
    status?: EncounterStatus;
    from?: string;
    to?: string;
    unresolvedOnly?: boolean;
    search?: string;
  }) {
    const qs = new URLSearchParams();
    if (params?.facilityId) qs.set("facilityId", params.facilityId);
    if (params?.clinicId) qs.set("clinicId", params.clinicId);
    if (params?.status) qs.set("status", params.status);
    if (params?.from) qs.set("from", params.from);
    if (params?.to) qs.set("to", params.to);
    if (typeof params?.unresolvedOnly === "boolean") qs.set("unresolvedOnly", String(params.unresolvedOnly));
    if (params?.search?.trim()) qs.set("search", params.search.trim());
    const q = qs.toString();
    return apiFetch<AdminEncounterRecoveryRow[]>(`/admin/encounters${q ? `?${q}` : ""}`, { cacheTtlMs: 10_000 });
  },
  updateAssignment(clinicId: string, dto: { providerUserId?: string | null; maUserId?: string | null }) {
    return apiFetch<ClinicAssignment>(`/admin/assignments/${clinicId}`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  listAssignmentOverrides(params?: {
    facilityId?: string;
    clinicId?: string;
    userId?: string;
    role?: Role;
    state?: "active" | "upcoming" | "expired" | "all";
  }) {
    const qs = new URLSearchParams();
    if (params?.facilityId) qs.set("facilityId", params.facilityId);
    if (params?.clinicId) qs.set("clinicId", params.clinicId);
    if (params?.userId) qs.set("userId", params.userId);
    if (params?.role) qs.set("role", params.role);
    if (params?.state) qs.set("state", params.state);
    const q = qs.toString();
    return apiFetch<TemporaryClinicAssignmentOverride[]>(`/admin/assignment-overrides${q ? `?${q}` : ""}`, { cacheTtlMs: 10_000 });
  },
  createAssignmentOverride(dto: {
    userId: string;
    role: "MA" | "Clinician";
    clinicId: string;
    facilityId: string;
    startsAt: string;
    endsAt: string;
    reason: string;
  }) {
    return apiFetch<TemporaryClinicAssignmentOverride>("/admin/assignment-overrides", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  revokeAssignmentOverride(id: string) {
    return apiFetch<TemporaryClinicAssignmentOverride>(`/admin/assignment-overrides/${id}/revoke`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  // Integrations (AthenaOne)
  getAthenaOneConnector(facilityId?: string) {
    const qs = new URLSearchParams();
    if (facilityId) qs.set("facilityId", facilityId);
    const q = qs.toString();
    return apiFetch<{
      facilityId: string;
      vendor: "athenaone";
      enabled: boolean;
      config: Record<string, unknown>;
      mapping: Record<string, string>;
      lastTestStatus: string | null;
      lastTestAt: string | null;
      lastTestMessage: string | null;
      lastSyncStatus: string | null;
      lastSyncAt: string | null;
      lastSyncMessage: string | null;
    }>(`/admin/integrations/athenaone${q ? `?${q}` : ""}`);
  },
  upsertAthenaOneConnector(dto: {
    facilityId?: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
    mapping?: Record<string, string>;
  }) {
    return apiFetch<{
      facilityId: string;
      vendor: "athenaone";
      enabled: boolean;
      config: Record<string, unknown>;
      mapping: Record<string, string>;
      lastTestStatus: string | null;
      lastTestAt: string | null;
      lastTestMessage: string | null;
      lastSyncStatus: string | null;
      lastSyncAt: string | null;
      lastSyncMessage: string | null;
    }>("/admin/integrations/athenaone", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  testAthenaOneConnector(dto: {
    facilityId?: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
    mapping?: Record<string, string>;
  }) {
    return apiFetch<{
      ok: boolean;
      status: string;
      message: string;
      testedAt: string | null;
    }>("/admin/integrations/athenaone/test", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  athenaOneSyncPreview(dto: {
    facilityId?: string;
    clinicId?: string;
    dateOfService?: string;
  }) {
    return apiFetch<{
      ok: boolean;
      mode: "preview";
      dateOfService: string;
      rowCount: number;
      rows: Array<Record<string, unknown>>;
      message: string;
    }>("/admin/integrations/athenaone/sync-preview", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  athenaOneRevenuePreview(dto: {
    facilityId?: string;
    clinicId?: string;
    dateOfService?: string;
    maxRows?: number;
  }) {
    return apiFetch<{
      ok: boolean;
      mode: "revenue_preview";
      dateOfService: string;
      rowCount: number;
      matchedCount: number;
      rows: Array<Record<string, unknown>>;
      message: string;
    }>("/admin/integrations/athenaone/revenue-preview", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  athenaOneRevenueImport(dto: {
    facilityId?: string;
    clinicId?: string;
    dateOfService?: string;
    maxRows?: number;
  }) {
    return apiFetch<{
      ok: boolean;
      mode: "revenue_import";
      dateOfService: string;
      rowCount: number;
      importedCount: number;
      skippedCount: number;
      importedCaseIds: string[];
      unmatchedRows: Array<Record<string, unknown>>;
      message: string;
    }>("/admin/integrations/athenaone/revenue-import", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  getRevenueSettings(facilityId?: string) {
    const qs = new URLSearchParams();
    if (facilityId) qs.set("facilityId", facilityId);
    const q = qs.toString();
    return apiFetch<RevenueSettings>(`/admin/revenue-settings${q ? `?${q}` : ""}`);
  },
  saveRevenueSettings(dto: {
    facilityId?: string;
    missedCollectionReasons?: string[];
    queueSla?: Record<string, number>;
    dayCloseDefaults?: {
      defaultDueHours?: number;
      requireNextAction?: boolean;
    };
    estimateDefaults?: {
      defaultPatientEstimateCents?: number;
      defaultPosCollectionPercent?: number;
      explainEstimateByDefault?: boolean;
    };
    providerQueryTemplates?: string[];
    athenaLinkTemplate?: string | null;
    athenaChecklistDefaults?: Array<{ label: string; sortOrder?: number }>;
    checklistDefaults?: Record<string, Array<{ label: string; sortOrder?: number; required?: boolean }>>;
    serviceCatalog?: Array<{
      id: string;
      label: string;
      suggestedProcedureCode?: string | null;
      expectedChargeCents?: number | null;
      detailSchemaKey?: string | null;
      active?: boolean;
      allowCustomNote?: boolean;
    }>;
    chargeSchedule?: Array<{
      code: string;
      amountCents: number;
      description?: string | null;
      active?: boolean;
    }>;
    reimbursementRules?: Array<{
      id: string;
      payerName?: string | null;
      financialClass?: string | null;
      expectedPercent: number;
      active?: boolean;
      note?: string | null;
    }>;
  }) {
    return apiFetch<RevenueSettings>("/admin/revenue-settings", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
};

export const events = {
  listAudit(params?: { route?: string; actorUserId?: string; facilityId?: string; limit?: number }) {
    const qs = new URLSearchParams();
    if (params?.route) qs.set("route", params.route);
    if (params?.actorUserId) qs.set("actorUserId", params.actorUserId);
    if (params?.facilityId) qs.set("facilityId", params.facilityId);
    if (params?.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return apiFetch<
      Array<{
        id: string;
        occurredAt: string;
        actorUserId: string | null;
        actorRole: string | null;
        authSource: string | null;
        method: string;
        route: string;
        statusCode: number;
        entityType: string | null;
        entityId: string | null;
      }>
    >(`/events/audit${q ? `?${q}` : ""}`, { cacheTtlMs: 20_000 });
  },
};

// ── Office Manager Controller (/office-manager) ─────────────────────

export const officeManager = {
  getLive(params?: {
    date?: string;
    clinicIds?: string;
    status?: string;
    alertLevel?: string;
    search?: string;
    overdueOnly?: boolean;
    safetyOnly?: boolean;
  }) {
    const qs = new URLSearchParams();
    if (params?.date) qs.set("date", params.date);
    if (params?.clinicIds) qs.set("clinicIds", params.clinicIds);
    if (params?.status) qs.set("status", params.status);
    if (params?.alertLevel) qs.set("alertLevel", params.alertLevel);
    if (params?.search) qs.set("search", params.search);
    if (params?.overdueOnly) qs.set("overdueOnly", "true");
    if (params?.safetyOnly) qs.set("safetyOnly", "true");
    const q = qs.toString();
    return apiFetch<unknown>(`/office-manager/live${q ? `?${q}` : ""}`, { cacheTtlMs: 10_000 });
  },

  getWorkbench(params?: { date?: string; clinicIds?: string }) {
    const qs = new URLSearchParams();
    if (params?.date) qs.set("date", params.date);
    if (params?.clinicIds) qs.set("clinicIds", params.clinicIds);
    const q = qs.toString();
    return apiFetch<unknown>(`/office-manager/workbench${q ? `?${q}` : ""}`, { cacheTtlMs: 10_000 });
  },

  getCloseout(params?: { date?: string; clinicIds?: string }) {
    const qs = new URLSearchParams();
    if (params?.date) qs.set("date", params.date);
    if (params?.clinicIds) qs.set("clinicIds", params.clinicIds);
    const q = qs.toString();
    return apiFetch<unknown>(`/office-manager/closeout${q ? `?${q}` : ""}`, { cacheTtlMs: 10_000 });
  },

  getReports(params?: { from?: string; to?: string; clinicIds?: string }) {
    const qs = new URLSearchParams();
    if (params?.from) qs.set("from", params.from);
    if (params?.to) qs.set("to", params.to);
    if (params?.clinicIds) qs.set("clinicIds", params.clinicIds);
    const q = qs.toString();
    return apiFetch<unknown>(`/office-manager/reports${q ? `?${q}` : ""}`, { cacheTtlMs: 15_000 });
  },

  acknowledge(dto: { encounterId: string; version: number }) {
    return apiFetch<void>("/office-manager/acknowledge", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },

  reassignMa(dto: { encounterId: string; newMaUserId: string; version: number }) {
    return apiFetch<void>("/office-manager/reassign-ma", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },

  flagNeedsHelp(dto: { encounterId: string; version: number; note?: string }) {
    return apiFetch<void>("/office-manager/flag-needs-help", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },

  workbenchUpdate(dto: {
    encounterId: string;
    status?: string;
    assigneeUserId?: string;
    notes?: string;
    holdReason?: string;
    priority?: number;
  }) {
    return apiFetch<void>("/office-manager/workbench/update", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },

  workbenchBulkUpdate(dto: {
    encounterIds: string[];
    status?: string;
    assigneeUserId?: string;
  }) {
    return apiFetch<void>("/office-manager/workbench/bulk-update", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },

  createProviderQuery(dto: {
    encounterId: string;
    queryText: string;
    priority?: number;
  }) {
    return apiFetch<void>("/office-manager/provider-query", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },

  updateProviderQueryStatus(id: string, dto: { status: string; responseText?: string }) {
    return apiFetch<void>(`/office-manager/provider-query/${id}/status`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },

  closeoutClose(dto: {
    encounterId: string;
    version: number;
    closureType: string;
    closureNotes?: string;
  }) {
    return apiFetch<void>("/office-manager/closeout/close", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },

  safetyEscalate(dto: { encounterId: string; escalationType: string; note?: string }) {
    return apiFetch<void>("/office-manager/safety/escalate", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },

  createAnnotation(dto: {
    encounterId: string;
    text: string;
    category?: string;
  }) {
    return apiFetch<void>("/office-manager/annotation", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
};

// ── Dashboard Aggregates (/dashboard) ────────────────────────────────

export const dashboards = {
  officeManager(params?: { clinicId?: string; date?: string }) {
    const qs = new URLSearchParams();
    if (params?.clinicId) qs.set("clinicId", params.clinicId);
    if (params?.date) qs.set("date", params.date);
    const q = qs.toString();
    return apiFetch<unknown>(`/dashboard/office-manager${q ? `?${q}` : ""}`, { cacheTtlMs: 25_000 });
  },
  officeManagerHistory(params?: { clinicId?: string; from?: string; to?: string }) {
    const qs = new URLSearchParams();
    if (params?.clinicId) qs.set("clinicId", params.clinicId);
    if (params?.from) qs.set("from", params.from);
    if (params?.to) qs.set("to", params.to);
    const q = qs.toString();
    return apiFetch<unknown>(`/dashboard/office-manager/history${q ? `?${q}` : ""}`, { cacheTtlMs: 30_000 });
  },
  roomHistory(params?: { clinicId?: string; from?: string; to?: string }) {
    const qs = new URLSearchParams();
    if (params?.clinicId) qs.set("clinicId", params.clinicId);
    if (params?.from) qs.set("from", params.from);
    if (params?.to) qs.set("to", params.to);
    const q = qs.toString();
    return apiFetch<{ scope: { clinicId?: string | null; from: string; to: string }; daily: RoomDailyHistoryRollup[] }>(
      `/dashboard/rooms/history${q ? `?${q}` : ""}`,
      { cacheTtlMs: 30_000 },
    );
  },
  ownerAnalytics(params?: { clinicId?: string; from?: string; to?: string }) {
    const qs = new URLSearchParams();
    if (params?.clinicId) qs.set("clinicId", params.clinicId);
    if (params?.from) qs.set("from", params.from);
    if (params?.to) qs.set("to", params.to);
    const q = qs.toString();
    return apiFetch<OwnerAnalyticsSnapshot>(`/dashboard/owner-analytics${q ? `?${q}` : ""}`, {
      cacheTtlMs: 30_000,
    });
  },
  revenueCycle(params?: {
    clinicId?: string;
    from?: string;
    to?: string;
    dayBucket?: RevenueDayBucket;
    workQueue?: RevenueWorkQueue;
    mine?: boolean;
    search?: string;
  }) {
    const qs = new URLSearchParams();
    if (params?.clinicId) qs.set("clinicId", params.clinicId);
    if (params?.from) qs.set("from", params.from);
    if (params?.to) qs.set("to", params.to);
    if (params?.dayBucket) qs.set("dayBucket", params.dayBucket);
    if (params?.workQueue) qs.set("workQueue", params.workQueue);
    if (params?.mine) qs.set("mine", "true");
    if (params?.search) qs.set("search", params.search);
    const q = qs.toString();
    return apiFetch<RevenueDashboardSnapshot>(`/dashboard/revenue-cycle${q ? `?${q}` : ""}`, {
      cacheTtlMs: 25_000,
      timeoutMs: 90_000,
    });
  },
  revenueCycleHistory(params?: { clinicId?: string; from?: string; to?: string }) {
    const qs = new URLSearchParams();
    if (params?.clinicId) qs.set("clinicId", params.clinicId);
    if (params?.from) qs.set("from", params.from);
    if (params?.to) qs.set("to", params.to);
    const q = qs.toString();
    return apiFetch<{
      scope: { clinicId?: string | null; from: string; to: string };
      daily: RevenueDailyHistoryRollup[];
      summary: RevenueHistorySummary;
    }>(
      `/dashboard/revenue-cycle/history${q ? `?${q}` : ""}`,
      {
        cacheTtlMs: 30_000,
        timeoutMs: 90_000,
      },
    );
  },
};

export const revenueCases = {
  list(params?: {
    clinicId?: string;
    encounterId?: string;
    dayBucket?: RevenueDayBucket;
    workQueue?: RevenueWorkQueue;
    search?: string;
    mine?: boolean;
    from?: string;
    to?: string;
  }) {
    const qs = new URLSearchParams();
    if (params?.clinicId) qs.set("clinicId", params.clinicId);
    if (params?.encounterId) qs.set("encounterId", params.encounterId);
    if (params?.dayBucket) qs.set("dayBucket", params.dayBucket);
    if (params?.workQueue) qs.set("workQueue", params.workQueue);
    if (params?.search) qs.set("search", params.search);
    if (params?.mine) qs.set("mine", "true");
    if (params?.from) qs.set("from", params.from);
    if (params?.to) qs.set("to", params.to);
    const q = qs.toString();
    return apiFetch<RevenueCaseDetail[]>(`/revenue-cases${q ? `?${q}` : ""}`, {
      cacheTtlMs: 15_000,
      timeoutMs: 90_000,
    });
  },
  get(id: string) {
    return apiFetch<RevenueCaseDetail>(`/revenue-cases/${id}`, {
      cacheTtlMs: 15_000,
      timeoutMs: 90_000,
    });
  },
  update(
    id: string,
    dto: {
      assignedToUserId?: string | null;
      assignedToRole?: Role | null;
      priority?: number;
      blockerCategory?: string | null;
      blockerText?: string | null;
      dueAt?: string | null;
      readyForAthena?: boolean;
      athenaHandoffStarted?: boolean;
      athenaHandoffConfirmed?: boolean;
      athenaHandoffNote?: string | null;
      financialReadiness?: {
        eligibilityStatus?: FinancialEligibilityStatus;
        registrationVerified?: boolean;
        contactInfoVerified?: boolean;
        coverageIssueCategory?: string | null;
        coverageIssueText?: string | null;
        primaryPayerName?: string | null;
        primaryPlanName?: string | null;
        secondaryPayerName?: string | null;
        financialClass?: string | null;
        benefitsSummaryText?: string | null;
        patientEstimateAmountCents?: number;
        referralRequired?: boolean;
        referralStatus?: FinancialRequirementStatus | null;
        priorAuthRequired?: boolean;
        priorAuthStatus?: FinancialRequirementStatus | null;
        priorAuthNumber?: string | null;
        pointOfServiceAmountDueCents?: number;
        estimateExplainedToPatient?: boolean;
        outstandingPriorBalanceCents?: number;
      };
      checkoutTracking?: {
        collectionExpected?: boolean;
        amountDueCents?: number;
        amountCollectedCents?: number;
        collectionOutcome?: CollectionOutcome | null;
        missedCollectionReason?: string | null;
        trackingNote?: string | null;
      };
      chargeCapture?: {
        documentationComplete?: boolean;
        codingStage?: CodingStage;
        icd10Codes?: string[];
        procedureLines?: RevenueProcedureLine[];
        cptCodes?: string[];
        modifiers?: string[];
        units?: string[];
        codingNote?: string | null;
      };
      checklistUpdates?: Array<{ id: string; status: string; evidenceText?: string | null }>;
    },
  ) {
    return apiFetch<RevenueCaseDetail>(`/revenue-cases/${id}`, {
      method: "PATCH",
      body: JSON.stringify(dto),
    });
  },
  assign(id: string, dto: { assignedToUserId?: string | null; assignedToRole: Role }) {
    return apiFetch<RevenueCaseDetail>(`/revenue-cases/${id}/assign`, {
      method: "PATCH",
      body: JSON.stringify(dto),
    });
  },
  createProviderClarification(id: string, dto: { questionText: string; queryType?: string }) {
    return apiFetch<unknown>(`/revenue-cases/${id}/provider-clarifications`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  createProviderQuery(id: string, dto: { questionText: string; queryType?: string }) {
    return apiFetch<unknown>(`/revenue-cases/${id}/provider-query`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  updateProviderClarification(id: string, dto: { responseText?: string; resolve?: boolean; status?: "Open" | "Responded" | "Resolved" }) {
    return apiFetch<unknown>(`/provider-clarifications/${id}`, {
      method: "PATCH",
      body: JSON.stringify(dto),
    });
  },
  respondToProviderQuery(id: string, dto: { responseText: string; resolve?: boolean }) {
    return apiFetch<unknown>(`/revenue-cases/queries/${id}/respond`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  roll(id: string, dto: { rollReason: string; assignedToUserId?: string | null; assignedToRole?: Role | null; dueAt?: string }) {
    return apiFetch<unknown>(`/revenue-cases/${id}/roll`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  confirmAthenaHandoff(id: string, dto: { athenaHandoffNote?: string | null; checklistUpdates?: Array<{ id: string; status: string; evidenceText?: string | null }> }) {
    return apiFetch<RevenueCaseDetail>(`/revenue-cases/${id}/athena-handoff-confirm`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
  closeout(dto: {
    clinicId?: string;
    date?: string;
    note?: string | null;
    items?: Array<{
      revenueCaseId: string;
      ownerUserId?: string | null;
      ownerRole?: Role | null;
      reasonNotCompleted: string;
      nextAction: string;
      dueAt: string;
      rollover: boolean;
    }>;
  }) {
    return apiFetch<{ date: string; rolledCount: number; unresolvedCount: number; status: string }>("/revenue-closeout", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  },
};

// ── Auth Context (/auth) ─────────────────────────────────────────────

export const auth = {
  getContext() {
    return apiFetch<AuthContextSummary>("/auth/context", { cacheTtlMs: 30_000 });
  },
  setActiveFacility(facilityId: string) {
    return apiFetch<AuthContextSummary>("/auth/context/facility", {
      method: "POST",
      body: JSON.stringify({ facilityId }),
    });
  },
};

function isoDateDaysAgo(daysAgo: number) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function swallowPrefetchError<T>(request: Promise<T>) {
  return request.catch(() => undefined);
}

export async function primeRouteData(path: string) {
  return primeRouteDataWithOptions(path);
}

export async function primeRouteDataWithOptions(
  path: string,
  options?: {
    skipAuthContext?: boolean;
  },
) {
  const session = getCurrentSession();
  if (!session) return;

  const facilityId = session.facilityId;
  const role = session.role;
  const normalizedPath = path.split("?")[0] || "/";

  let requests: Array<Promise<unknown>> = [];

  switch (normalizedPath) {
    case "/":
      requests = [
        ...(options?.skipAuthContext ? [] : [auth.getContext()]),
        admin.listRooms({ facilityId, includeInactive: true }),
        admin.listUsers(facilityId),
        admin.listAssignments(facilityId),
        alerts.list({ tab: "active", limit: 50 }),
        role === "Admin"
          ? tasks.list({ includeCompleted: false })
          : tasks.list({ mine: true, includeCompleted: false }),
      ];
      break;
    case "/office-manager":
      requests = [
        admin.listClinics({ facilityId }),
        admin.listAssignments(facilityId),
        admin.listRooms({ facilityId }),
        admin.listThresholds(facilityId),
        dashboards.officeManager(),
      ];
      break;
    case "/rooms":
      requests = [
        rooms.live({ mine: true }),
        rooms.listIssues(),
        tasks.list({ mine: true, includeCompleted: false }),
      ];
      break;
    case "/revenue-cycle":
      requests = [];
      break;
    case "/analytics":
      requests = [
        dashboards.ownerAnalytics({
          from: isoDateDaysAgo(4),
          to: isoDateDaysAgo(0),
        }),
      ];
      break;
    case "/settings":
      requests = [
        ...(options?.skipAuthContext ? [] : [auth.getContext()]),
        admin.listClinics({ facilityId, includeInactive: true, includeArchived: true }),
        admin.listRooms({ facilityId, includeInactive: true, includeArchived: true }),
        admin.listUsers(facilityId),
        admin.listAssignments(facilityId),
        admin.listReasons({ facilityId, includeInactive: true, includeArchived: true }),
        admin.listTemplates({ facilityId, includeInactive: true, includeArchived: true }),
        admin.listThresholds(facilityId),
        admin.listNotificationPolicies(facilityId),
        events.listAudit({ facilityId, limit: 200 }),
      ];
      break;
    default:
      return;
  }

  await Promise.all(requests.map(swallowPrefetchError));
}

export async function loadOverviewBootstrap(input: {
  facilityId?: string;
  role?: string;
}): Promise<OverviewBootstrapSnapshot> {
  const facilityId = input.facilityId || getCurrentSession()?.facilityId || "";
  const role = input.role || getCurrentSession()?.role || "Admin";
  const tasksRequest =
    role === "Admin"
      ? tasks.list({ includeCompleted: false })
      : tasks.list({ mine: true, includeCompleted: false });

  const [roomsResult, usersResult, assignmentsResult, alertsResult, tasksResult] =
    await Promise.allSettled([
      admin.listRooms({ facilityId, includeInactive: true }),
      admin.listUsers(facilityId),
      admin.listAssignments(facilityId),
      alerts.list({ tab: "active", limit: 50 }),
      tasksRequest,
    ]);

  const errors: string[] = [];

  return {
    facilityId,
    role,
    rooms:
      roomsResult.status === "fulfilled"
        ? (roomsResult.value as any[])
        : (errors.push(
            `Rooms: ${
              roomsResult.reason instanceof Error
                ? roomsResult.reason.message
                : "failed to load"
            }`,
          ),
          []),
    users:
      usersResult.status === "fulfilled"
        ? (usersResult.value as any[])
        : (errors.push(
            `Users: ${
              usersResult.reason instanceof Error
                ? usersResult.reason.message
                : "failed to load"
            }`,
          ),
          []),
    assignments:
      assignmentsResult.status === "fulfilled"
        ? (assignmentsResult.value as any[])
        : (errors.push(
            `Assignments: ${
              assignmentsResult.reason instanceof Error
                ? assignmentsResult.reason.message
                : "failed to load"
            }`,
          ),
          []),
    alerts:
      alertsResult.status === "fulfilled"
        ? (((alertsResult.value as any)?.items || []) as any[])
        : (errors.push(
            `Alerts: ${
              alertsResult.reason instanceof Error
                ? alertsResult.reason.message
                : "failed to load"
            }`,
          ),
          []),
    tasks:
      tasksResult.status === "fulfilled"
        ? ((tasksResult.value as any[]) || [])
        : (errors.push(
            `Tasks: ${
              tasksResult.reason instanceof Error
                ? tasksResult.reason.message
                : "failed to load"
            }`,
          ),
          []),
    errors,
  };
}
