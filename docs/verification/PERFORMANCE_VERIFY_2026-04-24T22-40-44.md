# Flow Performance Verification

- API Base URL: https://flow-staging-api-esgxesfjhnenabg7.centralus-01.azurewebsites.net
- Captured At: 2026-04-24T22:40:44.414Z

| Surface | Method | Path | Status | Duration | Result | Note |
|---|---:|---|---:|---:|---|---|
| Health | GET | `/health` | 200 | 274ms | PASS |  |
| Readiness | GET | `/ready` | 200 | 266ms | PASS |  |
| Encounter Board Page | GET | `/encounters?pageSize=25` | 200 | 336ms | PASS |  |
| Lobby Encounter Probe | GET | `/encounters?status=Lobby&pageSize=1` | 200 | 174ms | PASS |  |
| Analytics | GET | `/dashboard/owner-analytics` | 200 | 572ms | PASS |  |
| Revenue Dashboard | GET | `/dashboard/revenue-cycle` | 200 | 297ms | PASS |  |
| Revenue Queue Page | GET | `/revenue-cases?pageSize=25` | 200 | 208ms | PASS |  |
| Admin Facilities | GET | `/admin/facilities` | 200 | 71ms | PASS |  |
| Admin Clinics | GET | `/admin/clinics` | 200 | 175ms | PASS |  |
| Office Manager Summary | GET | `/dashboard/office-manager` | 200 | 856ms | PASS |  |
| Incoming Page | GET | `/incoming?pageSize=25` | 200 | 293ms | PASS |  |
| Pre-rooming Check | POST | `/rooms/pre-rooming-check` | 200 | 136ms | PASS |  |
