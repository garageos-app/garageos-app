-- BR-226 v1.3 / H1: rename email.new_intervention -> email.intervention_updates
-- and push.new_intervention -> push.intervention_updates.
-- Semantica: la toggle ora governa l'intero lifecycle dell'intervention
-- (create + revision + cancel) anziche' la sola creazione. Vedi spec H1
-- (docs/superpowers/specs/2026-05-08-h1-instant-email-notifications-design.md).
--
-- Idempotente: se il payload non contiene la vecchia chiave (rows con
-- prefs={} o nuove dopo questo deploy), la WHERE clause skippa la riga.
--
-- IMPORTANT: usiamo jsonb_set sopra il valore gia' "stripped" via #-, in una
-- singola espressione. NON usiamo il pattern `original #- key || jsonb_build_object(...)`
-- perche' l'operatore `||` fa shallow-merge top-level e RHS leggerebbe nuovamente
-- la colonna ORIGINALE (con la vecchia chiave ancora presente), facendo
-- sopravvivere `new_intervention` accanto a `intervention_updates` nel risultato.

UPDATE customers
SET notification_preferences = jsonb_set(
  notification_preferences #- '{email,new_intervention}',
  '{email,intervention_updates}',
  to_jsonb(COALESCE((notification_preferences->'email'->>'new_intervention')::boolean, true)),
  true
)
WHERE notification_preferences->'email' ? 'new_intervention';

UPDATE customers
SET notification_preferences = jsonb_set(
  notification_preferences #- '{push,new_intervention}',
  '{push,intervention_updates}',
  to_jsonb(COALESCE((notification_preferences->'push'->>'new_intervention')::boolean, true)),
  true
)
WHERE notification_preferences->'push' ? 'new_intervention';
