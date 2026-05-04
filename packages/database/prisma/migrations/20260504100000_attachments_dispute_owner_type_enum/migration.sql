-- =====================================================
-- GarageOS — migration 0009
-- Add enum value AttachmentOwnerType.intervention_dispute
--
-- Postgres restriction: a newly added enum value cannot be used in the
-- same transaction that adds it (PG ≤ 14 strict; PG ≥ 12 in some
-- contexts). Prisma migrate wraps each migration file in BEGIN/COMMIT,
-- so we ship the ALTER TYPE in its own migration. Migration 0010
-- (which references the new value in CHECK + RLS) ships next.
-- =====================================================

ALTER TYPE "AttachmentOwnerType" ADD VALUE 'intervention_dispute';
