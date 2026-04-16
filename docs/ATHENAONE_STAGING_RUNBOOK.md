# AthenaOne Staging Runbook

This runbook closes the operational gap between the existing AthenaOne connector code and an actual pilot-ready staging dry run.

## Scope

- Facility-level AthenaOne connector setup in the Admin Console
- Secret-preserving save/update flow
- Connector test
- Non-destructive sync preview
- Expected outputs, failure handling, and evidence capture

This does not enable live schedule ingestion by itself. It validates the current config + sync-hook slice that the app already implements.

## Required Inputs

Provide the same values listed in [NEEDS_FROM_YOU.md](NEEDS_FROM_YOU.md):

1. `baseUrl`
2. `practiceId`
3. One auth method:
   - API key: `apiKey` and optionally `apiKeyHeader` / `apiKeyPrefix`
   - Basic auth: `username` + `password`
   - OAuth2: `accessToken` and/or `clientId` + `clientSecret`
4. `departmentIds`
5. Optional overrides:
   - `testPath`
   - `previewPath`
   - custom header mappings if Athena staging requires them

## Admin Console Setup

Open:

- `Admin Console`
- `Incoming Uploads / EHR`
- `AthenaOne Connector (Config + Sync Hooks)`

Populate:

1. `Base URL`
2. `Practice ID`
3. `Department IDs`
4. `Auth Type`
5. The relevant auth secret fields
6. `Timeout (ms)`
7. `Retry Count`
8. `Retry Backoff (ms)`
9. `Test Path`
10. `Preview Path`

Recommended staging defaults:

1. `Timeout`: `7000`
2. `Retry Count`: `2`
3. `Retry Backoff`: `400`
4. `Test Path`: `/`
5. `Preview Path`: `/`

## Expected Save Behavior

1. Save does not echo secrets back into the UI.
2. Secret rows show as configured via the `Saved in vault: Yes/No` indicators.
3. Partial updates must preserve previously stored secrets if the user leaves those fields blank.

## Connection Test Procedure

1. Save the connector settings.
2. Press `Test Connection`.
3. Expected result:
   - `Last test: ok`
   - message includes HTTP status and duration
4. Failure result:
   - `Last test: error`
   - message includes the returned HTTP failure summary or timeout/auth failure

## Sync Preview Procedure

1. Confirm the facility is selected correctly.
2. Press `Sync Preview`.
3. Expected result:
   - `Last preview sync: ok`
   - preview rows render in the Incoming Uploads area without creating live encounters
4. Failure result:
   - `Last preview sync: error`
   - message includes the remote failure summary

## Mapping Expectations

The current preview mapper looks for these concepts:

1. Clinic / department
2. Patient ID / MRN
3. Appointment time
4. Provider last name
5. Reason for visit

If Athena staging uses different keys, update the mapping fields in the connector UI before retrying preview.

## Evidence Capture for Pilot Readiness

Save the following in `docs/verification/` after a live staging dry run:

1. Connector config save timestamp
2. Successful `Test Connection` result
3. Successful `Sync Preview` result
4. Count of preview rows returned
5. Any field mapping adjustments required

The staging validation report should reference this runbook and the evidence file produced by:

`pnpm pilot:validate:staging`

## Failure Triage

If `Test Connection` fails:

1. Verify `baseUrl` and `practiceId`
2. Confirm the auth mode matches the provided credentials
3. Confirm any required Athena staging path overrides
4. Increase timeout only if the remote environment is known to be slow
5. Do not rotate or paste secrets into logs

If `Sync Preview` fails:

1. Confirm `previewPath`
2. Confirm department scoping
3. Review returned payload shape
4. Adjust field mappings to match the remote keys
5. Retry preview before attempting any manual import workaround

## Exit Criteria

This slice is staging-ready when all of the following are true:

1. Connector saves successfully with secrets preserved
2. `Test Connection` passes
3. `Sync Preview` returns valid preview rows
4. Evidence is captured in `docs/verification/`
5. Remaining live onboarding inputs stay tracked in `docs/NEEDS_FROM_YOU.md`
