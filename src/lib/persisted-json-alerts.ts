import { RoleName } from "@prisma/client";
import { createInboxAlert } from "./user-alert-inbox.js";

export type IntegrityWarning = {
  field: string;
  code: string;
  message: string;
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export function buildIntegrityWarning(field: string): IntegrityWarning {
  const normalized = field.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
  return {
    field,
    code: `PERSISTED_JSON_SOFT_REPAIRED_${normalized}`,
    message: `Stored ${field} data was malformed and has been reset to a safe default until it is corrected.`,
  };
}

export async function recordPersistedJsonAlert(params: {
  facilityId: string;
  clinicId?: string | null;
  entityType: string;
  entityId: string;
  field: string;
  requestId?: string | null;
}) {
  const warning = buildIntegrityWarning(params.field);
  await createInboxAlert({
    facilityId: params.facilityId,
    clinicId: params.clinicId || null,
    kind: "threshold",
    sourceId: `${params.entityType}:${params.entityId}:${params.field}`,
    sourceVersionKey: `integrity:${params.entityType}:${params.entityId}:${params.field}:${todayKey()}`,
    title: "Persisted JSON integrity warning",
    message: `${warning.message} Review ${params.entityType} ${params.entityId}.`,
    payload: {
      entityType: params.entityType,
      entityId: params.entityId,
      field: params.field,
      requestId: params.requestId || null,
      code: warning.code,
    },
    roles: [RoleName.Admin],
  });
}
