import type { Encounter } from "./mock-data";
import type { CreatedTask, CompletedCheckout } from "./encounter-context";
import type { MATask } from "./mock-data";

const DB_NAME = "flow-encounter-board";
const STORE_NAME = "snapshots";
const SNAPSHOT_SCHEMA_VERSION = 1;

export type EncounterBoardSnapshotScope = {
  facilityId: string;
  dateKey: string;
  roleScope: string;
};

export type EncounterBoardSnapshot = EncounterBoardSnapshotScope & {
  key: string;
  schemaVersion: number;
  fetchedAt: string;
  encounters: Encounter[];
  maTasks: MATask[];
  createdTasks: CreatedTask[];
  completedCheckouts: CompletedCheckout[];
};

function resolveSnapshotKey(scope: EncounterBoardSnapshotScope) {
  return `${SNAPSHOT_SCHEMA_VERSION}:${scope.facilityId}:${scope.dateKey}:${scope.roleScope}`;
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Failed to open encounter board snapshot database."));
  });
}

export async function readEncounterBoardSnapshot(scope: EncounterBoardSnapshotScope) {
  const db = await openDb();
  if (!db) return null;

  const key = resolveSnapshotKey(scope);
  return new Promise<EncounterBoardSnapshot | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    request.onsuccess = () => {
      const value = request.result as EncounterBoardSnapshot | undefined;
      if (!value || value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
        resolve(null);
        return;
      }
      resolve(value);
    };
    request.onerror = () => reject(request.error || new Error("Failed to read encounter board snapshot."));
  });
}

export async function writeEncounterBoardSnapshot(
  snapshot: Omit<EncounterBoardSnapshot, "key" | "schemaVersion">,
) {
  const db = await openDb();
  if (!db) return;

  const value: EncounterBoardSnapshot = {
    ...snapshot,
    key: resolveSnapshotKey(snapshot),
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  };

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(value);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error("Failed to write encounter board snapshot."));
  });
}
