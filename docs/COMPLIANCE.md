# Compliance Posture

Flow handles Protected Health Information (PHI) for ambulatory clinical
operations. This document is the canonical statement of the technical,
contractual, and operational controls that let us run a pilot without a HIPAA
enforcement risk. It must be kept current — if a control listed here becomes
untrue, either restore the control or update this document and re-run the
[PILOT_SECURITY_GATE.md](PILOT_SECURITY_GATE.md) approval loop.

## Business Associate Agreements (BAA)

| Counterparty | Role | BAA status | Owner | Notes |
|---|---|---|---|---|
| Microsoft Azure (App Service, PostgreSQL Flexible Server, Key Vault, Blob, AD/Entra) | Cloud & IdP | **Required** — signed via Azure Online Services BAA; verify enrollment in the Microsoft Service Trust Portal | CTO | Covers the full Azure region where the service runs. Do not spin up resources in a region not enumerated in the BAA. |
| GitHub | Source control & CI | Not a BAA vendor — PHI must never touch git, CI runners, logs, or artefacts. | CTO | Enforced by (a) `.gitignore` for secrets and bearer-proof evidence, (b) pino PHI-redacting serializer, (c) SBOM-only artefacts in CI. |
| Sentry / logging SaaS | Error tracking | **Not yet wired.** If enabled, a signed BAA is required before PHI-capable environments. | CTO | Default stance: no third-party log shipping until BAA. |
| Email/SMS providers | Patient notifications | Only used for non-PHI transactional events in pilot. Any PHI in notifications requires a BAA with the provider (e.g. Twilio, SendGrid) before the channel is activated. | Product | Tracked in [NEEDS_FROM_YOU.md](NEEDS_FROM_YOU.md). |

BAA owner actions:

1. Download the countersigned Microsoft BAA from the Service Trust Portal and
   store it in the compliance drive (link in `NEEDS_FROM_YOU.md`).
2. Re-verify annually, or whenever a new Azure service is added to the
   architecture.
3. Any new vendor that could receive PHI must clear a BAA check in the
   procurement workflow before the integration lands in `main`.

## Encryption at Rest

| Layer | Control | Verification |
|---|---|---|
| Disk (Azure PostgreSQL Flexible Server) | AES-256 encryption-at-rest managed by the service tier | `az postgres flexible-server show` → `storage.storageEncryption` is `ServiceManaged` or `CustomerManaged` |
| Column (PHI) | AES-256-GCM envelope encryption on `Patient.displayName` and `Patient.dateOfBirth` (see [PHI_PROTECTION.md](PHI_PROTECTION.md)) | `SELECT count(*) FROM "Patient" WHERE "displayName" IS NOT NULL AND "displayNameCipher" IS NULL` returns 0 after backfill |
| Key | `PHI_ENCRYPTION_KEY` stored in Azure Key Vault, referenced by App Service via Key Vault reference | App Service → Configuration → the key must show `@Microsoft.KeyVault(...)` reference, not a literal value |
| Backups | Azure PostgreSQL Flexible Server backups inherit encryption-at-rest | Confirmed in the PostgreSQL blade → Backup / Restore → "Encryption enabled" |
| Blob / Object storage | Any blob container used for exports must be created with `--require-infrastructure-encryption` | `az storage account show --query 'encryption'` |

**Do not** store PHI in:
- Application logs (the pino redactor blocks known PHI keys; if new PHI
  fields are added, update `src/lib/logger-config.ts` first).
- GitHub Issues, PRs, or Slack (use an internal ticket with a patient ID
  pointer instead).
- `localStorage` / `sessionStorage` in the browser (see
  [PHI_PROTECTION.md](PHI_PROTECTION.md#frontend-considerations)).

## TLS Enforcement

| Hop | Requirement | Current state |
|---|---|---|
| Client → App Service (public) | TLS 1.2+, HSTS, no HTTP fallback | Enforced by Azure App Service "HTTPS Only" = On and "Minimum TLS" = 1.2. Verify: `az webapp config show` shows `httpsOnly=true, minTlsVersion=1.2`. |
| App Service → PostgreSQL | TLS required, server-verified | `DATABASE_URL` MUST include `sslmode=require`. Startup invariant (`src/lib/startup-invariants.ts`) checks the URL in production. |
| App Service → Key Vault | TLS 1.2 via managed identity | Automatic; no opt-out path. |
| Inter-container / inter-slot | N/A (single App Service, slot swap) | n/a |
| Browser ↔ static webapp ↔ backend | Static webapp is HTTPS-only by default; backend CORS only allows `https://` origins (no `http://` except `localhost`); enforced by the production startup invariant. | Enforced in `src/lib/startup-invariants.ts`. |

HSTS: set at App Service front-door with a minimum of 31536000 seconds and
`includeSubDomains`. Re-verify after any App Service configuration change.

## Access Controls

| Control | Source of truth | Review cadence |
|---|---|---|
| Identity / SSO | Microsoft Entra ID (JWT validated via JWKS; dev headers disabled in production via startup invariant) | Quarterly |
| MFA enforcement | Entra Conditional Access policy — required for every user in the Flow app registration | Monthly during pilot |
| Role assignments | `UserRole` table; report via `pnpm recert:report` | Weekly during pilot, monthly post-pilot |
| Break-glass / admin fallback | `AUTH_ALLOW_IMPLICIT_ADMIN=false` in production (startup invariant) | Verified on every deploy |
| Proof-header pilot gate | HMAC-signed request + per-IP rate limit (see `src/lib/proof-header-guard.ts`) | Revisit before any non-pilot use |

## Audit Posture

- Every mutation route writes an `AuditLog` row (request metadata only,
  no PHI bodies).
- Every state-machine transition writes an append-only event
  (`StatusChangeEvent`, `EntityEvent`) — who, when, before/after.
- 90-day hot retention → cold archive (`pnpm retention:enforce`; see
  [PILOT_DATA_GOVERNANCE.md](PILOT_DATA_GOVERNANCE.md#automation)).
- Cross-tenant denials, schema drift, validation failures, idempotency
  replays, and proof-header rejects are counted in the `/metrics`
  Prometheus endpoint.

## Data Residency

- All pilot data resides in a single Azure region named in the BAA.
- PostgreSQL backups do not leave that region.
- SBOMs and telemetry are de-identified and may reside in any GitHub
  region; nothing PHI-containing is sent to third parties.

## Incident Response

See [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md) for the severity taxonomy,
roles, and playbooks. A suspected PHI disclosure is SEV-1 — 24/7 paging, IC
engaged, compliance officer notified within 1 hour.

## Yearly Checklist

Run this checklist every January and whenever a major architectural change
lands:

1. Re-download the Microsoft BAA from the Service Trust Portal.
2. Confirm `az webapp config show` → `httpsOnly=true, minTlsVersion=1.2`.
3. Confirm `DATABASE_URL` has `sslmode=require`.
4. Confirm `PHI_ENCRYPTION_KEY` Key Vault reference resolves (App Service
   → Configuration → the setting shows a green check).
5. Run `pnpm recert:report` for every facility and attest that every row
   resolves to an active user + role.
6. Verify disk-level encryption on Azure PostgreSQL Flexible Server.
7. Run the DR drill ([DISASTER_RECOVERY.md](DISASTER_RECOVERY.md#quarterly-drill)).
8. Review and, if needed, rotate every secret in
   [SECRET_ROTATION.md](SECRET_ROTATION.md).
