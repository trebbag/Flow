# Security

Flow is intended for healthcare workflow operations, so repository hygiene and deployment hardening matter.

## Reporting

If you discover a security issue, do not open a public issue with sensitive details. Report it privately to the maintainers through your normal coordination channel.

## Repository Rules

- Do not commit `.env` files, bearer tokens, generated verification payloads, or local database files.
- Use `.env.example` and `docs/Flow Frontend/.env.example` as the only checked-in environment templates.
- Prefer Azure-managed identity or other Azure-native credentials over long-lived secrets in app configuration.
- Keep Microsoft Entra as the staged production auth source of truth.

## Staging and Pilot Expectations

- Staging and pilot environments should run in Entra-backed JWT mode.
- Developer bypass auth modes are for local development only.
- Follow the setup and hardening guidance in `docs/ENTRA_LOGIN_SETUP.md`, `docs/AZURE_STAGING_SETUP.md`, and `docs/PILOT_DATA_GOVERNANCE.md`.

## Follow-Up Actions

If the repository has ever contained local secrets or verification tokens, rotate them and record the follow-up in `docs/NEEDS_FROM_YOU.md`.
