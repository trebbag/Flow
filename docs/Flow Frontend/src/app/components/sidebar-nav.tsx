import { useState, useRef, useCallback, useEffect } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import {
  LayoutDashboard,
  ClipboardCheck,
  Stethoscope,
  Users,
  CreditCard,
  BarChart3,
  Settings,
  Shield,
  Activity,
  Bell,
  Moon,
  DollarSign,
  LogIn,
  DoorOpen,
} from "lucide-react";
import { cn } from "./ui/utils";
import { alerts as alertsApi, tasks as tasksApi, primeRouteDataWithOptions } from "./api-client";
import { useSidebar } from "./sidebar-context";
import { clearSession, loadSession, type AuthSession } from "./auth-session";
import { auth } from "./api-client";
import { ADMIN_REFRESH_EVENT, FACILITY_CONTEXT_CHANGED_EVENT, SESSION_CHANGED_EVENT } from "./app-events";
import { logoutFromMicrosoft, resetMicrosoftLoginState } from "./microsoft-auth";
import { getAllowedPathsForRole, type AppPath } from "./role-access";
import { useAppBootstrap } from "./app-bootstrap";

const workflowItems: Array<{ to: AppPath; icon: React.ElementType; label: string }> = [
  { to: "/", icon: Activity, label: "Overview" },
  { to: "/checkin", icon: LogIn, label: "Front Desk Check-In" },
  { to: "/ma-board", icon: Users, label: "MA Board" },
  { to: "/rooms", icon: DoorOpen, label: "Rooms" },
  { to: "/clinician", icon: Stethoscope, label: "Clinician Board" },
  { to: "/checkout", icon: CreditCard, label: "Front Desk Check-Out" },
  { to: "/office-manager", icon: LayoutDashboard, label: "Office Manager" },
  { to: "/revenue-cycle", icon: DollarSign, label: "Revenue Cycle" },
  { to: "/closeout", icon: Moon, label: "End-of-Day Closeout" },
  { to: "/alerts", icon: Bell, label: "Alerts" },
  { to: "/tasks", icon: ClipboardCheck, label: "Tasks" },
];

const adminItems: Array<{ to: AppPath; icon: React.ElementType; label: string }> = [
  { to: "/analytics", icon: BarChart3, label: "Analytics" },
  { to: "/settings", icon: Settings, label: "Admin Console" },
];

// ── Fixed-position tooltip state ──
type TooltipState = { label: string; top: number; left: number } | null;

function nameParts(session: AuthSession | null) {
  const explicitFirst = session?.firstName?.trim();
  const explicitLast = session?.lastName?.trim();
  if (explicitFirst || explicitLast) {
    return {
      first: explicitFirst || explicitLast || "User",
      last: explicitLast || ""
    };
  }
  const source = session?.name?.trim() || session?.username?.split("@")[0] || session?.email?.split("@")[0] || "";
  const parts = source.split(/\s+/).filter(Boolean);
  return {
    first: parts[0] || "User",
    last: parts.length > 1 ? parts[parts.length - 1] || "" : ""
  };
}

function deriveUserLabel(session: AuthSession | null) {
  if (!session) return "User";
  const parts = nameParts(session);
  const label = [parts.first, parts.last].filter(Boolean).join(" ").trim();
  return label || session.email || session.username || "User";
}

function deriveInitials(session: AuthSession | null) {
  const parts = nameParts(session);
  const first = parts.first?.[0] || session?.email?.[0] || session?.username?.[0] || "U";
  const last = parts.last?.[0] || "";
  return `${first}${last || (parts.first?.[1] || "")}`.toUpperCase();
}

export function SidebarNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const bootstrap = useAppBootstrap();
  const { collapsed, toggle: toggleCollapsed } = useSidebar();
  const [session, setSession] = useState(() => loadSession());
  const [tooltip, setTooltip] = useState<TooltipState>(null);
  const [facilityLabel, setFacilityLabel] = useState("Facility");
  const [facilityTimezone, setFacilityTimezone] = useState("America/New_York");
  const [alertCount, setAlertCount] = useState(0);
  const [taskCount, setTaskCount] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const hideTimeout = useRef<ReturnType<typeof setTimeout>>(null);

  const activeRole = session?.role || "Unknown";
  const allowedPaths = session ? getAllowedPathsForRole(session.role) : new Set<AppPath>();
  const visibleWorkflowItems = workflowItems.filter((item) => allowedPaths.has(item.to));
  const visibleAdminItems = activeRole === "Admin" ? adminItems.filter((item) => allowedPaths.has(item.to)) : [];
  const userLabel = deriveUserLabel(session);
  const initials = deriveInitials(session);

  useEffect(() => {
    let active = true;
    const refreshFacilityContext = () => {
      const nextSession = loadSession();
      setSession(nextSession);
      if (!nextSession) {
        setFacilityLabel("Facility");
        setFacilityTimezone("America/New_York");
        return;
      }

       if (bootstrap.authContext) {
        const context = bootstrap.authContext;
        setSession((current) =>
          current
            ? {
                ...current,
                userId: context.userId || current.userId,
                name: context.name || current.name,
                email: context.email || current.email,
                firstName: context.firstName || current.firstName,
                lastName: context.lastName || current.lastName,
              }
            : current,
        );
        const match = (context.availableFacilities || []).find(
          (facility) => facility.id === (context.activeFacilityId || nextSession.facilityId),
        );
        if (match?.name) {
          setFacilityLabel(match.name);
        }
        if (match?.timezone) {
          setFacilityTimezone(match.timezone);
        }
        if (bootstrap.phase !== "ready") {
          return;
        }
      }

      auth
        .getContext()
        .then((context) => {
          if (!active) return;
          setSession((current) =>
            current
              ? {
                  ...current,
                  userId: context.userId || current.userId,
                  name: context.name || current.name,
                  email: context.email || current.email,
                  firstName: context.firstName || current.firstName,
                  lastName: context.lastName || current.lastName,
                }
              : current,
          );
          const match = (context.availableFacilities || []).find(
            (facility) => facility.id === (context.activeFacilityId || nextSession.facilityId),
          );
          if (match?.name) {
            setFacilityLabel(match.name);
          }
          if (match?.timezone) {
            setFacilityTimezone(match.timezone);
          }
        })
        .catch(() => undefined);
    };

    refreshFacilityContext();
    if (typeof window !== "undefined") {
      window.addEventListener(FACILITY_CONTEXT_CHANGED_EVENT, refreshFacilityContext);
      window.addEventListener(SESSION_CHANGED_EVENT, refreshFacilityContext);
    }
    return () => {
      active = false;
      if (typeof window !== "undefined") {
        window.removeEventListener(FACILITY_CONTEXT_CHANGED_EVENT, refreshFacilityContext);
        window.removeEventListener(SESSION_CHANGED_EVENT, refreshFacilityContext);
      }
    };
  }, [bootstrap.authContext, bootstrap.phase]);

  useEffect(() => {
    let mounted = true;

    if (bootstrap.overviewSnapshot) {
      setAlertCount(bootstrap.overviewSnapshot.alerts.length);
      setTaskCount(bootstrap.overviewSnapshot.tasks.length);
    }

    if (bootstrap.phase !== "ready") {
      return () => {
        mounted = false;
      };
    }

    const refreshCounts = () => {
      Promise.all([
        alertsApi.list({ tab: "active", limit: 200 }),
        tasksApi.list({ mine: true, includeCompleted: false }),
      ])
        .then(([alertRes, taskRes]) => {
          if (!mounted) return;
          setAlertCount(alertRes.total || alertRes.items.length || 0);
          setTaskCount((taskRes || []).length);
        })
        .catch(() => {
          if (!mounted) return;
          setAlertCount(0);
          setTaskCount(0);
        });
    };

    const timeoutId = setTimeout(refreshCounts, bootstrap.overviewSnapshot ? 1200 : 0);
    const onRefresh = () => refreshCounts();
    if (typeof window !== "undefined") {
      window.addEventListener(ADMIN_REFRESH_EVENT, onRefresh);
      window.addEventListener(FACILITY_CONTEXT_CHANGED_EVENT, onRefresh);
      window.addEventListener(SESSION_CHANGED_EVENT, onRefresh);
    }
    const interval = setInterval(refreshCounts, 30000);
    return () => {
      mounted = false;
      clearTimeout(timeoutId);
      clearInterval(interval);
      if (typeof window !== "undefined") {
        window.removeEventListener(ADMIN_REFRESH_EVENT, onRefresh);
        window.removeEventListener(FACILITY_CONTEXT_CHANGED_EVENT, onRefresh);
        window.removeEventListener(SESSION_CHANGED_EVENT, onRefresh);
      }
    };
  }, [bootstrap.overviewSnapshot, bootstrap.phase]);

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(interval);
  }, []);

  const facilityDateTimeLabel = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: facilityTimezone,
    timeZoneName: "short"
  }).format(now);

  const showTooltip = useCallback((e: React.MouseEvent, label: string) => {
    if (hideTimeout.current) clearTimeout(hideTimeout.current);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setTooltip({
      label,
      top: rect.top + rect.height / 2,
      left: rect.right + 12,
    });
  }, []);

  const hideTooltip = useCallback(() => {
    hideTimeout.current = setTimeout(() => setTooltip(null), 80);
  }, []);

  const warmRoute = useCallback((to: string) => {
    if (bootstrap.phase !== "ready") return;
    void primeRouteDataWithOptions(to, {
      skipAuthContext: Boolean(bootstrap.authContext),
    });
  }, [bootstrap.authContext, bootstrap.phase]);

  const handleSwitchAccount = useCallback(async () => {
    const existing = loadSession();
    clearSession();
    resetMicrosoftLoginState();
    setSession(null);
    setAlertCount(0);
    setTaskCount(0);
    setFacilityLabel("Facility");
    setFacilityTimezone("America/New_York");

    if (existing?.mode === "microsoft") {
      try {
        await logoutFromMicrosoft();
        return;
      } catch {
        // Fall back to the local login screen if the remote logout redirect fails.
      }
    }

    navigate("/login?fresh=1", { replace: true });
  }, [navigate]);

  useEffect(() => {
    if (!session || bootstrap.phase !== "ready") return;

    const likelyRoutesByRole: Record<string, string[]> = {
      Admin: ["/", "/rooms", "/office-manager", "/revenue-cycle", "/analytics", "/settings"],
      FrontDeskCheckIn: ["/", "/checkin"],
      MA: ["/", "/ma-board", "/rooms"],
      Clinician: ["/", "/clinician"],
      FrontDeskCheckOut: ["/", "/checkout"],
      OfficeManager: ["/", "/rooms", "/office-manager"],
      RevenueCycle: ["/", "/revenue-cycle"],
    };

    const routeTargets = likelyRoutesByRole[activeRole] || ["/"];
    const uniqueTargets = Array.from(new Set([location.pathname, ...routeTargets]));

    const runWarmup = () => {
      uniqueTargets.forEach((target) => warmRoute(target));
    };

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let idleId: number | null = null;

    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      idleId = window.requestIdleCallback(runWarmup, { timeout: 2800 });
    } else {
      timeoutId = setTimeout(runWarmup, 1400);
    }

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (idleId !== null && typeof window !== "undefined" && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleId);
      }
    };
  }, [activeRole, bootstrap.phase, location.pathname, session, warmRoute]);

  const renderNavItem = (item: { to: string; icon: React.ElementType; label: string }, showBadge?: boolean) => {
    const isActive = item.to === "/"
      ? location.pathname === "/"
      : location.pathname === item.to || location.pathname.startsWith(item.to + "/");

    return (
      <NavLink
        key={item.to}
        to={item.to}
        className={cn(
          "relative group flex items-center gap-3 rounded-lg text-[13px] transition-all",
          collapsed ? "justify-center px-0 py-2.5" : "px-3 py-2.5",
          isActive
            ? "bg-white/10 text-white"
            : "text-white/50 hover:text-white/80 hover:bg-white/5"
        )}
        style={isActive ? { fontWeight: 500 } : {}}
        onMouseEnter={(e) => {
          warmRoute(item.to);
          if (collapsed) showTooltip(e, item.label);
        }}
        onMouseLeave={collapsed ? hideTooltip : undefined}
        onFocus={() => warmRoute(item.to)}
      >
        <item.icon className="w-[18px] h-[18px] shrink-0" />
        {!collapsed && <span className="flex-1">{item.label}</span>}
        {!collapsed && showBadge && (item.to === "/alerts" || item.to === "/tasks") && (
          <>
            {item.to === "/alerts" && alertCount > 0 && (
              <span className="w-5 h-5 rounded-full bg-red-500 text-white text-[10px] flex items-center justify-center" style={{ fontWeight: 600 }}>
                {alertCount}
              </span>
            )}
            {item.to === "/tasks" && taskCount > 0 && (
              <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-[10px] flex items-center justify-center" style={{ fontWeight: 600 }}>
                {taskCount}
              </span>
            )}
          </>
        )}
        {collapsed && showBadge && (item.to === "/alerts" || item.to === "/tasks") && (
          <>
            {item.to === "/alerts" && alertCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-red-500 text-white text-[8px] flex items-center justify-center" style={{ fontWeight: 600 }}>
                {alertCount}
              </span>
            )}
            {item.to === "/tasks" && taskCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-blue-600 text-white text-[8px] flex items-center justify-center" style={{ fontWeight: 600 }}>
                {taskCount}
              </span>
            )}
          </>
        )}
      </NavLink>
    );
  };

  return (
    <aside
      className={cn(
        "bg-[#0f0d1f] text-white flex flex-col h-full transition-all duration-200",
        collapsed ? "w-[60px] min-w-[60px]" : "w-[240px] min-w-[240px]"
      )}
    >
      {/* Logo / brand — clicking the icon toggles collapse */}
      <div className={cn("flex items-center border-b border-white/10", collapsed ? "justify-center px-0 py-5" : "px-5 py-5 gap-3")}>
        <button
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-pressed={!collapsed}
          className="w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shrink-0 hover:from-indigo-400 hover:to-purple-500 transition-all cursor-pointer"
          title={collapsed ? "Expand sidebar (⌘B)" : "Collapse sidebar (⌘B)"}
        >
          <Activity className="w-5 h-5 text-white" />
        </button>
        {!collapsed && (
          <div>
            <div className="text-[15px] tracking-tight" style={{ fontWeight: 600 }}>Flow</div>
            <div className="text-[11px] text-white/50 tracking-wide uppercase">Clinical Operations</div>
          </div>
        )}
      </div>

      {/* Clinic info */}
      {!collapsed && (
        <div className="px-5 py-4 border-b border-white/10">
          <div className="text-[11px] text-white/40 uppercase tracking-wider mb-1">Facility</div>
          <div className="text-[13px] text-white/90">{facilityLabel}</div>
          <div className="text-[11px] text-white/40 mt-0.5">{facilityDateTimeLabel}</div>
        </div>
      )}

      {/* Nav items */}
      <nav className={cn("flex-1 py-3 overflow-y-auto", collapsed ? "px-2 space-y-1" : "px-3 space-y-0.5")}>
        {visibleWorkflowItems.map((item) => renderNavItem(item, item.to === "/alerts" || item.to === "/tasks"))}

        {visibleAdminItems.length > 0 && (
          <>
            {!collapsed && <div className="px-2 py-2 mt-4 text-[10px] text-white/30 uppercase tracking-widest">Admin</div>}
            {collapsed && <div className="my-3 border-t border-white/10" />}
            {visibleAdminItems.map((item) => renderNavItem(item, true))}
          </>
        )}
      </nav>

      {/* User */}
      <div className={cn("border-t border-white/10", collapsed ? "px-2 py-4 flex justify-center" : "px-4 py-4 flex items-center gap-3")}>
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center text-[11px] text-white shrink-0" style={{ fontWeight: 600 }}>
          {initials}
        </div>
        {!collapsed && (
          <div className="flex-1 min-w-0">
            <div className="text-[13px] text-white/90 truncate">{userLabel}</div>
            <div className="text-[11px] text-white/40 flex items-center gap-1">
              <Shield className="w-3 h-3" /> {activeRole}
            </div>
          </div>
        )}
        {!collapsed && (
          <button
            type="button"
            onClick={() => {
              void handleSwitchAccount();
            }}
            className="h-7 px-2.5 rounded-md border border-white/15 text-white/70 hover:text-white hover:bg-white/5 text-[11px] flex items-center gap-1.5 transition-colors"
            style={{ fontWeight: 500 }}
          >
            <LogIn className="w-3 h-3" />
            Switch
          </button>
        )}
      </div>

      {/* Fixed-position tooltip — rendered directly with fixed positioning */}
      {tooltip && (
        <div
          className="fixed z-[9999] px-3 py-1.5 rounded-lg bg-gray-900/95 backdrop-blur-sm text-white text-[12px] whitespace-nowrap shadow-xl border border-white/10 pointer-events-none"
          style={{ top: tooltip.top, left: tooltip.left, transform: "translateY(-50%)", fontWeight: 500 }}
        >
          {/* Arrow */}
          <div
            className="absolute top-1/2 -left-[6px] -translate-y-1/2 w-0 h-0"
            style={{
              borderTop: "5px solid transparent",
              borderBottom: "5px solid transparent",
              borderRight: "6px solid rgba(17,24,39,0.95)",
            }}
          />
          {tooltip.label}
        </div>
      )}
    </aside>
  );
}
