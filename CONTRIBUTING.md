# Contributing

Thanks for contributing to Flow.

## Development Workflow

1. Install dependencies:

```bash
pnpm install
pnpm -C "docs/Flow Frontend" install
```

2. Create local environment files from the checked-in examples:

```bash
cp .env.example .env
cp "docs/Flow Frontend/.env.example" "docs/Flow Frontend/.env"
```

3. Initialize local data:

```bash
pnpm db:push
pnpm db:seed
```

4. Run the application:

```bash
pnpm dev:all
```

## Before Opening a PR

Run the baseline verification commands from the repository root:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm -C "docs/Flow Frontend" build
```

If your change touches live verification, authentication, or staging workflows, also run:

```bash
pnpm frontend:verify-live
```

## Standards

- Keep secrets out of git. Use the existing `.env.example` files as templates.
- Prefer incremental, production-ready changes that include tests and documentation updates.
- When a change needs user-side setup, document it in `docs/NEEDS_FROM_YOU.md`.
- Avoid committing generated build output, local databases, or verification artifacts.

## Pull Request Guidance

- Explain the user-facing problem and the operational impact.
- Call out any schema, auth, deployment, or migration implications.
- Include screenshots or verification notes for UI-heavy changes when helpful.
