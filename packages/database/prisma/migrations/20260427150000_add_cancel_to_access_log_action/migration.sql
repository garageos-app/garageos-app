-- F-OFF-307 — the cancel action is a distinct audit event from
-- update. Audit consumers (ops dashboards, future legal-hold queries)
-- need to count cancellations independently of edits.
-- ALTER TYPE ADD VALUE is not transactional in Postgres; Prisma
-- migrate applies it in a dedicated migration with no other DDL.
ALTER TYPE "AccessLogAction" ADD VALUE 'cancel';
