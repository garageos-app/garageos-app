-- Global ordering index for the platform-admin audit viewer's cross-tenant
-- keyset pagination (ORDER BY created_at DESC, id DESC with no tenant filter).
CREATE INDEX IF NOT EXISTS idx_audit_created_at
  ON audit_logs (created_at DESC, id DESC);
