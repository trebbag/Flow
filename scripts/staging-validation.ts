import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

type StepResult = {
  name: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
};

function nowStamp() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function clip(text: string, limit = 12000) {
  const value = text || "";
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n... [truncated ${value.length - limit} chars] ...`;
}

function runStep(
  name: string,
  command: string,
  args: string[],
  envPatch: Record<string, string | undefined>,
  cwd: string
): StepResult {
  const started = Date.now();
  const run = spawnSync(command, args, {
    cwd,
    env: {
      ...process.env,
      ...envPatch
    },
    encoding: "utf8"
  });

  return {
    name,
    command: `${command} ${args.join(" ")}`,
    ok: run.status === 0,
    exitCode: run.status,
    durationMs: Date.now() - started,
    stdout: run.stdout || "",
    stderr: run.stderr || ""
  };
}

async function writeReport(params: {
  reportPath: string;
  startedAt: Date;
  finishedAt: Date;
  stagingApiBaseUrl: string;
  authMode: string;
  missing: string[];
  steps: StepResult[];
}) {
  const lines: string[] = [];
  lines.push(`# Staging Validation Evidence`);
  lines.push("");
  lines.push(`- Started: ${params.startedAt.toISOString()}`);
  lines.push(`- Finished: ${params.finishedAt.toISOString()}`);
  lines.push(`- API Base URL: ${params.stagingApiBaseUrl || "(missing)"}`);
  lines.push(`- Auth Mode: ${params.authMode}`);
  lines.push("");

  if (params.missing.length > 0) {
    lines.push("## Missing Inputs");
    lines.push("");
    params.missing.forEach((entry) => lines.push(`- ${entry}`));
    lines.push("");
  }

  lines.push("## Step Results");
  lines.push("");
  if (params.steps.length === 0) {
    lines.push("- No commands executed.");
  }

  params.steps.forEach((step) => {
    lines.push(`### ${step.name}`);
    lines.push("");
    lines.push(`- Command: \`${step.command}\``);
    lines.push(`- Result: ${step.ok ? "PASS" : "FAIL"}`);
    lines.push(`- Exit code: ${step.exitCode ?? "null"}`);
    lines.push(`- Duration: ${step.durationMs}ms`);
    lines.push("");
    if (step.stdout.trim()) {
      lines.push("#### Stdout");
      lines.push("");
      lines.push("```text");
      lines.push(clip(step.stdout));
      lines.push("```");
      lines.push("");
    }
    if (step.stderr.trim()) {
      lines.push("#### Stderr");
      lines.push("");
      lines.push("```text");
      lines.push(clip(step.stderr));
      lines.push("```");
      lines.push("");
    }
  });

  const reportDir = path.dirname(params.reportPath);
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(params.reportPath, `${lines.join("\n")}\n`, "utf8");
}

async function main() {
  const startedAt = new Date();
  const repoRoot = process.cwd();

  const stagingApiBaseUrl =
    (process.env.STAGING_FRONTEND_API_BASE_URL || process.env.PILOT_API_BASE_URL || "").trim();
  const stagingBearerToken = (process.env.STAGING_FRONTEND_BEARER_TOKEN || "").trim();
  const stagingDevUserId = (process.env.STAGING_VITE_DEV_USER_ID || "").trim();
  const stagingDevRole = (process.env.STAGING_VITE_DEV_ROLE || "Admin").trim() || "Admin";
  const stagingProofUserId =
    (process.env.STAGING_PROOF_USER_ID || process.env.STAGING_FRONTEND_PROOF_USER_ID || "").trim();
  const stagingProofRole =
    (process.env.STAGING_PROOF_ROLE || process.env.STAGING_FRONTEND_PROOF_ROLE || "Admin").trim() || "Admin";
  const stagingProofSecret =
    (process.env.STAGING_PROOF_SECRET || process.env.STAGING_FRONTEND_PROOF_SECRET || "").trim();
  const stagingProofHmacSecret =
    (process.env.STAGING_PROOF_HMAC_SECRET || process.env.STAGING_FRONTEND_PROOF_HMAC_SECRET || "").trim();
  const frontendRepoPath = (process.env.FRONTEND_REPO_PATH || "docs/Flow Frontend").trim() || "docs/Flow Frontend";

  const missing: string[] = [];
  if (!stagingApiBaseUrl) {
    missing.push("Set STAGING_FRONTEND_API_BASE_URL (or PILOT_API_BASE_URL) before running staging validation.");
  }
  if (!stagingBearerToken && !stagingDevUserId && !(stagingProofUserId && stagingProofSecret)) {
    missing.push(
      "Provide durable proof auth (STAGING_PROOF_USER_ID + STAGING_PROOF_SECRET), STAGING_FRONTEND_BEARER_TOKEN, or STAGING_VITE_DEV_USER_ID for authenticated frontend checks.",
    );
  }
  if (stagingProofUserId && stagingProofSecret && !stagingProofHmacSecret) {
    missing.push(
      "Proof-header auth is configured, but STAGING_PROOF_HMAC_SECRET (or STAGING_FRONTEND_PROOF_HMAC_SECRET) is missing.",
    );
  }

  const authMode = stagingProofUserId && stagingProofSecret
    ? "proof-header"
    : stagingBearerToken
      ? "bearer"
      : stagingDevUserId
        ? "dev-header"
        : "none";
  const steps: StepResult[] = [];

  if (missing.length === 0) {
    steps.push(
      runStep(
        "Pilot Preflight",
        process.platform === "win32" ? "pnpm.cmd" : "pnpm",
        ["pilot:preflight"],
        {
          PILOT_API_BASE_URL: stagingApiBaseUrl
        },
        repoRoot
      )
    );

    steps.push(
      runStep(
        "Frontend Live Verification",
        process.platform === "win32" ? "pnpm.cmd" : "pnpm",
        ["frontend:verify-live"],
        {
          FRONTEND_REPO_PATH: frontendRepoPath,
          FRONTEND_API_BASE_URL: stagingApiBaseUrl,
          VITE_API_BASE_URL: stagingApiBaseUrl,
          FRONTEND_PROOF_USER_ID: stagingProofUserId || undefined,
          VITE_PROOF_USER_ID: stagingProofUserId || undefined,
          FRONTEND_PROOF_ROLE: stagingProofRole,
          VITE_PROOF_ROLE: stagingProofRole,
          FRONTEND_PROOF_SECRET: stagingProofSecret || undefined,
          VITE_PROOF_SECRET: stagingProofSecret || undefined,
          FRONTEND_PROOF_HMAC_SECRET: stagingProofHmacSecret || undefined,
          VITE_PROOF_HMAC_SECRET: stagingProofHmacSecret || undefined,
          FRONTEND_BEARER_TOKEN: stagingBearerToken || undefined,
          VITE_BEARER_TOKEN: stagingBearerToken || undefined,
          FRONTEND_DEV_USER_ID: stagingDevUserId || undefined,
          VITE_DEV_USER_ID: stagingDevUserId || undefined,
          FRONTEND_DEV_ROLE: stagingDevRole,
          VITE_DEV_ROLE: stagingDevRole
        },
        repoRoot
      )
    );

    steps.push(
      runStep(
        "Role-by-Role Facility Switch Proof",
        process.platform === "win32" ? "pnpm.cmd" : "pnpm",
        ["staging:proof:facility-switch"],
        {
          STAGING_FRONTEND_API_BASE_URL: stagingApiBaseUrl,
          PILOT_API_BASE_URL: stagingApiBaseUrl,
          STAGING_PROOF_USER_ID: stagingProofUserId || undefined,
          STAGING_FRONTEND_PROOF_USER_ID: stagingProofUserId || undefined,
          STAGING_PROOF_ROLE: stagingProofRole,
          STAGING_FRONTEND_PROOF_ROLE: stagingProofRole,
          STAGING_PROOF_SECRET: stagingProofSecret || undefined,
          STAGING_FRONTEND_PROOF_SECRET: stagingProofSecret || undefined,
          STAGING_PROOF_HMAC_SECRET: stagingProofHmacSecret || undefined,
          STAGING_FRONTEND_PROOF_HMAC_SECRET: stagingProofHmacSecret || undefined,
          STAGING_FRONTEND_BEARER_TOKEN: stagingBearerToken || undefined,
          STAGING_VITE_DEV_USER_ID: stagingDevUserId || undefined,
          STAGING_VITE_DEV_ROLE: stagingDevRole
        },
        repoRoot
      )
    );

    steps.push(
      runStep(
        "Threshold Trigger Evidence Across Roles",
        process.platform === "win32" ? "pnpm.cmd" : "pnpm",
        ["staging:proof:threshold-alerts"],
        {
          STAGING_FRONTEND_API_BASE_URL: stagingApiBaseUrl,
          PILOT_API_BASE_URL: stagingApiBaseUrl,
          STAGING_PROOF_USER_ID: stagingProofUserId || undefined,
          STAGING_FRONTEND_PROOF_USER_ID: stagingProofUserId || undefined,
          STAGING_PROOF_ROLE: stagingProofRole,
          STAGING_FRONTEND_PROOF_ROLE: stagingProofRole,
          STAGING_PROOF_SECRET: stagingProofSecret || undefined,
          STAGING_FRONTEND_PROOF_SECRET: stagingProofSecret || undefined,
          STAGING_PROOF_HMAC_SECRET: stagingProofHmacSecret || undefined,
          STAGING_FRONTEND_PROOF_HMAC_SECRET: stagingProofHmacSecret || undefined,
          STAGING_FRONTEND_BEARER_TOKEN: stagingBearerToken || undefined,
          STAGING_VITE_DEV_USER_ID: stagingDevUserId || undefined,
          STAGING_VITE_DEV_ROLE: stagingDevRole
        },
        repoRoot
      )
    );
  }

  const finishedAt = new Date();
  const reportPath = path.resolve(repoRoot, "docs", "verification", `staging-validation-${nowStamp()}.md`);
  await writeReport({
    reportPath,
    startedAt,
    finishedAt,
    stagingApiBaseUrl,
    authMode,
    missing,
    steps
  });

  console.info(`Staging validation evidence written: ${reportPath}`);

  const failedSteps = steps.filter((step) => !step.ok);
  if (missing.length > 0 || failedSteps.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
