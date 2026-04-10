import { AlertInboxStatus, Prisma } from "@prisma/client";
import type { AlertInboxKind, RoleName } from "@prisma/client";
export declare function resolveAlertRecipientUserIds(params: {
    facilityId: string;
    clinicId?: string | null;
    roles?: RoleName[];
}): Promise<string[]>;
export declare function createInboxAlert(params: {
    facilityId: string;
    clinicId?: string | null;
    kind: AlertInboxKind;
    sourceId: string;
    sourceVersionKey: string;
    title: string;
    message: string;
    payload?: Record<string, unknown> | null;
    userIds?: string[];
    roles?: RoleName[];
}): Promise<number>;
export declare function listUserInboxAlerts(params: {
    userId: string;
    tab: "active" | "archived";
    limit: number;
}): Promise<{
    rows: {
        message: string;
        status: import("@prisma/client").$Enums.AlertInboxStatus;
        id: string;
        createdAt: Date;
        facilityId: string;
        userId: string;
        clinicId: string | null;
        kind: import("@prisma/client").$Enums.AlertInboxKind;
        sourceId: string;
        sourceVersionKey: string;
        title: string;
        payloadJson: Prisma.JsonValue | null;
        acknowledgedAt: Date | null;
        archivedAt: Date | null;
    }[];
    total: number;
}>;
export declare function updateUserInboxAlertStatus(params: {
    id: string;
    userId: string;
    status: AlertInboxStatus;
}): Promise<Prisma.BatchPayload>;
