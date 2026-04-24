# Flow Performance Verification

- API Base URL: https://flow-staging-api-esgxesfjhnenabg7.centralus-01.azurewebsites.net
- Captured At: 2026-04-24T22:40:50.803Z

| Surface | Method | Path | Status | Duration | Result | Note |
|---|---:|---|---:|---:|---|---|
| Health | GET | `/health` | 200 | 276ms | PASS |  |
| Readiness | GET | `/ready` | 200 | 75ms | PASS |  |
| Encounter Board Page | GET | `/encounters?pageSize=25` | 200 | 414ms | PASS |  |
| Lobby Encounter Probe | GET | `/encounters?status=Lobby&pageSize=1` | 200 | 198ms | PASS |  |
| Analytics | GET | `/dashboard/owner-analytics` | 200 | 306ms | PASS |  |
| Revenue Dashboard | GET | `/dashboard/revenue-cycle` | 200 | 175ms | PASS |  |
| Revenue Queue Page | GET | `/revenue-cases?pageSize=25` | 200 | 211ms | PASS |  |
| Admin Facilities | GET | `/admin/facilities` | 200 | 80ms | PASS |  |
| Admin Clinics | GET | `/admin/clinics` | 200 | 306ms | PASS |  |
| Office Manager Summary | GET | `/dashboard/office-manager` | 200 | 537ms | PASS |  |
| Incoming Page | GET | `/incoming?pageSize=25` | 200 | 233ms | PASS |  |
| Pre-rooming Check | POST | `/rooms/pre-rooming-check` | 200 | 383ms | PASS |  |
