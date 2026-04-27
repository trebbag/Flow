# Flow Performance Verification

- API Base URL: https://flow-staging-api-esgxesfjhnenabg7.centralus-01.azurewebsites.net
- Captured At: 2026-04-27T16:46:50.317Z

| Surface | Method | Path | Status | Duration | Result | Note |
|---|---:|---|---:|---:|---|---|
| Health | GET | `/health` | 200 | 281ms | PASS |  |
| Readiness | GET | `/ready` | 200 | 687ms | PASS |  |
| Encounter Board Page | GET | `/encounters?pageSize=25` | 200 | 358ms | PASS |  |
| Lobby Encounter Probe | GET | `/encounters?status=Lobby&pageSize=1` | 200 | 216ms | PASS |  |
| Analytics | GET | `/dashboard/owner-analytics` | 200 | 496ms | PASS |  |
| Revenue Dashboard | GET | `/dashboard/revenue-cycle` | 200 | 439ms | PASS |  |
| Revenue Queue Page | GET | `/revenue-cases?pageSize=25` | 200 | 553ms | PASS |  |
| Admin Facilities | GET | `/admin/facilities` | 200 | 89ms | PASS |  |
| Admin Clinics | GET | `/admin/clinics` | 200 | 386ms | PASS |  |
| Office Manager Summary | GET | `/dashboard/office-manager` | 200 | 402ms | PASS |  |
| Incoming Page | GET | `/incoming?pageSize=25` | 200 | 706ms | PASS |  |
| Pre-rooming Check | POST | `/rooms/pre-rooming-check` | skipped | 0ms | PASS | Skipped because no Lobby encounter was present in the first encounter page. |
