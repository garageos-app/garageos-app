import { describe, expect, it, beforeEach } from 'vitest';

import { resetDb } from '../helpers.js';
import { pgAdmin } from '../setup.js';

describe('migration 20260508120000 — rename new_intervention to intervention_updates (email + push)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function insertCustomer(prefs: object): Promise<string> {
    const { rows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO customers
         (id, email, first_name, last_name, status, notification_preferences,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'Test', 'Test',
         'active'::"CustomerStatus", $2::jsonb, NOW(), NOW())
       RETURNING id`,
      [`migration-test-${Math.random().toString(36).slice(2)}@test.it`, JSON.stringify(prefs)],
    );
    return rows[0]!.id;
  }

  async function getPrefs(id: string): Promise<unknown> {
    const { rows } = await pgAdmin.query<{ p: unknown }>(
      `SELECT notification_preferences AS p FROM customers WHERE id = $1`,
      [id],
    );
    return rows[0]!.p;
  }

  it('migration already applied — verifies forward state on existing rows', async () => {
    // resetDb runs migrations on a fresh container. Test that the
    // migration produced the expected end state for synthetic seed cases
    // that we insert AFTER reset and then re-run the renaming UPDATE.
    const idEmpty = await insertCustomer({});
    const idOldTrue = await insertCustomer({ email: { new_intervention: true } });
    const idOldFalse = await insertCustomer({ email: { new_intervention: false } });
    const idMixed = await insertCustomer({
      email: { new_intervention: true, deadline_reminder: false },
    });

    // Re-run the renaming step (idempotent SQL — same statement as the
    // migration body).
    await pgAdmin.query(`
      UPDATE customers
      SET notification_preferences = jsonb_set(
        notification_preferences #- '{email,new_intervention}',
        '{email,intervention_updates}',
        to_jsonb(COALESCE((notification_preferences->'email'->>'new_intervention')::boolean, true)),
        true
      )
      WHERE notification_preferences->'email' ? 'new_intervention';
    `);

    expect(await getPrefs(idEmpty)).toEqual({});
    expect(await getPrefs(idOldTrue)).toEqual({ email: { intervention_updates: true } });
    expect(await getPrefs(idOldFalse)).toEqual({ email: { intervention_updates: false } });
    expect(await getPrefs(idMixed)).toEqual({
      email: { intervention_updates: true, deadline_reminder: false },
    });
  });

  it('WHERE clause skips rows already on the new key (no-op on migrated DB)', async () => {
    const id = await insertCustomer({ email: { intervention_updates: true } });

    await pgAdmin.query(`
      UPDATE customers
      SET notification_preferences = jsonb_set(
        notification_preferences #- '{email,new_intervention}',
        '{email,intervention_updates}',
        to_jsonb(COALESCE((notification_preferences->'email'->>'new_intervention')::boolean, true)),
        true
      )
      WHERE notification_preferences->'email' ? 'new_intervention';
    `);

    expect(await getPrefs(id)).toEqual({ email: { intervention_updates: true } });
  });

  it('migration already applied — verifies forward state on push channel', async () => {
    const idOldTrue = await insertCustomer({ push: { new_intervention: true } });
    const idOldFalse = await insertCustomer({ push: { new_intervention: false } });
    const idMixed = await insertCustomer({
      push: { new_intervention: true, deadline_reminder: false },
    });

    // Re-run the renaming step for the push channel (byte-identical to the
    // push UPDATE in migration.sql).
    await pgAdmin.query(`
      UPDATE customers
      SET notification_preferences = jsonb_set(
        notification_preferences #- '{push,new_intervention}',
        '{push,intervention_updates}',
        to_jsonb(COALESCE((notification_preferences->'push'->>'new_intervention')::boolean, true)),
        true
      )
      WHERE notification_preferences->'push' ? 'new_intervention';
    `);

    expect(await getPrefs(idOldTrue)).toEqual({ push: { intervention_updates: true } });
    expect(await getPrefs(idOldFalse)).toEqual({ push: { intervention_updates: false } });
    expect(await getPrefs(idMixed)).toEqual({
      push: { intervention_updates: true, deadline_reminder: false },
    });
  });
});
