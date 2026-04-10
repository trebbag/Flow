import type { FastifyInstance } from "fastify";
import { AlertInboxStatus, RoleName } from "@prisma/client";
import { z } from "zod";
import { assert } from "../lib/errors.js";
import { requireRoles } from "../lib/auth.js";
import { listUserInboxAlerts, updateUserInboxAlertStatus } from "../lib/user-alert-inbox.js";
import { refreshEncounterAlertStates } from "../lib/alert-engine.js";
import { prisma } from "../lib/prisma.js";

const alertsQuerySchema = z.object({
  tab: z.enum(["active", "archived"]).default("active"),
  limit: z.coerce.number().int().positive().max(200).default(100)
});

export async function registerAlertRoutes(app: FastifyInstance) {
  const guard = requireRoles(
    RoleName.FrontDeskCheckIn,
    RoleName.MA,
    RoleName.Clinician,
    RoleName.FrontDeskCheckOut,
    RoleName.Admin,
    RoleName.RevenueCycle
  );

  app.get("/alerts", { preHandler: guard }, async (request) => {
    const query = alertsQuerySchema.parse(request.query);
    await refreshEncounterAlertStates(prisma, {
      facilityId: request.user!.facilityId,
      clinicIds: request.user!.clinicId ? [request.user!.clinicId] : undefined
    });
    const { rows, total } = await listUserInboxAlerts({
      userId: request.user!.id,
      tab: query.tab,
      limit: query.limit
    });
    return {
      tab: query.tab,
      total,
      items: rows.map((row) => ({
        ...row,
        payload: row.payloadJson
      }))
    };
  });

  app.post("/alerts/:id/acknowledge", { preHandler: guard }, async (request) => {
    const alertId = (request.params as { id: string }).id;
    const updated = await updateUserInboxAlertStatus({
      id: alertId,
      userId: request.user!.id,
      status: AlertInboxStatus.archived
    });
    assert(updated.count > 0, 404, "Alert not found");
    return { status: "archived", id: alertId };
  });

  app.post("/alerts/:id/unarchive", { preHandler: guard }, async (request) => {
    const alertId = (request.params as { id: string }).id;
    const updated = await updateUserInboxAlertStatus({
      id: alertId,
      userId: request.user!.id,
      status: AlertInboxStatus.active
    });
    assert(updated.count > 0, 404, "Alert not found");
    return { status: "active", id: alertId };
  });
}
