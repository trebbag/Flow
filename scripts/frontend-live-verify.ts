import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";

async function main() {
  const frontendRepoPath = process.env.FRONTEND_REPO_PATH || "docs/Flow Frontend";
  const apiBaseUrl = process.env.FRONTEND_API_BASE_URL || "http://localhost:4000";
  const hasDevAuth = Boolean(process.env.VITE_DEV_USER_ID || process.env.FRONTEND_DEV_USER_ID);
  const hasBearerAuth = Boolean(process.env.VITE_BEARER_TOKEN || process.env.FRONTEND_BEARER_TOKEN);

  if (!frontendRepoPath) {
    throw new Error("FRONTEND_REPO_PATH is required to run frontend live wiring verification.");
  }

  if (!hasDevAuth && !hasBearerAuth) {
    console.info(
      "No frontend auth env detected (set VITE_DEV_USER_ID/FRONTEND_DEV_USER_ID or VITE_BEARER_TOKEN/FRONTEND_BEARER_TOKEN). Authenticated checks may be skipped.",
    );
  }

  const resolvedPath = path.resolve(process.cwd(), frontendRepoPath);
  const packageJsonPath = path.join(resolvedPath, "package.json");

  const rawPackage = await fs.readFile(packageJsonPath, "utf8");
  const packageJson = JSON.parse(rawPackage) as { scripts?: Record<string, string> };

  const scripts = packageJson.scripts || {};

  const run = (command: string) => {
    console.info(`Running: ${command}`);
    execSync(command, {
      cwd: resolvedPath,
      stdio: "inherit",
      env: {
        ...process.env,
        VITE_API_BASE_URL: apiBaseUrl,
        NEXT_PUBLIC_API_BASE_URL: apiBaseUrl,
        REACT_APP_API_BASE_URL: apiBaseUrl
      }
    });
  };

  if (scripts["test:contract"]) {
    run("pnpm run test:contract");
  } else {
    console.info("Skipping contract test: package script 'test:contract' not found.");
  }

  if (scripts["test:visual"]) {
    run("pnpm run test:visual");
  } else {
    console.info("Skipping visual test: package script 'test:visual' not found.");
  }

  if (scripts["test:e2e-live"]) {
    run("pnpm run test:e2e-live");
  } else {
    console.info("Skipping live e2e: package script 'test:e2e-live' not found.");
  }

  if (scripts["test:e2e-browser"]) {
    run("pnpm run test:e2e-browser");
  } else {
    console.info("Skipping browser e2e: package script 'test:e2e-browser' not found.");
  }

  if (scripts["test:bundle-budget"]) {
    run("pnpm run test:bundle-budget");
  } else {
    console.info("Skipping bundle budget test: package script 'test:bundle-budget' not found.");
  }

  console.info("Frontend live wiring verification hook completed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
