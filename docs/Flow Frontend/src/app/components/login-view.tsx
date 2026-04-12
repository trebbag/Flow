import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Shield, KeyRound, UserRound, LogIn, Loader2 } from "lucide-react";
import { auth } from "./api-client";
import { applySession, clearSession, loadSession, saveSession, type AuthMode, type AuthSession } from "./auth-session";
import {
  getMicrosoftAccount,
  handleMicrosoftRedirect,
  isMicrosoftAuthConfigured,
  logoutFromMicrosoft,
  startMicrosoftLogin,
} from "./microsoft-auth";
import type { Role } from "./types";

const roles: Role[] = [
  "Admin",
  "FrontDeskCheckIn",
  "MA",
  "Clinician",
  "FrontDeskCheckOut",
  "RevenueCycle",
];

const loginEnv = (typeof import.meta !== "undefined" && (import.meta as any).env) || {};
const configuredDevUserId = String(loginEnv.VITE_DEV_USER_ID || "").trim();
const enableDevHeaderLogin =
  String(
    loginEnv.VITE_ENABLE_DEV_HEADER_LOGIN ??
      (!loginEnv.PROD || configuredDevUserId ? "true" : "false"),
  ).toLowerCase() === "true";
const microsoftConfigured = isMicrosoftAuthConfigured();
const requestedDefaultMode = String(loginEnv.VITE_DEFAULT_AUTH_MODE || "").toLowerCase();
const defaultMode: AuthMode =
  requestedDefaultMode === "microsoft" && microsoftConfigured
    ? "microsoft"
    : requestedDefaultMode === "bearer"
      ? "bearer"
      : enableDevHeaderLogin
        ? "dev_header"
        : microsoftConfigured
          ? "microsoft"
          : "bearer";

type FacilityOption = {
  id: string;
  name: string;
  shortCode?: string | null;
  timezone?: string;
  status?: string;
};

function parseNext(locationSearch: string) {
  const params = new URLSearchParams(locationSearch);
  return params.get("next") || "/";
}

export function LoginView() {
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState<AuthMode>(defaultMode);
  const [role, setRole] = useState<Role>("Admin");
  const [userId, setUserId] = useState("");
  const [token, setToken] = useState("");
  const [facilityId, setFacilityId] = useState("");
  const [facilityOptions, setFacilityOptions] = useState<FacilityOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [microsoftAccountLabel, setMicrosoftAccountLabel] = useState("");

  const nextPath = useMemo(() => parseNext(location.search), [location.search]);

  const finalizeSession = async (session: AuthSession, redirectTarget = nextPath) => {
    applySession(session);
    const context = await auth.getContext();
    setFacilityOptions(context.availableFacilities || []);

    const resolvedRole = (context.role as Role) || session.role;
    setRole(resolvedRole);

    let resolvedFacilityId =
      session.facilityId ||
      context.activeFacilityId ||
      context.facilityId ||
      (context.availableFacilities.length === 1 ? context.availableFacilities[0]!.id : "");

    if (resolvedRole !== "Admin" && !resolvedFacilityId) {
      setError("Select a facility to continue.");
      return null;
    }

    if (resolvedFacilityId && resolvedFacilityId !== context.activeFacilityId) {
      const updatedContext = await auth.setActiveFacility(resolvedFacilityId);
      setFacilityOptions(updatedContext.availableFacilities || []);
      resolvedFacilityId = updatedContext.activeFacilityId || resolvedFacilityId;
    }

    const persisted: AuthSession = {
      ...session,
      role: resolvedRole,
      userId: context.userId,
      facilityId: resolvedFacilityId || undefined,
    };

    applySession(persisted);
    saveSession(persisted);
    navigate(redirectTarget, { replace: true });
    return persisted;
  };

  useEffect(() => {
    const existing = loadSession();
    if (!existing) {
      setMode(defaultMode);
      return;
    }

    const resolvedMode =
      !enableDevHeaderLogin && existing.mode === "dev_header"
        ? "bearer"
        : !microsoftConfigured && existing.mode === "microsoft"
          ? "bearer"
          : existing.mode;
    setMode(resolvedMode);
    setRole(existing.role);
    setUserId(existing.userId || "");
    setToken(existing.token || "");
    setFacilityId(existing.facilityId || "");
    setMicrosoftAccountLabel(existing.name || existing.username || "");
  }, []);

  useEffect(() => {
    if (!enableDevHeaderLogin && mode === "dev_header") {
      setMode(microsoftConfigured ? "microsoft" : "bearer");
    }
  }, [mode]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateMicrosoftSession() {
      if (!microsoftConfigured) return;

      try {
        const redirect = await handleMicrosoftRedirect();
        const account = redirect.account || (await getMicrosoftAccount());
        if (cancelled || !account) return;

        const label = account.name || account.username || "Microsoft account connected";
        setMicrosoftAccountLabel(label);

        if (!redirect.result) return;

        setLoading(true);
        setError(null);
        setMode("microsoft");

        const provisional: AuthSession = {
          mode: "microsoft",
          role: "Admin",
          facilityId: facilityId || undefined,
          accountHomeId: account.homeAccountId,
          username: account.username,
          name: account.name || undefined,
        };

        const completed = await finalizeSession(provisional, redirect.postLoginPath || nextPath);
        if (!completed && !cancelled) {
          applySession(provisional);
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Microsoft sign-in failed";
        setError(message);
        applySession(null);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    hydrateMicrosoftSession();
    return () => {
      cancelled = true;
    };
  }, [nextPath, facilityId]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      if (mode === "microsoft") {
        if (!microsoftConfigured) {
          throw new Error("Microsoft Entra login is not configured for this environment.");
        }

        const account = await getMicrosoftAccount();
        if (!account) {
          const loginResult = await startMicrosoftLogin(nextPath);
          if (!loginResult?.account) {
            return;
          }

          setMicrosoftAccountLabel(
            loginResult.account.name || loginResult.account.username || "Microsoft account connected",
          );

          const popupSession: AuthSession = {
            mode,
            role,
            facilityId: facilityId || undefined,
            accountHomeId: loginResult.account.homeAccountId,
            username: loginResult.account.username,
            name: loginResult.account.name || undefined,
          };

          const popupCompleted = await finalizeSession(popupSession);
          if (!popupCompleted) {
            applySession(popupSession);
          }
          return;
        }

        setMicrosoftAccountLabel(account.name || account.username || "Microsoft account connected");

        const session: AuthSession = {
          mode,
          role,
          facilityId: facilityId || undefined,
          accountHomeId: account.homeAccountId,
          username: account.username,
          name: account.name || undefined,
        };

        const completed = await finalizeSession(session);
        if (!completed) {
          applySession(session);
        }
        return;
      }

      const session: AuthSession =
        mode === "bearer"
          ? { mode, role, token: token.trim(), facilityId: facilityId || undefined }
          : { mode, role, userId: userId.trim(), facilityId: facilityId || undefined };

      if (mode === "bearer" && !session.token) {
        throw new Error("JWT token is required.");
      }

      if (mode === "dev_header" && !session.userId) {
        throw new Error("User ID is required for dev-header login.");
      }
      if (mode === "dev_header" && !enableDevHeaderLogin) {
        throw new Error("Dev-header login is disabled in this environment.");
      }

      const completed = await finalizeSession(session);
      if (!completed) {
        applySession(session);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Login failed";
      setError(message);
      applySession(null);
    } finally {
      setLoading(false);
    }
  };

  const handleClearSession = async () => {
    const existing = loadSession();
    clearSession();
    setError(null);
    setToken("");
    setUserId("");
    setFacilityId("");
    setFacilityOptions([]);
    setMicrosoftAccountLabel("");
    setMode(defaultMode);

    if (existing?.mode === "microsoft" && microsoftConfigured) {
      try {
        await logoutFromMicrosoft();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Microsoft sign-out failed";
        setError(message);
      }
    }
  };

  return (
    <div className="min-h-screen bg-[#f7f8fb] flex items-center justify-center p-4">
      <div className="w-full max-w-[480px] rounded-2xl border border-gray-200 bg-white shadow-sm">
        <div className="px-6 pt-6 pb-4 border-b border-gray-100">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
              <Shield className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-[18px] tracking-tight" style={{ fontWeight: 700 }}>
                ClinOps Login
              </h1>
              <p className="text-[12px] text-muted-foreground">
                Sign in with Microsoft for production-style access, or use local auth modes for development.
              </p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className={`grid gap-2 ${enableDevHeaderLogin ? "grid-cols-3" : microsoftConfigured ? "grid-cols-2" : "grid-cols-1"}`}>
            {enableDevHeaderLogin && (
              <button
                type="button"
                onClick={() => setMode("dev_header")}
                className={`h-9 rounded-lg border text-[12px] transition-colors ${
                  mode === "dev_header"
                    ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                    : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                }`}
                style={{ fontWeight: 500 }}
              >
                Dev Header
              </button>
            )}
            {microsoftConfigured && (
              <button
                type="button"
                onClick={() => setMode("microsoft")}
                className={`h-9 rounded-lg border text-[12px] transition-colors ${
                  mode === "microsoft"
                    ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                    : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                }`}
                style={{ fontWeight: 500 }}
              >
                Microsoft Entra
              </button>
            )}
            <button
              type="button"
              onClick={() => setMode("bearer")}
              className={`h-9 rounded-lg border text-[12px] transition-colors ${
                mode === "bearer"
                  ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                  : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
              }`}
              style={{ fontWeight: 500 }}
            >
              Bearer JWT
            </button>
          </div>

          {mode !== "microsoft" && (
            <div>
              <label
                htmlFor="login-role"
                className="text-[12px] text-muted-foreground mb-1.5 block"
                style={{ fontWeight: 500 }}
              >
                Role
              </label>
              <div className="relative">
                <UserRound className="w-3.5 h-3.5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <select
                  id="login-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as Role)}
                  className="w-full h-10 pl-9 pr-3 rounded-lg border border-gray-200 bg-white text-[13px] focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                >
                  {roles.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {mode === "dev_header" ? (
            <div>
              <label
                htmlFor="login-user-id"
                className="text-[12px] text-muted-foreground mb-1.5 block"
                style={{ fontWeight: 500 }}
              >
                User ID
              </label>
              <div className="relative">
                <KeyRound className="w-3.5 h-3.5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  id="login-user-id"
                  value={userId}
                  onChange={(e) => setUserId(e.target.value)}
                  placeholder="UUID from seeded DB (example: admin user)"
                  className="w-full h-10 pl-9 pr-3 rounded-lg border border-gray-200 bg-white text-[13px] focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                />
              </div>
              <p className="text-[11px] text-muted-foreground mt-1.5">
                Uses `x-dev-user-id` + `x-dev-role` headers.
              </p>
            </div>
          ) : mode === "bearer" ? (
            <div>
              <label
                htmlFor="login-jwt-token"
                className="text-[12px] text-muted-foreground mb-1.5 block"
                style={{ fontWeight: 500 }}
              >
                JWT Token
              </label>
              <textarea
                id="login-jwt-token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste Bearer token here"
                className="w-full h-28 p-3 rounded-lg border border-gray-200 bg-white text-[12px] focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 resize-none"
              />
            </div>
          ) : (
            <div className="rounded-xl border border-gray-200 bg-[#f9fafc] px-4 py-3">
              <div className="text-[12px] text-gray-500" style={{ fontWeight: 600 }}>
                Microsoft Entra
              </div>
              <div className="text-[13px] text-gray-900 mt-1" style={{ fontWeight: 600 }}>
                {microsoftAccountLabel || "No Microsoft account connected yet."}
              </div>
              <p className="text-[11px] text-muted-foreground mt-1.5 leading-5">
                Use your Microsoft 365 / Entra account. Flow will still apply role and facility access from its own database.
              </p>
            </div>
          )}

          {(role !== "Admin" || facilityOptions.length > 0 || facilityId || mode === "microsoft") && (
            <div>
              <label
                htmlFor="login-facility"
                className="text-[12px] text-muted-foreground mb-1.5 block"
                style={{ fontWeight: 500 }}
              >
                Facility
              </label>
              <select
                id="login-facility"
                value={facilityId}
                onChange={(e) => setFacilityId(e.target.value)}
                className="w-full h-10 px-3 rounded-lg border border-gray-200 bg-white text-[13px] focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                disabled={facilityOptions.length === 0}
              >
                <option value="">{facilityOptions.length === 0 ? "Sign in once to load facilities" : "Select facility"}</option>
                {facilityOptions.map((facility) => (
                  <option key={facility.id} value={facility.id}>
                    {facility.shortCode ? `${facility.shortCode} · ${facility.name}` : facility.name}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground mt-1.5">
                Non-admin roles must select a facility context at login.
              </p>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
              {error}
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button
              type="submit"
              disabled={loading}
              className="h-10 px-4 rounded-lg bg-indigo-600 text-white text-[13px] hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
              style={{ fontWeight: 600 }}
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
              {loading
                ? "Signing In..."
                : mode === "microsoft"
                  ? microsoftAccountLabel
                    ? "Continue"
                    : "Continue with Microsoft"
                  : "Sign In"}
            </button>
            <button
              type="button"
              onClick={() => {
                void handleClearSession();
              }}
              className="h-10 px-4 rounded-lg border border-gray-200 text-[13px] text-gray-600 hover:bg-gray-50 transition-colors"
              style={{ fontWeight: 500 }}
            >
              Clear Session
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
