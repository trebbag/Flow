import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, RoleName as PrismaRoleName } from "../generated/postgres-client/index.js";

type StagingRoleName = keyof typeof PrismaRoleName;

type CreateProofUserParams = {
  role: StagingRoleName;
  facilityIds: string[];
  namePrefix: string;
};

type ArchiveProofUsersParams = {
  userIds: string[];
  facilityId: string;
};

const roleFixtureEmails: Partial<Record<StagingRoleName, string>> = {
  FrontDeskCheckIn: "staging-proof-checkin@flow.local",
  MA: "staging-proof-ma@flow.local",
  Clinician: "staging-proof-clinician@flow.local",
  FrontDeskCheckOut: "staging-proof-checkout@flow.local",
  OfficeManager: "staging-proof-office@flow.local",
  RevenueCycle: "staging-proof-revenue@flow.local",
};

function postgresUrl() {
  return (process.env.POSTGRES_DATABASE_URL || "").trim();
}

function roleValue(role: StagingRoleName) {
  const value = PrismaRoleName[role];
  if (!value) {
    throw new Error(`Unsupported staging proof role: ${role}`);
  }
  return value;
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "proof";
}

export function hasStagingProofDatabaseAccess() {
  return Boolean(postgresUrl());
}

export async function createStagingProofRoleUser(params: CreateProofUserParams) {
  const connectionString = postgresUrl();
  if (!connectionString) return null;

  const facilityIds = params.facilityIds.map((id) => id.trim()).filter(Boolean);
  if (facilityIds.length === 0) {
    throw new Error("At least one facility id is required to create a staging proof user");
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  try {
    const created = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_facility_id', ${facilityIds[0]}, true)`;
      const timestamp = Date.now();
      const user = await tx.user.create({
        data: {
          email: `${slug(params.namePrefix)}-${params.role.toLowerCase()}-${timestamp}@flow.local`,
          name: `${params.namePrefix} ${params.role}`,
          status: "active",
          activeFacilityId: facilityIds[0],
          identityProvider: "staging-proof",
        },
      });

      for (const facilityId of facilityIds) {
        await tx.userRole.create({
          data: {
            userId: user.id,
            role: roleValue(params.role),
            facilityId,
          },
        });
      }

      return user;
    });

    return created.id;
  } finally {
    await prisma.$disconnect();
  }
}

export async function archiveStagingProofUsers(params: ArchiveProofUsersParams) {
  const connectionString = postgresUrl();
  if (!connectionString || params.userIds.length === 0 || !params.facilityId) return false;

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_facility_id', ${params.facilityId}, true)`;
      await tx.user.updateMany({
        where: {
          id: { in: params.userIds },
        },
        data: {
          status: "archived",
        },
      });
    });
    return true;
  } finally {
    await prisma.$disconnect();
  }
}

export async function findStagingProofFixtureRoleUserIds(params: { facilityId: string }) {
  const connectionString = postgresUrl();
  if (!connectionString || !params.facilityId) return new Map<StagingRoleName, string>();

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_facility_id', ${params.facilityId}, true)`;
      const rows = await tx.user.findMany({
        where: {
          status: "active",
          email: { in: Object.values(roleFixtureEmails) },
        },
        select: {
          id: true,
          email: true,
          roles: {
            select: {
              role: true,
              facilityId: true,
              clinic: { select: { facilityId: true } },
            },
          },
        },
      });

      const byRole = new Map<StagingRoleName, string>();
      for (const [role, email] of Object.entries(roleFixtureEmails) as Array<[StagingRoleName, string]>) {
        const row = rows.find((candidate) => candidate.email === email);
        if (!row) continue;
        const hasRoleInFacility = row.roles.some(
          (entry) =>
            entry.role === roleValue(role) &&
            (entry.facilityId === params.facilityId || entry.clinic?.facilityId === params.facilityId),
        );
        if (hasRoleInFacility) {
          byRole.set(role, row.id);
        }
      }
      return byRole;
    });
  } finally {
    await prisma.$disconnect();
  }
}
