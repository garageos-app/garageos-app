# @garageos/database

Prisma schema, generated client, and migrations for GarageOS.

This package is the single source of truth for the database layer: every
other workspace (API, web, mobile) imports `PrismaClient` from here and
runs against the same schema.

## What's in this PR

This is the **scaffold** — schema + generated client + initial
migration only. The following land in a follow-up PR:

- Zod validators (`src/validators/**`)
- RLS policies, triggers, and custom PostgreSQL functions
  (`sql/rls-policies.sql`, `sql/triggers.sql`, `sql/functions.sql`)
- Seed script with the 12 system `intervention_types`
  (`prisma/seed.ts`)
- Test factories and integration test suite

The schema (`prisma/schema.prisma`) is copied verbatim from
[`docs/APPENDICE_B_DATABASE.md`](../../docs/APPENDICE_B_DATABASE.md) §2.1.
Only the `generator` and `datasource` blocks differ to accommodate
Prisma 7 (see _Prisma 7 notes_ below).

## Local setup

```bash
# 1. Install workspace deps (run from repo root)
pnpm install

# 2. Create your local env file (gitignored)
cp packages/database/.env.example packages/database/.env.local
# then edit .env.local with the real Supabase connection strings
```

**Do not commit `.env.local`.** Real connection strings come from
AWS Secrets Manager in production and from `.env.local` in local dev.
The package-level `.gitignore` already blocks both `.env` and `.env.local`.

### Environment variables

Two connection strings are required:

| Var | Purpose | Supabase port |
|---|---|---|
| `DATABASE_URL` | Runtime queries from the app. Hits the Supabase transaction pooler and is pinned via the `?pgbouncer=true` query param. | 6543 |
| `DIRECT_URL` | Prisma CLI for migrations and introspection. Direct session connection — pooler does not support DDL or prepared statements. | 5432 |

See [`docs/APPENDICE_B_DATABASE.md`](../../docs/APPENDICE_B_DATABASE.md) §1.4 and
[`docs/APPENDICE_C_INFRASTRUCTURE.md`](../../docs/APPENDICE_C_INFRASTRUCTURE.md) §6.3 for how these are sourced.

## Scripts

All scripts run through pnpm filters from the repo root, or directly inside this package.

```bash
pnpm --filter @garageos/database db:generate        # regenerate Prisma Client from schema.prisma
pnpm --filter @garageos/database db:migrate:dev     # dev-time: create or apply migrations, generate client
pnpm --filter @garageos/database db:migrate:deploy  # prod: apply pending migrations without prompts
pnpm --filter @garageos/database db:migrate:status  # show which migrations are applied vs pending
pnpm --filter @garageos/database db:studio          # open Prisma Studio UI on the local DB
pnpm --filter @garageos/database typecheck          # tsc --noEmit
```

At the repo root, convenience aliases forward to this package:

```bash
pnpm db:generate
pnpm db:migrate:dev
pnpm db:migrate:deploy
pnpm db:studio
```

## Applying the schema to a fresh database

First-time deploy against a clean Supabase project (see
[`docs/APPENDICE_C_INFRASTRUCTURE.md`](../../docs/APPENDICE_C_INFRASTRUCTURE.md) §6.6):

```bash
# With DATABASE_URL + DIRECT_URL set in the shell or in .env.local
pnpm --filter @garageos/database db:migrate:deploy
```

This applies every migration in `prisma/migrations/` in order. The
initial migration (`20260424070954_init`) creates every table, enum,
index, and foreign key from the schema — it does **not** install RLS
policies, triggers, or seed data; those arrive in a follow-up migration.

## Editing the schema

```bash
# 1. Edit prisma/schema.prisma
# 2. Generate a new migration against your local dev DB
pnpm --filter @garageos/database db:migrate:dev --name descriptive_change_name

# 3. Review the generated SQL under prisma/migrations/<timestamp>_<name>/
# 4. Commit both the schema change and the migration file in the same PR
```

Migrations already applied to production must never be edited
(see [`docs/APPENDICE_B_DATABASE.md`](../../docs/APPENDICE_B_DATABASE.md) §9.7 — expand → migrate → contract
for breaking changes).

## Prisma 7 notes

This package targets Prisma 7. Key deviations from the templates in
APPENDICE_B — which predate Prisma 7 — are:

- **`prisma.config.ts`** replaces the `prisma` block that used to live
  in `package.json`. It's the single place the CLI reads for schema
  location, migrations path, seed script, and the datasource URL.
- **`url` / `directUrl` removed from `schema.prisma`.** In Prisma 7 the
  datasource block carries only the provider; the connection URL for
  the CLI lives in `prisma.config.ts`, and the runtime connection URL
  is handed to the client via a driver adapter.
- **Driver adapter required.** `src/client.ts` builds a `PrismaPg`
  adapter from `@prisma/adapter-pg` and passes it to
  `new PrismaClient({ adapter })`. Calling `new PrismaClient()` without
  an adapter throws on Prisma 7.
- **Generator output path required.** The generated client is emitted
  to `prisma/generated/prisma/client/` (gitignored) instead of
  `node_modules/.prisma/client`. `src/index.ts` re-exports
  `PrismaClient` and the `Prisma` namespace from that location.
- **Node version.** Prisma 7 supports Node 20.19+, 22.12+, or 24+.
  This repo pins Node 22.22.2 via `.nvmrc`; Node 23 (non-LTS) is
  explicitly rejected by the Prisma preinstall script.

A small follow-up PR will update APPENDICE_B with these differences.

## Reference

- Schema source of truth: [`docs/APPENDICE_B_DATABASE.md`](../../docs/APPENDICE_B_DATABASE.md) §2.1
- Business rules that map to DB constraints: [`docs/APPENDICE_F_BUSINESS_LOGIC.md`](../../docs/APPENDICE_F_BUSINESS_LOGIC.md) (BR-001, BR-021, BR-220 enforced at the schema level; BR-020, BR-040, BR-100 arrive as `CHECK` / partial-unique in PR 5)
- Testing strategy for this package: [`docs/APPENDICE_E_TESTING.md`](../../docs/APPENDICE_E_TESTING.md)
