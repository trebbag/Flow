import { PrismaClient } from "@prisma/client";

type Row = {
  facilityId: string | null;
  facilityName: string | null;
  userId: string;
  userEmail: string;
  userName: string;
  userStatus: string;
  directoryStatus: string | null;
  directoryAccountEnabled: boolean | null;
  lastDirectorySyncAt: string | null;
  role: string;
  clinicId: string | null;
  clinicName: string | null;
};

function toCsvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function main() {
  const db = new PrismaClient();
  const facilityFilter = process.env.RECERT_FACILITY_ID?.trim();
  try {
    const roles = await db.userRole.findMany({
      where: facilityFilter ? { facilityId: facilityFilter } : undefined,
      include: {
        user: true,
        facility: true,
        clinic: true,
      },
      orderBy: [{ facilityId: "asc" }, { role: "asc" }],
    });

    const rows: Row[] = roles.map((r) => ({
      facilityId: r.facilityId,
      facilityName: r.facility?.name ?? null,
      userId: r.userId,
      userEmail: r.user.email,
      userName: r.user.name,
      userStatus: r.user.status,
      directoryStatus: r.user.directoryStatus,
      directoryAccountEnabled: r.user.directoryAccountEnabled,
      lastDirectorySyncAt: r.user.lastDirectorySyncAt?.toISOString() ?? null,
      role: r.role,
      clinicId: r.clinicId,
      clinicName: r.clinic?.name ?? null,
    }));

    const format = (process.env.RECERT_FORMAT || "csv").toLowerCase();
    const out = (line: string) => process.stdout.write(line + "\n");
    if (format === "json") {
      out(JSON.stringify(rows, null, 2));
    } else {
      const header = [
        "facilityId",
        "facilityName",
        "userId",
        "userEmail",
        "userName",
        "userStatus",
        "directoryStatus",
        "directoryAccountEnabled",
        "lastDirectorySyncAt",
        "role",
        "clinicId",
        "clinicName",
      ].join(",");
      out(header);
      for (const row of rows) {
        out(
          [
            row.facilityId,
            row.facilityName,
            row.userId,
            row.userEmail,
            row.userName,
            row.userStatus,
            row.directoryStatus,
            row.directoryAccountEnabled,
            row.lastDirectorySyncAt,
            row.role,
            row.clinicId,
            row.clinicName,
          ]
            .map(toCsvCell)
            .join(","),
        );
      }
    }

    const stale = rows.filter(
      (r) =>
        r.userStatus !== "active" ||
        r.directoryAccountEnabled === false ||
        (r.directoryStatus && r.directoryStatus !== "active"),
    );
    console.error(
      `[recert] rows=${rows.length} stale=${stale.length}${facilityFilter ? ` facility=${facilityFilter}` : ""}`,
    );
    if (stale.length > 0 && process.env.RECERT_FAIL_ON_STALE === "1") {
      process.exit(2);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error("[recert] failed", error);
  process.exit(1);
});
