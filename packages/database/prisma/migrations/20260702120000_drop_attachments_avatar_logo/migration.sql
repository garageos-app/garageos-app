-- Contract migration — arc "remove uploads and S3" (PR4).
-- All readers/writers of these objects were removed in PR1 (#240), PR2 (#241)
-- and PR3 (#242); this drops the now-orphaned DB objects. Operator-driven with
-- DIRECT_URL (NOT in deploy.yml). Portable: no ROLE/DATABASE hardcoded.
--
-- The physical S3 bucket (garageos-production-attachments) is deleted in a
-- separate operator step; this migration only touches the database.

ALTER TABLE users   DROP COLUMN avatar_url;
ALTER TABLE tenants DROP COLUMN logo_url;

-- CASCADE removes the dispute_id FK, the indexes (idx_attachments_owner /
-- _tenant / _dispute_id), the CHECK constraints (chk_attachment_size,
-- chk_attachment_owner_consistent) and the RLS policies (attachments_read /
-- _insert / _update) attached to the table.
DROP TABLE attachments CASCADE;

-- Enum is unused once the table (its only consumer) is gone.
DROP TYPE "AttachmentOwnerType";
