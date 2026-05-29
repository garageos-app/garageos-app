-- F-OFF-109 / BR-028: tag reprint audit free-text reason note.
-- Spec: docs/superpowers/specs/2026-05-29-F-OFF-109-pr2-tag-reprint-design.md §3.5.
-- Additive column, default NULL. No RLS change required: existing INSERT policy
-- (tenant_id = current_tenant_id()) does not discriminate on per-column basis.

ALTER TABLE "vehicle_tag_prints" ADD COLUMN "reason_note" TEXT;
