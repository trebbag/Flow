# Staging Validation Evidence

- Started: 2026-03-03T21:27:00.844Z
- Finished: 2026-03-03T21:27:16.222Z
- API Base URL: http://127.0.0.1:4000
- Auth Mode: bearer

## Step Results

### Pilot Preflight

- Command: `pnpm pilot:preflight`
- Result: FAIL
- Exit code: 1
- Duration: 395ms

#### Stdout

```text

> flow-backend@0.1.0 pilot:preflight /Users/gregorygabbert/Documents/GitHub/Flow
> tsx scripts/pilot-preflight.ts

FAIL auth_mode: AUTH_MODE is 'unset'
FAIL dev_headers_disabled: AUTH_ALLOW_DEV_HEADERS=unset
FAIL implicit_admin_disabled: AUTH_ALLOW_IMPLICIT_ADMIN=unset
FAIL env_POSTGRES_DATABASE_URL: POSTGRES_DATABASE_URL is missing
FAIL env_JWT_ISSUER: JWT_ISSUER is missing
FAIL env_JWT_AUDIENCE: JWT_AUDIENCE is missing
FAIL env_CORS_ORIGINS: CORS_ORIGINS is missing
PASS cors_no_wildcard: CORS_ORIGINS=unset
PASS api_health_endpoint: Health endpoint reachable at http://127.0.0.1:4000/health
 ELIFECYCLE  Command failed with exit code 1.

```

#### Stderr

```text
Pilot preflight failed with 7 issue(s).

```

### Frontend Live Verification

- Command: `pnpm frontend:verify-live`
- Result: PASS
- Exit code: 0
- Duration: 14280ms

#### Stdout

```text

> flow-backend@0.1.0 frontend:verify-live /Users/gregorygabbert/Documents/GitHub/Flow
> tsx scripts/frontend-live-verify.ts

Running: pnpm run test:contract

> @figma/my-make-file@0.0.1 test:contract /Users/gregorygabbert/Documents/GitHub/Flow/docs/Flow Frontend
> node ./scripts/test-contract.mjs

Contract checks passed.
Running: pnpm run test:visual

> @figma/my-make-file@0.0.1 test:visual /Users/gregorygabbert/Documents/GitHub/Flow/docs/Flow Frontend
> npm run build && node ./scripts/test-visual.mjs


> @figma/my-make-file@0.0.1 build
> vite build

vite v6.3.5 building for production...
transforming...
✓ 2340 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                                     0.45 kB │ gzip:   0.29 kB
dist/assets/index-BM686M1O.css                    147.66 kB │ gzip:  22.09 kB
dist/assets/index-CmCz51XD.js                       0.14 kB │ gzip:   0.14 kB
dist/assets/index-CqCQ1Scq.js                       0.23 kB │ gzip:   0.20 kB
dist/assets/chevron-up-CXtCyMpl.js                  0.30 kB │ gzip:   0.25 kB
dist/assets/chevron-down-Cq8e7aZB.js                0.30 kB │ gzip:   0.25 kB
dist/assets/chevron-right-Cjv_CIqr.js               0.30 kB │ gzip:   0.25 kB
dist/assets/BarChart-Dw2vZw3z.js                    0.32 kB │ gzip:   0.23 kB
dist/assets/plus-Cy_ZswZS.js                        0.33 kB │ gzip:   0.25 kB
dist/assets/x-CZu4LMVp.js                           0.33 kB │ gzip:   0.26 kB
dist/assets/arrow-right-CHmTTjJm.js                 0.34 kB │ gzip:   0.27 kB
dist/assets/arrow-left-DL4epPHS.js                  0.34 kB │ gzip:   0.27 kB
dist/assets/circle-check-Cz0eSNLD.js                0.35 kB │ gzip:   0.27 kB
dist/assets/circle-dot-D86hxLtC.js                  0.35 kB │ gzip:   0.26 kB
dist/assets/clock-DJwix7bL.js                       0.35 kB │ gzip:   0.27 kB
dist/assets/user-Cu6YzRyl.js                        0.36 kB │ gzip:   0.29 kB
dist/assets/sticky-note-2pN6xco-.js                 0.40 kB │ gzip:   0.29 kB
dist/assets/timer-CvXTzXgc.js                       0.41 kB │ gzip:   0.29 kB
dist/assets/circle-alert-Bvp-0QKk.js                0.42 kB │ gzip:   0.29 kB
dist/assets/eye-9aR6ZFx1.js                         0.42 kB │ gzip:   0.30 kB
dist/assets/clipboard-CwuG9TQ2.js                   0.43 kB │ gzip:   0.32 kB
dist/assets/triangle-alert-SnOTyRbo.js              0.44 kB │ gzip:   0.32 kB
dist/assets/file-check-DHAbFM8i.js                  0.44 kB │ gzip:   0.30 kB
dist/assets/inbox-DKhln1zX.js                       0.46 kB │ gzip:   0.33 kB
dist/assets/layout-template-OOs8NUH9.js             0.46 kB │ gzip:   0.30 kB
dist/assets/index-IZMt6jFo.js                       0.48 kB │ gzip:   0.32 kB
dist/assets/file-text-BVLtBnNG.js                   0.51 kB │ gzip:   0.32 kB
dist/assets/shield-alert-BcrnM7Sk.js                0.53 kB │ gzip:   0.37 kB
dist/assets/door-open-BXNa8ab0.js                   0.54 kB │ gzip:   0.36 kB
dist/assets/index-DwAtZbrT.js                       0.54 kB │ gzip:   0.35 kB
dist/assets/clipboard-list-C-bH-49P.js              0.58 kB │ gzip:   0.37 kB
dist/assets/building-2-Cw2uZdiC.js                  0.61 kB │ gzip:   0.35 kB
dist/assets/footprints-DQon23aC.js                  0.62 kB │ gzip:   0.41 kB
dist/assets/wifi-DCYQslVE.js                        0.74 kB │ gzip:   0.37 kB
dist/assets/card-C8JjNQxd.js                        0.75 kB │ gzip:   0.36 kB
dist/assets/not-found-BxDX93yL.js                   0.82 kB │ gzip:   0.49 kB
dist/assets/zap-Kvtoxu0H.js                         0.84 kB │ gzip:   0.41 kB
dist/assets/encounter-timers-42IdczWp.js            0.89 kB │ gzip:   0.41 kB
dist/assets/thermometer-DUnDZEC8.js                 1.00 kB │ gzip:   0.44 kB
dist/assets/index-CTnwKNbP.js                       2.15 kB │ gzip:   0.95 kB
dist/assets/index-BFBMPvsA.js                       2.26 kB │ gzip:   1.08 kB
dist/assets/switch-Cpbc2Bva.js                      2.73 kB │ gzip:   1.32 kB
dist/assets/badge-CiNjUKHG.js                       3.52 kB │ gzip:   1.55 kB
dist/assets/safety-assist-modal-55sJovA8.js         4.13 kB │ gzip:   1.61 kB
dist/assets/alerts-view-D7y66b7t.js                 5.25 kB │ gzip:   2.02 kB
dist/assets/tasks-view-Zv6AN2E6.js                  6.17 kB │ gzip:   2.08 kB
dist/assets/login-view-1MKHwlgm.js                  7.96 kB │ gzip:   2.73 kB
dist/assets/tabs-Bf9Q8T3v.js                        8.37 kB │ gzip:   3.38 kB
dist/assets/scroll-area-Ck3ILj9P.js                12.77 kB │ gzip:   4.03 kB
dist/assets/closeout-view-C2J2cp8D.js              19.55 kB │ gzip:   5.11 kB
dist/assets/CartesianGrid-Cit0CeDb.js              21.29 kB │ gzip:   5.59 kB
dist/assets/revenue-cycle-view-ZRGm7yt5.js         21.44 kB │ gzip:   5.79 kB
dist/assets/clinician-view-BvoWkMxI.js             22.14 kB │ gzip:   5.86 kB
dist/assets/ma-board-view-CU1fKrbB.js              25.07 kB │ gzip:   6.67 kB
dist/assets/checkin-view-C-SrrVhd.js               26.00 kB │ gzip:   6.79 kB
dist/assets/overview-page-CAwcwI-K.js              29.71 kB │ gzip:   7.40 kB
dist/assets/checkout-view-BzBIL3hr.js              30.72 kB │ gzip:   7.48 kB
dist/assets/analytics-view-DAsj6qvW.js             34.71 kB │ gzip:   9.51 kB
dist/assets/encounter-detail-view-bsjgMX3I.js      54.39 kB │ gzip:  11.85 kB
dist/assets/office-manager-dashboard-Cz4sKXad.js   64.68 kB │ gzip:  18.04 kB
dist/assets/alert-dialog-Cs0Hjxr8.js               67.77 kB │ gzip:  23.46 kB
dist/assets/admin-console-B7mjTS3x.js             167.49 kB │ gzip:  36.17 kB
dist/assets/index-DrE6I3aZ.js                     353.87 kB │ gzip: 110.12 kB
dist/assets/generateCategoricalChart-CEwSskwN.js  377.76 kB │ gzip: 104.58 kB
✓ built in 1.88s
Visual artifact checks passed.
Running: pnpm run test:e2e-live

> @figma/my-make-file@0.0.1 test:e2e-live /Users/gregorygabbert/Documents/GitHub/Flow/docs/Flow Frontend
> node ./scripts/test-e2e-live.mjs

Live role-board encounter flow e2e check passed.
Running: pnpm run test:e2e-browser

> @figma/my-make-file@0.0.1 test:e2e-browser /Users/gregorygabbert/Documents/GitHub/Flow/docs/Flow Frontend
> pnpm run build && node ./scripts/test-e2e-browser.mjs


> @figma/my-make-file@0.0.1 build /Users/gregorygabbert/Documents/GitHub/Flow/docs/Flow Frontend
> vite build

vite v6.3.5 building for production...
transforming...
✓ 2340 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                                     0.45 kB │ gzip:   0.29 kB
dist/assets/index-BM686M1O.css                    147.66 kB │ gzip:  22.09 kB
dist/assets/index-CmCz51XD.js                       0.14 kB │ gzip:   0.14 kB
dist/assets/index-CqCQ1Scq.js                       0.23 kB │ gzip:   0.20 kB
dist/assets/chevron-up-CXtCyMpl.js                  0.30 kB │ gzip:   0.25 kB
dist/assets/chevron-down-Cq8e7aZB.js                0.30 kB │ gzip:   0.25 kB
dist/assets/chevron-right-Cjv_CIqr.js               0.30 kB │ gzip:   0.25 kB
dist/assets/BarChart-Dw2vZw3z.js                    0.32 kB │ gzip:   0.23 kB
dist/assets/plus-Cy_ZswZS.js                        0.33 kB │ gzip:   0.25 kB
dist/assets/x-CZu4LMVp.js                           0.33 kB │ gzip:   0.26 kB
dist/assets/arrow-right-CHmTTjJm.js                 0.34 kB │ gzip:   0.27 kB
dist/assets/arrow-left-DL4epPHS.js                  0.34 kB │ gzip:   0.27 kB
dist/assets/circle-check-Cz0eSNLD.js                0.35 kB │ gzip:   0.27 kB
dist/assets/circle-dot-D86hxLtC.js                  0.35 kB │ gzip:   0.26 kB
dist/assets/clock-DJwix7bL.js                       0.35 kB │ gzip:   0.27 kB
dist/assets/user-Cu6YzRyl.js                        0.36 kB │ gzip:   0.29 kB
dist/assets/sticky-note-2pN6xco-.js                 0.40 kB │ gzip:   0.29 kB
dist/assets/timer-CvXTzXgc.js                       0.41 kB │ gzip:   0.29 kB
dist/assets/circle-alert-Bvp-0QKk.js                0.42 kB │ gzip:   0.29 kB
dist/assets/eye-9aR6ZFx1.js                         0.42 kB │ gzip:   0.30 kB
dist/assets/clipboard-CwuG9TQ2.js                   0.43 kB │ gzip:   0.32 kB
dist/assets/triangle-alert-SnOTyRbo.js              0.44 kB │ gzip:   0.32 kB
dist/assets/file-check-DHAbFM8i.js                  0.44 kB │ gzip:   0.30 kB
dist/assets/inbox-DKhln1zX.js                       0.46 kB │ gzip:   0.33 kB
dist/assets/layout-template-OOs8NUH9.js             0.46 kB │ gzip:   0.30 kB
dist/assets/index-IZMt6jFo.js                       0.48 kB │ gzip:   0.32 kB
dist/assets/file-text-BVLtBnNG.js                   0.51 kB │ gzip:   0.32 kB
dist/assets/shield-alert-BcrnM7Sk.js                0.53 kB │ gzip:   0.37 kB
dist/assets/door-open-BXNa8ab0.js                   0.54 kB │ gzip:   0.36 kB
dist/assets/index-DwAtZbrT.js                       0.54 kB │ gzip:   0.35 kB
dist/assets/clipboard-list-C-bH-49P.js              0.58 kB │ gzip:   0.37 kB
dist/assets/building-2-Cw2uZdiC.js                  0.61 kB │ gzip:   0.35 kB
dist/assets/footprints-DQon23aC.js                  0.62 kB │ gzip:   0.41 kB
dist/assets/wifi-DCYQslVE.js                        0.74 kB │ gzip:   0.37 kB
dist/assets/card-C8JjNQxd.js                        0.75 kB │ gzip:   0.36 kB
dist/assets/not-found-BxDX93yL.js                   0.82 kB │ gzip:   0.49 kB
dist/assets/zap-Kvtoxu0H.js                         0.84 kB │ gzip:   0.41 kB
dist/assets/encounter-timers-42IdczWp.js            0.89 kB │ gzip:   0.41 kB
dist/assets/thermometer-DUnDZEC8.js                 1.00 kB │ gzip:   0.44 kB
dist/assets/index-CTnwKNbP.js                       2.15 kB │ gzip:   0.95 kB
dist/assets/index-BFBMPvsA.js                       2.26 kB │ gzip:   1.08 kB
dist/assets/switch-Cpbc2Bva.js                      2.73 kB │ gzip:   1.32 kB
dist/assets/badge-CiNjUKHG.js                       3.52 kB │ gzip:   1.55 kB
dist/assets/safety-assist-modal-55sJovA8.js         4.13 kB │ gzip:   1.61 kB
dist/assets/alerts-view-D7y66b7t.js                 5.25 kB │ gzip:   2.02 kB
dist/assets/tasks-view-Zv6AN2E6.js                  6.17 kB │ gzip:   2.08 kB
dist/assets/login-view-1MKHwlgm.js                  7.96 kB │ gzip:   2.73 kB
dist/assets/tabs-Bf9Q8T3v.js                        8.37 kB │ gzip:   3.38 kB
dist/assets/scroll-area-Ck3ILj9P.js                12.77 kB │ gzip:   4.03 kB
dist/assets/closeout-view-C2J2cp8D.js              19.55 kB │ gzip:   5.11 kB
dist/assets/CartesianGrid-Cit0CeDb.js              21.29 kB │ gzip:   5.59 kB
dist/assets/revenue-cycle-view-ZRGm7yt5.js         21.44 kB │ gzip:   5.79 kB
dist/assets/clinician-view-BvoWkMxI.js             22.14 kB │ gzip:   5.86 kB
dist/assets/ma-board-view-CU1fKrbB.js              25.07 kB │ gzip:   6.67 kB
dist/assets/checkin-view-C-SrrVhd.js               26.00 kB │ gzip:   6.79 kB
dist/assets/overview-page-CAwcwI-K.js              29.71 kB │ gzip:   7.40 kB
dist/assets/checkout-view-BzBIL3hr.js              30.72 kB │ gzip:   7.48 kB
dist/assets/analytics-view-DAsj6qvW.js             34.71 kB │ gzip:   9.51 kB
dist/assets/encounter-detail-view-bsjgMX3I.js      54.39 kB │ gzip:  11.85 kB
dist/assets/office-manager-dashboard-Cz4sKXad.js   64.68 kB │ gzip:  18.04 kB
dist/assets/alert-dialog-Cs0Hjxr8.js               67.77 kB │ gzip:  23.46 kB
dist/assets/admin-console-B7mjTS3x.js             167.49 kB │ gzip:  36.17 kB
dist/assets/index-DrE6I3aZ.js                     353.87 kB │ gzip: 110.12 kB
dist/assets/generateCategoricalChart-CEwSskwN.js  377.76 kB │ gzip: 104.58 kB
✓ built in 1.60s
  ➜  Local:   http://localhost:4173/
Browser role-flow regression checks passed.
Running: pnpm run test:bundle-budget

> @figma/my-make-file@0.0.1 test:bundle-budget /Users/gregorygabbert/Documents/GitHub/Flow/docs/Flow Frontend
> node ./scripts/test-bundle-budget.mjs

Bundle budget summary (gzip):
- Entry JS: 107.38KB / 125KB (index-DrE6I3aZ.js)
- Largest JS: 107.38KB / 125KB (index-DrE6I3aZ.js)
- Largest CSS: 21.27KB / 28KB (index-BM686M1O.css)
- Total JS: 386.42KB / 420KB
- Total CSS: 21.27KB / 35KB
Bundle budgets passed.
Frontend live wiring verification hook completed.

```

#### Stderr

```text
npm warn Unknown env config "dir". This will stop working in the next major version of npm.

```

### Role-by-Role Facility Switch Proof

- Command: `pnpm staging:proof:facility-switch`
- Result: FAIL
- Exit code: 1
- Duration: 369ms

#### Stdout

```text

> flow-backend@0.1.0 staging:proof:facility-switch /Users/gregorygabbert/Documents/GitHub/Flow
> tsx scripts/staging-facility-switch-proof.ts

Facility switch proof written: /Users/gregorygabbert/Documents/GitHub/Flow/docs/verification/staging-facility-switch-roles-20260303-162715.md
 ELIFECYCLE  Command failed with exit code 1.

```

### Threshold Trigger Evidence Across Roles

- Command: `pnpm staging:proof:threshold-alerts`
- Result: FAIL
- Exit code: 1
- Duration: 334ms

#### Stdout

```text

> flow-backend@0.1.0 staging:proof:threshold-alerts /Users/gregorygabbert/Documents/GitHub/Flow
> tsx scripts/staging-threshold-evidence.ts

 ELIFECYCLE  Command failed with exit code 1.

```

#### Stderr

```text
Error: 500 Internal Server Error /auth/context: Rate limit exceeded, retry in 42 seconds
    at requestJson (/Users/gregorygabbert/Documents/GitHub/Flow/scripts/staging-threshold-evidence.ts:97:11)
    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    at async main (/Users/gregorygabbert/Documents/GitHub/Flow/scripts/staging-threshold-evidence.ts:279:23)

```

