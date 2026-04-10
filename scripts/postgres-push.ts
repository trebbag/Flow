import { spawn } from "node:child_process";

const postgresUrl = (process.env.POSTGRES_DATABASE_URL || "").trim();

if (!postgresUrl) {
  console.error("POSTGRES_DATABASE_URL is required");
  process.exit(1);
}

const child = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["prisma", "db", "push", "--schema", "prisma/schema.postgres.prisma"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: postgresUrl,
    },
  },
);

child.on("exit", (code) => {
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
