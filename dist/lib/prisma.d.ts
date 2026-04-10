import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
export declare const prisma: PrismaClient<{
    adapter: PrismaBetterSqlite3;
    log: ("error" | "query" | "warn")[];
}, "error" | "query" | "warn", import("@prisma/client/runtime/client").DefaultArgs>;
