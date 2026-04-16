# Flow

Flow is a clinical operations workflow application for ambulatory care teams. It supports front desk intake, MA rooming, clinician workflow, checkout, room readiness, task routing, reporting, and Entra-backed authentication for staged pilot environments.

This repository contains:

- A Fastify + Prisma backend
- A React + Vite frontend in [`docs/Flow Frontend`](docs/Flow%20Frontend)
- SQLite-first local development with PostgreSQL staging support
- Deployment, pilot, and security runbooks under [`docs`](docs)

## Highlights

- Encounter lifecycle: `Incoming -> Lobby -> Rooming -> ReadyForProvider -> Optimizing -> CheckOut -> Optimized`
- Room operations: Day Start / Day End, readiness gating, turnover, holds, room issues, room analytics
- Role-based workflows: Front Desk Check-In, MA, Clinician, Front Desk Check-Out, Office Manager, Revenue Cycle, Admin
- Admin tooling: facilities, clinics, reasons, templates, assignments, temporary coverage, archived encounter recovery
- Microsoft Entra-first auth for staging and pilot hardening

## Tech Stack

- Backend: Fastify, TypeScript, Prisma, Zod
- Frontend: React, Vite, TypeScript, Radix UI, MUI
- Data: SQLite for local development, PostgreSQL for staging/pilot readiness
- Testing: Vitest, browser/live verification scripts, staging GitHub Actions workflows

## Repository Structure

- [`src`](src): backend application source
- [`tests`](tests): backend tests
- [`scripts`](scripts): operational scripts and verification tooling
- [`prisma`](prisma): Prisma schemas and seed data
- [`docs/Flow Frontend`](docs/Flow%20Frontend): frontend application
- [`docs`](docs): deployment, security, migration, and pilot documentation

## Quick Start

### 1. Install dependencies

```bash
pnpm install
pnpm -C "docs/Flow Frontend" install
```

### 2. Configure local environment

```bash
cp .env.example .env
cp "docs/Flow Frontend/.env.example" "docs/Flow Frontend/.env"
```

### 3. Prepare the database

```bash
pnpm db:push
pnpm db:seed
```

### 4. Run the app

Backend only:

```bash
pnpm dev
```

Backend + frontend:

```bash
pnpm dev:all
```

Default backend URL: `http://localhost:4000`

## Common Commands

Backend:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm db:push`
- `pnpm db:seed`
- `pnpm frontend:verify-live`

Frontend:

- `pnpm -C "docs/Flow Frontend" dev`
- `pnpm -C "docs/Flow Frontend" build`
- `pnpm -C "docs/Flow Frontend" test:contract`
- `pnpm -C "docs/Flow Frontend" test:e2e-live`
- `pnpm -C "docs/Flow Frontend" test:e2e-browser`

## Authentication

Local development supports explicit dev-header auth and JWT-backed auth depending on environment configuration.

Staging and pilot direction is Entra-first:

- backend auth mode: JWT
- frontend sign-in: Microsoft redirect flow
- authorization: Flow database roles and scope

See:

- [`docs/ENTRA_LOGIN_SETUP.md`](docs/ENTRA_LOGIN_SETUP.md)
- [`docs/AZURE_STAGING_SETUP.md`](docs/AZURE_STAGING_SETUP.md)
- [`docs/PILOT_DATA_GOVERNANCE.md`](docs/PILOT_DATA_GOVERNANCE.md)

## Deployment and Operations

Key runbooks:

- [`docs/DEPLOYMENT_RUNBOOK.md`](docs/DEPLOYMENT_RUNBOOK.md)
- [`docs/POSTGRES_MIGRATION.md`](docs/POSTGRES_MIGRATION.md)
- [`docs/AZURE_STAGING_RECOVERY_GUIDE.md`](docs/AZURE_STAGING_RECOVERY_GUIDE.md)
- [`docs/ATHENAONE_STAGING_RUNBOOK.md`](docs/ATHENAONE_STAGING_RUNBOOK.md)

## Verification

Baseline verification for this repo:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm -C "docs/Flow Frontend" build
```

## Security Note

- Do not commit local `.env` files, generated build artifacts, local database files, or verification tokens.
- If you are preparing the repository for broader sharing, review [`docs/NEEDS_FROM_YOU.md`](docs/NEEDS_FROM_YOU.md) for any follow-up secret rotation or environment actions.
- Reporting guidance and setup expectations are also documented in [`SECURITY.md`](SECURITY.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md).
