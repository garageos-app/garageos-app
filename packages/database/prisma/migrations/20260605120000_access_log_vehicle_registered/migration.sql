-- F-CLI-304 — vehicle registration is a distinct audit event from an
-- intervention create. The customer audit (BR-155) surfaces intervention
-- 'create' as "new intervention"; without a separate action the two are
-- indistinguishable in access_logs (no row-level discriminator).
-- ALTER TYPE ADD VALUE is not transactional in Postgres; Prisma migrate
-- applies it in a dedicated migration with no other DDL.
ALTER TYPE "AccessLogAction" ADD VALUE 'vehicle_registered';
