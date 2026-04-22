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

RLS is **recommended** and **not yet enabled by default** — enabling it requires
an application-side session GUC set per transaction, which is a wider refactor.
Below is the migration SQL to apply when ready; it is additive and idempotent.

### Design
- The app sets a session GUC `app.current_facility_id` at the start of each
  transaction (via `SET LOCAL app.current_facility_id = '<uuid>'`).
- Each tenant-scoped table has a policy that requires `facility_id = current_setting('app.current_facility_id')::uuid`.
- A privileged role (`flow_admin`) bypasses RLS for migrations and maintenance.

### Migration SQL (apply after wiring the session GUC)
```sql
-- Enable RLS on core tenant-scoped tables.
ALTER TABLE "Patient"                         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Encounter"                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RevenueCase"                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IncomingSchedule"                ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Task"                            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RoomIssue"                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog"                        ENABLE ROW LEVEL SECURITY;

-- Policies: facility scope.
CREATE POLICY patient_facility_scope ON "Patient"
  USING ("facilityId" = current_setting('app.current_facility_id', true)::text);

CREATE POLICY encounter_facility_scope ON "Encounter"
  USING (
    EXISTS (
      SELECT 1 FROM "Clinic" c
      WHERE c.id = "Encounter"."clinicId"
        AND c."facilityId" = current_setting('app.current_facility_id', true)::text
    )
  );

CREATE POLICY revenue_case_facility_scope ON "RevenueCase"
  USING ("facilityId" = current_setting('app.current_facility_id', true)::text);

CREATE POLICY incoming_facility_scope ON "IncomingSchedule"
  USING ("facilityId" = current_setting('app.current_facility_id', true)::text);

CREATE POLICY task_facility_scope ON "Task"
  USING ("facilityId" = current_setting('app.current_facility_id', true)::text);

CREATE POLICY room_issue_facility_scope ON "RoomIssue"
  USING (
    EXISTS (
      SELECT 1 FROM "ClinicRoom" r
      WHERE r.id = "RoomIssue"."roomId"
        AND r."facilityId" = current_setting('app.current_facility_id', true)::text
    )
  );

CREATE POLICY audit_facility_scope ON "AuditLog"
  USING ("facilityId" = current_setting('app.current_facility_id', true)::text);

-- Bypass role for migrations/maintenance.
CREATE ROLE flow_admin NOLOGIN BYPASSRLS;
GRANT flow_admin TO <migration-login>;
```

### Application wiring (deferred)
Wrap every request's Prisma work in a transaction that first runs
`SET LOCAL app.current_facility_id = <uuid>`. Pseudocode:

```ts
async function withFacilityScope<T>(facilityId: string, work: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_facility_id', ${facilityId}, true)`;
    return work(tx);
  });
}
```

This is a meaningful surgery because many routes use `prisma.*` directly
without an outer transaction. Track enabling RLS as a follow-up after the
P3 milestone.

## Frontend considerations

`localStorage` is currently used for some client state. Before any PHI lands
client-side, apply:

- Never store PHI in `localStorage`.
- Session-scoped fields (tokens) go in memory or a `sessionStorage` cleared on
  logout.
- Any PHI shown in the UI must also be redacted from browser devtools
  network logs — confirm by inspecting the Chrome DevTools network tab under
  a test patient.
