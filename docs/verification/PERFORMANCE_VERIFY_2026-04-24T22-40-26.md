# Flow Performance Verification

- API Base URL: https://flow-staging-api-esgxesfjhnenabg7.centralus-01.azurewebsites.net
- Captured At: 2026-04-24T22:40:26.861Z

| Surface | Method | Path | Status | Duration | Result | Note |
|---|---:|---|---:|---:|---|---|
| Health | GET | `/health` | 200 | 249ms | PASS |  |
| Readiness | GET | `/ready` | 200 | 381ms | PASS |  |
| Encounter Board Page | GET | `/encounters?pageSize=25` | 200 | 521ms | PASS |  |
| Lobby Encounter Probe | GET | `/encounters?status=Lobby&pageSize=1` | 200 | 502ms | PASS |  |
| Analytics | GET | `/dashboard/owner-analytics` | 200 | 1436ms | PASS |  |
| Revenue Dashboard | GET | `/dashboard/revenue-cycle` | 200 | 639ms | PASS |  |
| Revenue Queue Page | GET | `/revenue-cases?pageSize=25` | 200 | 593ms | PASS |  |
| Admin Facilities | GET | `/admin/facilities` | 200 | 100ms | PASS |  |
| Admin Clinics | GET | `/admin/clinics` | 200 | 192ms | PASS |  |
| Office Manager Summary | GET | `/dashboard/office-manager` | 200 | 337ms | PASS |  |
| Incoming Page | GET | `/incoming?pageSize=25` | 200 | 152ms | PASS |  |
| Pre-rooming Check | POST | `/rooms/pre-rooming-check` | 200 | 975ms | PASS |  |
