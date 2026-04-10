function withArchivedSuffix(name: string) {
  return name.endsWith(" (Archived)") ? name : `${name} (Archived)`;
}

function isArchivedStatus(status?: string | null) {
  return (status || "").toLowerCase() === "archived";
}

export function formatClinicDisplayName(clinic?: { name?: string | null; status?: string | null } | null) {
  const name = (clinic?.name || "").trim();
  if (!name) return "Clinic";
  return isArchivedStatus(clinic?.status) ? withArchivedSuffix(name) : name;
}

export function formatRoomDisplayName(room?: { name?: string | null; status?: string | null } | null) {
  const name = (room?.name || "").trim();
  if (!name) return null;
  return isArchivedStatus(room?.status) ? withArchivedSuffix(name) : name;
}

export function formatProviderDisplayName(provider?: { name?: string | null; active?: boolean | null } | null) {
  const name = (provider?.name || "").trim();
  if (!name) return "Unassigned";
  return provider?.active === false ? withArchivedSuffix(name) : name;
}

export function formatUserDisplayName(user?: { name?: string | null; status?: string | null } | null) {
  const name = (user?.name || "").trim();
  if (!name) return null;
  return isArchivedStatus(user?.status) ? withArchivedSuffix(name) : name;
}

export function formatReasonDisplayName(reason?: { name?: string | null; status?: string | null } | null) {
  const name = (reason?.name || "").trim();
  if (!name) return null;
  return isArchivedStatus(reason?.status) ? withArchivedSuffix(name) : name;
}

export function formatTemplateDisplayName(template?: { name?: string | null; status?: string | null } | null) {
  const name = (template?.name || "").trim();
  if (!name) return null;
  return isArchivedStatus(template?.status) ? withArchivedSuffix(name) : name;
}
