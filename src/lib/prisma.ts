import * as PrismaClientModule from "@prisma/client";
import type { Prisma, PrismaClient as PrismaClientType } from "@prisma/client";
import {
  getCurrentFacilityScopeId,
  getCurrentScopedTransaction,
  runWithScopedTransaction,
} from "./facility-scope.js";

const sqliteDatabaseUrl = process.env.DATABASE_URL || "file:./prisma/dev.db";
const postgresRuntimeDatabaseUrl = (process.env.POSTGRES_RUNTIME_DATABASE_URL || "").trim();
const postgresDatabaseUrl = (postgresRuntimeDatabaseUrl || process.env.POSTGRES_DATABASE_URL || "").trim();
const postgresDatabaseUrlSource = postgresRuntimeDatabaseUrl ? "POSTGRES_RUNTIME_DATABASE_URL" : "POSTGRES_DATABASE_URL";
const { PrismaClient } = PrismaClientModule;
type PrismaClient = PrismaClientType;
type PrismaClientOptions = ConstructorParameters<typeof PrismaClient>[0];
type PrismaLogConfig = PrismaClientOptions extends { log?: infer T } ? T : never;

const prismaLogLevels: PrismaLogConfig =
  process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"];

async function createPrismaClient(): Promise<PrismaClient> {
  if (postgresDatabaseUrl) {
    const postgresClientModulePath = "../../generated/postgres-client/index.js";
    let PostgresPrismaClient: typeof PrismaClient;
    const { PrismaPg } = await import("@prisma/adapter-pg");

    try {
      ({ PrismaClient: PostgresPrismaClient } = (await import(postgresClientModulePath)) as {
        PrismaClient: typeof PrismaClient;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${postgresDatabaseUrlSource} is configured, but the generated PostgreSQL Prisma client is unavailable. ` +
          `Run "pnpm db:generate:postgres" before starting the server. Underlying error: ${message}`,
      );
    }

    const adapter = new PrismaPg({ connectionString: postgresDatabaseUrl });
    return new PostgresPrismaClient({
      adapter,
      log: prismaLogLevels,
    });
  }

  const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
  const adapter = new PrismaBetterSqlite3({
    url: sqliteDatabaseUrl,
  });

  return new PrismaClient({
    adapter,
    log: prismaLogLevels,
  });
}

const rootPrisma = await createPrismaClient();
const scopedQueryMethods = new Set<PropertyKey>(["$queryRaw", "$queryRawUnsafe", "$executeRaw", "$executeRawUnsafe"]);

async function executeScopedOperation<T>(work: (client: PrismaClient | Prisma.TransactionClient) => Promise<T>) {
  const currentTx = getCurrentScopedTransaction();
  if (currentTx) {
    return work(currentTx);
  }

  const facilityId = getCurrentFacilityScopeId();
  if (!postgresDatabaseUrl || !facilityId) {
    return work(rootPrisma);
  }

  return rootPrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_facility_id', ${facilityId}, true)`;
    return runWithScopedTransaction(tx, () => work(tx));
  });
}

function wrapDelegate(modelKey: string, delegate: object) {
  return new Proxy(delegate, {
    get(_target, property, _receiver) {
      const value = Reflect.get(delegate, property);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) =>
        executeScopedOperation((client) => {
          const scopedDelegate = (client as Record<string, unknown>)[modelKey] as Record<string, (...callArgs: unknown[]) => Promise<unknown>>;
          return scopedDelegate[property as keyof typeof scopedDelegate](...args);
        });
    },
  });
}

function createScopedPrismaClient(client: PrismaClient) {
  return new Proxy(client, {
    get(target, property, _receiver) {
      const value = Reflect.get(target, property);

      if (property === "$transaction") {
        return (input: unknown, ...rest: unknown[]) => {
          const currentTx = getCurrentScopedTransaction();
          const facilityId = getCurrentFacilityScopeId();
          if (currentTx) {
            if (typeof input === "function") {
              return (input as (tx: Prisma.TransactionClient) => Promise<unknown>)(currentTx);
            }
            if (Array.isArray(input)) {
              return Promise.all(input as Array<Promise<unknown>>);
            }
            return (currentTx.$transaction as (...args: unknown[]) => Promise<unknown>)(input, ...rest);
          }

          if (Array.isArray(input)) {
            if (postgresDatabaseUrl && getCurrentFacilityScopeId()) {
              throw new Error("Array-form prisma.$transaction is not supported with facility-scoped Postgres access. Use callback form.");
            }
            return (target.$transaction as (...args: unknown[]) => Promise<unknown>)(input, ...rest);
          }

          if (typeof input !== "function") {
            return (target.$transaction as (...args: unknown[]) => Promise<unknown>)(input, ...rest);
          }

          return target.$transaction(
            async (tx) => {
              if (postgresDatabaseUrl && facilityId) {
                await tx.$executeRaw`SELECT set_config('app.current_facility_id', ${facilityId}, true)`;
              }
              return runWithScopedTransaction(tx, () => (input as (tx: Prisma.TransactionClient) => Promise<unknown>)(tx));
            },
            ...(rest as []),
          );
        };
      }

      if (property === "$connect" || property === "$disconnect") {
        return typeof value === "function" ? value.bind(target) : value;
      }

      if (scopedQueryMethods.has(property)) {
        return (...args: unknown[]) =>
          executeScopedOperation((db) =>
            (db[property as keyof PrismaClient] as (...callArgs: unknown[]) => Promise<unknown>)(...args),
          );
      }

      if (value && typeof value === "object") {
        return wrapDelegate(String(property), value);
      }

      if (typeof value === "function") {
        return value.bind(target);
      }

      return value;
    },
  });
}

export const prisma = createScopedPrismaClient(rootPrisma) as PrismaClient;
export const unsafePrisma = rootPrisma;
