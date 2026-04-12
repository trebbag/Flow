# Staging Threshold Trigger Evidence (All Roles)

- Started: 2026-04-12T16:22:48.743Z
- Finished: 2026-04-12T16:23:58.195Z
- API Base URL: https://flow-staging-api-esgxesfjhnenabg7.centralus-01.azurewebsites.net
- Auth Mode: bearer
- Encounter ID: 4e5fa021-7198-4d13-a29f-21dfff174025
- Clinic ID: c372ccd2-efac-47ce-a75f-af843ad63d16
- Threshold Row ID: 8d50ee79-ba54-4326-bd7d-ae0d2440b429

## Threshold Trigger

- Trigger reached: yes
- Level reached: Yellow
- Poll attempts: 13
- Elapsed ms: 64219

## Role Alert Evidence

| Role | Result | Detail | Alert ID |
|---|---|---|---|
| FrontDeskCheckIn | FAIL | Missing STAGING_ROLE_TOKEN_FRONTDESKCHECKIN for role proof | - |
| MA | FAIL | Missing STAGING_ROLE_TOKEN_MA for role proof | - |
| Clinician | FAIL | Missing STAGING_ROLE_TOKEN_CLINICIAN for role proof | - |
| FrontDeskCheckOut | FAIL | Missing STAGING_ROLE_TOKEN_FRONTDESKCHECKOUT for role proof | - |
| RevenueCycle | FAIL | Missing STAGING_ROLE_TOKEN_REVENUECYCLE for role proof | - |
| Admin | PASS | Threshold alert present | 4a2d8bad-a1e5-43dc-bb7b-f231c61a5b72 |
