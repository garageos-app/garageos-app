ALTER TABLE interventions DROP COLUMN location_id;
ALTER TABLE deadlines     DROP COLUMN location_id;
ALTER TABLE users         DROP COLUMN location_id;
ALTER TABLE access_logs   DROP COLUMN location_id;
ALTER TABLE invitations   DROP COLUMN location_id;

DROP TABLE locations CASCADE;  -- removes FKs, indexes, RLS policies, updated_at trigger
DROP TYPE "LocationStatus";
