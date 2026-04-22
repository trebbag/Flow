import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const sqlitePath = resolve(repoRoot, "prisma/schema.prisma");
const postgresPath = resolve(repoRoot, "prisma/schema.postgres.prisma");

const SQLITE_HEADER = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
}
`;

const POSTGRES_HEADER = `generator client {
  provider = "prisma-client-js"
  output   = "../generated/postgres-client"
}

datasource db {
  provider = "postgresql"
}
`;

function stripKnownHeader(raw: string, expected: string, label: string): string {
  if (!raw.startsWith(expected)) {
    console.error(`[verify-schema-parity] ${label} does not begin with the expected generator/datasource header.`);
    console.error(`Expected prefix:\n${expected}`);
    console.error(`Found prefix:\n${raw.slice(0, expected.length)}`);
    process.exit(1);
  }
  return raw.slice(expected.length);
}

const sqliteRaw = readFileSync(sqlitePath, "utf8");
const postgresRaw = readFileSync(postgresPath, "utf8");

const sqliteBody = stripKnownHeader(sqliteRaw, SQLITE_HEADER, "schema.prisma");
const postgresBody = stripKnownHeader(postgresRaw, POSTGRES_HEADER, "schema.postgres.prisma");

function normalize(body: string): string {
  return body
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").replace(/\s+$/, ""))
    .join("\n");
}

const sqliteNormalized = normalize(sqliteBody);
const postgresNormalized = normalize(postgresBody);

if (sqliteNormalized !== postgresNormalized) {
  console.error(
    "[verify-schema-parity] Drift detected between prisma/schema.prisma and prisma/schema.postgres.prisma.",
  );
  console.error(
    "These files must be identical below their generator/datasource headers. Sync both files to reflect the same models, enums, fields, indexes, and relations.",
  );
  const sqliteLines = sqliteNormalized.split("\n");
  const postgresLines = postgresNormalized.split("\n");
  const maxLen = Math.max(sqliteLines.length, postgresLines.length);
  const diffs: string[] = [];
  for (let i = 0; i < maxLen; i += 1) {
    const a = sqliteLines[i] ?? "<missing>";
    const b = postgresLines[i] ?? "<missing>";
    if (a !== b) {
      diffs.push(`line ${i + 1}:\n  sqlite : ${a}\n  postgres: ${b}`);
      if (diffs.length >= 10) {
        diffs.push("… (truncated)");
        break;
      }
    }
  }
  console.error(diffs.join("\n"));
  process.exit(1);
}

console.info("[verify-schema-parity] OK — schema.prisma and schema.postgres.prisma match below their headers.");
