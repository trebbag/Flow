import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

try {
  const prismaClientPkg = require.resolve("@prisma/client/package.json", { paths: [process.cwd()] });
  const prismaClientDir = path.dirname(fs.realpathSync(prismaClientPkg));
  const generatedPrismaDir = path.resolve(prismaClientDir, "..", "..", ".prisma");
  const projectPrismaLink = path.resolve(process.cwd(), "node_modules", ".prisma");

  if (!fs.existsSync(generatedPrismaDir)) {
    console.warn(`[link-prisma-client] Skipped: generated path not found at ${generatedPrismaDir}`);
    process.exit(0);
  }

  fs.mkdirSync(path.dirname(projectPrismaLink), { recursive: true });
  fs.rmSync(projectPrismaLink, { recursive: true, force: true });
  fs.symlinkSync(generatedPrismaDir, projectPrismaLink, "dir");
  console.info(`[link-prisma-client] Linked ${projectPrismaLink} -> ${generatedPrismaDir}`);
} catch (error) {
  console.warn(
    `[link-prisma-client] Unable to create node_modules/.prisma symlink: ${(error && error.message) || String(error)}`
  );
}
