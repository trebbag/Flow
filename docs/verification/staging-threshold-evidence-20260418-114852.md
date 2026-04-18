# Staging Threshold Trigger Evidence (All Roles)

- Started: 2026-04-18T15:47:45.951Z
- Finished: 2026-04-18T15:48:52.643Z
- API Base URL: https://flow-staging-api-esgxesfjhnenabg7.centralus-01.azurewebsites.net
- Auth Mode: bearer
- Encounter ID: ac3fb453-26ee-42f3-a2ac-5546eb2e362d
- Clinic ID: c372ccd2-efac-47ce-a75f-af843ad63d16
- Threshold Row ID: 8d50ee79-ba54-4326-bd7d-ae0d2440b429

## Threshold Trigger

- Trigger reached: yes
- Level reached: Yellow
- Poll attempts: 13
- Elapsed ms: 63539

## Role Alert Evidence

| Role | Result | Detail | Alert ID |
|---|---|---|---|
| FrontDeskCheckIn | FAIL | Missing STAGING_ROLE_TOKEN_FRONTDESKCHECKIN for role proof | - |
| MA | FAIL | Missing STAGING_ROLE_TOKEN_MA for role proof | - |
| Clinician | FAIL | Missing STAGING_ROLE_TOKEN_CLINICIAN for role proof | - |
| FrontDeskCheckOut | FAIL | Missing STAGING_ROLE_TOKEN_FRONTDESKCHECKOUT for role proof | - |
| OfficeManager | FAIL | Missing STAGING_ROLE_TOKEN_OFFICEMANAGER for role proof | - |
| RevenueCycle | FAIL | Missing STAGING_ROLE_TOKEN_REVENUECYCLE for role proof | - |
| Admin | PASS | Threshold alert present | 27878a14-c337-4898-a2f8-a1d751af1e54 |
