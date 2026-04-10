# Entra Local Auth Verification — April 9, 2026

## Completed

1. Local backend auth was switched to JWT validation against the Microsoft Entra tenant.
2. Frontend login was configured to default to Microsoft Entra.
3. Local Flow pilot users were synced to the provided Entra Object IDs.
4. A missing `FrontDeskCheckOut` Flow user was created and mapped.
5. Local verification confirmed all six pilot roles authenticate successfully through `/auth/context` using Entra-style `oid` claims.

## Commands Run

```bash
pnpm auth:sync:entra
pnpm auth:verify:entra-local
pnpm lint
pnpm typecheck
pnpm test
pnpm build
cd "docs/Flow Frontend" && pnpm build
```

## Result Summary

- `auth:sync:entra`: PASS
- `auth:verify:entra-local`: PASS
- `pnpm lint`: PASS
- `pnpm typecheck`: PASS
- `pnpm test`: PASS
- `pnpm build`: PASS
- frontend `pnpm build`: PASS

## Role Mapping Summary

- Admin -> `admin@clinicos1.onmicrosoft.com`
- FrontDeskCheckIn -> `frontdesk@clinicos1.onmicrosoft.com`
- MA -> `ma@clinicos1.onmicrosoft.com`
- Clinician -> `clinician@clinicos1.onmicrosoft.com`
- FrontDeskCheckOut -> `checkout@clinicos1.onmicrosoft.com`
- RevenueCycle -> `revenue@clinicos1.onmicrosoft.com`

## Remaining Manual Step

A real browser sign-in against the live Entra tenant still needs to be completed by a human user with the actual Microsoft account credentials and any required MFA. The code and local env are ready for that test.

## Remaining External Inputs

1. Staging redirect URI once staging exists.
2. Live staging proof using real Entra sign-in.
3. AthenaOne staging onboarding inputs.
