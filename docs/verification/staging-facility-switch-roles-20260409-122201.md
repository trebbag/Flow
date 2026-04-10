# Staging Facility Switch Proof (Role-by-Role)

- Started: 2026-04-09T16:22:01.693Z
- Finished: 2026-04-09T16:22:01.895Z
- API Base URL: http://127.0.0.1:4000
- Auth Mode: bearer

## Role Results

| Role | Result | Detail | Facilities In Scope |
|---|---|---|---|
| Admin | PASS | Switch and restore persisted | 6394555a-0e8d-483f-b8f0-753ed402bd97, 46c1cfe6-6889-4f41-b1fa-c4e8ed21944b |
| FrontDeskCheckIn | SKIP | User has fewer than two facilities in scope | 46c1cfe6-6889-4f41-b1fa-c4e8ed21944b |
| MA | SKIP | User has fewer than two facilities in scope | 46c1cfe6-6889-4f41-b1fa-c4e8ed21944b |
| Clinician | SKIP | User has fewer than two facilities in scope | 46c1cfe6-6889-4f41-b1fa-c4e8ed21944b |
| FrontDeskCheckOut | SKIP | User has fewer than two facilities in scope | 46c1cfe6-6889-4f41-b1fa-c4e8ed21944b |
| RevenueCycle | SKIP | User has fewer than two facilities in scope | 46c1cfe6-6889-4f41-b1fa-c4e8ed21944b |

## Evidence Notes

- Admin: switched to `6394555a-0e8d-483f-b8f0-753ed402bd97` then restored to `46c1cfe6-6889-4f41-b1fa-c4e8ed21944b`.
