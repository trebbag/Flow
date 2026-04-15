import { DefaultAzureCredential } from "@azure/identity";
import { env } from "./env.js";
import { ApiError } from "./errors.js";
const GRAPH_USER_SELECT = "id,displayName,mail,userPrincipalName,accountEnabled,userType";
let credential = null;
function getCredential() {
    if (!credential) {
        credential = new DefaultAzureCredential({
            managedIdentityClientId: env.ENTRA_GRAPH_MANAGED_IDENTITY_CLIENT_ID || undefined
        });
    }
    return credential;
}
function escapeODataLiteral(value) {
    return value.replace(/'/g, "''");
}
function normalizeDirectoryUser(row) {
    const email = String(row.mail || row.userPrincipalName || "").trim().toLowerCase();
    const userType = String(row.userType || "").trim() || "Unknown";
    const accountEnabled = row.accountEnabled !== false;
    const memberUser = userType.toLowerCase() === "member";
    return {
        objectId: row.id,
        displayName: String(row.displayName || email || row.id).trim(),
        email,
        userPrincipalName: String(row.userPrincipalName || email).trim().toLowerCase(),
        accountEnabled,
        userType,
        tenantId: env.ENTRA_TENANT_ID || "",
        identityProvider: "entra",
        directoryStatus: !accountEnabled ? "disabled" : memberUser ? "active" : "guest"
    };
}
async function graphRequest(pathname, init) {
    const token = await getCredential().getToken(env.ENTRA_GRAPH_SCOPE);
    if (!token?.token) {
        throw new ApiError(503, "Microsoft Graph access is unavailable. Configure a managed identity or Azure developer login before using Entra provisioning.");
    }
    const response = await fetch(`${env.ENTRA_GRAPH_API_BASE_URL}${pathname}`, {
        ...init,
        headers: {
            authorization: `Bearer ${token.token}`,
            accept: "application/json",
            ...(init?.headers || {})
        }
    });
    if (response.status === 404) {
        throw new ApiError(404, "Microsoft Entra user was not found.");
    }
    if (!response.ok) {
        const body = await response.text();
        throw new ApiError(503, `Microsoft Graph request failed (${response.status}). ${body || "Verify Graph permissions and managed identity access."}`);
    }
    return (await response.json());
}
async function graphRequestMaybe(pathname, init) {
    try {
        return await graphRequest(pathname, init);
    }
    catch (error) {
        if (error instanceof ApiError && error.statusCode === 404) {
            return null;
        }
        throw error;
    }
}
async function getEntraDirectoryUserByPrincipal(params) {
    const exactMatches = Array.from(new Set([params.userPrincipalName, params.email]
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean)));
    if (exactMatches.length === 0) {
        return null;
    }
    const filter = exactMatches
        .flatMap((value) => {
        const escaped = escapeODataLiteral(value);
        return [`userPrincipalName eq '${escaped}'`, `mail eq '${escaped}'`];
    })
        .join(" or ");
    const search = new URLSearchParams({
        $select: GRAPH_USER_SELECT,
        $top: "5",
        $filter: filter
    });
    const payload = await graphRequest(`/users?${search.toString()}`);
    const rows = Array.isArray(payload.value) ? payload.value : [];
    for (const row of rows) {
        const normalized = normalizeDirectoryUser(row);
        if (exactMatches.includes(normalized.userPrincipalName) || exactMatches.includes(normalized.email)) {
            return normalized;
        }
    }
    return rows.length > 0 ? normalizeDirectoryUser(rows[0]) : null;
}
export async function searchEntraDirectoryUsers(query) {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length < 2) {
        return [];
    }
    const escaped = escapeODataLiteral(normalizedQuery);
    const search = new URLSearchParams({
        $select: GRAPH_USER_SELECT,
        $top: "15",
        $filter: `accountEnabled eq true and userType eq 'Member' and (` +
            `startsWith(displayName,'${escaped}') or startsWith(userPrincipalName,'${escaped}') or startsWith(mail,'${escaped}'))`
    });
    const payload = await graphRequest(`/users?${search.toString()}`);
    return (payload.value || []).map(normalizeDirectoryUser);
}
export async function getEntraDirectoryUserByObjectId(objectId, fallbackIdentifiers) {
    const trimmed = objectId.trim();
    if (!trimmed) {
        throw new ApiError(400, "Microsoft Entra object ID is required.");
    }
    const search = new URLSearchParams({
        $select: GRAPH_USER_SELECT
    });
    const payload = await graphRequestMaybe(`/users/${encodeURIComponent(trimmed)}?${search.toString()}`);
    if (payload) {
        return normalizeDirectoryUser(payload);
    }
    return getEntraDirectoryUserByPrincipal(fallbackIdentifiers || {});
}
//# sourceMappingURL=entra-directory.js.map