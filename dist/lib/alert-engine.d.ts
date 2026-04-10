import { type PrismaClient } from "@prisma/client";
export declare function refreshEncounterAlertStates(prisma: PrismaClient, options?: {
    facilityId?: string | null;
    clinicIds?: string[];
    encounterIds?: string[];
    now?: Date;
}): Promise<{
    scannedCount: number;
    updatedCount: number;
}>;
