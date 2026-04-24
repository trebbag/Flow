import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, RoleName, RoomOperationalStatus } from "../generated/postgres-client/index.js";

const postgresUrl = (process.env.POSTGRES_DATABASE_URL || "").trim();

if (!postgresUrl) {
  throw new Error("POSTGRES_DATABASE_URL is required");
}

const PROOF_CLINIC_NAME = "Staging Proof Clinic";
const PROOF_CLINIC_SHORT_CODE = "STGPROOF";
const PROOF_ROOM_NAME = "Proof Room 1";
const PROOF_REASON_NAME = "Staging Proof Visit";

type ScopedUser = {
  email: string;
  name: string;
  role: RoleName;
  clinicScoped?: boolean;
};

const FIXTURE_USERS: ScopedUser[] = [
  { email: "staging-proof-checkin@flow.local", name: "Staging Check-In", role: RoleName.FrontDeskCheckIn },
  { email: "staging-proof-ma@flow.local", name: "Staging MA", role: RoleName.MA, clinicScoped: true },
  { email: "staging-proof-clinician@flow.local", name: "Staging Clinician", role: RoleName.Clinician, clinicScoped: true },
  { email: "staging-proof-checkout@flow.local", name: "Staging Check-Out", role: RoleName.FrontDeskCheckOut },
  { email: "staging-proof-office@flow.local", name: "Staging Office Manager", role: RoleName.OfficeManager },
  { email: "staging-proof-revenue@flow.local", name: "Staging Revenue", role: RoleName.RevenueCycle },
];

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: postgresUrl }),
});

async function main() {
  const admin =
    (await prisma.user.findFirst({
      where: {
        status: "active",
        roles: {
          some: {
            role: RoleName.Admin,
          },
        },
      },
      include: {
        roles: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    })) || null;

  if (!admin) {
    throw new Error("No active Admin user exists in the staging database.");
  }

  const adminFacilityId =
    admin.activeFacilityId ||
    admin.roles.find((role) => role.role === RoleName.Admin && role.facilityId)?.facilityId ||
    null;

  if (!adminFacilityId) {
    throw new Error(`Admin user ${admin.email} does not have a facility-scoped Admin role.`);
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_facility_id', ${adminFacilityId}, true)`;

    const ensureUser = async (params: { email: string; name: string; facilityId: string }) => {
      const existing = await tx.user.findUnique({
        where: { email: params.email },
      });

      if (existing) {
        return tx.user.update({
          where: { id: existing.id },
          data: {
            name: params.name,
            status: "active",
            activeFacilityId: params.facilityId,
          },
        });
      }

      return tx.user.create({
        data: {
          email: params.email,
          name: params.name,
          status: "active",
          activeFacilityId: params.facilityId,
        },
      });
    };

    const ensureUserRole = async (params: {
      userId: string;
      role: RoleName;
      facilityId: string;
      clinicId?: string | null;
    }) => {
      const existing = await tx.userRole.findFirst({
        where: {
          userId: params.userId,
          role: params.role,
          facilityId: params.facilityId,
          clinicId: params.clinicId || null,
        },
      });

      if (existing) return existing;

      return tx.userRole.create({
        data: {
          userId: params.userId,
          role: params.role,
          facilityId: params.facilityId,
          clinicId: params.clinicId || null,
        },
      });
    };

    await ensureUserRole({
      userId: admin.id,
      role: RoleName.Admin,
      facilityId: adminFacilityId,
    });

    if (admin.activeFacilityId !== adminFacilityId) {
      await tx.user.update({
        where: { id: admin.id },
        data: { activeFacilityId: adminFacilityId },
      });
    }

    let clinic =
      (await tx.clinic.findFirst({
        where: {
          facilityId: adminFacilityId,
          OR: [{ shortCode: PROOF_CLINIC_SHORT_CODE }, { name: PROOF_CLINIC_NAME }],
        },
      })) || null;

    if (!clinic) {
      clinic = await tx.clinic.create({
        data: {
          facilityId: adminFacilityId,
          name: PROOF_CLINIC_NAME,
          shortCode: PROOF_CLINIC_SHORT_CODE,
          timezone: "America/New_York",
          status: "active",
          maRun: false,
        },
      });
    } else if (clinic.status !== "active" || clinic.maRun) {
      clinic = await tx.clinic.update({
        where: { id: clinic.id },
        data: {
          status: "active",
          maRun: false,
          timezone: clinic.timezone || "America/New_York",
        },
      });
    }

    const scopedUsers = new Map<RoleName, Awaited<ReturnType<typeof ensureUser>>>();
    for (const userDef of FIXTURE_USERS) {
      const user = await ensureUser({
        email: userDef.email,
        name: userDef.name,
        facilityId: adminFacilityId,
      });
      scopedUsers.set(userDef.role, user);
      await ensureUserRole({
        userId: user.id,
        role: userDef.role,
        facilityId: adminFacilityId,
        clinicId: userDef.clinicScoped ? clinic.id : null,
      });
    }

    const clinicianUser = scopedUsers.get(RoleName.Clinician);
    const maUser = scopedUsers.get(RoleName.MA);

    if (!clinicianUser || !maUser) {
      throw new Error("Failed to ensure clinician and MA fixture users.");
    }

    const proofProviderName = clinicianUser.name;
    let provider =
      (await tx.provider.findFirst({
        where: {
          clinicId: clinic.id,
          name: proofProviderName,
        },
      })) || null;

    if (!provider) {
      provider = await tx.provider.create({
        data: {
          clinicId: clinic.id,
          name: proofProviderName,
          active: true,
        },
      });
    } else if (!provider.active) {
      provider = await tx.provider.update({
        where: { id: provider.id },
        data: { active: true },
      });
    }

    const existingAssignment = await tx.clinicAssignment.findUnique({
      where: { clinicId: clinic.id },
    });

    if (!existingAssignment) {
      await tx.clinicAssignment.create({
        data: {
          clinicId: clinic.id,
          providerUserId: clinicianUser.id,
          providerId: provider.id,
          maUserId: maUser.id,
        },
      });
    } else {
      await tx.clinicAssignment.update({
        where: { clinicId: clinic.id },
        data: {
          providerUserId: clinicianUser.id,
          providerId: provider.id,
          maUserId: maUser.id,
        },
      });
    }

    const existingMaProviderMap = await tx.maProviderMap.findFirst({
      where: {
        clinicId: clinic.id,
        providerId: provider.id,
        maUserId: maUser.id,
      },
    });
    if (!existingMaProviderMap) {
      await tx.maProviderMap.create({
        data: {
          clinicId: clinic.id,
          providerId: provider.id,
          maUserId: maUser.id,
        },
      });
    }

    const existingMaClinicMap = await tx.maClinicMap.findFirst({
      where: {
        clinicId: clinic.id,
        maUserId: maUser.id,
      },
    });
    if (!existingMaClinicMap) {
      await tx.maClinicMap.create({
        data: {
          clinicId: clinic.id,
          maUserId: maUser.id,
        },
      });
    }

    let room =
      (await tx.clinicRoom.findFirst({
        where: {
          facilityId: adminFacilityId,
          name: PROOF_ROOM_NAME,
        },
      })) || null;

    if (!room) {
      room = await tx.clinicRoom.create({
        data: {
          facilityId: adminFacilityId,
          name: PROOF_ROOM_NAME,
          roomNumber: 101,
          roomType: "exam",
          status: "active",
          sortOrder: 1,
        },
      });
    } else if (room.status !== "active") {
      room = await tx.clinicRoom.update({
        where: { id: room.id },
        data: { status: "active" },
      });
    }

    const existingRoomLink = await tx.clinicRoomAssignment.findFirst({
      where: {
        clinicId: clinic.id,
        roomId: room.id,
      },
    });
    if (!existingRoomLink) {
      await tx.clinicRoomAssignment.create({
        data: {
          clinicId: clinic.id,
          roomId: room.id,
          active: true,
        },
      });
    } else if (!existingRoomLink.active) {
      await tx.clinicRoomAssignment.update({
        where: { id: existingRoomLink.id },
        data: { active: true },
      });
    }

    const roomState = await tx.roomOperationalState.findUnique({
      where: { roomId: room.id },
    });
    if (!roomState) {
      await tx.roomOperationalState.create({
        data: {
          roomId: room.id,
          currentStatus: RoomOperationalStatus.Ready,
          lastReadyAt: new Date(),
        },
      });
    } else if (roomState.currentStatus !== RoomOperationalStatus.Ready || roomState.occupiedEncounterId) {
      await tx.roomOperationalState.update({
        where: { roomId: room.id },
        data: {
          currentStatus: RoomOperationalStatus.Ready,
          occupiedEncounterId: null,
          holdReason: null,
          holdNote: null,
          activeCleanerUserId: null,
          lastReadyAt: new Date(),
        },
      });
    }

    let reason =
      (await tx.reasonForVisit.findFirst({
        where: {
          facilityId: adminFacilityId,
          name: PROOF_REASON_NAME,
        },
      })) || null;

    if (!reason) {
      reason = await tx.reasonForVisit.create({
        data: {
          clinicId: clinic.id,
          facilityId: adminFacilityId,
          name: PROOF_REASON_NAME,
          appointmentLengthMinutes: 20,
          status: "active",
          active: true,
        },
      });
    } else {
      reason = await tx.reasonForVisit.update({
        where: { id: reason.id },
        data: {
          clinicId: clinic.id,
          facilityId: adminFacilityId,
          appointmentLengthMinutes: 20,
          status: "active",
          active: true,
        },
      });
    }

    const existingReasonAssignment = await tx.reasonClinicAssignment.findFirst({
      where: {
        reasonId: reason.id,
        clinicId: clinic.id,
      },
    });
    if (!existingReasonAssignment) {
      await tx.reasonClinicAssignment.create({
        data: {
          reasonId: reason.id,
          clinicId: clinic.id,
        },
      });
    }

    return {
      proofUserId: admin.id,
      facilityId: adminFacilityId,
      clinicId: clinic.id,
      clinicName: clinic.name,
      reasonId: reason.id,
      roomId: room.id,
    };
  });

  console.info(JSON.stringify(result));
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
