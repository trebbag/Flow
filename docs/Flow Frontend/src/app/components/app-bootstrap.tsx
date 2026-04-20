import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  auth,
  loadOverviewBootstrap,
  type AuthContextSummary,
  type OverviewBootstrapSnapshot,
} from "./api-client";
import { loadSession, type AuthSession } from "./auth-session";
import { SESSION_CHANGED_EVENT, FACILITY_CONTEXT_CHANGED_EVENT } from "./app-events";
import {
  completeMicrosoftSignIn,
  type CompleteMicrosoftSignInResult,
} from "./complete-microsoft-signin";
import { hasMicrosoftLoginPending } from "./microsoft-auth";

export type BootstrapPhase =
  | "idle"
  | "microsoft_redirect"
  | "session_restoration"
  | "context_loading"
  | "initial_data_loading"
  | "ready"
  | "error";

type BootstrapRunKind = "microsoft" | "restore";

type AppBootstrapContextValue = {
  phase: BootstrapPhase;
  error: string | null;
  session: AuthSession | null;
  authContext: AuthContextSummary | null;
  overviewSnapshot: OverviewBootstrapSnapshot | null;
  isBootstrapping: boolean;
  completeMicrosoftBootstrap: (nextPath?: string) => Promise<string | null>;
  retryBootstrap: () => Promise<string | null>;
};

const AppBootstrapContext = createContext<AppBootstrapContextValue | null>(null);

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : "Flow could not finish startup.";
}

function fallbackPathFromWindow() {
  if (typeof window === "undefined") return "/";

  const { pathname, search, hash } = window.location;
  if (pathname === "/login") {
    const params = new URLSearchParams(search);
    return params.get("next") || "/";
  }

  if (pathname === "/auth/callback") {
    return "/";
  }

  const resolved = `${pathname}${search}${hash}`;
  return resolved || "/";
}

export function AppBootstrapProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<BootstrapPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<AuthSession | null>(() => loadSession());
  const [authContext, setAuthContext] = useState<AuthContextSummary | null>(null);
  const [overviewSnapshot, setOverviewSnapshot] = useState<OverviewBootstrapSnapshot | null>(null);

  const bootstrapPromiseRef = useRef<Promise<string | null> | null>(null);
  const lastRunRef = useRef<{ kind: BootstrapRunKind; nextPath?: string } | null>(null);
  const restoredSessionKeyRef = useRef<string | null>(null);
  const microsoftRedirectPending = !session && hasMicrosoftLoginPending();

  const hydrateOverview = useCallback(
    async (inputSession: AuthSession, inputContext: AuthContextSummary) => {
      setPhase("initial_data_loading");
      const snapshot = await loadOverviewBootstrap({
        facilityId: inputContext.activeFacilityId || inputContext.facilityId || inputSession.facilityId || "",
        role: inputSession.role || inputContext.role,
      });
      setOverviewSnapshot(snapshot);
      setPhase("ready");
      return snapshot;
    },
    [],
  );

  const restoreSessionBootstrap = useCallback(
    async (inputSession?: AuthSession | null) => {
      const candidateSession = inputSession || loadSession();
      if (!candidateSession) {
        setSession(null);
        setAuthContext(null);
        setOverviewSnapshot(null);
        setPhase("idle");
        return null;
      }

      setError(null);
      setSession(candidateSession);
      setPhase("session_restoration");

      setPhase("context_loading");
      const context = await auth.getContext();
      const activeFacilityId =
        context.activeFacilityId ||
        context.facilityId ||
        (candidateSession.facilityId &&
        context.availableFacilities.some((facility) => facility.id === candidateSession.facilityId)
          ? candidateSession.facilityId
          : undefined) ||
        (context.availableFacilities.length === 1 ? context.availableFacilities[0]!.id : undefined);

      let resolvedContext = context;
      if (activeFacilityId && activeFacilityId !== context.activeFacilityId) {
        resolvedContext = await auth.setActiveFacility(activeFacilityId);
      }

      setAuthContext(resolvedContext);

      const mergedSession: AuthSession = {
        ...candidateSession,
        role: (resolvedContext.role as AuthSession["role"]) || candidateSession.role,
        userId: resolvedContext.userId || candidateSession.userId,
        facilityId: activeFacilityId || candidateSession.facilityId,
        name: resolvedContext.name || candidateSession.name,
        email: resolvedContext.email || candidateSession.email,
        firstName: resolvedContext.firstName || candidateSession.firstName,
        lastName: resolvedContext.lastName || candidateSession.lastName,
      };

      setSession(mergedSession);
      await hydrateOverview(mergedSession, resolvedContext);
      return null;
    },
    [hydrateOverview],
  );

  const completeMicrosoftBootstrap = useCallback(
    async (nextPath = "/") => {
      if (bootstrapPromiseRef.current) {
        return bootstrapPromiseRef.current;
      }

      lastRunRef.current = { kind: "microsoft", nextPath };
      setError(null);
      setOverviewSnapshot(null);
      setPhase("microsoft_redirect");

      const request = (async () => {
        try {
          const result = await completeMicrosoftSignIn(nextPath, {
            onPhaseChange: (nextPhase) => {
              setPhase(nextPhase);
            },
          });

          if (!result) {
            setPhase("idle");
            return null;
          }

          const typedResult = result as CompleteMicrosoftSignInResult;
          setSession(typedResult.session);
          setAuthContext(typedResult.context);
          await hydrateOverview(typedResult.session, typedResult.context);
          return typedResult.targetPath;
        } catch (nextError) {
          setError(messageFromError(nextError));
          setPhase("error");
          return null;
        } finally {
          bootstrapPromiseRef.current = null;
        }
      })();

      bootstrapPromiseRef.current = request;
      return request;
    },
    [hydrateOverview],
  );

  const retryBootstrap = useCallback(async () => {
    const lastRun = lastRunRef.current;
    if (lastRun?.kind === "microsoft") {
      return completeMicrosoftBootstrap(lastRun.nextPath || "/");
    }

    const current = loadSession();
    if (current) {
      try {
        lastRunRef.current = { kind: "restore" };
        await restoreSessionBootstrap(current);
        return null;
      } catch (nextError) {
        setError(messageFromError(nextError));
        setPhase("error");
      }
    }

    return null;
  }, [completeMicrosoftBootstrap, restoreSessionBootstrap]);

  useEffect(() => {
    const syncSession = () => {
      const nextSession = loadSession();
      setSession(nextSession);
      if (!nextSession) {
        restoredSessionKeyRef.current = null;
        setAuthContext(null);
        setOverviewSnapshot(null);
        setPhase("idle");
        setError(null);
      }
    };

    syncSession();
    if (typeof window !== "undefined") {
      window.addEventListener(SESSION_CHANGED_EVENT, syncSession);
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener(SESSION_CHANGED_EVENT, syncSession);
      }
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    if (authContext) return;
    if (phase !== "idle") return;

    const sessionKey = [
      session.mode,
      session.userId || "",
      session.accountHomeId || "",
      session.facilityId || "",
      session.username || "",
    ].join("|");
    if (restoredSessionKeyRef.current === sessionKey) return;

    restoredSessionKeyRef.current = sessionKey;
    lastRunRef.current = { kind: "restore" };
    void restoreSessionBootstrap(session).catch((nextError) => {
      setError(messageFromError(nextError));
      setPhase("error");
    });
  }, [authContext, phase, restoreSessionBootstrap, session]);

  useEffect(() => {
    if (session) return;
    if (phase !== "idle") return;
    if (!hasMicrosoftLoginPending()) return;

    const fallbackPath = fallbackPathFromWindow();
    void completeMicrosoftBootstrap(fallbackPath).catch((nextError) => {
      setError(messageFromError(nextError));
      setPhase("error");
    });
  }, [completeMicrosoftBootstrap, phase, session]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const refreshContext = () => {
      const current = loadSession();
      if (!current) {
        setSession(null);
        setAuthContext(null);
        setOverviewSnapshot(null);
        return;
      }

      setSession(current);
      void auth
        .getContext()
        .then((context) => {
          setAuthContext(context);
        })
        .catch(() => undefined);
    };

    window.addEventListener(FACILITY_CONTEXT_CHANGED_EVENT, refreshContext);
    return () => {
      window.removeEventListener(FACILITY_CONTEXT_CHANGED_EVENT, refreshContext);
    };
  }, []);

  const value = useMemo<AppBootstrapContextValue>(
    () => ({
      phase,
      error,
      session,
      authContext,
      overviewSnapshot,
      isBootstrapping:
        microsoftRedirectPending || (phase !== "idle" && phase !== "ready" && phase !== "error"),
      completeMicrosoftBootstrap,
      retryBootstrap,
    }),
    [
      authContext,
      completeMicrosoftBootstrap,
      error,
      microsoftRedirectPending,
      overviewSnapshot,
      phase,
      retryBootstrap,
      session,
    ],
  );

  return <AppBootstrapContext.Provider value={value}>{children}</AppBootstrapContext.Provider>;
}

export function useAppBootstrap() {
  const context = useContext(AppBootstrapContext);
  if (!context) {
    throw new Error("useAppBootstrap must be used within AppBootstrapProvider");
  }
  return context;
}
