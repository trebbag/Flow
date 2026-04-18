# Staging Facility Switch Proof (Role-by-Role)

- Started: 2026-04-18T15:47:44.525Z
- Finished: 2026-04-18T15:47:45.549Z
- API Base URL: https://flow-staging-api-esgxesfjhnenabg7.centralus-01.azurewebsites.net
- Auth Mode: bearer

## Role Results

| Role | Result | Detail | Facilities In Scope |
|---|---|---|---|
| Admin | PASS | Switch and restore persisted | 58a9224a-6a85-4f41-8b59-f827316991cf, 6394555a-0e8d-483f-b8f0-753ed402bd97, 46c1cfe6-6889-4f41-b1fa-c4e8ed21944b |
| FrontDeskCheckIn | SKIP | Missing STAGING_ROLE_TOKEN_FRONTDESKCHECKIN for bearer role proof | - |
| MA | SKIP | Missing STAGING_ROLE_TOKEN_MA for bearer role proof | - |
| Clinician | SKIP | Missing STAGING_ROLE_TOKEN_CLINICIAN for bearer role proof | - |
| FrontDeskCheckOut | SKIP | Missing STAGING_ROLE_TOKEN_FRONTDESKCHECKOUT for bearer role proof | - |
| OfficeManager | SKIP | Missing STAGING_ROLE_TOKEN_OFFICEMANAGER for bearer role proof | - |
| RevenueCycle | SKIP | Missing STAGING_ROLE_TOKEN_REVENUECYCLE for bearer role proof | - |

## Evidence Notes

- Admin: switched to `6394555a-0e8d-483f-b8f0-753ed402bd97` then restored to `58a9224a-6a85-4f41-8b59-f827316991cf`.
