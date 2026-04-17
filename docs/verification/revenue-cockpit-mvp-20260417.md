# Revenue Cockpit MVP Verification - 2026-04-17

## Figma-first UI sources
- File: `0WCFA2eqweqfW5I0ErsqqC`
- Page: `Revenue Ops MVP` (`4:2`)
- Frames used during implementation and final parity review:
  - `Revenue / Work Queues` (`4:49`)
  - `Admin / Revenue Settings` (`4:155`)
  - `Encounter / Revenue Read-Only View` (`4:135`)
  - Supporting frames on the same page:
    - `Revenue / Overview` (`4:3`)
    - `Revenue / Day Close` (`4:105`)
    - `Revenue / History` (`4:118`)
    - `Clinician / Revenue Clarification Response` (`4:145`)
    - `Card / Athena revenue monitoring import` (`5:2`)

## Implemented in this slice
- Revenue cockpit now reads queue state from `RevenueCase` APIs instead of task text.
- Revenue dashboard exposes visit-based and dollar-based same-day collection metrics.
- Revenue dashboard now exposes a second expectation track for Flow-only expected gross charges without depending on Athena data.
- Revenue work queues use a list + drawer model aligned to the Figma frames.
- Drawer tabs now support:
  - insurance readiness with quiet prior-auth/referral defaults
  - normalized checkout collection tracking with settings-backed reasons
  - structured diagnosis and procedure line editing with modifiers and units
  - MA service-capture visibility and expected-charge contribution
  - manual Athena handoff confirmation with explicit Flow/Athena boundary copy
  - activity and provider clarification resolution
- Encounter rooming now includes structured MA service capture with facility-scoped catalog items plus an "other service" path.
- Clinician coding handoff continues to seed revenue charge capture, while revenue finalizes the coded line set before Athena handoff.
- Clinician optimizing now uses structured ICD-10 and CPT/HCPCS entry instead of free-text coding notes, with:
  - code-chip entry
  - local lookup/search suggestions
  - MA service-capture-driven procedure suggestions
  - advance-to-checkout gating when no diagnosis code, no procedure code, or no documentation-complete flag is present
- Revenue checklist completion is now explicit across financial readiness, checkout tracking, charge capture, Athena handoff, and day close.
- Soft day close captures owner, unresolved reason, next action, due date, and rollover choice.
- Admin console includes facility-scoped revenue settings for taxonomy, SLA defaults, query templates, Athena link template, checklist defaults, MA service catalog, and Flow charge schedule.
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
  - expected-gross-charge and handoff-lag trend context

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
- The seeded service catalog and charge schedule currently provide working default expected-charge math for local proof, but pilot-ready values still need facility confirmation in admin settings.
- Existing facility revenue settings now inherit newly seeded default service-catalog and charge-schedule rows automatically when those rows are missing, so older local/staging data picks up common time-of-service defaults without a destructive reset.

## Follow-up verification after clinician coding hardening
- Structured clinician code lookup/search and stricter optimizing handoff validation were added after the initial revenue-cockpit pass.
- Local checks still pass for:
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test`
  - `pnpm build`
  - `pnpm -C "docs/Flow Frontend" build`
- `pnpm frontend:verify-live` is currently just over the frontend bundle budget after that continuation:
  - total JS gzip: `446.42KB`
  - budget: `445KB`
- Authenticated frontend checks still skip locally without dev-user or bearer-token auth env.
