import { RoleName } from "@prisma/client";
export declare function isTemporaryClinicOverrideRole(role: RoleName): role is "MA" | "Clinician";
export declare function listActiveTemporaryClinicOverrideIds(params: {
    userId: string;
    role: RoleName;
    facilityId?: string | null;
    at?: Date;
}): Promise<string[]>;
export declare function hasActiveTemporaryClinicOverride(params: {
    userId: string;
    role: RoleName;
    clinicId: string;
    facilityId?: string | null;
    at?: Date;
}): Promise<boolean>;
