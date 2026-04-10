import { Client } from "pg";

type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
};

function required(name: string, value?: string) {
  return Boolean(value && value.trim().length > 0);
}

async function checkPostgres(postgresUrl: string): Promise<CheckResult> {
  const client = new Client({ connectionString: postgresUrl });
  try {
    await client.connect();
    const result = await client.query<{ value: number }>("select 1 as value");
    return {
      name: "postgres_connectivity",
      ok: result.rows[0]?.value === 1,
      detail: "Connected and executed heartbeat query"
    };
  } catch (error) {
    return {
      name: "postgres_connectivity",
      ok: false,
      detail: `Connection failed: ${(error as Error).message}`
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function checkApiHealth(baseUrl: string): Promise<CheckResult> {
  const url = `${baseUrl.replace(/\/$/, "")}/health`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" }
    });

    if (!response.ok) {
      return {
        name: "api_health_endpoint",
        ok: false,
        detail: `Health check failed with status ${response.status}`
      };
    }

    return {
      name: "api_health_endpoint",
      ok: true,
      detail: `Health endpoint reachable at ${url}`
    };
  } catch (error) {
    return {
      name: "api_health_endpoint",
      ok: false,
      detail: `Health endpoint request failed: ${(error as Error).message}`
    };
  }
}

async function main() {
  const checks: CheckResult[] = [];

  const authMode = process.env.AUTH_MODE || "";
  checks.push({
    name: "auth_mode",
    ok: authMode === "jwt",
    detail: authMode === "jwt" ? "AUTH_MODE=jwt" : `AUTH_MODE is '${authMode || "unset"}'`
  });

  checks.push({
    name: "dev_headers_disabled",
    ok: (process.env.AUTH_ALLOW_DEV_HEADERS || "").toLowerCase() === "false",
    detail: `AUTH_ALLOW_DEV_HEADERS=${process.env.AUTH_ALLOW_DEV_HEADERS || "unset"}`
  });

  checks.push({
    name: "implicit_admin_disabled",
    ok: (process.env.AUTH_ALLOW_IMPLICIT_ADMIN || "").toLowerCase() === "false",
    detail: `AUTH_ALLOW_IMPLICIT_ADMIN=${process.env.AUTH_ALLOW_IMPLICIT_ADMIN || "unset"}`
  });

  const requiredVars = ["POSTGRES_DATABASE_URL", "JWT_ISSUER", "JWT_AUDIENCE", "CORS_ORIGINS"];
  for (const key of requiredVars) {
    checks.push({
      name: `env_${key}`,
      ok: required(key, process.env[key]),
      detail: required(key, process.env[key]) ? `${key} is set` : `${key} is missing`
    });
  }

  const corsOrigins = (process.env.CORS_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean);
  checks.push({
    name: "cors_no_wildcard",
    ok: !corsOrigins.includes("*"),
    detail: `CORS_ORIGINS=${corsOrigins.join(",") || "unset"}`
  });

  if (required("POSTGRES_DATABASE_URL", process.env.POSTGRES_DATABASE_URL)) {
    checks.push(await checkPostgres(process.env.POSTGRES_DATABASE_URL!));
  }

  if (required("PILOT_API_BASE_URL", process.env.PILOT_API_BASE_URL)) {
    checks.push(await checkApiHealth(process.env.PILOT_API_BASE_URL!));
  }

  const failed = checks.filter((entry) => !entry.ok);

  for (const check of checks) {
    const icon = check.ok ? "PASS" : "FAIL";
    console.info(`${icon} ${check.name}: ${check.detail}`);
  }

  if (failed.length > 0) {
    console.error(`Pilot preflight failed with ${failed.length} issue(s).`);
    process.exit(1);
  }

  console.info("Pilot preflight passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
