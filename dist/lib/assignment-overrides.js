import { RoleName } from "@prisma/client";
import { prisma } from "./prisma.js";
export function isTemporaryClinicOverrideRole(role) {
    return role === RoleName.MA || role === RoleName.Clinician;
}
function activeOverrideWhere(params) {
    const at = params.at || new Date();
    return {
        userId: params.userId,
        role: params.role,
        revokedAt: null,
        startsAt: { lte: at },
        endsAt: { gt: at },
        ...(params.clinicId ? { clinicId: params.clinicId } : {}),
        ...(params.facilityId ? { facilityId: params.facilityId } : {})
    };
}
export async function listActiveTemporaryClinicOverrideIds(params) {
    if (!isTemporaryClinicOverrideRole(params.role))
        return [];
    const rows = await prisma.temporaryClinicAssignmentOverride.findMany({
        where: activeOverrideWhere(params),
        select: { clinicId: true }
    });
    return Array.from(new Set(rows.map((row) => row.clinicId)));
}
export async function hasActiveTemporaryClinicOverride(params) {
    if (!isTemporaryClinicOverrideRole(params.role))
        return false;
    const count = await prisma.temporaryClinicAssignmentOverride.count({
        where: activeOverrideWhere(params)
    });
    return count > 0;
}
//# sourceMappingURL=assignment-overrides.js.map