import { env } from "./env.js";

type AthenaAuthType = "none" | "api_key" | "basic" | "oauth2";

const ATHENA_SECRET_FIELDS = ["password", "apiKey", "clientSecret", "accessToken", "refreshToken"] as const;

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function toStringValue(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeAuthType(value: unknown): AthenaAuthType {
  const raw = toStringValue(value).toLowerCase();
  if (raw === "api_key" || raw === "apikey") return "api_key";
  if (raw === "basic") return "basic";
  if (raw === "oauth2" || raw === "oauth") return "oauth2";
  return "none";
}

function normalizeDepartmentIds(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((entry) => toStringValue(entry)).filter(Boolean);
  }
  const raw = toStringValue(value);
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeHeaders(value: unknown) {
  const raw = toRecord(value);
  const normalized: Record<string, string> = {};
  for (const [key, entry] of Object.entries(raw)) {
    const k = toStringValue(key);
    const v = toStringValue(entry);
    if (!k || !v) continue;
    normalized[k] = v;
  }
  return normalized;
}

export type AthenaConnectorConfig = {
  baseUrl: string;
  practiceId: string;
  departmentIds: string[];
  authType: AthenaAuthType;
  username: string;
  password: string;
  apiKey: string;
  apiKeyHeader: string;
  apiKeyPrefix: string;
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  timeoutMs: number;
  retryCount: number;
  retryBackoffMs: number;
  testPath: string;
  previewPath: string;
  revenuePath: string;
  headers: Record<string, string>;
};

export type AthenaConnectorConfigWithSecrets = AthenaConnectorConfig & {
  secretsConfigured: {
    password: boolean;
    apiKey: boolean;
    clientSecret: boolean;
    accessToken: boolean;
    refreshToken: boolean;
  };
};

export function normalizeAthenaConnectorConfig(input: unknown): AthenaConnectorConfig {
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
    timeoutMs:
      Number.isFinite(timeoutCandidate) && timeoutCandidate >= 500
        ? Math.round(timeoutCandidate)
        : env.ATHENA_TIMEOUT_MS,
    retryCount:
      Number.isFinite(retryCandidate) && retryCandidate >= 0
        ? Math.round(retryCandidate)
        : env.ATHENA_RETRY_COUNT,
    retryBackoffMs:
      Number.isFinite(backoffCandidate) && backoffCandidate >= 0
        ? Math.round(backoffCandidate)
        : env.ATHENA_RETRY_BACKOFF_MS,
    testPath: toStringValue(raw.testPath) || "/",
    previewPath: toStringValue(raw.previewPath) || "/",
    revenuePath: toStringValue(raw.revenuePath) || "/",
    headers: normalizeHeaders(raw.headers)
  };
}

function withLeadingSlash(path: string) {
  const cleaned = path.trim();
  if (!cleaned) return "/";
  return cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
}

function isRetryableStatus(statusCode: number) {
  return statusCode === 429 || statusCode >= 500;
}

function parseRetryAfterMs(value: string | null) {
  if (!value) return null;
  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.round(asSeconds * 1000);
  }
  const parsedDate = Date.parse(value);
  if (!Number.isFinite(parsedDate)) return null;
  const delta = parsedDate - Date.now();
  return delta > 0 ? delta : null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeBody(bodyText: string) {
  const compact = bodyText.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.slice(0, 280);
}

function buildAthenaHeaders(config: AthenaConnectorConfig, extraHeaders?: Record<string, string>) {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...config.headers,
    ...extraHeaders
  };

  if (config.authType === "api_key") {
    if (config.apiKey) {
      const authValue = config.apiKeyPrefix ? `${config.apiKeyPrefix} ${config.apiKey}` : config.apiKey;
      headers[config.apiKeyHeader || "Authorization"] = authValue;
    }
  } else if (config.authType === "basic") {
    if (config.username && config.password) {
      headers.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
    }
  } else if (config.authType === "oauth2") {
    if (config.accessToken) {
      headers.Authorization = `Bearer ${config.accessToken}`;
    }
  }

  return headers;
}

function parseJsonMaybe(text: string) {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

type AthenaHttpResult = {
  ok: boolean;
  statusCode: number | null;
  attempts: number;
  durationMs: number;
  message: string;
  bodyText: string;
  bodyJson: unknown;
};

async function requestAthena(config: AthenaConnectorConfig, params: { path: string; query?: Record<string, string | undefined> }) {
  const requestPath = withLeadingSlash(params.path);
  const url = new URL(requestPath, `${config.baseUrl || "https://localhost"}`);
  if (params.query) {
    Object.entries(params.query).forEach(([key, value]) => {
      if (value === undefined || value === null || String(value).trim().length === 0) return;
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
        } as AthenaHttpResult;
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
      } as AthenaHttpResult;
    } catch (error) {
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
      } as AthenaHttpResult;
    } finally {
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
  } as AthenaHttpResult;
}

export function mergeAthenaConnectorConfig(existingInput: unknown, incomingInput: unknown) {
  const existing = normalizeAthenaConnectorConfig(existingInput);
  const incoming = normalizeAthenaConnectorConfig(incomingInput);

  const merged = {
    ...existing,
    ...incoming
  } as AthenaConnectorConfig;

  ATHENA_SECRET_FIELDS.forEach((field) => {
    const incomingValue = incoming[field];
    if (incomingValue) return;
    merged[field] = existing[field] || "";
  });

  if (!incoming.baseUrl) merged.baseUrl = existing.baseUrl;
  if (!incoming.practiceId) merged.practiceId = existing.practiceId;
  if (incoming.departmentIds.length === 0 && existing.departmentIds.length > 0) {
    merged.departmentIds = existing.departmentIds;
  }
  if (!incoming.testPath) merged.testPath = existing.testPath;
  if (!incoming.previewPath) merged.previewPath = existing.previewPath;
  if (!incoming.revenuePath) merged.revenuePath = existing.revenuePath;
  if (Object.keys(incoming.headers).length === 0 && Object.keys(existing.headers).length > 0) {
    merged.headers = existing.headers;
  }

  return merged;
}

export function redactAthenaConnectorConfig(input: unknown): AthenaConnectorConfigWithSecrets {
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

function extractPreviewRows(payload: unknown) {
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  if (!payload || typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;
  const keys = ["appointments", "rows", "data", "results", "items"];
  for (const key of keys) {
    const entry = obj[key];
    if (Array.isArray(entry)) {
      return entry as Array<Record<string, unknown>>;
    }
  }
  return [];
}

function readMappedValue(row: Record<string, unknown>, candidates: string[]) {
  for (const candidate of candidates) {
    const key = candidate.trim();
    if (!key) continue;
    if (!(key in row)) continue;
    const value = row[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (!text) continue;
    return text;
  }
  return "";
}

export async function testAthenaConnectorConfig(input: unknown) {
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

export async function previewAthenaSchedule(params: {
  config: unknown;
  mapping?: Record<string, string> | unknown;
  dateOfService: string;
  clinicId?: string;
  maxRows?: number;
}) {
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

function parseAthenaNumber(value: string) {
  if (!value) return null;
  const normalized = value.replace(/[$,%\s,]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseAthenaInteger(value: string) {
  const parsed = parseAthenaNumber(value);
  return parsed === null ? null : Math.round(parsed);
}

function parseAthenaDateValue(value: string) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export type AthenaRevenueMonitoringRow = {
  index: number;
  encounterId: string;
  patientId: string;
  clinic: string;
  dateOfService: string;
  chargeEnteredAt: string | null;
  claimSubmittedAt: string | null;
  daysToSubmit: number | null;
  daysInAR: number | null;
  claimStatus: string;
  patientBalanceCents: number | null;
  raw: Record<string, unknown>;
};

export async function previewAthenaRevenueMonitoring(params: {
  config: unknown;
  mapping?: Record<string, string> | unknown;
  dateOfService?: string;
  clinicId?: string;
  maxRows?: number;
}) {
  const config = normalizeAthenaConnectorConfig(params.config);
  const mappingRaw = toRecord(params.mapping);

  if (!config.baseUrl || !config.practiceId) {
    return {
      ok: false,
      status: "error",
      rowCount: 0,
      rows: [] as AthenaRevenueMonitoringRow[],
      message: "AthenaOne revenue monitoring preview requires baseUrl and practiceId in connector config.",
      detail: {
        attempts: 0,
        durationMs: 0,
        statusCode: null,
      },
    };
  }

  const result = await requestAthena(config, {
    path: config.revenuePath || config.previewPath || "/",
    query: {
      practiceId: config.practiceId,
      dateOfService: params.dateOfService,
      clinicId: params.clinicId,
      departmentIds: config.departmentIds.join(",") || undefined,
    },
  });

  if (!result.ok) {
    return {
      ok: false,
      status: "error",
      rowCount: 0,
      rows: [] as AthenaRevenueMonitoringRow[],
      message: `AthenaOne revenue monitoring preview failed: ${result.message}`,
      detail: {
        attempts: result.attempts,
        durationMs: result.durationMs,
        statusCode: result.statusCode,
        responsePreview: summarizeBody(result.bodyText),
      },
    };
  }

  const payloadRows = extractPreviewRows(result.bodyJson);
  const maxRows = Math.max(1, Math.min(250, params.maxRows || 50));

  const encounterKeys = [
    toStringValue(mappingRaw.revenueEncounterId),
    toStringValue(mappingRaw.athenaEncounterId),
    toStringValue(mappingRaw.encounterId),
    "encounterId",
    "encounter_id",
    "appointmentid",
    "appointmentId",
    "athenaEncounterId",
  ];
  const patientKeys = [
    toStringValue(mappingRaw.revenuePatientId),
    toStringValue(mappingRaw.patientId),
    "patientId",
    "patient_id",
    "patientid",
    "mrn",
  ];
  const clinicKeys = [
    toStringValue(mappingRaw.revenueClinicId),
    toStringValue(mappingRaw.clinicId),
    "clinicId",
    "clinic_id",
    "departmentid",
    "departmentId",
    "clinic",
  ];
  const dosKeys = [
    toStringValue(mappingRaw.revenueDateOfService),
    toStringValue(mappingRaw.dateOfService),
    "dateOfService",
    "date_of_service",
    "dos",
    "appointmentDate",
    "appointment_date",
    "date",
  ];
  const chargeEnteredKeys = [
    toStringValue(mappingRaw.revenueChargeEnteredAt),
    "chargeEnteredAt",
    "charge_entered_at",
    "chargeenteredat",
    "chargeentrydate",
    "chargeEntryDate",
  ];
  const claimSubmittedKeys = [
    toStringValue(mappingRaw.revenueClaimSubmittedAt),
    "claimSubmittedAt",
    "claim_submitted_at",
    "claimsubmittedat",
    "claimSubmissionDate",
    "claimsubmissiondate",
  ];
  const daysToSubmitKeys = [
    toStringValue(mappingRaw.revenueDaysToSubmit),
    "daysToSubmit",
    "days_to_submit",
    "daystosubmit",
  ];
  const daysInARKeys = [
    toStringValue(mappingRaw.revenueDaysInAR),
    "daysInAR",
    "days_in_ar",
    "daysinar",
    "daysInAr",
  ];
  const claimStatusKeys = [
    toStringValue(mappingRaw.revenueClaimStatus),
    "claimStatus",
    "claim_status",
    "claimstatus",
  ];
  const patientBalanceKeys = [
    toStringValue(mappingRaw.revenuePatientBalanceCents),
    toStringValue(mappingRaw.patientBalance),
    "patientBalanceCents",
    "patient_balance_cents",
    "patient_balance",
    "patientbalance",
    "patientBalance",
  ];

  const mappedRows = payloadRows.slice(0, maxRows).map((row, index) => {
    const record = toRecord(row);
    const patientBalance = parseAthenaNumber(readMappedValue(record, patientBalanceKeys));
    return {
      index: index + 1,
      encounterId: readMappedValue(record, encounterKeys),
      patientId: readMappedValue(record, patientKeys),
      clinic: readMappedValue(record, clinicKeys),
      dateOfService: readMappedValue(record, dosKeys),
      chargeEnteredAt: parseAthenaDateValue(readMappedValue(record, chargeEnteredKeys)),
      claimSubmittedAt: parseAthenaDateValue(readMappedValue(record, claimSubmittedKeys)),
      daysToSubmit: parseAthenaInteger(readMappedValue(record, daysToSubmitKeys)),
      daysInAR: parseAthenaInteger(readMappedValue(record, daysInARKeys)),
      claimStatus: readMappedValue(record, claimStatusKeys),
      patientBalanceCents: patientBalance === null ? null : Math.round(patientBalance * 100),
      raw: record,
    } satisfies AthenaRevenueMonitoringRow;
  });

  return {
    ok: true,
    status: "ok",
    rowCount: mappedRows.length,
    rows: mappedRows,
    message: `AthenaOne revenue monitoring preview completed (${mappedRows.length} row${mappedRows.length === 1 ? "" : "s"}).`,
    detail: {
      attempts: result.attempts,
      durationMs: result.durationMs,
      statusCode: result.statusCode,
    },
  };
}
