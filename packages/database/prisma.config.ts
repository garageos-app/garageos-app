import dotenv from 'dotenv';

// Load .env.local first (takes precedence, Vite/Next convention for
// developer-local overrides), then .env as fallback. dotenv does not
// overwrite variables already set, so ordering here is load-order-sensitive.
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import { defineConfig } from 'prisma/config';

// Prisma 7 CLI configuration.
//
// In Prisma 7 the datasource URL is configured here rather than in
// schema.prisma. The CLI (migrate, generate, studio) uses this
// connection; the application runtime uses its own adapter in
// src/client.ts with DATABASE_URL from env.
//
// We point the CLI at DIRECT_URL because migrations need a direct
// connection (port 5432) — Supabase's transaction pooler (port 6543)
// does not support prepared statements or DDL.
//
// See: docs/APPENDICE_B_DATABASE.md §1.4 and §9.7
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // Seed script lives here as a placeholder only — its implementation
    // (intervention types + dev fixtures) arrives with PR 5.
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Prisma generate (schema-only operation) does not need a real connection,
    // so we fall back to a placeholder when DIRECT_URL is not set.
    // Real migrations (db:migrate:dev, db:migrate:deploy) require DIRECT_URL
    // set via .env locally or via GitHub Actions secrets in CI.
    url: process.env.DIRECT_URL ?? 'postgresql://placeholder:placeholder@localhost:5432/postgres',
  },
});
