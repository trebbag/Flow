import 'dotenv/config';
import { RoleName } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';

type Mapping = {
  role: RoleName;
  oidEnv: string;
  emailEnv: string;
  defaultEmail: string;
  defaultName: string;
};

const mappings: Mapping[] = [
  {
    role: RoleName.Admin,
    oidEnv: 'ENTRA_OID_ADMIN',
    emailEnv: 'ENTRA_EMAIL_ADMIN',
    defaultEmail: 'admin@clinicos1.onmicrosoft.com',
    defaultName: 'Admin',
  },
  {
    role: RoleName.FrontDeskCheckIn,
    oidEnv: 'ENTRA_OID_FRONTDESKCHECKIN',
    emailEnv: 'ENTRA_EMAIL_FRONTDESKCHECKIN',
    defaultEmail: 'frontdesk@clinicos1.onmicrosoft.com',
    defaultName: 'Front Desk',
  },
  {
    role: RoleName.MA,
    oidEnv: 'ENTRA_OID_MA',
    emailEnv: 'ENTRA_EMAIL_MA',
    defaultEmail: 'ma@clinicos1.onmicrosoft.com',
    defaultName: 'Medical Assistant',
  },
  {
    role: RoleName.Clinician,
    oidEnv: 'ENTRA_OID_CLINICIAN',
    emailEnv: 'ENTRA_EMAIL_CLINICIAN',
    defaultEmail: 'clinician@clinicos1.onmicrosoft.com',
    defaultName: 'Clinician',
  },
  {
    role: RoleName.FrontDeskCheckOut,
    oidEnv: 'ENTRA_OID_FRONTDESKCHECKOUT',
    emailEnv: 'ENTRA_EMAIL_FRONTDESKCHECKOUT',
    defaultEmail: 'checkout@clinicos1.onmicrosoft.com',
    defaultName: 'Check Out',
  },
  {
    role: RoleName.RevenueCycle,
    oidEnv: 'ENTRA_OID_REVENUECYCLE',
    emailEnv: 'ENTRA_EMAIL_REVENUECYCLE',
    defaultEmail: 'revenue@clinicos1.onmicrosoft.com',
    defaultName: 'Revenue',
  },
];

function envValue(key: string) {
  return String(process.env[key] || '').trim();
}

async function main() {
  const facilities = await prisma.facility.findMany({
    where: { status: { not: 'archived' } },
    orderBy: { createdAt: 'asc' },
    take: 2,
  });
  const facility = facilities[0] || null;
  const secondaryFacility = facilities[1] || null;

  if (!facility) {
    throw new Error('No active facility found. Seed or create a facility before syncing Entra users.');
  }

  const results: Array<Record<string, string>> = [];

  for (const mapping of mappings) {
    const oid = envValue(mapping.oidEnv);
    if (!oid) {
      throw new Error(`Missing ${mapping.oidEnv}`);
    }

    const targetEmail = envValue(mapping.emailEnv) || mapping.defaultEmail;

    const roleRow = await prisma.userRole.findFirst({
      where: { role: mapping.role },
      include: { user: true },
      orderBy: { user: { createdAt: 'asc' } },
    });

    let user = roleRow?.user ?? null;

    if (!user) {
      user = await prisma.user.create({
        data: {
          email: targetEmail.toLowerCase(),
          name: mapping.defaultName,
          activeFacilityId: facility.id,
          status: 'active',
          entraObjectId: oid,
          entraTenantId: process.env.ENTRA_TENANT_ID || null,
          entraUserPrincipalName: targetEmail.toLowerCase(),
          identityProvider: 'entra',
          directoryStatus: 'active',
          directoryUserType: 'Member',
          directoryAccountEnabled: true,
          lastDirectorySyncAt: new Date(),
          cognitoSub: oid,
        },
      });

      await prisma.userRole.create({
        data: {
          userId: user.id,
          role: mapping.role,
          facilityId: facility.id,
        },
      });
    } else {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          status: 'active',
          entraObjectId: oid,
          entraTenantId: process.env.ENTRA_TENANT_ID || user.entraTenantId || null,
          entraUserPrincipalName: targetEmail.toLowerCase(),
          identityProvider: 'entra',
          directoryStatus: 'active',
          directoryUserType: 'Member',
          directoryAccountEnabled: true,
          lastDirectorySyncAt: new Date(),
          cognitoSub: oid,
          email: targetEmail.toLowerCase(),
          activeFacilityId: facility.id,
        },
      });
    }

    const requiredFacilityIds = [facility.id, secondaryFacility?.id].filter(Boolean) as string[];
    for (const facilityId of requiredFacilityIds) {
      const existingRole = await prisma.userRole.findFirst({
        where: {
          userId: user.id,
          role: mapping.role,
          facilityId,
          clinicId: null,
        },
      });
      if (!existingRole) {
        await prisma.userRole.create({
          data: {
            userId: user.id,
            role: mapping.role,
            facilityId,
          },
        });
      }
    }

    results.push({
      role: mapping.role,
      userId: user.id,
      email: user.email,
      entraObjectId: user.entraObjectId || '',
      cognitoSub: user.cognitoSub || '',
      facilityScope: requiredFacilityIds.join(','),
    });
  }

  console.info(
    JSON.stringify(
      {
        facilityId: facility.id,
        secondaryFacilityId: secondaryFacility?.id || '',
        synced: results,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
