# Staging Threshold Trigger Evidence (All Roles)

- Started: 2026-04-12T16:20:28.043Z
- Finished: 2026-04-12T16:21:36.212Z
- API Base URL: https://flow-staging-api-esgxesfjhnenabg7.centralus-01.azurewebsites.net
- Auth Mode: bearer
- Encounter ID: c8b29f73-a8f3-44a9-897b-c1435ab8237d
- Clinic ID: c372ccd2-efac-47ce-a75f-af843ad63d16
- Threshold Row ID: 8d50ee79-ba54-4326-bd7d-ae0d2440b429

## Threshold Trigger

- Trigger reached: yes
- Level reached: Yellow
- Poll attempts: 12
- Elapsed ms: 61953

## Role Alert Evidence

| Role | Result | Detail | Alert ID |
|---|---|---|---|
| FrontDeskCheckIn | FAIL | Missing STAGING_ROLE_TOKEN_FRONTDESKCHECKIN for role proof | - |
| MA | FAIL | Missing STAGING_ROLE_TOKEN_MA for role proof | - |
| Clinician | FAIL | Missing STAGING_ROLE_TOKEN_CLINICIAN for role proof | - |
| FrontDeskCheckOut | FAIL | Missing STAGING_ROLE_TOKEN_FRONTDESKCHECKOUT for role proof | - |
| RevenueCycle | FAIL | Missing STAGING_ROLE_TOKEN_REVENUECYCLE for role proof | - |
| Admin | FAIL | No threshold alert found in active inbox | - |
