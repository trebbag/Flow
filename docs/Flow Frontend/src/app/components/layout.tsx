import { useMemo } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { SidebarNav } from "./sidebar-nav";
import { Toaster } from "sonner";
import { EncounterProvider } from "./encounter-context";
import { SidebarProvider, useSidebar } from "./sidebar-context";
import { useKeyboardShortcuts } from "./use-keyboard-shortcuts";
import { applySession, loadSession } from "./auth-session";

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
  const session = loadSession();

  if (!session) {
    const next = encodeURIComponent(`${location.pathname}${location.search}${location.hash}`);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  if (location.pathname.startsWith("/settings") && session.role !== "Admin") {
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
