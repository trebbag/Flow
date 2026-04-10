import type { FastifyInstance } from "fastify";
import { AlertInboxKind, RoleName } from "@prisma/client";
import { z } from "zod";
import { env } from "../lib/env.js";
import { prisma } from "../lib/prisma.js";
import { ApiError, assert } from "../lib/errors.js";
import { requireRoles } from "../lib/auth.js";
import { createInboxAlert } from "../lib/user-alert-inbox.js";

const activateSchema = z.object({
  confirmationWord: z.string().min(1),
  location: z.string().optional()
});

const resolveSchema = z.object({
  confirmationWord: z.string().min(1),
  resolutionNote: z.string().optional()
});

function verifySafetyWord(input: string) {
  return input.trim().toUpperCase() === env.SAFETY_WORD.trim().toUpperCase();
}

export async function registerSafetyRoutes(app: FastifyInstance) {
  app.get("/safety/word", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.MA, RoleName.Clinician, RoleName.FrontDeskCheckOut, RoleName.Admin, RoleName.RevenueCycle) }, async () => {
    return { word: env.SAFETY_WORD };
  });

  app.post("/safety/:encounterId/activate", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.MA, RoleName.Clinician, RoleName.FrontDeskCheckOut, RoleName.Admin) }, async (request) => {
    const encounterId = (request.params as { encounterId: string }).encounterId;
    const dto = activateSchema.parse(request.body);

    if (!verifySafetyWord(dto.confirmationWord)) {
      throw new ApiError(400, "Invalid safety confirmation word");
    }

    const encounter = await prisma.encounter.findUnique({
      where: { id: encounterId },
      include: {
        clinic: {
          select: { id: true, facilityId: true, name: true }
        }
      }
    });
    assert(encounter, 404, "Encounter not found");

    const active = await prisma.safetyEvent.findFirst({
      where: {
        encounterId,
        resolvedAt: null
      }
    });

    if (active) {
      throw new ApiError(400, "Safety assist is already active for this encounter");
    }

    const event = await prisma.safetyEvent.create({
      data: {
        encounterId,
        activatedBy: request.user!.id,
        location: dto.location
      }
    });

    await prisma.encounter.update({
      where: { id: encounterId },
      data: {
        alertState: {
          update: {
            currentAlertLevel: "Red"
          }
        }
      }
    });

    if (encounter.clinic?.facilityId) {
      await createInboxAlert({
        facilityId: encounter.clinic.facilityId,
        clinicId: encounter.clinic.id,
        kind: AlertInboxKind.safety,
        sourceId: event.id,
        sourceVersionKey: `safety:${event.id}:active`,
        title: "Safety assist activated",
        message: `Safety assist is active for encounter ${encounter.patientId}.`,
        payload: {
          encounterId: encounter.id,
          patientId: encounter.patientId,
          clinicId: encounter.clinicId
        }
      });
    }

    return event;
  });

  app.post("/safety/:encounterId/resolve", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.MA, RoleName.Clinician, RoleName.FrontDeskCheckOut, RoleName.Admin) }, async (request) => {
    const encounterId = (request.params as { encounterId: string }).encounterId;
    const dto = resolveSchema.parse(request.body);

    if (!verifySafetyWord(dto.confirmationWord)) {
      throw new ApiError(400, "Invalid safety confirmation word");
    }

    const activeEvent = await prisma.safetyEvent.findFirst({
      where: {
        encounterId,
        resolvedAt: null
      },
      orderBy: { activatedAt: "desc" }
    });
    assert(activeEvent, 404, "No active safety event found");

    const resolved = await prisma.safetyEvent.update({
      where: { id: activeEvent.id },
      data: {
        resolvedAt: new Date(),
        resolvedBy: request.user!.id,
        resolutionNote: dto.resolutionNote
      }
    });

    return resolved;
  });
}
