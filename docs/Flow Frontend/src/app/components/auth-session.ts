import type { Role } from "./types";
import { dispatchSessionChanged } from "./app-events";

export type AuthMode = "dev_header" | "proof_header" | "bearer" | "microsoft";

export type AuthSession = {
  mode: AuthMode;
  role: Role;
  userId?: string;
  token?: string;
  proofSecret?: string;
  facilityId?: string;
  accountHomeId?: string;
  username?: string;
  name?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
};

const STORAGE_KEY = "flow_auth_session";
let currentSession: AuthSession | null = null;

function isAuthMode(value: unknown): value is AuthMode {
  return value === "dev_header" || value === "proof_header" || value === "bearer" || value === "microsoft";
}

export function buildHeaders(session: AuthSession): Record<string, string> {
  if (session.mode === "bearer") {
    const headers: Record<string, string> = {};
    if (session.token) headers.Authorization = `Bearer ${session.token}`;
    if (session.facilityId) headers["x-facility-id"] = session.facilityId;
    return headers;
  }

  if (session.mode === "microsoft") {
    const headers: Record<string, string> = {};
    if (session.facilityId) headers["x-facility-id"] = session.facilityId;
    return headers;
  }

  if (session.mode === "proof_header") {
    const headers: Record<string, string> = {
      "x-proof-role": session.role,
    };
    if (session.userId) {
      headers["x-proof-user-id"] = session.userId;
    }
    if (session.proofSecret) {
      headers["x-proof-secret"] = session.proofSecret;
    }
    if (session.facilityId) {
      headers["x-facility-id"] = session.facilityId;
    }
    return headers;
  }

  const headers: Record<string, string> = {
    "x-dev-role": session.role,
  };
  if (session.userId) {
    headers["x-dev-user-id"] = session.userId;
  }
  if (session.facilityId) {
    headers["x-facility-id"] = session.facilityId;
  }
  return headers;
}

function parseStoredSession(raw: string | null): AuthSession | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as AuthSession;
    if (!parsed?.role || !isAuthMode(parsed.mode)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function applySession(session: AuthSession | null) {
  currentSession = session;
}

export function loadSession(): AuthSession | null {
  if (currentSession) return currentSession;
  if (typeof window === "undefined") return null;

  currentSession = parseStoredSession(window.localStorage.getItem(STORAGE_KEY));
  return currentSession;
}

export function getCurrentSession(): AuthSession | null {
  return currentSession || loadSession();
}

export function saveSession(session: AuthSession) {
  currentSession = session;
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  dispatchSessionChanged();
}

export function clearSession() {
  currentSession = null;
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
  dispatchSessionChanged();
}
