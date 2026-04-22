type CounterKey = string;

const counters = new Map<CounterKey, Map<string, number>>();

const REGISTERED_COUNTERS: Array<{
  name: string;
  help: string;
  labelNames: readonly string[];
}> = [
  {
    name: "flow_validation_failures_total",
    help: "Count of request validation failures by route and error code",
    labelNames: ["route", "code"],
  },
  {
    name: "flow_schema_drift_total",
    help: "Count of persisted JSON schema-drift detections by entity and field",
    labelNames: ["entity", "field"],
  },
  {
    name: "flow_cross_tenant_denied_total",
    help: "Count of cross-tenant access denials by route and caller facility",
    labelNames: ["route", "facility"],
  },
  {
    name: "flow_idempotency_replay_total",
    help: "Count of idempotency key replays (same user/key hit again) by route",
    labelNames: ["route"],
  },
  {
    name: "flow_proof_header_reject_total",
    help: "Count of rejected proof-header auth attempts by reason",
    labelNames: ["reason"],
  },
  {
    name: "flow_auth_failure_total",
    help: "Count of authentication failures by source and reason",
    labelNames: ["source", "reason"],
  },
];

for (const counter of REGISTERED_COUNTERS) {
  counters.set(counter.name, new Map());
}

function serializeLabels(labels: Record<string, string>, labelNames: readonly string[]): string {
  const ordered = labelNames.map((name) => `${name}=${sanitizeLabelValue(labels[name] ?? "")}`);
  return ordered.join(",");
}

function sanitizeLabelValue(value: string): string {
  const trimmed = value.length > 64 ? `${value.slice(0, 61)}...` : value;
  return trimmed
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function counterDef(name: string) {
  const def = REGISTERED_COUNTERS.find((entry) => entry.name === name);
  if (!def) {
    throw new Error(`Unknown counter: ${name}`);
  }
  return def;
}

export function incrementCounter(name: string, labels: Record<string, string> = {}, by = 1): void {
  const def = counterDef(name);
  const bucket = counters.get(name);
  if (!bucket) return;
  const key = serializeLabels(labels, def.labelNames);
  bucket.set(key, (bucket.get(key) ?? 0) + by);
}

export function recordValidationFailure(route: string, code: string) {
  incrementCounter("flow_validation_failures_total", { route, code });
}

export function recordSchemaDrift(entity: string, field: string) {
  incrementCounter("flow_schema_drift_total", { entity, field });
}

export function recordCrossTenantDenied(route: string, facility: string) {
  incrementCounter("flow_cross_tenant_denied_total", { route, facility: facility || "unknown" });
}

export function recordIdempotencyReplay(route: string) {
  incrementCounter("flow_idempotency_replay_total", { route });
}

export function recordProofHeaderReject(reason: string) {
  incrementCounter("flow_proof_header_reject_total", { reason });
}

export function recordAuthFailure(source: string, reason: string) {
  incrementCounter("flow_auth_failure_total", { source, reason });
}

export function renderMetrics(): string {
  const lines: string[] = [];
  for (const def of REGISTERED_COUNTERS) {
    lines.push(`# HELP ${def.name} ${def.help}`);
    lines.push(`# TYPE ${def.name} counter`);
    const bucket = counters.get(def.name);
    if (!bucket || bucket.size === 0) {
      lines.push(`${def.name} 0`);
      continue;
    }
    for (const [labelKey, value] of bucket.entries()) {
      if (!labelKey) {
        lines.push(`${def.name} ${value}`);
        continue;
      }
      const labelPairs = labelKey
        .split(",")
        .map((entry) => {
          const eqIndex = entry.indexOf("=");
          if (eqIndex === -1) return entry;
          const k = entry.slice(0, eqIndex);
          const v = entry.slice(eqIndex + 1);
          return `${k}="${v}"`;
        })
        .join(",");
      lines.push(`${def.name}{${labelPairs}} ${value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function resetMetricsForTest(): void {
  for (const def of REGISTERED_COUNTERS) {
    counters.set(def.name, new Map());
  }
}

export function listCounterNames(): string[] {
  return REGISTERED_COUNTERS.map((entry) => entry.name);
}
