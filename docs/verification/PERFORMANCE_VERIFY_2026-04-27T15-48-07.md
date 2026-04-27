# Flow Performance Verification

- API Base URL: https://flow-staging-api-esgxesfjhnenabg7.centralus-01.azurewebsites.net
- Captured At: 2026-04-27T15:48:07.878Z

| Surface | Method | Path | Status | Duration | Result | Note |
|---|---:|---|---:|---:|---|---|
| Health | GET | `/health` | 200 | 415ms | PASS |  |
| Readiness | GET | `/ready` | 200 | 2292ms | PASS |  |
| Encounter Board Page | GET | `/encounters?pageSize=25` | 200 | 5514ms | PASS |  |
| Lobby Encounter Probe | GET | `/encounters?status=Lobby&pageSize=1` | 200 | 2029ms | PASS |  |
| Analytics | GET | `/dashboard/owner-analytics` | 200 | 3967ms | PASS |  |
| Revenue Dashboard | GET | `/dashboard/revenue-cycle` | 200 | 2291ms | PASS |  |
| Revenue Queue Page | GET | `/revenue-cases?pageSize=25` | 200 | 5709ms | PASS |  |
| Admin Facilities | GET | `/admin/facilities` | 200 | 248ms | PASS |  |
| Admin Clinics | GET | `/admin/clinics` | 200 | 989ms | PASS |  |
| Office Manager Summary | GET | `/dashboard/office-manager` | 200 | 1601ms | PASS |  |
| Incoming Page | GET | `/incoming?pageSize=25` | 200 | 625ms | PASS |  |
| Pre-rooming Check | POST | `/rooms/pre-rooming-check` | 200 | 1991ms | PASS |  |
