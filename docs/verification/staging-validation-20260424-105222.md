# Staging Validation Evidence

- Started: 2026-04-24T14:49:45.101Z
- Finished: 2026-04-24T14:52:22.756Z
- API Base URL: https://flow-staging-api-esgxesfjhnenabg7.centralus-01.azurewebsites.net
- Auth Mode: proof-header

## Step Results

### Pilot Preflight

- Command: `pnpm pilot:preflight`
- Result: PASS
- Exit code: 0
- Duration: 1410ms

#### Stdout

```text

> flow-backend@0.1.0 pilot:preflight /Users/gregorygabbert/Documents/GitHub/Flow
> tsx scripts/pilot-preflight.ts

PASS auth_mode: AUTH_MODE=jwt
PASS dev_headers_disabled: AUTH_ALLOW_DEV_HEADERS=false
PASS implicit_admin_disabled: AUTH_ALLOW_IMPLICIT_ADMIN=false
PASS env_POSTGRES_DATABASE_URL: POSTGRES_DATABASE_URL is set
PASS env_JWT_ISSUER: JWT_ISSUER is set
PASS env_JWT_AUDIENCE: JWT_AUDIENCE is set
PASS env_CORS_ORIGINS: CORS_ORIGINS is set
PASS cors_no_wildcard: CORS_ORIGINS=https://orange-beach-0851cdc0f.6.azurestaticapps.net,http://localhost:5173,http://localhost:4173
PASS postgres_connectivity: Connected and executed heartbeat query
PASS api_health_endpoint: Health endpoint reachable at https://flow-staging-api-esgxesfjhnenabg7.centralus-01.azurewebsites.net/health
Pilot preflight passed.

```

### Frontend Live Verification

- Command: `pnpm frontend:verify-live`
- Result: PASS
- Exit code: 0
- Duration: 70104ms

#### Stdout

```text

> flow-backend@0.1.0 frontend:verify-live /Users/gregorygabbert/Documents/GitHub/Flow
> tsx scripts/frontend-live-verify.ts

Running: pnpm run test:contract

> flow-frontend@0.0.1 test:contract /Users/gregorygabbert/Documents/GitHub/Flow/docs/Flow Frontend
> node ./scripts/test-contract.mjs

Contract checks passed.
Running: pnpm run test:visual

> flow-frontend@0.0.1 test:visual /Users/gregorygabbert/Documents/GitHub/Flow/docs/Flow Frontend
> npm run build && node ./scripts/test-visual.mjs


> flow-frontend@0.0.1 build
> vite build

vite v6.3.5 building for production...
transforming...
✓ 2496 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                                      0.87 kB │ gzip:   0.38 kB
dist/assets/index-DYzMRmWG.css                     158.64 kB │ gzip:  23.85 kB
dist/assets/card-BYI2I-Sd.js                         0.78 kB │ gzip:   0.38 kB
dist/assets/not-found-ChI7EZM2.js                    0.83 kB │ gzip:   0.48 kB
dist/assets/encounter-timers-p2KjRlYB.js             0.88 kB │ gzip:   0.40 kB
dist/assets/switch-52b1IlZQ.js                       0.94 kB │ gzip:   0.48 kB
dist/assets/auth-callback-view-CYeA7wZF.js           1.00 kB │ gzip:   0.59 kB
dist/assets/mock-data-DvDvfmIL.js                    1.04 kB │ gzip:   0.52 kB
dist/assets/badge-xnrhtC0U.js                        1.23 kB │ gzip:   0.59 kB
dist/assets/tabs-w7aXKHu3.js                         1.35 kB │ gzip:   0.59 kB
dist/assets/dialog-DfPeL0yA.js                       2.24 kB │ gzip:   0.86 kB
dist/assets/safety-assist-modal-BBgKk_jq.js          4.15 kB │ gzip:   1.60 kB
dist/assets/alert-dialog-DGYsai0m.js                 4.23 kB │ gzip:   1.45 kB
dist/assets/alerts-view-C0gr1afi.js                  5.22 kB │ gzip:   1.97 kB
dist/assets/use-unsaved-changes-guard-DXplfvbC.js    5.62 kB │ gzip:   1.80 kB
dist/assets/tasks-view-C9JJjfcH.js                   6.54 kB │ gzip:   2.18 kB
dist/assets/login-view-Bg-daziv.js                   9.83 kB │ gzip:   3.40 kB
dist/assets/ma-board-view-Dk3d7pQg.js               16.96 kB │ gzip:   4.91 kB
dist/assets/overview-page-CdmXPRDU.js               17.91 kB │ gzip:   4.67 kB
dist/assets/analytics-view-DLwlfnVF.js              21.07 kB │ gzip:   4.69 kB
dist/assets/vendor-icons-D8OZIlqE.js                21.41 kB │ gzip:   7.09 kB
dist/assets/closeout-view-CsW3d9xV.js               22.21 kB │ gzip:   5.61 kB
dist/assets/clinician-view-BbYPuGil.js              22.41 kB │ gzip:   5.81 kB
dist/assets/rooms-view-CotCHN-i.js                  26.09 kB │ gzip:   6.76 kB
dist/assets/vendor-toast-DK3a3kws.js                33.65 kB │ gzip:   9.26 kB
dist/assets/checkout-view-B2W4uGRK.js               39.19 kB │ gzip:   8.67 kB
dist/assets/checkin-view-CqqayjXl.js                43.36 kB │ gzip:   9.22 kB
dist/assets/office-manager-dashboard-D6HknXoH.js    52.55 kB │ gzip:  13.37 kB
dist/assets/vendor-radix-CpTigsM6.js                54.29 kB │ gzip:  17.01 kB
dist/assets/index-CwxATxgM.js                       85.78 kB │ gzip:  23.47 kB
dist/assets/vendor-router-waZZoVvD.js               87.06 kB │ gzip:  28.65 kB
dist/assets/revenue-cycle-view-BK1YvJFI.js          90.80 kB │ gzip:  19.38 kB
dist/assets/encounter-detail-view-BJ4O_ZYP.js       94.65 kB │ gzip:  21.59 kB
dist/assets/vendor-msal-B1rPPdZ6.js                131.08 kB │ gzip:  32.07 kB
dist/assets/admin-console-DY7Ck2ZO.js              228.41 kB │ gzip:  45.94 kB
dist/assets/vendor-charts-BuEI2fT_.js              340.08 kB │ gzip:  82.19 kB
dist/assets/vendor-misc-D7jtLOqS.js                365.37 kB │ gzip: 114.81 kB
✓ built in 6.42s
Visual artifact checks passed.
Running: pnpm run test:e2e-live

> flow-frontend@0.0.1 test:e2e-live /Users/gregorygabbert/Documents/GitHub/Flow/docs/Flow Frontend
> node ./scripts/test-e2e-live.mjs

Live role-board encounter flow e2e check passed.
Running: pnpm run test:e2e-browser

> flow-frontend@0.0.1 test:e2e-browser /Users/gregorygabbert/Documents/GitHub/Flow/docs/Flow Frontend
> pnpm run build && node ./scripts/test-e2e-browser.mjs


> flow-frontend@0.0.1 build /Users/gregorygabbert/Documents/GitHub/Flow/docs/Flow Frontend
> vite build

vite v6.3.5 building for production...
transforming...
✓ 2496 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                                      0.87 kB │ gzip:   0.38 kB
dist/assets/index-DYzMRmWG.css                     158.64 kB │ gzip:  23.85 kB
dist/assets/card-BYI2I-Sd.js                         0.78 kB │ gzip:   0.38 kB
dist/assets/not-found-ChI7EZM2.js                    0.83 kB │ gzip:   0.48 kB
dist/assets/encounter-timers-p2KjRlYB.js             0.88 kB │ gzip:   0.40 kB
dist/assets/switch-52b1IlZQ.js                       0.94 kB │ gzip:   0.48 kB
dist/assets/auth-callback-view-CYeA7wZF.js           1.00 kB │ gzip:   0.59 kB
dist/assets/mock-data-DvDvfmIL.js                    1.04 kB │ gzip:   0.52 kB
dist/assets/badge-xnrhtC0U.js                        1.23 kB │ gzip:   0.59 kB
dist/assets/tabs-w7aXKHu3.js                         1.35 kB │ gzip:   0.59 kB
dist/assets/dialog-DfPeL0yA.js                       2.24 kB │ gzip:   0.86 kB
dist/assets/safety-assist-modal-BBgKk_jq.js          4.15 kB │ gzip:   1.60 kB
dist/assets/alert-dialog-DGYsai0m.js                 4.23 kB │ gzip:   1.45 kB
dist/assets/alerts-view-C0gr1afi.js                  5.22 kB │ gzip:   1.97 kB
dist/assets/use-unsaved-changes-guard-DXplfvbC.js    5.62 kB │ gzip:   1.80 kB
dist/assets/tasks-view-C9JJjfcH.js                   6.54 kB │ gzip:   2.18 kB
dist/assets/login-view-Bg-daziv.js                   9.83 kB │ gzip:   3.40 kB
dist/assets/ma-board-view-Dk3d7pQg.js               16.96 kB │ gzip:   4.91 kB
dist/assets/overview-page-CdmXPRDU.js               17.91 kB │ gzip:   4.67 kB
dist/assets/analytics-view-DLwlfnVF.js              21.07 kB │ gzip:   4.69 kB
dist/assets/vendor-icons-D8OZIlqE.js                21.41 kB │ gzip:   7.09 kB
dist/assets/closeout-view-CsW3d9xV.js               22.21 kB │ gzip:   5.61 kB
dist/assets/clinician-view-BbYPuGil.js              22.41 kB │ gzip:   5.81 kB
dist/assets/rooms-view-CotCHN-i.js                  26.09 kB │ gzip:   6.76 kB
dist/assets/vendor-toast-DK3a3kws.js                33.65 kB │ gzip:   9.26 kB
dist/assets/checkout-view-B2W4uGRK.js               39.19 kB │ gzip:   8.67 kB
dist/assets/checkin-view-CqqayjXl.js                43.36 kB │ gzip:   9.22 kB
dist/assets/office-manager-dashboard-D6HknXoH.js    52.55 kB │ gzip:  13.37 kB
dist/assets/vendor-radix-CpTigsM6.js                54.29 kB │ gzip:  17.01 kB
dist/assets/index-CwxATxgM.js                       85.78 kB │ gzip:  23.47 kB
dist/assets/vendor-router-waZZoVvD.js               87.06 kB │ gzip:  28.65 kB
dist/assets/revenue-cycle-view-BK1YvJFI.js          90.80 kB │ gzip:  19.38 kB
dist/assets/encounter-detail-view-BJ4O_ZYP.js       94.65 kB │ gzip:  21.59 kB
dist/assets/vendor-msal-B1rPPdZ6.js                131.08 kB │ gzip:  32.07 kB
dist/assets/admin-console-DY7Ck2ZO.js              228.41 kB │ gzip:  45.94 kB
dist/assets/vendor-charts-BuEI2fT_.js              340.08 kB │ gzip:  82.19 kB
dist/assets/vendor-misc-D7jtLOqS.js                365.37 kB │ gzip: 114.81 kB
✓ built in 5.44s
  ➜  Local:   http://localhost:4173/
Browser role-flow regression checks passed.
Running: pnpm run test:bundle-budget

> flow-frontend@0.0.1 test:bundle-budget /Users/gregorygabbert/Documents/GitHub/Flow/docs/Flow Frontend
> node ./scripts/test-bundle-budget.mjs

Bundle budget summary (gzip):
- Entry JS: 22.86KB / 125KB (index-CwxATxgM.js)
- Largest JS: 111.88KB / 125KB (vendor-misc-D7jtLOqS.js)
- Largest CSS: 22.93KB / 28KB (index-DYzMRmWG.css)
- Total JS: 469.57KB / 575KB
- Total CSS: 22.93KB / 46KB
Bundle budgets passed.
Frontend live wiring verification hook completed.

```

### Role-by-Role Facility Switch Proof

- Command: `pnpm staging:proof:facility-switch`
- Result: PASS
- Exit code: 0
- Duration: 9900ms

#### Stdout

```text

> flow-backend@0.1.0 staging:proof:facility-switch /Users/gregorygabbert/Documents/GitHub/Flow
> tsx scripts/staging-facility-switch-proof.ts

Facility switch proof written: /Users/gregorygabbert/Documents/GitHub/Flow/docs/verification/staging-facility-switch-roles-20260424-105106.md

```

### Threshold Trigger Evidence Across Roles

- Command: `pnpm staging:proof:threshold-alerts`
- Result: PASS
- Exit code: 0
- Duration: 76241ms

#### Stdout

```text

> flow-backend@0.1.0 staging:proof:threshold-alerts /Users/gregorygabbert/Documents/GitHub/Flow
> tsx scripts/staging-threshold-evidence.ts

Threshold evidence report written: /Users/gregorygabbert/Documents/GitHub/Flow/docs/verification/staging-threshold-evidence-20260424-105222.md

```

