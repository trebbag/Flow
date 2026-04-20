import { useMemo } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { SidebarNav } from "./sidebar-nav";
import { Toaster } from "sonner";
import { EncounterProvider } from "./encounter-context";
import { SidebarProvider, useSidebar } from "./sidebar-context";
import { useKeyboardShortcuts } from "./use-keyboard-shortcuts";
import { applySession, clearSession, loadSession } from "./auth-session";
import { canAccessPath } from "./role-access";
import { useAppBootstrap } from "./app-bootstrap";
import { BootstrapLoadingScreen } from "./bootstrap-loading-screen";
import { resetMicrosoftLoginState } from "./microsoft-auth";

function LayoutInner() {
  const navigate = useNavigate();
  const location = useLocation();
  const { toggle } = useSidebar();

  const shortcuts = useMemo(
    () => [
      {
        key: "b",
        meta: true,
        handler: () => {
          toggle();
        },
      },
      {
        key: "Escape",
        handler: () => {
          // If an input/textarea is focused, blur it first instead of navigating
          const active = document.activeElement as HTMLElement | null;
          if (
            active &&
            (active.tagName === "INPUT" ||
              active.tagName === "TEXTAREA" ||
              active.tagName === "SELECT")
          ) {
            active.blur();
            return;
          }
          // Only navigate back if we're on a sub-page (not root)
          if (location.pathname !== "/") {
            navigate(-1);
          }
        },
      },
    ],
    [toggle, navigate, location.pathname],
  );

  useKeyboardShortcuts(shortcuts);

  return (
    <div
      className="flex h-screen w-full overflow-hidden bg-[#f8f9fb]"
      style={{ fontFamily: "'Inter', system-ui, sans-serif" }}
    >
      <SidebarNav />
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
      <Toaster position="bottom-right" richColors closeButton />
    </div>
  );
}

export function RootLayout() {
  const location = useLocation();
  const bootstrap = useAppBootstrap();
  const session = bootstrap.session || loadSession();

  if (!session) {
    if (bootstrap.isBootstrapping || bootstrap.phase === "error") {
      return (
        <BootstrapLoadingScreen
          phase={bootstrap.phase === "idle" ? "microsoft_redirect" : bootstrap.phase}
          error={bootstrap.error}
          onRetry={() => {
            void bootstrap.retryBootstrap();
          }}
          onReturnToLogin={() => {
            clearSession();
            resetMicrosoftLoginState();
          }}
        />
      );
    }
    const next = encodeURIComponent(`${location.pathname}${location.search}${location.hash}`);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  if (!canAccessPath(session.role, location.pathname)) {
    return <Navigate to="/" replace />;
  }

  applySession(session);

  return (
    <EncounterProvider>
      <SidebarProvider>
        <LayoutInner />
      </SidebarProvider>
    </EncounterProvider>
  );
}
