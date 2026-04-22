import { ApiError } from "./errors.js";

export const CURRENT_TEMPLATE_SCHEMA_VERSION = 1;
export const CURRENT_REVENUE_CYCLE_SETTINGS_SCHEMA_VERSION = 1;

export const SUPPORTED_TEMPLATE_SCHEMA_VERSIONS = new Set([
  CURRENT_TEMPLATE_SCHEMA_VERSION,
]);
export const SUPPORTED_REVENUE_CYCLE_SETTINGS_SCHEMA_VERSIONS = new Set([
  CURRENT_REVENUE_CYCLE_SETTINGS_SCHEMA_VERSION,
]);

function describeEntity(entity: string) {
  switch (entity) {
    case "Template":
      return { label: "Template", code: "TEMPLATE_SCHEMA_VERSION_UNSUPPORTED" };
    case "RevenueCycleSettings":
      return {
        label: "Revenue cycle settings",
        code: "REVENUE_CYCLE_SETTINGS_SCHEMA_VERSION_UNSUPPORTED",
      };
    default:
      return { label: entity, code: "SCHEMA_VERSION_UNSUPPORTED" };
  }
}

export function assertSupportedSchemaVersionOnWrite(
  entity: "Template" | "RevenueCycleSettings",
  version: number | null | undefined,
): number {
  const desired = version ?? currentVersionFor(entity);
  if (!supportedSetFor(entity).has(desired)) {
    const { label, code } = describeEntity(entity);
    throw new ApiError({
      statusCode: 400,
      code,
      message: `${label} schemaVersion ${desired} is not supported by this server (expected one of: ${Array.from(
        supportedSetFor(entity),
      ).join(", ")})`,
    });
  }
  return desired;
}

export function assertSupportedSchemaVersionOnRead(
  entity: "Template" | "RevenueCycleSettings",
  version: number | null | undefined,
  log?: { warn: (obj: Record<string, unknown>, msg?: string) => void },
) {
  if (version == null) return;
  if (!supportedSetFor(entity).has(version)) {
    if (log) {
      log.warn(
        {
          entity,
          actualVersion: version,
          supportedVersions: Array.from(supportedSetFor(entity)),
        },
        "Stored JSON schemaVersion is unsupported",
      );
    }
  }
}

function currentVersionFor(entity: "Template" | "RevenueCycleSettings"): number {
  return entity === "Template"
    ? CURRENT_TEMPLATE_SCHEMA_VERSION
    : CURRENT_REVENUE_CYCLE_SETTINGS_SCHEMA_VERSION;
}

function supportedSetFor(entity: "Template" | "RevenueCycleSettings"): Set<number> {
  return entity === "Template"
    ? SUPPORTED_TEMPLATE_SCHEMA_VERSIONS
    : SUPPORTED_REVENUE_CYCLE_SETTINGS_SCHEMA_VERSIONS;
}
