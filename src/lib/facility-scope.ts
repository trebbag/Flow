import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@prisma/client";

type ScopeStore = {
  facilityId: string | null;
  tx: Prisma.TransactionClient | null;
};

const facilityScopeStorage = new AsyncLocalStorage<ScopeStore>();

function normalizeFacilityId(facilityId: string | null | undefined) {
  const normalized = facilityId?.trim() || null;
  return normalized && normalized.length > 0 ? normalized : null;
}

export function getCurrentFacilityScopeId() {
  return facilityScopeStorage.getStore()?.facilityId || null;
}

export function getCurrentScopedTransaction() {
  return facilityScopeStorage.getStore()?.tx || null;
}

export function enterFacilityScope(facilityId: string | null | undefined) {
  const normalized = normalizeFacilityId(facilityId);
  const current = facilityScopeStorage.getStore();
  if (current) {
    current.facilityId = normalized;
    return;
  }
  facilityScopeStorage.enterWith({
    facilityId: normalized,
    tx: null,
  });
}

export function runWithFacilityScope<T>(facilityId: string | null | undefined, work: () => Promise<T>) {
  const current = facilityScopeStorage.getStore();
  return facilityScopeStorage.run(
    {
      facilityId: normalizeFacilityId(facilityId),
      tx: current?.tx || null,
    },
    work,
  );
}

export function runWithScopedTransaction<T>(tx: Prisma.TransactionClient, work: () => Promise<T>) {
  const current = facilityScopeStorage.getStore();
  return facilityScopeStorage.run(
    {
      facilityId: current?.facilityId || null,
      tx,
    },
    work,
  );
}
