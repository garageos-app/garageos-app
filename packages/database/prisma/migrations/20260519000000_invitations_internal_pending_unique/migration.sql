-- F-OFF-004 BR-206: ensure at most one pending internal_user invitation per
-- (tenant_id, target_email). Customer-app invitations are intentionally not
-- constrained (BR-205 customer invitation flow allows resend semantics).

CREATE UNIQUE INDEX uq_invitations_pending_internal
  ON invitations (tenant_id, target_email)
  WHERE invitation_type = 'internal_user' AND accepted_at IS NULL;
