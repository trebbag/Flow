import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { getEntraDirectoryUserByObjectId } from "../src/lib/entra-directory.js";

async function main() {
  const users = await prisma.user.findMany({
    where: {
      OR: [{ identityProvider: "entra" }, { entraObjectId: { not: null } }]
    },
    orderBy: { createdAt: "asc" }
  });

  const results: Array<Record<string, string>> = [];

  for (const user of users) {
    const objectId = user.entraObjectId || user.cognitoSub;
    if (!objectId) {
      results.push({
        userId: user.id,
        email: user.email,
        status: "skipped",
        detail: "No Entra object ID is stored on this Flow user."
      });
      continue;
    }

    const directoryUser = await getEntraDirectoryUserByObjectId(objectId, {
      email: user.email,
      userPrincipalName: user.entraUserPrincipalName
    });
    const nextStatus = !directoryUser
      ? "deleted"
      : !directoryUser.accountEnabled
        ? "disabled"
        : directoryUser.userType.toLowerCase() !== "member"
          ? "guest"
          : "active";

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        email: directoryUser ? (directoryUser.email || directoryUser.userPrincipalName).toLowerCase() : user.email,
        name: directoryUser?.displayName || user.name,
        entraObjectId: objectId,
        entraTenantId: directoryUser?.tenantId || user.entraTenantId || null,
        entraUserPrincipalName: directoryUser?.userPrincipalName || user.entraUserPrincipalName || null,
        identityProvider: "entra",
        directoryStatus: nextStatus,
        directoryUserType: directoryUser?.userType || user.directoryUserType || null,
        directoryAccountEnabled: directoryUser?.accountEnabled ?? false,
        lastDirectorySyncAt: new Date(),
        status:
          user.status === "archived"
            ? "archived"
            : nextStatus === "active"
              ? user.status
              : "suspended"
      }
    });

    results.push({
      userId: updated.id,
      email: updated.email,
      status: updated.directoryStatus || "unknown",
      flowStatus: updated.status
    });
  }

  console.info(JSON.stringify({ ok: true, synced: results }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
