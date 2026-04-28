-- F-OFF-602 — dispute response is a discrete audit event distinct from
-- update (PATCH) and cancel (BR-066). Granular accounting helps
-- reconstruct dispute investigation timelines.
-- ALTER TYPE ADD VALUE is not transactional in Postgres; Prisma migrate
-- applies it in a dedicated migration with no other DDL.
ALTER TYPE "AccessLogAction" ADD VALUE 'respond';
