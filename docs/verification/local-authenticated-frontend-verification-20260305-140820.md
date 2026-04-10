# Local Authenticated Frontend Verification

Date: 2026-03-05 local verification run
Environment: local backend at `http://localhost:4000`
Auth mode: dev header (`x-dev-user-id` + `x-dev-role`)
Admin user id: `d37760d3-f107-4e92-a38c-6ef801481366`

## Commands
1. `cd "docs/Flow Frontend" && VITE_API_BASE_URL=http://localhost:4000 VITE_DEV_USER_ID=d37760d3-f107-4e92-a38c-6ef801481366 VITE_DEV_ROLE=Admin pnpm test:contract`
2. `cd "docs/Flow Frontend" && VITE_API_BASE_URL=http://localhost:4000 VITE_DEV_USER_ID=d37760d3-f107-4e92-a38c-6ef801481366 VITE_DEV_ROLE=Admin pnpm test:e2e-live`
3. `cd "docs/Flow Frontend" && VITE_API_BASE_URL=http://localhost:4000 VITE_DEV_USER_ID=d37760d3-f107-4e92-a38c-6ef801481366 VITE_DEV_ROLE=Admin pnpm test:e2e-browser`

## Results
- Contract checks: passed
- Live role-board encounter flow e2e: passed
- Browser role-flow regression checks: passed

## Notes
- These checks ran against the live local API and SQLite seed data, not auth-skip mode.
- Staging-only proof remains separately blocked by missing staging API URL and bearer/role tokens.
