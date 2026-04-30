-- ----------------------------------------------------------------------------
-- Migration: 20260430120000_create_garageos_app_role
--
-- Goal: introdurre il ruolo least-privilege `garageos_app` per il runtime
--       Lambda. Il ruolo è creato NOLOGIN con password placeholder; l'operatore
--       imposta la password reale e flippa LOGIN via SQL Editor (vedi
--       `infrastructure/README.md` -> "Runtime DB role rotation runbook").
--
-- Idempotency: il blocco DO controlla l'esistenza prima del CREATE; GRANT
--              e REVOKE sono naturalmente idempotenti in Postgres; ALTER
--              DEFAULT PRIVILEGES dedupa.
--
-- Invarianti preservate: RLS, FORCE RLS, trigger anti-audit-modification,
--                        connection adapter, schema, policy split SELECT/WRITE.
--
-- Cluster: hardening PR 2 di 5.
-- ----------------------------------------------------------------------------

-- 1. Role creation (NOLOGIN until operator sets real password via runbook)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'garageos_app') THEN
    CREATE ROLE garageos_app PASSWORD 'rotate-me-immediately' NOLOGIN;
  END IF;
END $$;

-- 2. Schema + connect privileges
GRANT CONNECT ON DATABASE postgres TO garageos_app;
GRANT USAGE ON SCHEMA public TO garageos_app;

-- 3. Blanket CRUD on existing tables in `public`
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public
  TO garageos_app;

-- 4. REVOKE UPDATE/DELETE on append-only audit tables (defense-in-depth)
REVOKE UPDATE, DELETE
  ON access_logs, audit_logs, intervention_revisions
  FROM garageos_app;

-- 5. EXECUTE on all functions in `public`
--    (current_tenant_id, current_customer_id, is_admin_role, set_app_context,
--     generate_garage_code, assign_garage_code, set_updated_at,
--     prevent_audit_modification)
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO garageos_app;

-- 6. Default privileges per oggetti creati da `postgres` in migration future
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO garageos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO garageos_app;
