# Revenue Cockpit MVP Verification - 2026-04-17

## Figma-first UI sources
- File: `0WCFA2eqweqfW5I0ErsqqC`
- Page: `Revenue Ops MVP` (`4:2`)
- Frames used during implementation:
  - `Revenue / Work Queues` (`4:49`)
  - `Revenue / Day Close` (`4:105`)
  - `Admin / Revenue Settings` (`4:155`)
  - Added during this refinement:
    - `Card / Athena revenue monitoring import` (`5:2`)
  - Additional supporting frames created on the same page:
    - `Revenue / Overview` (`4:3`)
    - `Revenue / History` (`4:118`)
    - `Encounter / Revenue Read-Only View` (`4:135`)
    - `Clinician / Revenue Clarification Response` (`4:145`)

## Implemented in this slice
- Revenue cockpit now reads queue state from `RevenueCase` APIs instead of task text.
- Revenue dashboard exposes visit-based and dollar-based same-day collection metrics.
- Revenue work queues use a list + drawer model aligned to the Figma frames.
- Drawer tabs now support:
  - insurance readiness with quiet prior-auth/referral defaults
  - normalized checkout collection tracking with settings-backed reasons
  - structured diagnosis and procedure line editing with modifiers and units
  - manual Athena handoff confirmation with explicit Flow/Athena boundary copy
  - activity and provider clarification resolution
- Soft day close captures owner, unresolved reason, next action, due date, and rollover choice.
- Admin console includes facility-scoped revenue settings for taxonomy, SLA defaults, query templates, Athena link template, and checklist defaults.
- Admin console now supports Athena revenue monitoring preview/import using the configured `revenuePath`, with matched-row visibility before import.
- Clinicians can respond to open revenue clarifications directly from encounter detail.
- RevenueCycle encounter review remains read-only.
- Revenue dashboard and history now consume imported Athena monitoring values when available:
  - charge entered date
  - claim submitted date
  - days to submit
  - days in A/R
  - claim status
  - patient balance
- Revenue history now returns supervisor-oriented summaries for:
  - unfinished queues
  - common unresolved reasons
  - unfinished owners
  - unfinished providers
  - clinic pressure

## Verification results
Passed:
- `pnpm typecheck`
- `pnpm test`
- `pnpm lint`
- `pnpm build`
- `pnpm -C "docs/Flow Frontend" build`
- `pnpm frontend:verify-live`

Notes:
- `frontend:verify-live` passed with the local backend running on `http://127.0.0.1:4000`.
- Authenticated frontend checks were skipped because no local `VITE_DEV_USER_ID` / `FRONTEND_DEV_USER_ID` or bearer-token auth variables were set in the shell.
