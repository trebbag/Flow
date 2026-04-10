# Figma Micro-Parity Pass — March 5, 2026

## Scope

1. Template builder interaction capture
2. Rooming encounter screen capture
3. Ready-for-provider encounter screen capture
4. Clinician / optimizing encounter screen capture
5. Check-out encounter screen capture
6. Board/check-in surface capture coverage

## Verification Commands

1. `cd "/Users/gregorygabbert/Documents/GitHub/Flow/docs/Flow Frontend" && VITE_API_BASE_URL=http://localhost:4000 VITE_DEV_USER_ID=d37760d3-f107-4e92-a38c-6ef801481366 VITE_DEV_ROLE=Admin pnpm test:visual`
2. `cd "/Users/gregorygabbert/Documents/GitHub/Flow/docs/Flow Frontend" && VITE_API_BASE_URL=http://localhost:4000 VITE_DEV_USER_ID=d37760d3-f107-4e92-a38c-6ef801481366 VITE_DEV_ROLE=Admin node ./scripts/capture-figma-parity.mjs`

## Results

- `test:visual`: PASS
- `capture-figma-parity.mjs`: PASS
- Capture bundle: `docs/verification/figma-parity-20260305-141255`
- `skippedScreens`: `[]`

## Harness Fixes Applied

1. Decoded `import.meta.url` with `fileURLToPath(...)` so the script resolves `docs/Flow Frontend` correctly on paths containing spaces.
2. Hardened preview startup to run through a shell command path instead of assuming a parent `pnpm` process context.

## Artifacts Captured

- `admin-templates-tab.png`
- `admin-template-modal.png`
- `checkin-page.png`
- `clinician-board.png`
- `checkout-page.png`
- `encounter-rooming.png`
- `encounter-ready-provider.png`
- `encounter-optimizing.png`
- `encounter-checkout.png`
