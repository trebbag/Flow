import { RoomEventType, RoomHoldReason, RoomOperationalStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import type { RequestUser } from "./auth.js";
type RoomOpsTx = Prisma.TransactionClient;
type ScopedClinic = {
    id: string;
    name: string;
    facilityId: string | null;
    timezone: string;
};
type EncounterRoomCandidate = {
    id: string;
    clinicId: string;
    roomId: string | null;
};
export declare function backfillRoomOperationalStates(): Promise<number>;
export declare function getRoomScopeClinicIds(user: RequestUser, requestedClinicId?: string | null): Promise<string[]>;
export declare function ensureRoomOperationalStateInTx(tx: RoomOpsTx, roomId: string): Promise<{
    updatedAt: Date;
    roomId: string;
    currentStatus: import("@prisma/client").$Enums.RoomOperationalStatus;
    statusSinceAt: Date;
    occupiedEncounterId: string | null;
    activeCleanerUserId: string | null;
    holdReason: import("@prisma/client").$Enums.RoomHoldReason | null;
    holdNote: string | null;
    lastReadyAt: Date | null;
    lastOccupiedAt: Date | null;
    lastTurnoverAt: Date | null;
}>;
export declare function transitionRoomOperationalStateInTx(tx: RoomOpsTx, params: {
    roomId: string;
    clinicId: string;
    facilityId: string;
    toStatus: RoomOperationalStatus;
    eventType: RoomEventType;
    createdByUserId?: string | null;
    encounterId?: string | null;
    note?: string | null;
    metadata?: Record<string, unknown> | null;
    holdReason?: RoomHoldReason | null;
    holdNote?: string | null;
    allowedFrom?: RoomOperationalStatus[];
}): Promise<{
    updatedAt: Date;
    roomId: string;
    currentStatus: import("@prisma/client").$Enums.RoomOperationalStatus;
    statusSinceAt: Date;
    occupiedEncounterId: string | null;
    activeCleanerUserId: string | null;
    holdReason: import("@prisma/client").$Enums.RoomHoldReason | null;
    holdNote: string | null;
    lastReadyAt: Date | null;
    lastOccupiedAt: Date | null;
    lastTurnoverAt: Date | null;
}>;
export declare function transitionRoomOperationalState(params: Parameters<typeof transitionRoomOperationalStateInTx>[1]): Promise<{
    updatedAt: Date;
    roomId: string;
    currentStatus: import("@prisma/client").$Enums.RoomOperationalStatus;
    statusSinceAt: Date;
    occupiedEncounterId: string | null;
    activeCleanerUserId: string | null;
    holdReason: import("@prisma/client").$Enums.RoomHoldReason | null;
    holdNote: string | null;
    lastReadyAt: Date | null;
    lastOccupiedAt: Date | null;
    lastTurnoverAt: Date | null;
}>;
export declare function assertRoomAssignableForEncounter(params: {
    encounter: EncounterRoomCandidate;
    roomId: string;
    user: RequestUser;
}): Promise<{
    state: {
        updatedAt: Date;
        roomId: string;
        currentStatus: import("@prisma/client").$Enums.RoomOperationalStatus;
        statusSinceAt: Date;
        occupiedEncounterId: string | null;
        activeCleanerUserId: string | null;
        holdReason: import("@prisma/client").$Enums.RoomHoldReason | null;
        holdNote: string | null;
        lastReadyAt: Date | null;
        lastOccupiedAt: Date | null;
        lastTurnoverAt: Date | null;
    };
    room: {
        clinicLinks: ({
            clinic: {
                name: string;
                id: string;
                facilityId: string;
                timezone: string;
            };
        } & {
            id: string;
            createdAt: Date;
            clinicId: string;
            roomId: string;
            active: boolean;
        })[];
        operationalState: {
            updatedAt: Date;
            roomId: string;
            currentStatus: import("@prisma/client").$Enums.RoomOperationalStatus;
            statusSinceAt: Date;
            occupiedEncounterId: string | null;
            activeCleanerUserId: string | null;
            holdReason: import("@prisma/client").$Enums.RoomHoldReason | null;
            holdNote: string | null;
            lastReadyAt: Date | null;
            lastOccupiedAt: Date | null;
            lastTurnoverAt: Date | null;
        };
    } & {
        status: string;
        name: string;
        id: string;
        facilityId: string;
        roomNumber: number;
        roomType: string;
        sortOrder: number;
    };
    clinic: ScopedClinic;
    facilityId: string;
}>;
export declare function markEncounterRoomOccupiedInTx(tx: RoomOpsTx, params: {
    encounter: EncounterRoomCandidate;
    roomId: string;
    userId: string;
    facilityId: string;
}): Promise<{
    updatedAt: Date;
    roomId: string;
    currentStatus: import("@prisma/client").$Enums.RoomOperationalStatus;
    statusSinceAt: Date;
    occupiedEncounterId: string | null;
    activeCleanerUserId: string | null;
    holdReason: import("@prisma/client").$Enums.RoomHoldReason | null;
    holdNote: string | null;
    lastReadyAt: Date | null;
    lastOccupiedAt: Date | null;
    lastTurnoverAt: Date | null;
}>;
export declare function markEncounterRoomNeedsTurnover(params: {
    encounter: EncounterRoomCandidate;
    userId?: string | null;
}): Promise<{
    updatedAt: Date;
    roomId: string;
    currentStatus: import("@prisma/client").$Enums.RoomOperationalStatus;
    statusSinceAt: Date;
    occupiedEncounterId: string | null;
    activeCleanerUserId: string | null;
    holdReason: import("@prisma/client").$Enums.RoomHoldReason | null;
    holdNote: string | null;
    lastReadyAt: Date | null;
    lastOccupiedAt: Date | null;
    lastTurnoverAt: Date | null;
}>;
export declare function listRoomCards(params: {
    user: RequestUser;
    clinicId?: string | null;
    dateKey?: string;
}): Promise<{
    id: string;
    roomId: string;
    name: string;
    roomNumber: number;
    roomType: string;
    clinicId: string;
    clinicName: string;
    facilityId: string;
    operationalStatus: import("@prisma/client").$Enums.RoomOperationalStatus;
    statusSinceAt: Date;
    minutesInStatus: number;
    timerLabel: string;
    currentEncounter: {
        id: string;
        patientId: string;
        currentStatus: import("@prisma/client").$Enums.EncounterStatus;
    };
    issueCount: number;
    hasOpenIssue: boolean;
    holdReason: import("@prisma/client").$Enums.RoomHoldReason;
    holdNote: string;
    dayStartCompleted: boolean;
    dayEndCompleted: boolean;
    lowStock: boolean;
    auditDue: boolean;
}[]>;
export declare function getRoomDetail(params: {
    roomId: string;
    user: RequestUser;
    clinicId?: string | null;
}): Promise<{
    room: {
        id: string;
        name: string;
        roomNumber: number;
        roomType: string;
        facilityId: string;
        clinicId: string;
        clinicName: string;
    };
    operationalState: ({
        occupiedEncounter: {
            id: string;
            roomId: string;
            patientId: string;
            currentStatus: import("@prisma/client").$Enums.EncounterStatus;
        };
    } & {
        updatedAt: Date;
        roomId: string;
        currentStatus: import("@prisma/client").$Enums.RoomOperationalStatus;
        statusSinceAt: Date;
        occupiedEncounterId: string | null;
        activeCleanerUserId: string | null;
        holdReason: import("@prisma/client").$Enums.RoomHoldReason | null;
        holdNote: string | null;
        lastReadyAt: Date | null;
        lastOccupiedAt: Date | null;
        lastTurnoverAt: Date | null;
    }) | {
        roomId: string;
        currentStatus: "Ready";
        statusSinceAt: Date;
        occupiedEncounterId: any;
        activeCleanerUserId: any;
        holdReason: any;
        holdNote: any;
        lastReadyAt: any;
        lastOccupiedAt: any;
        lastTurnoverAt: any;
    };
    events: {
        id: string;
        clinicId: string;
        facilityId: string;
        encounterId: string | null;
        roomId: string;
        eventType: import("@prisma/client").$Enums.RoomEventType;
        fromStatus: import("@prisma/client").$Enums.RoomOperationalStatus | null;
        toStatus: import("@prisma/client").$Enums.RoomOperationalStatus | null;
        note: string | null;
        metadataJson: Prisma.JsonValue | null;
        createdByUserId: string | null;
        occurredAt: Date;
    }[];
    issues: {
        status: import("@prisma/client").$Enums.RoomIssueStatus;
        id: string;
        createdAt: Date;
        clinicId: string;
        facilityId: string;
        encounterId: string | null;
        roomId: string;
        description: string | null;
        title: string;
        metadataJson: Prisma.JsonValue | null;
        createdByUserId: string;
        issueType: import("@prisma/client").$Enums.RoomIssueType;
        severity: number;
        placesRoomOnHold: boolean;
        taskId: string | null;
        sourceModule: string | null;
        resolvedAt: Date | null;
        resolvedByUserId: string | null;
        resolutionNote: string | null;
    }[];
    checklistRuns: {
        id: string;
        clinicId: string;
        facilityId: string;
        roomId: string;
        completedAt: Date | null;
        kind: import("@prisma/client").$Enums.RoomChecklistKind;
        dateKey: string;
        note: string | null;
        itemsJson: Prisma.JsonValue;
        completed: boolean;
        startedAt: Date;
        completedByUserId: string | null;
    }[];
    placeholders: {
        supplies: string;
        audits: string;
    };
}>;
export declare function getPreRoomingAvailability(params: {
    user: RequestUser;
    encounterId: string;
}): Promise<{
    encounterId: string;
    readyCount: number;
    preferredRoomId: string;
    lastReadyRoom: boolean;
    blocked: boolean;
    rooms: {
        id: string;
        roomId: string;
        name: string;
        roomNumber: number;
        roomType: string;
        clinicId: string;
        clinicName: string;
        facilityId: string;
        operationalStatus: import("@prisma/client").$Enums.RoomOperationalStatus;
        statusSinceAt: Date;
        minutesInStatus: number;
        timerLabel: string;
        currentEncounter: {
            id: string;
            patientId: string;
            currentStatus: import("@prisma/client").$Enums.EncounterStatus;
        };
        issueCount: number;
        hasOpenIssue: boolean;
        holdReason: import("@prisma/client").$Enums.RoomHoldReason;
        holdNote: string;
        dayStartCompleted: boolean;
        dayEndCompleted: boolean;
        lowStock: boolean;
        auditDue: boolean;
    }[];
}>;
export declare function resolveRoomActionContext(params: {
    roomId: string;
    user: RequestUser;
    clinicId?: string | null;
}): Promise<{
    room: {
        clinicLinks: ({
            clinic: {
                name: string;
                id: string;
                facilityId: string;
                timezone: string;
            };
        } & {
            id: string;
            createdAt: Date;
            clinicId: string;
            roomId: string;
            active: boolean;
        })[];
        operationalState: {
            updatedAt: Date;
            roomId: string;
            currentStatus: import("@prisma/client").$Enums.RoomOperationalStatus;
            statusSinceAt: Date;
            occupiedEncounterId: string | null;
            activeCleanerUserId: string | null;
            holdReason: import("@prisma/client").$Enums.RoomHoldReason | null;
            holdNote: string | null;
            lastReadyAt: Date | null;
            lastOccupiedAt: Date | null;
            lastTurnoverAt: Date | null;
        };
    } & {
        status: string;
        name: string;
        id: string;
        facilityId: string;
        roomNumber: number;
        roomType: string;
        sortOrder: number;
    };
    clinic: ScopedClinic;
    facilityId: string;
}>;
export {};
