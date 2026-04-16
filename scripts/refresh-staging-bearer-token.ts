import { execFileSync } from "node:child_process";

const defaultApiBaseUrl = "https://flow-staging-api-esgxesfjhnenabg7.centralus-01.azurewebsites.net";
const defaultAudience = "api://89658fe4-9844-439a-97b0-ee31ace455da/access_as_user";

function run(command: string, args: string[]) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

async function main() {
  const apiBaseUrl = (process.env.STAGING_FRONTEND_API_BASE_URL || defaultApiBaseUrl).trim();
  const audience = (process.env.STAGING_BEARER_SCOPE || defaultAudience).trim();
  const secretName = (process.env.STAGING_BEARER_SECRET_NAME || "STAGING_FRONTEND_BEARER_TOKEN").trim();
  const environment = (process.env.STAGING_GITHUB_ENVIRONMENT || "staging").trim();

  console.info(`Refreshing ${secretName} for GitHub environment '${environment}'`);
  console.info(`API base URL: ${apiBaseUrl}`);
  console.info(`Scope: ${audience}`);

  const token = run("az", [
    "account",
    "get-access-token",
    "--scope",
    audience,
    "--query",
    "accessToken",
    "-o",
    "tsv"
  ]);

  if (!token) {
    throw new Error("Azure CLI returned an empty access token");
  }

  const healthResponse = await fetch(`${apiBaseUrl}/auth/context`, {
    headers: {
      authorization: `Bearer ${token}`
    }
  });
  const bodyText = await healthResponse.text();
  if (!healthResponse.ok) {
    throw new Error(`Token verification failed with ${healthResponse.status}: ${bodyText}`);
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }

  console.info(
    `Verified token for ${String(parsed?.name || parsed?.email || parsed?.userId || "unknown user")} against /auth/context`
  );

  execFileSync("gh", ["secret", "set", secretName, "--env", environment], {
    input: token,
    stdio: ["pipe", "inherit", "inherit"]
  });

  console.info(`Updated GitHub Actions secret ${secretName} in environment '${environment}'.`);
  console.info("Note: this bearer token is short-lived and should be refreshed before future staging proof runs.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
