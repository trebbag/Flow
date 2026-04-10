import { AlertLevel, EncounterStatus, type PrismaClient } from "@prisma/client";
export declare const MAX_HISTORY_DAYS = 31;
export type ScopedClinic = {
    id: string;
    timezone: string;
};
type StageTotals = {
    count: number;
    totalMinutes: number;
};
export type ProviderRollupRaw = {
    providerName: string;
    encounterCount: number;
    activeCount: number;
    completedCount: number;
    stageTotals: Record<string, StageTotals>;
};
export type DailyClinicRollupRaw = {
    clinicId: string;
    dateKey: string;
    queueByStatus: Record<EncounterStatus, number>;
    alertsByLevel: Record<AlertLevel, number>;
    encounterCount: number;
    lobbyWaitTotalMins: number;
    lobbyWaitSamples: number;
    roomingWaitTotalMins: number;
    roomingWaitSamples: number;
    providerVisitTotalMins: number;
    providerVisitSamples: number;
    stageRollups: Array<{
        status: EncounterStatus;
        count: number;
        totalMinutes: number;
    }>;
    providerRollups: ProviderRollupRaw[];
};
export type DailyHistoryRollupView = {
    date: string;
    queueByStatus: Record<EncounterStatus, number>;
    alertsByLevel: Record<AlertLevel, number>;
    encounterCount: number;
    avgLobbyWaitMins: number;
    avgRoomingWaitMins: number;
    avgProviderVisitMins: number;
    stageRollups: Array<{
        status: EncounterStatus;
        count: number;
        avgMinutes: number;
    }>;
    providerRollups: Array<{
        providerName: string;
        encounterCount: number;
        activeCount: number;
        completedCount: number;
        stageAverages: Record<string, number>;
    }>;
};
export declare function listDateKeys(fromDate: string, toDate: string, maxDays?: number): string[];
export declare function computeDailyClinicRollup(prisma: PrismaClient, clinic: ScopedClinic, dateKey: string): Promise<DailyClinicRollupRaw>;
export declare function upsertDailyClinicRollup(prisma: PrismaClient, rollup: DailyClinicRollupRaw): Promise<void>;
type DailyHistoryOptions = {
    persist?: boolean;
    forceRecompute?: boolean;
};
export declare function getDailyHistoryRollups(prisma: PrismaClient, clinics: ScopedClinic[], dateKeys: string[], options?: DailyHistoryOptions): Promise<DailyHistoryRollupView[]>;
export {};
