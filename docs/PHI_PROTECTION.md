# PHI Protection: Column Encryption + Row-Level Security

Flow layers three defenses on PHI at rest:

1. **Column-level envelope encryption** — AES-256-GCM on `Patient.displayName` and `Patient.dateOfBirth` with a key held in Azure Key Vault.
2. **Row-level security (RLS)** — Postgres policies that refuse cross-tenant `SELECT`/`UPDATE` at the database layer.
3. **Disk-level encryption** — Azure-managed encryption-at-rest on the PostgreSQL Flexible Server tier (see [COMPLIANCE.md](COMPLIANCE.md)).

## Column-level encryption

### Shape
Ciphertext is stored in a sibling column next to the plaintext:

| Plaintext column | Cipher column | Key-id column |
|---|---|---|
| `Patient.displayName` | `Patient.displayNameCipher` | `Patient.cipherKeyId` |
| `Patient.dateOfBirth` | `Patient.dateOfBirthCipher` | `Patient.cipherKeyId` |

Ciphertext format: `v1:<keyId>:<ivB64>:<tagB64>:<ctB64>` (AES-256-GCM, 96-bit IV, 128-bit tag).

### Activation
1. Generate a 32-byte key: `openssl rand -base64 32`.
2. Store as `PHI_ENCRYPTION_KEY` in Azure Key Vault.
3. Reference it from the App Service setting `PHI_ENCRYPTION_KEY` (Key Vault reference, unversioned).
4. Set `PHI_ENCRYPTION_KEY_ID=v1` (or the active version id).
5. Deploy. All subsequent patient writes dual-write ciphertext.
6. Run backfill once to populate ciphers for existing rows: `pnpm phi:backfill`
   (optional dry run: `PHI_BACKFILL_DRY_RUN=1 pnpm phi:backfill`).

### Rotation
See [SECRET_ROTATION.md](SECRET_ROTATION.md#phi_encryption_key-rotation-dual-key-window). The rotation procedure uses a dual-key reader window to avoid data loss.

### Removing plaintext
Once cipher columns are populated and reads have migrated to cipher-first, a
future migration may null out the plaintext columns. Until then, defense-in-depth
is enforced by RLS + disk encryption.

## Row-level security (Postgres)

Flow now includes Postgres RLS wiring in both the application runtime and the
Postgres rollout script. The application enters a facility scope when the user
is authenticated or a facility is resolved, and the Prisma runtime opens a
scoped transaction that sets `app.current_facility_id` before tenant-scoped
queries execute against Postgres.

### Design
- The app sets a session GUC `app.current_facility_id` at the start of each
  Postgres transaction (via `SELECT set_config('app.current_facility_id', '<uuid>', true)`).
- Authenticated request flows establish facility scope before issuing
  tenant-scoped reads or writes.
- Worker flows that operate by facility, such as revenue sync, enter an
  explicit facility scope before processing queued work.
- Each tenant-scoped table has a policy that requires either a direct
  `facilityId` match or a join path back to the scoped facility.
- A privileged role (`flow_admin`) bypasses RLS for migrations and maintenance.

### Rollout status
- Postgres version-bump triggers and RLS policies are installed by
  [`scripts/postgres-push.ts`](../scripts/postgres-push.ts).
- The runtime facility-scope transaction wiring is implemented in
  [`src/lib/prisma.ts`](../src/lib/prisma.ts) and
  [`src/lib/facility-scope.ts`](../src/lib/facility-scope.ts).
- Request-scoped facility selection is entered during auth and facility/clinic
  resolution paths before tenant-scoped Prisma access.

### Policy shape
```sql
-- Direct facility scope.
"facilityId" = current_setting('app.current_facility_id', true)

-- Clinic descendant scope.
EXISTS (
  SELECT 1 FROM "Clinic" c
  WHERE c.id = <table>."clinicId"
    AND c."facilityId" = current_setting('app.current_facility_id', true)
)

-- Room descendant scope.
EXISTS (
  SELECT 1
  FROM "ClinicRoom" r
  JOIN "Clinic" c ON c.id = r."clinicId"
  WHERE r.id = <table>."roomId"
    AND c."facilityId" = current_setting('app.current_facility_id', true)
)
```

### Operational caveats
- RLS is enforced in the Postgres runtime path. Local SQLite development still
  relies on application scope checks plus the existing test harness.
- Array-form Prisma transactions are intentionally rejected in scoped Postgres
  request paths; callback-form transactions are required so the facility GUC can
  be set in-band.
- Migrations, maintenance scripts, and administrative repair work must use the
  privileged bypass role or explicit maintenance clients rather than the normal
  request-scoped runtime path.
- Pilot hardening should still include a live Postgres verification pass that
  proves cross-facility reads fail under the active app role.

## Frontend considerations

`localStorage` is currently used for some client state. Before any PHI lands
client-side, apply:

- Never store PHI in `localStorage`.
- Session-scoped fields (tokens) go in memory or a `sessionStorage` cleared on
  logout.
- Any PHI shown in the UI must also be redacted from browser devtools
  network logs — confirm by inspecting the Chrome DevTools network tab under
  a test patient.
