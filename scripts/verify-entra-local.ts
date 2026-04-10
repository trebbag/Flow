import 'dotenv/config';
import { SignJWT } from 'jose';
import { RoleName } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const roleSpecs = [
  { role: RoleName.Admin, oidEnv: 'ENTRA_OID_ADMIN' },
  { role: RoleName.FrontDeskCheckIn, oidEnv: 'ENTRA_OID_FRONTDESKCHECKIN' },
  { role: RoleName.MA, oidEnv: 'ENTRA_OID_MA' },
  { role: RoleName.Clinician, oidEnv: 'ENTRA_OID_CLINICIAN' },
  { role: RoleName.FrontDeskCheckOut, oidEnv: 'ENTRA_OID_FRONTDESKCHECKOUT' },
  { role: RoleName.RevenueCycle, oidEnv: 'ENTRA_OID_REVENUECYCLE' },
] as const;

function envValue(key: string) {
  return String(process.env[key] || '').trim();
}

async function mintToken(oid: string, role: RoleName, facilityId?: string | null) {
  const secret = envValue('JWT_SECRET');
  const issuer = envValue('JWT_ISSUER');
  const audience = envValue('JWT_AUDIENCE');

  if (!secret || !issuer || !audience) {
    throw new Error('JWT_SECRET, JWT_ISSUER, and JWT_AUDIENCE must be configured.');
  }

  const claims: Record<string, unknown> = {
    oid,
    roles: [role],
  };
  if (facilityId) claims.facility_id = facilityId;

  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(new TextEncoder().encode(secret));
}

async function main() {
  const app = buildApp();
  const results: Array<Record<string, string>> = [];

  try {
    for (const spec of roleSpecs) {
      const oid = envValue(spec.oidEnv);
      if (!oid) throw new Error(`Missing ${spec.oidEnv}`);

      const userRole = await prisma.userRole.findFirst({
        where: { role: spec.role, user: { cognitoSub: oid, status: 'active' } },
        include: { user: true, clinic: true },
        orderBy: { user: { createdAt: 'asc' } },
      });

      if (!userRole) {
        throw new Error(`No active Flow user is mapped to ${spec.role} with Entra OID ${oid}`);
      }

      const facilityId = userRole.facilityId || userRole.clinic?.facilityId || userRole.user.activeFacilityId || null;
      const token = await mintToken(oid, spec.role, facilityId);
      const response = await app.inject({
        method: 'GET',
        url: '/auth/context',
        headers: {
          authorization: `Bearer ${token}`,
          ...(facilityId ? { 'x-facility-id': facilityId } : {}),
        },
      });

      if (response.statusCode !== 200) {
        throw new Error(`${spec.role} auth check failed: ${response.statusCode} ${response.body}`);
      }

      const payload = response.json();
      results.push({
        role: spec.role,
        userId: payload.userId,
        activeFacilityId: payload.activeFacilityId || '',
      });
    }

    console.info(JSON.stringify({ ok: true, verified: results }, null, 2));
  } finally {
    await app.close();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
