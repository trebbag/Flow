import type { FastifyInstance } from "fastify";
import { RoleName } from "@prisma/client";
import { z } from "zod";
import { authenticate, type RequestUser } from "../lib/auth.js";
import { prisma } from "../lib/prisma.js";
import { ApiError } from "../lib/errors.js";

export async function registerAuthRoutes(app: FastifyInstance) {
  const facilityContextSchema = z.object({
    facilityId: z.string().uuid()
  });

  async function buildAuthContext(user: RequestUser) {
    const facilities =
      user.availableFacilityIds.length > 0
        ? await prisma.facility.findMany({
            where: { id: { in: user.availableFacilityIds } },
            select: { id: true, name: true, shortCode: true, timezone: true, status: true },
            orderBy: { name: "asc" }
          })
        : [];

    return {
      userId: user.id,
      role: user.role,
      roles: user.roles,
      clinicId: user.clinicId,
      facilityId: user.facilityId,
      activeFacilityId: user.activeFacilityId,
      availableFacilities: facilities
    };
  }

  app.get("/auth/context", { preHandler: authenticate }, async (request) => {
    const user = request.user!;
    return buildAuthContext(user);
  });

  app.post("/auth/context/facility", { preHandler: authenticate }, async (request) => {
    const user = request.user!;
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
