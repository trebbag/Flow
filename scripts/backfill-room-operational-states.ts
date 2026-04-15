import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { backfillRoomOperationalStates } from "../src/lib/room-operations.js";

async function main() {
  const count = await backfillRoomOperationalStates();
  console.info(`Room operational state backfill complete: ${count} active room${count === 1 ? "" : "s"} checked.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
