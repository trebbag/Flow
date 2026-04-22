import { PrismaClient } from "@prisma/client";
import { env } from "../src/lib/env.js";
import {
  encryptPhi,
  encryptPhiDate,
  isPhiEncryptionEnabled,
} from "../src/lib/phi-encryption.js";

async function main() {
  if (!isPhiEncryptionEnabled()) {
    console.error(
      "PHI_ENCRYPTION_KEY is not configured. Set it (base64-encoded 32 bytes) before running the backfill.",
    );
    process.exit(2);
  }

  const db = new PrismaClient();
  const batchSize = Number(process.env.PHI_BACKFILL_BATCH_SIZE || 500);
  const dryRun = process.env.PHI_BACKFILL_DRY_RUN === "1";
  let cursor: string | undefined;
  let total = 0;
  let written = 0;

  try {
    while (true) {
      const rows = await db.patient.findMany({
        where: {
          OR: [
            { displayName: { not: null }, displayNameCipher: null },
            { dateOfBirth: { not: null }, dateOfBirthCipher: null },
          ],
        },
        orderBy: { id: "asc" },
        take: batchSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: {
          id: true,
          displayName: true,
          displayNameCipher: true,
          dateOfBirth: true,
          dateOfBirthCipher: true,
        },
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        total += 1;
        const data: Record<string, string | null> = {};
        if (row.displayName && !row.displayNameCipher) {
          const cipher = encryptPhi(row.displayName);
          if (cipher) data.displayNameCipher = cipher;
        }
        if (row.dateOfBirth && !row.dateOfBirthCipher) {
          const cipher = encryptPhiDate(row.dateOfBirth);
          if (cipher) data.dateOfBirthCipher = cipher;
        }
        if (Object.keys(data).length === 0) continue;
        data.cipherKeyId = env.PHI_ENCRYPTION_KEY_ID;
        if (!dryRun) {
          await db.patient.update({ where: { id: row.id }, data });
        }
        written += 1;
      }
      cursor = rows[rows.length - 1].id;
      console.info(
        `[phi-backfill] batch=${rows.length} total=${total} written=${written} cursor=${cursor}${dryRun ? " (dry-run)" : ""}`,
      );
    }
    console.info(
      `[phi-backfill] done. scanned=${total} encrypted=${written}${dryRun ? " (dry-run, nothing written)" : ""}`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error("[phi-backfill] failed", error);
  process.exit(1);
});
