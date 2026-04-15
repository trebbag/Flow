import { RoleName } from "@prisma/client";
import { z } from "zod";
import { authenticate } from "../lib/auth.js";
import { prisma } from "../lib/prisma.js";
import { ApiError } from "../lib/errors.js";
export async function registerAuthRoutes(app) {
    const facilityContextSchema = z.object({
        facilityId: z.string().uuid()
    });
    async function buildAuthContext(user) {
        const [facilities, persistedUser] = await Promise.all([
            user.availableFacilityIds.length > 0
                ? prisma.facility.findMany({
                    where: { id: { in: user.availableFacilityIds } },
                    select: { id: true, name: true, shortCode: true, timezone: true, status: true },
                    orderBy: { name: "asc" }
                })
                : Promise.resolve([]),
            prisma.user.findUnique({
                where: { id: user.id },
                select: { name: true, email: true, entraUserPrincipalName: true }
            })
        ]);
        const displayName = persistedUser?.name?.trim() || persistedUser?.entraUserPrincipalName || persistedUser?.email || null;
        const nameParts = (displayName || "").split(/\s+/).filter(Boolean);
        return {
            userId: user.id,
            name: displayName,
            email: persistedUser?.email || persistedUser?.entraUserPrincipalName || null,
            firstName: nameParts[0] || null,
            lastName: nameParts.length > 1 ? nameParts[nameParts.length - 1] || null : null,
            role: user.role,
            roles: user.roles,
            clinicId: user.clinicId,
            facilityId: user.facilityId,
            activeFacilityId: user.activeFacilityId,
            availableFacilities: facilities
        };
    }
    app.get("/auth/context", { preHandler: authenticate }, async (request) => {
        const user = request.user;
        return buildAuthContext(user);
    });
    app.post("/auth/context/facility", { preHandler: authenticate }, async (request) => {
        const user = request.user;
        const dto = facilityContextSchema.parse(request.body);
        const facility = await prisma.facility.findUnique({ where: { id: dto.facilityId } });
        if (!facility) {
            throw new ApiError(404, "Facility not found");
        }
        const inScope = user.role === RoleName.Admin || user.availableFacilityIds.includes(dto.facilityId);
        if (!inScope) {
            throw new ApiError(403, "Facility is outside your assigned scope");
        }
        await prisma.user.update({
            where: { id: user.id },
            data: { activeFacilityId: dto.facilityId }
        });
        request.user = {
            ...user,
            facilityId: dto.facilityId,
            activeFacilityId: dto.facilityId
        };
        return buildAuthContext(request.user);
    });
}
//# sourceMappingURL=auth.js.map