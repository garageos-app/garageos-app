-- Backfill tenant address from the primary active location, only where the
-- tenant column is NULL (do not overwrite an address the officina already set).
UPDATE tenants t SET
  address_line = COALESCE(t.address_line, l.address_line),
  city         = COALESCE(t.city, l.city),
  province     = COALESCE(t.province, l.province),
  postal_code  = COALESCE(t.postal_code, l.postal_code),
  phone        = COALESCE(t.phone, l.phone)
FROM locations l
WHERE l.tenant_id = t.id
  AND l.deleted_at IS NULL
  AND l.is_primary = true
  AND l.status = 'active';

-- Fallback: tenants without a primary-active location, take any live location.
UPDATE tenants t SET
  address_line = COALESCE(t.address_line, l.address_line),
  city         = COALESCE(t.city, l.city),
  province     = COALESCE(t.province, l.province),
  postal_code  = COALESCE(t.postal_code, l.postal_code),
  phone        = COALESCE(t.phone, l.phone)
FROM locations l
WHERE l.tenant_id = t.id
  AND l.deleted_at IS NULL
  AND t.address_line IS NULL;

-- Drop NOT NULL so the new code can insert interventions/deadlines without it.
ALTER TABLE interventions ALTER COLUMN location_id DROP NOT NULL;
ALTER TABLE deadlines     ALTER COLUMN location_id DROP NOT NULL;
