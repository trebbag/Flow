import { RoomIssueType, RoomOperationalStatus, type PrismaClient } from "@prisma/client";
import { MAX_HISTORY_DAYS, listDateKeys } from "./office-manager-rollups.js";
export { MAX_HISTORY_DAYS, listDateKeys };
export type RoomScopedClinic = {
    id: string;
    timezone: string;
    facilityId?: string | null;
};
type StatusMinutes = Record<RoomOperationalStatus, number>;
type RoomRollupRaw = {
    roomId: string;
    roomName: string;
    roomNumber: number | null;
    statusMinutes: StatusMinutes;
    occupiedMinutes: number;
    turnoverMinutes: number;
    holdMinutes: number;
    notReadyMinutes: number;
    turnoverCount: number;
    holdCount: number;
    issueCount: number;
    dayStartCompleted: boolean;
    dayEndCompleted: boolean;
};
type IssueRollupRaw = {
    issueType: RoomIssueType;
    count: number;
    openCount: number;
    resolvedCount: number;
    resolutionTotalMins: number;
    resolutionSamples: number;
};
export type RoomDailyRollupRaw = {
    facilityId: string;
    clinicId: string;
    dateKey: string;
    roomCount: number;
    dayStartCompletedCount: number;
    dayEndCompletedCount: number;
    turnoverCount: number;
    holdCount: number;
    issueCount: number;
    resolvedIssueCount: number;
    occupiedTotalMins: number;
    occupiedSamples: number;
    turnoverTotalMins: number;
    turnoverSamples: number;
    statusMinutes: StatusMinutes;
    roomRollups: RoomRollupRaw[];
    issueRollups: IssueRollupRaw[];
};
export type RoomDailyHistoryRollupView = {
    date: string;
    roomCount: number;
    dayStartCompletedCount: number;
    dayEndCompletedCount: number;
    turnoverCount: number;
    holdCount: number;
    issueCount: number;
    resolvedIssueCount: number;
    avgOccupiedMins: number;
    avgTurnoverMins: number;
    statusMinutes: StatusMinutes;
    issueRollups: Array<{
        issueType: RoomIssueType;
        count: number;
        openCount: number;
        resolvedCount: number;
        avgResolutionMins: number;
    }>;
    roomRollups: Array<RoomRollupRaw & {
        avgOccupiedMins: number;
        avgTurnoverMins: number;
    }>;
};
export declare function computeRoomDailyRollup(prisma: PrismaClient, clinic: RoomScopedClinic, dateKey: string): Promise<RoomDailyRollupRaw>;
export declare function upsertRoomDailyRollup(prisma: PrismaClient, rollup: RoomDailyRollupRaw): Promise<void>;
type RoomHistoryOptions = {
    persist?: boolean;
    forceRecompute?: boolean;
};
export declare function getRoomDailyHistoryRollups(prisma: PrismaClient, clinics: RoomScopedClinic[], dateKeys: string[], options?: RoomHistoryOptions): Promise<RoomDailyHistoryRollupView[]>;
