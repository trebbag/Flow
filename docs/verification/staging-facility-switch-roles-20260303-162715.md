# Staging Facility Switch Proof (Role-by-Role)

- Started: 2026-03-03T21:27:15.800Z
- Finished: 2026-03-03T21:27:15.861Z
- API Base URL: http://127.0.0.1:4000
- Auth Mode: bearer

## Role Results

| Role | Result | Detail | Facilities In Scope |
|---|---|---|---|
| Admin | PASS | Switch and restore persisted | cc90c9fd-f36d-45a0-8d2d-32b74784fc91, 626c062e-c3a5-4ad9-a3d0-6875d3407033 |
| FrontDeskCheckIn | PASS | Switch and restore persisted | cc90c9fd-f36d-45a0-8d2d-32b74784fc91, 626c062e-c3a5-4ad9-a3d0-6875d3407033 |
| MA | PASS | Switch and restore persisted | cc90c9fd-f36d-45a0-8d2d-32b74784fc91, 626c062e-c3a5-4ad9-a3d0-6875d3407033 |
| Clinician | PASS | Switch and restore persisted | cc90c9fd-f36d-45a0-8d2d-32b74784fc91, 626c062e-c3a5-4ad9-a3d0-6875d3407033 |
| FrontDeskCheckOut | FAIL | 500 Internal Server Error /auth/context/facility: Rate limit exceeded, retry in 43 seconds | - |
| RevenueCycle | FAIL | 500 Internal Server Error /auth/context: Rate limit exceeded, retry in 43 seconds | - |

## Evidence Notes

- Admin: switched to `cc90c9fd-f36d-45a0-8d2d-32b74784fc91` then restored to `626c062e-c3a5-4ad9-a3d0-6875d3407033`.
- FrontDeskCheckIn: switched to `626c062e-c3a5-4ad9-a3d0-6875d3407033` then restored to `cc90c9fd-f36d-45a0-8d2d-32b74784fc91`.
- MA: switched to `626c062e-c3a5-4ad9-a3d0-6875d3407033` then restored to `cc90c9fd-f36d-45a0-8d2d-32b74784fc91`.
- Clinician: switched to `626c062e-c3a5-4ad9-a3d0-6875d3407033` then restored to `cc90c9fd-f36d-45a0-8d2d-32b74784fc91`.
