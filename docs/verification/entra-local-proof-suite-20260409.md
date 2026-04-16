# Entra Local Proof Suite

- Date: 2026-04-09
- Scope: local Microsoft Entra pilot authentication and local equivalents of the remaining role/facility/threshold proof items.

## Evidence

- Pilot user sync and OID mapping: [entra-local-auth-20260409.md](entra-local-auth-20260409.md)
- Browser redirect wiring: [entra-browser-redirect-20260409.md](entra-browser-redirect-20260409.md)
- Role-by-role facility switching: [staging-facility-switch-roles-20260409-122526.md](staging-facility-switch-roles-20260409-122526.md)
- Threshold alerts across all roles: [staging-threshold-evidence-20260412-122358.md](staging-threshold-evidence-20260412-122358.md)

## Result

- Local Entra bearer verification: PASS for all six pilot roles.
- Browser redirect to Microsoft Entra authorize endpoint: PASS.
- Local role-by-role facility switching: PASS for all six pilot roles.
- Local threshold alert fanout: PASS for all six pilot roles.

## Remaining Manual / Environment-Dependent Steps

- A human must complete an actual Microsoft sign-in and MFA flow in the browser.
- A staging hostname is still needed before staging redirect URIs can be registered.
- True staging proof still depends on staging API base URL, role tokens or live Entra sessions, and AthenaOne staging credentials.
