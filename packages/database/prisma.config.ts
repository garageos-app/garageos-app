import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

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
    url: env('DIRECT_URL'),
  },
});
