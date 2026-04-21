import type { FastifyInstance } from "fastify";
import { AlertInboxKind, RoleName } from "@prisma/client";
import { z } from "zod";
import { env } from "../lib/env.js";
import { prisma } from "../lib/prisma.js";
import { ApiError, requireCondition } from "../lib/errors.js";
import { requireRoles } from "../lib/auth.js";
import { createInboxAlert } from "../lib/user-alert-inbox.js";
import { flushOperationalOutbox, persistMutationOperationalEventTx } from "../lib/operational-events.js";

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

    const event = await prisma.$transaction(async (tx) => {
      const encounter = await tx.encounter.findUnique({
        where: { id: encounterId },
        include: {
          clinic: {
            select: { id: true, facilityId: true, name: true }
          }
        }
      });
      requireCondition(encounter, 404, "Encounter not found");

      const active = await tx.safetyEvent.findFirst({
        where: {
          encounterId,
          resolvedAt: null
        }
      });

      if (active) {
        throw new ApiError(400, "Safety assist is already active for this encounter");
      }

      const created = await tx.safetyEvent.create({
        data: {
          encounterId,
          activatedBy: request.user!.id,
          location: dto.location
        }
      });

      await tx.encounter.update({
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
          sourceId: created.id,
          sourceVersionKey: `safety:${created.id}:active`,
          title: "Safety assist activated",
          message: `Safety assist is active for encounter ${encounter.patientId}.`,
          payload: {
            encounterId: encounter.id,
            patientId: encounter.patientId,
            clinicId: encounter.clinicId
          }
        }, tx);
      }

      await persistMutationOperationalEventTx({
        db: tx,
        request,
        entityType: "safety",
        entityId: created.id,
      });

      return created;
    });

    await flushOperationalOutbox(prisma);
    return event;
  });

  app.post("/safety/:encounterId/resolve", { preHandler: requireRoles(RoleName.FrontDeskCheckIn, RoleName.MA, RoleName.Clinician, RoleName.FrontDeskCheckOut, RoleName.Admin) }, async (request) => {
    const encounterId = (request.params as { encounterId: string }).encounterId;
    const dto = resolveSchema.parse(request.body);

    if (!verifySafetyWord(dto.confirmationWord)) {
      throw new ApiError(400, "Invalid safety confirmation word");
    }

    const resolved = await prisma.$transaction(async (tx) => {
      const activeEvent = await tx.safetyEvent.findFirst({
        where: {
          encounterId,
          resolvedAt: null
        },
        orderBy: { activatedAt: "desc" }
      });
      requireCondition(activeEvent, 404, "No active safety event found");

      const updated = await tx.safetyEvent.update({
        where: { id: activeEvent.id },
        data: {
          resolvedAt: new Date(),
          resolvedBy: request.user!.id,
          resolutionNote: dto.resolutionNote
        }
      });

      await persistMutationOperationalEventTx({
        db: tx,
        request,
        entityType: "safety",
        entityId: updated.id,
      });

      return updated;
    });

    await flushOperationalOutbox(prisma);
    return resolved;
  });
}
