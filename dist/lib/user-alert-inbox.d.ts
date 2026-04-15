import { AlertInboxStatus, Prisma, RoleName } from "@prisma/client";
import type { AlertInboxKind, PrismaClient } from "@prisma/client";
type AlertRecipientDb = Pick<PrismaClient, "user">;
export declare function resolveAlertRecipientUserIds(params: {
    facilityId: string;
    clinicId?: string | null;
    roles?: RoleName[];
}, db?: AlertRecipientDb): Promise<string[]>;
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
        userId: string;
        clinicId: string | null;
        facilityId: string;
        sourceId: string;
        acknowledgedAt: Date | null;
        kind: import("@prisma/client").$Enums.AlertInboxKind;
        sourceVersionKey: string;
        title: string;
        payloadJson: Prisma.JsonValue | null;
        archivedAt: Date | null;
    }[];
    total: number;
}>;
export declare function updateUserInboxAlertStatus(params: {
    id: string;
    userId: string;
    status: AlertInboxStatus;
}): Promise<Prisma.BatchPayload>;
export {};
