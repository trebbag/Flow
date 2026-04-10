function appendArchivedSuffix(name: string) {
  return name.endsWith(" (Archived)") ? name : `${name} (Archived)`;
}

function normalized(value?: string | null) {
  return String(value || "").trim();
}

export function labelClinicName(name?: string | null, status?: string | null) {
  const value = normalized(name);
  if (!value) return "Clinic";
  return String(status || "").toLowerCase() === "archived" ? appendArchivedSuffix(value) : value;
}

export function compactClinicBadgeLabel(name?: string | null) {
  const value = normalized(name);
  if (!value) return "Clinic";
  if (value.endsWith(" (Archived)")) {
    const base = value.slice(0, -" (Archived)".length).trim();
    const compact = base.split(/\s+/)[0] || base;
    return appendArchivedSuffix(compact);
  }
  const compact = value.split(/\s+/)[0] || value;
  return compact;
}

export function labelRoomName(name?: string | null, status?: string | null) {
  const value = normalized(name);
  if (!value) return "";
  return String(status || "").toLowerCase() === "archived" ? appendArchivedSuffix(value) : value;
}

export function labelProviderName(name?: string | null, active?: boolean | null) {
  const value = normalized(name);
  if (!value) return "Unassigned";
  return active === false ? appendArchivedSuffix(value) : value;
}

export function labelUserName(name?: string | null, status?: string | null) {
  const value = normalized(name);
  if (!value) return "";
  return String(status || "").toLowerCase() === "archived" ? appendArchivedSuffix(value) : value;
}

export function labelReasonName(name?: string | null, status?: string | null) {
  const value = normalized(name);
  if (!value) return "";
  return String(status || "").toLowerCase() === "archived" ? appendArchivedSuffix(value) : value;
}

export function labelTemplateName(name?: string | null, status?: string | null) {
  const value = normalized(name);
  if (!value) return "";
  return String(status || "").toLowerCase() === "archived" ? appendArchivedSuffix(value) : value;
}
