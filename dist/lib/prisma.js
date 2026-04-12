import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
const sqliteDatabaseUrl = process.env.DATABASE_URL || "file:./prisma/dev.db";
const postgresDatabaseUrl = (process.env.POSTGRES_DATABASE_URL || "").trim();
const prismaLogLevels = process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"];
async function createPrismaClient() {
    if (postgresDatabaseUrl) {
        const postgresClientModulePath = "../../generated/postgres-client/index.js";
        let PostgresPrismaClient;
        try {
            ({ PrismaClient: PostgresPrismaClient } = (await import(postgresClientModulePath)));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`POSTGRES_DATABASE_URL is configured, but the generated PostgreSQL Prisma client is unavailable. ` +
                `Run "pnpm db:generate:postgres" before starting the server. Underlying error: ${message}`);
        }
        const adapter = new PrismaPg({ connectionString: postgresDatabaseUrl });
        return new PostgresPrismaClient({
            adapter,
            log: prismaLogLevels
        });
    }
    const adapter = new PrismaBetterSqlite3({
        url: sqliteDatabaseUrl
    });
    return new PrismaClient({
        adapter,
        log: prismaLogLevels
    });
}
export const prisma = await createPrismaClient();
//# sourceMappingURL=prisma.js.map