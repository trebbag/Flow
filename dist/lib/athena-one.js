import { env } from "./env.js";
const ATHENA_SECRET_FIELDS = ["password", "apiKey", "clientSecret", "accessToken", "refreshToken"];
function toRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    return value;
}
function toStringValue(value) {
    if (value === null || value === undefined)
        return "";
    return String(value).trim();
}
function normalizeAuthType(value) {
    const raw = toStringValue(value).toLowerCase();
    if (raw === "api_key" || raw === "apikey")
        return "api_key";
    if (raw === "basic")
        return "basic";
    if (raw === "oauth2" || raw === "oauth")
        return "oauth2";
    return "none";
}
function normalizeDepartmentIds(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => toStringValue(entry)).filter(Boolean);
    }
    const raw = toStringValue(value);
    if (!raw)
        return [];
    return raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}
function normalizeHeaders(value) {
    const raw = toRecord(value);
    const normalized = {};
    for (const [key, entry] of Object.entries(raw)) {
        const k = toStringValue(key);
        const v = toStringValue(entry);
        if (!k || !v)
            continue;
        normalized[k] = v;
    }
    return normalized;
}
export function normalizeAthenaConnectorConfig(input) {
    const raw = toRecord(input);
    const timeoutCandidate = Number(raw.timeoutMs);
    const retryCandidate = Number(raw.retryCount);
    const backoffCandidate = Number(raw.retryBackoffMs);
    return {
        baseUrl: toStringValue(raw.baseUrl).replace(/\/$/, ""),
        practiceId: toStringValue(raw.practiceId),
        departmentIds: normalizeDepartmentIds(raw.departmentIds),
        authType: normalizeAuthType(raw.authType),
        username: toStringValue(raw.username),
        password: toStringValue(raw.password),
        apiKey: toStringValue(raw.apiKey),
        apiKeyHeader: toStringValue(raw.apiKeyHeader) || "Authorization",
        apiKeyPrefix: toStringValue(raw.apiKeyPrefix) || "Bearer",
        clientId: toStringValue(raw.clientId),
        clientSecret: toStringValue(raw.clientSecret),
        accessToken: toStringValue(raw.accessToken),
        refreshToken: toStringValue(raw.refreshToken),
        timeoutMs: Number.isFinite(timeoutCandidate) && timeoutCandidate >= 500
            ? Math.round(timeoutCandidate)
            : env.ATHENA_TIMEOUT_MS,
        retryCount: Number.isFinite(retryCandidate) && retryCandidate >= 0
            ? Math.round(retryCandidate)
            : env.ATHENA_RETRY_COUNT,
        retryBackoffMs: Number.isFinite(backoffCandidate) && backoffCandidate >= 0
            ? Math.round(backoffCandidate)
            : env.ATHENA_RETRY_BACKOFF_MS,
        testPath: toStringValue(raw.testPath) || "/",
        previewPath: toStringValue(raw.previewPath) || "/",
        headers: normalizeHeaders(raw.headers)
    };
}
function withLeadingSlash(path) {
    const cleaned = path.trim();
    if (!cleaned)
        return "/";
    return cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
}
function isRetryableStatus(statusCode) {
    return statusCode === 429 || statusCode >= 500;
}
function parseRetryAfterMs(value) {
    if (!value)
        return null;
    const asSeconds = Number(value);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
        return Math.round(asSeconds * 1000);
    }
    const parsedDate = Date.parse(value);
    if (!Number.isFinite(parsedDate))
        return null;
    const delta = parsedDate - Date.now();
    return delta > 0 ? delta : null;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function summarizeBody(bodyText) {
    const compact = bodyText.replace(/\s+/g, " ").trim();
    if (!compact)
        return "";
    return compact.slice(0, 280);
}
function buildAthenaHeaders(config, extraHeaders) {
    const headers = {
        Accept: "application/json",
        ...config.headers,
        ...extraHeaders
    };
    if (config.authType === "api_key") {
        if (config.apiKey) {
            const authValue = config.apiKeyPrefix ? `${config.apiKeyPrefix} ${config.apiKey}` : config.apiKey;
            headers[config.apiKeyHeader || "Authorization"] = authValue;
        }
    }
    else if (config.authType === "basic") {
        if (config.username && config.password) {
            headers.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
        }
    }
    else if (config.authType === "oauth2") {
        if (config.accessToken) {
            headers.Authorization = `Bearer ${config.accessToken}`;
        }
    }
    return headers;
}
function parseJsonMaybe(text) {
    if (!text)
        return null;
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
async function requestAthena(config, params) {
    const requestPath = withLeadingSlash(params.path);
    const url = new URL(requestPath, `${config.baseUrl || "https://localhost"}`);
    if (params.query) {
        Object.entries(params.query).forEach(([key, value]) => {
            if (value === undefined || value === null || String(value).trim().length === 0)
                return;
            url.searchParams.set(key, String(value));
        });
    }
    const maxAttempts = Math.max(1, config.retryCount + 1);
    const startedAt = Date.now();
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
        try {
            const response = await fetch(url, {
                method: "GET",
                headers: buildAthenaHeaders(config),
                signal: controller.signal
            });
            const bodyText = await response.text();
            const bodyJson = parseJsonMaybe(bodyText);
            if (response.ok) {
                return {
                    ok: true,
                    statusCode: response.status,
                    attempts: attempt,
                    durationMs: Date.now() - startedAt,
                    message: `Remote request succeeded with HTTP ${response.status}`,
                    bodyText,
                    bodyJson
                };
            }
            const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
            const canRetry = attempt < maxAttempts && isRetryableStatus(response.status);
            if (canRetry) {
                const backoff = retryAfterMs ?? Math.max(100, config.retryBackoffMs * attempt);
                clearTimeout(timeout);
                await sleep(backoff);
                continue;
            }
            return {
                ok: false,
                statusCode: response.status,
                attempts: attempt,
                durationMs: Date.now() - startedAt,
                message: `HTTP ${response.status}: ${summarizeBody(bodyText) || "request failed"}`,
                bodyText,
                bodyJson
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const canRetry = attempt < maxAttempts;
            if (canRetry) {
                clearTimeout(timeout);
                await sleep(Math.max(100, config.retryBackoffMs * attempt));
                continue;
            }
            return {
                ok: false,
                statusCode: null,
                attempts: attempt,
                durationMs: Date.now() - startedAt,
                message,
                bodyText: "",
                bodyJson: null
            };
        }
        finally {
            clearTimeout(timeout);
        }
    }
    return {
        ok: false,
        statusCode: null,
        attempts: maxAttempts,
        durationMs: Date.now() - startedAt,
        message: "Unknown request failure",
        bodyText: "",
        bodyJson: null
    };
}
export function mergeAthenaConnectorConfig(existingInput, incomingInput) {
    const existing = normalizeAthenaConnectorConfig(existingInput);
    const incoming = normalizeAthenaConnectorConfig(incomingInput);
    const merged = {
        ...existing,
        ...incoming
    };
    ATHENA_SECRET_FIELDS.forEach((field) => {
        const incomingValue = incoming[field];
        if (incomingValue)
            return;
        merged[field] = existing[field] || "";
    });
    if (!incoming.baseUrl)
        merged.baseUrl = existing.baseUrl;
    if (!incoming.practiceId)
        merged.practiceId = existing.practiceId;
    if (incoming.departmentIds.length === 0 && existing.departmentIds.length > 0) {
        merged.departmentIds = existing.departmentIds;
    }
    if (!incoming.testPath)
        merged.testPath = existing.testPath;
    if (!incoming.previewPath)
        merged.previewPath = existing.previewPath;
    if (Object.keys(incoming.headers).length === 0 && Object.keys(existing.headers).length > 0) {
        merged.headers = existing.headers;
    }
    return merged;
}
export function redactAthenaConnectorConfig(input) {
    const normalized = normalizeAthenaConnectorConfig(input);
    const redacted = {
        ...normalized,
        password: "",
        apiKey: "",
        clientSecret: "",
        accessToken: "",
        refreshToken: "",
        secretsConfigured: {
            password: normalized.password.length > 0,
            apiKey: normalized.apiKey.length > 0,
            clientSecret: normalized.clientSecret.length > 0,
            accessToken: normalized.accessToken.length > 0,
            refreshToken: normalized.refreshToken.length > 0
        }
    };
    return redacted;
}
function extractPreviewRows(payload) {
    if (Array.isArray(payload))
        return payload;
    if (!payload || typeof payload !== "object")
        return [];
    const obj = payload;
    const keys = ["appointments", "rows", "data", "results", "items"];
    for (const key of keys) {
        const entry = obj[key];
        if (Array.isArray(entry)) {
            return entry;
        }
    }
    return [];
}
function readMappedValue(row, candidates) {
    for (const candidate of candidates) {
        const key = candidate.trim();
        if (!key)
            continue;
        if (!(key in row))
            continue;
        const value = row[key];
        if (value === undefined || value === null)
            continue;
        const text = String(value).trim();
        if (!text)
            continue;
        return text;
    }
    return "";
}
export async function testAthenaConnectorConfig(input) {
    const config = normalizeAthenaConnectorConfig(input);
    if (!config.baseUrl || !config.practiceId) {
        return {
            ok: false,
            status: "error",
            message: "baseUrl and practiceId are required for AthenaOne test validation.",
            testedAt: new Date().toISOString(),
            detail: {
                attempts: 0,
                durationMs: 0,
                statusCode: null
            }
        };
    }
    const result = await requestAthena(config, {
        path: config.testPath || "/",
        query: {
            practiceId: config.practiceId,
            departmentIds: config.departmentIds.join(",") || undefined
        }
    });
    return {
        ok: result.ok,
        status: result.ok ? "ok" : "error",
        message: result.ok
            ? `AthenaOne connectivity check succeeded (${result.statusCode ?? "n/a"}) in ${result.durationMs}ms.`
            : `AthenaOne connectivity check failed: ${result.message}`,
        testedAt: new Date().toISOString(),
        detail: {
            attempts: result.attempts,
            durationMs: result.durationMs,
            statusCode: result.statusCode,
            responsePreview: summarizeBody(result.bodyText)
        }
    };
}
export async function previewAthenaSchedule(params) {
    const config = normalizeAthenaConnectorConfig(params.config);
    const mappingRaw = toRecord(params.mapping);
    if (!config.baseUrl || !config.practiceId) {
        return {
            ok: false,
            status: "error",
            rowCount: 0,
            rows: [],
            message: "AthenaOne preview requires baseUrl and practiceId in connector config.",
            detail: {
                attempts: 0,
                durationMs: 0,
                statusCode: null
            }
        };
    }
    const result = await requestAthena(config, {
        path: config.previewPath || "/",
        query: {
            practiceId: config.practiceId,
            dateOfService: params.dateOfService,
            clinicId: params.clinicId,
            departmentIds: config.departmentIds.join(",") || undefined
        }
    });
    if (!result.ok) {
        return {
            ok: false,
            status: "error",
            rowCount: 0,
            rows: [],
            message: `AthenaOne sync preview failed: ${result.message}`,
            detail: {
                attempts: result.attempts,
                durationMs: result.durationMs,
                statusCode: result.statusCode,
                responsePreview: summarizeBody(result.bodyText)
            }
        };
    }
    const payloadRows = extractPreviewRows(result.bodyJson);
    const maxRows = Math.max(1, Math.min(100, params.maxRows || 25));
    const clinicKeys = [toStringValue(mappingRaw.clinicId), toStringValue(mappingRaw.clinic), "clinicId", "departmentid", "departmentId", "clinic"];
    const patientKeys = [toStringValue(mappingRaw.patientId), toStringValue(mappingRaw.patient), "patientId", "patientid", "mrn"];
    const appointmentKeys = [toStringValue(mappingRaw.appointmentTime), toStringValue(mappingRaw.time), "appointmentTime", "appointmenttime", "time"];
    const providerKeys = [toStringValue(mappingRaw.providerLastName), toStringValue(mappingRaw.provider), "providerLastName", "providerlastname", "provider"];
    const reasonKeys = [toStringValue(mappingRaw.reasonForVisit), toStringValue(mappingRaw.reason), "reasonForVisit", "reason", "reasonforvisit"];
    const mappedRows = payloadRows.slice(0, maxRows).map((row, index) => {
        const record = toRecord(row);
        return {
            index: index + 1,
            clinic: readMappedValue(record, clinicKeys),
            patientId: readMappedValue(record, patientKeys),
            appointmentTime: readMappedValue(record, appointmentKeys),
            providerLastName: readMappedValue(record, providerKeys),
            reasonForVisit: readMappedValue(record, reasonKeys),
            raw: record
        };
    });
    return {
        ok: true,
        status: "ok",
        rowCount: mappedRows.length,
        rows: mappedRows,
        message: `AthenaOne sync preview completed (${mappedRows.length} row${mappedRows.length === 1 ? "" : "s"}).`,
        detail: {
            attempts: result.attempts,
            durationMs: result.durationMs,
            statusCode: result.statusCode
        }
    };
}
//# sourceMappingURL=athena-one.js.map