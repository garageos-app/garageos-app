import { describe, expect, it } from 'vitest';

import { pgAdmin } from './setup.js';

// sede-unica migration structural tests.
//
// Strategy: OPTION (b) — structural schema assertion.
//
// The integration test harness runs `prisma migrate deploy` which applies
// ALL migrations including the expand (backfill + DROP NOT NULL) and the
// contract (DROP TABLE locations, DROP COLUMN location_id). The final test
// DB therefore has no `locations` table and no `location_id` columns, making
// it impossible to seed a location row via Prisma to exercise the UPDATE
// backfill logic directly.
//
// The backfill correctness (migrating address data from locations → tenants
// for production rows) is instead covered by:
//   - The migration SQL being verbatim from the spec (reviewed in PR).
//   - The prod smoke runbook (manual verification post-deploy).
//
// What we verify here is that BOTH migrations ran to completion and left the
// DB in exactly the expected final state.

describe('sede-unica migration — structural schema assertions', () => {
  it('locations table no longer exists', async () => {
    const { rows } = await pgAdmin.query<{ exists: boolean }>(
      `SELECT to_regclass('public.locations') IS NOT NULL AS exists`,
    );
    expect(rows[0]!.exists).toBe(false);
  });

  it('LocationStatus enum no longer exists', async () => {
    const { rows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pg_type WHERE typname = 'LocationStatus'`,
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('interventions table has no location_id column', async () => {
    const { rows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'interventions'
         AND column_name  = 'location_id'`,
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('deadlines table has no location_id column', async () => {
    const { rows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'deadlines'
         AND column_name  = 'location_id'`,
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('users table has no location_id column', async () => {
    const { rows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'users'
         AND column_name  = 'location_id'`,
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('access_logs table has no location_id column', async () => {
    const { rows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'access_logs'
         AND column_name  = 'location_id'`,
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('invitations table has no location_id column', async () => {
    const { rows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'invitations'
         AND column_name  = 'location_id'`,
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('tenants table retains address columns for the backfilled data', async () => {
    // Verify the target columns that the expand migration writes into
    // still exist and are nullable (they were nullable before migration too).
    const { rows } = await pgAdmin.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'tenants'
         AND column_name IN ('address_line', 'city', 'province', 'postal_code', 'phone')
       ORDER BY column_name`,
    );
    expect(rows).toHaveLength(5);
    for (const col of rows) {
      expect(col.is_nullable).toBe('YES');
    }
  });
});
