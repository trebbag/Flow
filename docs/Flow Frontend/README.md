# Flow Frontend

This directory contains the React frontend for Flow.

## What It Covers

- Front desk intake and incoming schedule handling
- MA board and rooming workflow
- Clinician workflow
- Checkout and closeout flows
- Admin console, room operations, analytics, alerts, and tasks
- Microsoft Entra redirect-based sign-in for staging-ready environments

## Development

Install dependencies:

```bash
pnpm install
```

Create a local environment file:

```bash
cp .env.example .env
```

Run the frontend:

```bash
pnpm dev
```

Build for production:

```bash
pnpm build
```

## Useful Scripts

- `pnpm build`
- `pnpm test:contract`
- `pnpm test:visual`
- `pnpm test:e2e-live`
- `pnpm test:e2e-browser`
- `pnpm test:bundle-budget`

## Environment

Common variables:

- `VITE_API_BASE_URL`
- `VITE_DEV_USER_ID`
- `VITE_DEV_ROLE`
- `VITE_ENTRA_TENANT_ID`
- `VITE_ENTRA_CLIENT_ID`
- `VITE_ENTRA_API_SCOPE`
- `VITE_DEFAULT_AUTH_MODE`

Keep local `.env` files out of version control. Use `.env.example` as the template.
