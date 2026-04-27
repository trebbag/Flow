# Flow Performance Verification

- API Base URL: https://flow-staging-api-esgxesfjhnenabg7.centralus-01.azurewebsites.net
- Captured At: 2026-04-27T16:51:16.779Z

| Surface | Method | Path | Status | Duration | Result | Note |
|---|---:|---|---:|---:|---|---|
| Health | GET | `/health` | 200 | 258ms | PASS |  |
| Readiness | GET | `/ready` | 200 | 271ms | PASS |  |
| Encounter Board Page | GET | `/encounters?pageSize=25` | 200 | 694ms | PASS |  |
| Lobby Encounter Probe | GET | `/encounters?status=Lobby&pageSize=1` | 200 | 149ms | PASS |  |
| Analytics | GET | `/dashboard/owner-analytics` | 200 | 1646ms | PASS |  |
| Revenue Dashboard | GET | `/dashboard/revenue-cycle` | 200 | 476ms | PASS |  |
| Revenue Queue Page | GET | `/revenue-cases?pageSize=25` | 200 | 1453ms | PASS |  |
| Admin Facilities | GET | `/admin/facilities` | 200 | 60ms | PASS |  |
| Admin Clinics | GET | `/admin/clinics` | 200 | 232ms | PASS |  |
| Office Manager Summary | GET | `/dashboard/office-manager` | 200 | 221ms | PASS |  |
| Incoming Page | GET | `/incoming?pageSize=25` | 200 | 773ms | PASS |  |
| Pre-rooming Check | POST | `/rooms/pre-rooming-check` | skipped | 0ms | PASS | Skipped because no Lobby encounter was present in the first encounter page. |
