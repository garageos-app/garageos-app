-- BR-308: remove the free-text intervention "title" entirely. The title was
-- superseded by the coarse intervention type + checklist snapshot (arc
-- 2026-07, PRs #244-#253). By this point no application code reads or writes
-- it: all select/DTO/notification references were removed in this PR's
-- contract step (interventions-recent, interventions-cancel, create/update
-- notification inputs, intervention-created email template, InterventionForEmail).
-- Destructive contract migration (owner-approved 2026-07-06): drop the column.
-- Operator-applied via `db:migrate:deploy` (DIRECT_URL); deploy.yml ships CDK only.
ALTER TABLE "interventions" DROP COLUMN "title";
