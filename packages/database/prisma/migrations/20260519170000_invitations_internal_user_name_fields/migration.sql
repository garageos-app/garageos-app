-- F-OFF-004: add first/last name columns to invitations for internal_user
-- invites (pre-fill on accept page). Nullable so existing customer_app
-- rows are unaffected.

ALTER TABLE invitations
  ADD COLUMN first_name VARCHAR(100),
  ADD COLUMN last_name  VARCHAR(100);
