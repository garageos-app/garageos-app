-- Remove the intervention-type "category" concept entirely.
-- Interventions are not tied to categories (owner decision, 2026-07-03);
-- the field was display/ordering-only with no business-rule dependency.
-- Destructive contract migration (owner-approved): drop the column, then the
-- now-unused enum type. Operator-applied via `db:migrate:deploy` (DIRECT_URL);
-- deploy.yml ships CDK only.
ALTER TABLE "intervention_types" DROP COLUMN "category";

DROP TYPE "InterventionTypeCategory";
