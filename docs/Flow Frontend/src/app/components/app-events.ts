export const ADMIN_REFRESH_EVENT = "clinops:admin-refresh";
export const FACILITY_CONTEXT_CHANGED_EVENT = "clinops:facility-context-changed";
export const SESSION_CHANGED_EVENT = "clinops:session-changed";

export function dispatchAdminRefresh() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(ADMIN_REFRESH_EVENT));
  }
}

export function dispatchFacilityContextChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(FACILITY_CONTEXT_CHANGED_EVENT));
  }
}

export function dispatchSessionChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
  }
}
