# Flow Performance Verification

- API Base URL: https://flow-staging-api-esgxesfjhnenabg7.centralus-01.azurewebsites.net
- Captured At: 2026-04-24T22:27:41.507Z

| Surface | Method | Path | Status | Duration | Result | Note |
|---|---:|---|---:|---:|---|---|
| Health | GET | `/health` | 200 | 632ms | PASS |  |
| Readiness | GET | `/ready` | 200 | 1011ms | PASS |  |
| Encounter Board Page | GET | `/encounters?pageSize=25` | 200 | 1264ms | PASS |  |
| Lobby Encounter Probe | GET | `/encounters?status=Lobby&pageSize=1` | 200 | 1712ms | PASS |  |
| Analytics | GET | `/dashboard/owner-analytics` | 200 | 2316ms | PASS |  |
| Revenue Dashboard | GET | `/dashboard/revenue-cycle` | 200 | 788ms | PASS |  |
| Revenue Queue Page | GET | `/revenue-cases?pageSize=25` | 200 | 1350ms | PASS |  |
| Admin Facilities | GET | `/admin/facilities` | 200 | 232ms | PASS |  |
| Admin Clinics | GET | `/admin/clinics` | 200 | 1064ms | PASS |  |
| Office Manager Summary | GET | `/dashboard/office-manager` | 200 | 1142ms | PASS |  |
| Incoming Page | GET | `/incoming?pageSize=25` | 200 | 1448ms | PASS |  |
| Pre-rooming Check | POST | `/rooms/pre-rooming-check` | 200 | 634ms | PASS |  |
