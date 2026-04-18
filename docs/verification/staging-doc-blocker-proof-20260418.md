# Staging Proof: Documentation-Incomplete Revenue Blocker - 2026-04-18

## Scope
- Environment: staging
- Frontend: `https://orange-beach-0851cdc0f.6.azurestaticapps.net`
- API: `https://flow-staging-api-esgxesfjhnenabg7.centralus-01.azurewebsites.net`
- Facility: `Optimum Health`
- Clinic: `Team A`

## Objective
Prove the intended workflow where:
- the clinician can move the encounter forward with real diagnosis and procedure codes even when documentation is still incomplete
- checkout can still be completed
- Revenue then inherits `documentation_incomplete` as the blocker
- Day Close defaults the unresolved reason and next action from that documentation blocker

## Setup Notes
- The staging PostgreSQL schema had drift and was brought back in sync before proof.
- `Team A` clinic assignment had a missing `providerId` even though `providerUserId` existed; that assignment was repaired in staging before proof.
- At proof time, the original rooms were not reusable because prior proof encounters stayed marked as occupying Room 2 and Room 3, so a temporary active room named `Proof Room` was added to Team A to finish the validation.
- Post-proof cleanup on April 18, 2026 removed the synthetic proof encounters, cleared `Team A / Room 2` and `Room 3`, and removed `Proof Room`.

## Proof Encounter
- Encounter ID: `08ef6983-7276-48f0-abb7-1109cad80238`
- Patient ID: `ZZ-STAGE-DOC-1776520879664`
- Reason for visit: `Acute`

## Verified Results

### 1. Clinician can proceed before documentation is complete
Confirmed in the deployed staging encounter screen:
- clinician entered real working codes in Flow:
  - diagnosis: `J01.90`
  - procedure: `99213`
- clinician left `Documentation Complete` set to `No`
- clinician warning appeared explaining checkout can continue while Revenue remains blocked downstream
- encounter advanced from `Optimizing` to `CheckOut`

### 2. Checkout tracking can be completed without Athena data
Confirmed in staging API:
- checkout tracking was completed in Flow using structured checkout data
- encounter advanced from `CheckOut` to `Optimized`
- no Athena data was required to continue the time-of-service workflow

### 3. Revenue inherits the correct blocker after checkout tracking is complete
Confirmed in staging API:
- `currentRevenueStatus = CodingReviewInProgress`
- `currentWorkQueue = ChargeCapture`
- `currentDayBucket = Today`
- `currentBlockerCategory = documentation_incomplete`
- `currentBlockerText = Clinician marked documentation incomplete. Revenue cannot fully close Athena handoff until documentation is complete.`

### 4. Revenue Cycle UI shows the documentation blocker
Confirmed in the deployed staging frontend by loading the Revenue Cycle page directly into `Work Queues -> Charge Capture`:
- the proof encounter appears in the queue
- the queue card shows the documentation blocker
- the drawer summary shows:
  - charge capture queue
  - documentation complete = `No - still blocks handoff`
  - expected gross charge
  - Athena fields as `Not yet synced from Athena`

### 5. Day Close defaults from the documentation blocker
Confirmed in the deployed staging frontend `Day Close` view:
- default reason not completed:
  - `Clinician marked documentation incomplete. Revenue cannot fully close Athena handoff until documentation is complete.`
- default next action:
  - `Follow up with the clinician to complete documentation, then finish Athena handoff.`

## Athena Validation Status
Athena monitoring/import was validated only up to connector readiness.

Current staging state for the main facility:
- Athena connector exists but is unconfigured
- `enabled = false`
- `baseUrl` missing
- `practiceId` missing
- `previewPath` missing
- `revenuePath` missing

Result:
- connector test validation is blocked by missing config
- revenue-monitoring preview/import is blocked by missing config
- this is not currently a code failure; it is a staging configuration gap

## Issues Uncovered During Proof

### Room release follow-up
Staging room operations still need broader live validation:
- the stale proof-room residue that originally forced use of `Proof Room` has now been cleaned up
- the remaining work is to validate room operations through broader real-role staging usage, not to clean synthetic residue

This does not block the documentation-blocker workflow itself, but broader room-operations proof is still part of pilot validation.

### Revenue page proof harness brittleness
The first proof harness assumed:
- a hardcoded room
- a single advance button
- `networkidle` page navigation for revenue views

Those assumptions were too brittle for staging and had to be adapted during proof. The product code path was still validated successfully after those harness adjustments.

## Bottom Line
Pass:
- clinicians can proceed toward checkout before documentation is complete
- Flow can complete same-day time-of-service RCM steps without Athena data
- once checkout tracking is complete, Revenue correctly inherits the documentation blocker
- Revenue Cycle and Day Close both surface that blocker and default the follow-up reason/action from it

Still outstanding before broader pilot proof:
- configure the Athena staging connector
- validate room-release behavior in live staging workflows
- continue broader real role-by-role staging proof
