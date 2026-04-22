import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TRANSIENT_FAILURE_PATTERNS = [
  /502\s+Bad Gateway/i,
  /503\s+Service Unavailable/i,
  /504\s+Gateway Timeout/i,
  /Application Error/i,
  /fetch failed/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /socket hang up/i
];

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientVerificationFailure(output: string) {
  return TRANSIENT_FAILURE_PATTERNS.some((pattern) => pattern.test(output));
}

async function main() {
  const frontendRepoPath = process.env.FRONTEND_REPO_PATH || "docs/Flow Frontend";
  const apiBaseUrl = process.env.FRONTEND_API_BASE_URL || "http://localhost:4000";
  const hasDevAuth = Boolean(process.env.VITE_DEV_USER_ID || process.env.FRONTEND_DEV_USER_ID);
  const hasBearerAuth = Boolean(process.env.VITE_BEARER_TOKEN || process.env.FRONTEND_BEARER_TOKEN);
  const hasProofAuth = Boolean(
    (process.env.VITE_PROOF_USER_ID || process.env.FRONTEND_PROOF_USER_ID) &&
      (process.env.VITE_PROOF_SECRET || process.env.FRONTEND_PROOF_SECRET),
  );

  if (!frontendRepoPath) {
    throw new Error("FRONTEND_REPO_PATH is required to run frontend live wiring verification.");
  }

  if (!hasDevAuth && !hasBearerAuth && !hasProofAuth) {
    console.info(
      "No frontend auth env detected (set proof, dev-header, or bearer auth env vars). Authenticated checks may be skipped.",
    );
  }

  const resolvedPath = path.resolve(process.cwd(), frontendRepoPath);
  const packageJsonPath = path.join(resolvedPath, "package.json");

  const rawPackage = await fs.readFile(packageJsonPath, "utf8");
  const packageJson = JSON.parse(rawPackage) as { scripts?: Record<string, string> };

  const scripts = packageJson.scripts || {};

  const run = async (command: string) => {
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      console.info(
        attempt === 1 ? `Running: ${command}` : `Retrying after transient failure: ${command} (${attempt}/${maxAttempts})`
      );

      const result = spawnSync(command, {
        cwd: resolvedPath,
        shell: true,
        encoding: "utf8",
        env: {
          ...process.env,
          VITE_API_BASE_URL: apiBaseUrl,
          NEXT_PUBLIC_API_BASE_URL: apiBaseUrl,
          REACT_APP_API_BASE_URL: apiBaseUrl
        }
      });

      if (result.stdout) {
        process.stdout.write(result.stdout);
      }
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }

      if (result.status === 0) {
        return;
      }

      const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;
      const canRetry = attempt < maxAttempts && isTransientVerificationFailure(combinedOutput);
      if (!canRetry) {
        const error = new Error(`Command failed: ${command}`);
        (error as Error & { status?: number | null }).status = result.status;
        throw error;
      }

      await delay(attempt * 2_000);
    }
  };

  if (scripts["test:contract"]) {
    await run("pnpm run test:contract");
  } else {
    console.info("Skipping contract test: package script 'test:contract' not found.");
  }

  if (scripts["test:visual"]) {
    await run("pnpm run test:visual");
  } else {
    console.info("Skipping visual test: package script 'test:visual' not found.");
  }

  if (scripts["test:e2e-live"]) {
    await run("pnpm run test:e2e-live");
  } else {
    console.info("Skipping live e2e: package script 'test:e2e-live' not found.");
  }

  if (scripts["test:e2e-browser"]) {
    await run("pnpm run test:e2e-browser");
  } else {
    console.info("Skipping browser e2e: package script 'test:e2e-browser' not found.");
  }

  if (scripts["test:bundle-budget"]) {
    await run("pnpm run test:bundle-budget");
  } else {
    console.info("Skipping bundle budget test: package script 'test:bundle-budget' not found.");
  }

  console.info("Frontend live wiring verification hook completed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
