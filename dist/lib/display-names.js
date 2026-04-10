function withArchivedSuffix(name) {
    return name.endsWith(" (Archived)") ? name : `${name} (Archived)`;
}
function isArchivedStatus(status) {
    return (status || "").toLowerCase() === "archived";
}
export function formatClinicDisplayName(clinic) {
    const name = (clinic?.name || "").trim();
    if (!name)
        return "Clinic";
    return isArchivedStatus(clinic?.status) ? withArchivedSuffix(name) : name;
}
export function formatRoomDisplayName(room) {
    const name = (room?.name || "").trim();
    if (!name)
        return null;
    return isArchivedStatus(room?.status) ? withArchivedSuffix(name) : name;
}
export function formatProviderDisplayName(provider) {
    const name = (provider?.name || "").trim();
    if (!name)
        return "Unassigned";
    return provider?.active === false ? withArchivedSuffix(name) : name;
}
export function formatUserDisplayName(user) {
    const name = (user?.name || "").trim();
    if (!name)
        return null;
    return isArchivedStatus(user?.status) ? withArchivedSuffix(name) : name;
}
export function formatReasonDisplayName(reason) {
    const name = (reason?.name || "").trim();
    if (!name)
        return null;
    return isArchivedStatus(reason?.status) ? withArchivedSuffix(name) : name;
}
export function formatTemplateDisplayName(template) {
    const name = (template?.name || "").trim();
    if (!name)
        return null;
    return isArchivedStatus(template?.status) ? withArchivedSuffix(name) : name;
}
//# sourceMappingURL=display-names.js.map