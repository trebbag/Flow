# Service Level Objectives

## Target SLOs (pilot)
| Surface | SLI | SLO | Error budget | Measurement window |
|---|---|---|---|---|
| API availability | % of `/health` probes returning 200 | 99.5% | 3h 36m / month | Rolling 30 days |
| API readiness | % of `/ready` probes returning 200 | 99.0% | 7h 12m / month | Rolling 30 days |
| API latency (p95) | route-level p95 under 1.0s | 99% of routes | — | Daily rollup |
| API latency (p99) | route-level p99 under 3.0s | 95% of routes | — | Daily rollup |
| Ingestion freshness | time from CSV POST to batch `finalized` | < 5 min for 95% of batches under 5000 rows | — | Daily rollup |
| Auth failure rate | `flow_auth_failure_total` / request count | < 0.5% | — | Rolling 24 h |
| Schema drift | `flow_schema_drift_total` | 0 per hour | 1 per hour alert | Rolling 1 h |
| Cross-tenant denies | `flow_cross_tenant_denied_total` | < 10 per hour | alert beyond | Rolling 1 h |
| Idempotency replay rate | `flow_idempotency_replay_total` / POST count | < 1% | — | Rolling 24 h |
| Data integrity | % of `PatientIdentityReview` open > 48h | 0% | any > 0 alerts | Daily rollup |
| Frontend crash rate | client error reports / session | < 0.5% | — | Rolling 7 days |

Pilot SLOs are conservative relative to commercial EHRs to allow iteration. Tighten
to 99.9% availability and 99% readiness at GA.

## Error budget policy
- If any SLO is breached, freeze non-critical releases for the remainder of the month.
- Two consecutive breaches → explicit stability sprint (no new features for 1 week, only reliability work).
- SEV-1 incidents count against the full month's error budget regardless of cause.

## Data sources
- Availability/readiness: Azure Monitor availability tests hitting `/health`, `/ready`.
- Latency: Azure App Service metrics + pino `responseTime` serializer.
- Counters: `/metrics` endpoint scraped by Prometheus (or Azure Monitor metrics workspace).
- Ingestion freshness: `IncomingImportBatch.status` transitions.
- Data integrity: `PatientIdentityReview` query.

## Review cadence
- Weekly: SLO burn-down in ops review (IC rotation reports).
- Monthly: error-budget policy decisions (freeze / release).
- Quarterly: SLO retargeting if workloads or clinical scope expand.
