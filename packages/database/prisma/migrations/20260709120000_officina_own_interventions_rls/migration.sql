-- =====================================================
-- GarageOS — migration: officina own-interventions RLS
-- Stringe SELECT su interventions, intervention_revisions e
-- intervention_checklist_selections (il corpo itemizzato
-- dell'intervento, sibling di parts_replaced, con tenant_id NOT NULL) in
-- modo pool-gated: sessione officina (current_tenant_id() valorizzato) vede
-- solo i propri interventi; sessione cliente (current_tenant_id() IS NULL,
-- solo customer_id settato) resta permissiva (privacy app-layer invariata);
-- admin (is_admin_role()) permissivo per le metriche cross-tenant.
-- Deprecazione della semantica "libretto condiviso tra officine"
-- (BR-150/BR-153); il libretto resta condiviso solo verso il cliente.
-- Espansiva: solo DROP/CREATE POLICY, nessun column change.
-- Le altre policy _read (tenants/locations/intervention_types/users/
-- attachments) restano permissive: servono al path cliente cross-officina.
-- =====================================================

DROP POLICY IF EXISTS interventions_read ON interventions;
CREATE POLICY interventions_read ON interventions
FOR SELECT USING (
    is_admin_role()
    OR current_tenant_id() IS NULL
    OR tenant_id = current_tenant_id()
);

DROP POLICY IF EXISTS intervention_revisions_read ON intervention_revisions;
CREATE POLICY intervention_revisions_read ON intervention_revisions
FOR SELECT USING (
    is_admin_role()
    OR current_tenant_id() IS NULL
    OR EXISTS (
        SELECT 1 FROM interventions i
        WHERE i.id = intervention_revisions.intervention_id
          AND i.tenant_id = current_tenant_id()
    )
);

DROP POLICY IF EXISTS selections_read ON intervention_checklist_selections;
CREATE POLICY selections_read ON intervention_checklist_selections
FOR SELECT USING (
    is_admin_role()
    OR current_tenant_id() IS NULL
    OR tenant_id = current_tenant_id()
);
