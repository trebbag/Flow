import type { Role } from "./types";

export type AppPath =
  | "/"
  | "/encounter"
  | "/checkin"
  | "/ma-board"
  | "/clinician"
  | "/checkout"
  | "/rooms"
  | "/office-manager"
  | "/revenue-cycle"
  | "/closeout"
  | "/alerts"
  | "/tasks"
  | "/analytics"
  | "/settings";

const ROLE_ROUTE_ACCESS: Record<Role, Set<AppPath>> = {
  Admin: new Set([
    "/",
    "/encounter",
    "/checkin",
    "/ma-board",
    "/clinician",
    "/checkout",
    "/rooms",
    "/office-manager",
    "/revenue-cycle",
    "/closeout",
    "/alerts",
    "/tasks",
    "/analytics",
    "/settings",
  ]),
  FrontDeskCheckIn: new Set(["/", "/checkin", "/alerts", "/tasks"]),
  MA: new Set(["/", "/ma-board", "/rooms", "/alerts", "/tasks"]),
  Clinician: new Set(["/", "/clinician", "/alerts", "/tasks"]),
  FrontDeskCheckOut: new Set(["/", "/checkout", "/closeout", "/alerts", "/tasks"]),
  OfficeManager: new Set(["/", "/rooms", "/office-manager", "/alerts", "/tasks"]),
  RevenueCycle: new Set(["/", "/encounter", "/revenue-cycle", "/alerts", "/tasks"]),
};

const ROUTE_PREFIXES: Array<[AppPath, string]> = [
  ["/encounter", "/encounter"],
  ["/settings", "/settings"],
  ["/analytics", "/analytics"],
  ["/office-manager", "/office-manager"],
  ["/rooms", "/rooms"],
  ["/revenue-cycle", "/revenue-cycle"],
  ["/closeout", "/closeout"],
  ["/checkout", "/checkout"],
  ["/clinician", "/clinician"],
  ["/ma-board", "/ma-board"],
  ["/checkin", "/checkin"],
  ["/alerts", "/alerts"],
  ["/tasks", "/tasks"],
  ["/", "/"],
];

export function getAllowedPathsForRole(role: Role): ReadonlySet<AppPath> {
  return ROLE_ROUTE_ACCESS[role];
}

export function canAccessPath(role: Role, pathname: string): boolean {
  const normalizedPath = pathname.split("?")[0] || "/";
  const matchedPath =
    ROUTE_PREFIXES.find(([path, prefix]) =>
      prefix === "/"
        ? normalizedPath === "/"
        : normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`),
    )?.[0] || "/";
  return ROLE_ROUTE_ACCESS[role].has(matchedPath);
}
