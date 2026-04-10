import { DateTime } from "luxon";
import { prisma } from "../src/lib/prisma.js";
import { getDailyHistoryRollups, listDateKeys } from "../src/lib/office-manager-rollups.js";

function parseArgs(argv: string[]) {
  const parsed: Record<string, string> = {};
  argv.forEach((arg) => {
    if (!arg.startsWith("--")) return;
    const [rawKey, ...rest] = arg.slice(2).split("=");
    const key = rawKey.trim();
    if (!key) return;
    parsed[key] = rest.join("=").trim();
  });
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const defaultDate = DateTime.utc().minus({ days: 1 }).toISODate() || "";
  const from = (args.from || args.date || defaultDate).trim();
  const to = (args.to || args.date || from).trim();

  if (!from || !to) {
    throw new Error("Unable to resolve date range. Provide --date=YYYY-MM-DD or --from/--to.");
  }

  const dateKeys = listDateKeys(from, to);
  const clinicId = (args.clinicId || "").trim();

  const clinics = await prisma.clinic.findMany({
    where: clinicId
      ? {
          id: clinicId,
          status: "active"
        }
      : {
          status: "active"
        },
    select: { id: true, timezone: true },
    orderBy: { id: "asc" }
  });

  if (clinics.length === 0) {
    if (clinicId) {
      throw new Error(`Clinic '${clinicId}' is not active or does not exist.`);
    }
    throw new Error("No active clinics found to roll up.");
  }

  const daily = await getDailyHistoryRollups(prisma, clinics, dateKeys, {
    persist: true,
    forceRecompute: true
  });

  const totalDays = daily.length;
  const totalClinics = clinics.length;
  const totalRows = totalDays * totalClinics;
  console.info(
    `Office-manager rollups computed for ${totalRows} clinic-day rows (${totalClinics} clinics x ${totalDays} day(s)).`
  );
  console.info(`Range: ${dateKeys[0]} -> ${dateKeys[dateKeys.length - 1]}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
