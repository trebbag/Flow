# Entra Browser Redirect Check

- Date: 2026-04-09
- Frontend URL: http://localhost:5173/login
- Result: PASS
- Check performed: selected `Microsoft Entra` on the login screen and continued into the hosted authorization redirect.
- Redirect host: `login.microsoftonline.com`
- Tenant ID in authorize URL: `b9b1d566-d7ed-44a4-b3cc-cf8786d6a6ed`
- Client ID in authorize URL: `020f7909-e66e-4ec8-810b-cfdf58e70014`
- API scope in authorize URL: `api://89658fe4-9844-439a-97b0-ee31ace455da/access_as_user`
- Local redirect URI in authorize URL: `http://localhost:5173/login`

## Remaining Manual Step

A real browser sign-in still requires an interactive Microsoft account login and MFA from a pilot user. The app-side redirect wiring is correct; the remaining unverified step is the human sign-in itself.
