// Request body for POST /v1/me/vehicles/:id/private-interventions and PATCH
// /v1/me/private-interventions/:id. XOR: a catalog type sends
// intervention_type_id + checklist_item_ids (custom_type null); the free-text
// "Altro" path sends custom_type and omits checklist_item_ids.
export type CreatePrivateInterventionBody = {
  intervention_date: string; // YYYY-MM-DD
  odometer_km: number | null;
  intervention_type_id: string | null;
  custom_type: string | null;
  description: string;
  checklist_item_ids?: string[];
};

// Frozen checklist snapshot returned on the detail DTO. `id` is the catalog
// checklistItemId, nullable if the catalog row was later deleted (BR-303
// onDelete: SetNull). `label` is the frozen snapshot label.
export type PrivateInterventionChecklistItem = { id: string | null; label: string };

// snake_case response (serializer projectDetail).
export type PrivateInterventionDetail = {
  id: string;
  vehicle_id: string;
  intervention_date: string;
  odometer_km: number | null;
  type: { id: string; name_it: string } | null;
  custom_type: string | null;
  description: string;
  checklist_items: PrivateInterventionChecklistItem[];
  created_at: string;
  updated_at: string;
};

// GET /v1/me/intervention-types — the customer-facing global catalog (PR-1).
// Deadline fields are intentionally absent (private interventions have no
// deadline logic). checklist_items are pre-filtered active + BR-305 server-side.
export type MeInterventionChecklistItem = {
  id: string;
  code: string;
  name_it: string;
  sort_order: number;
};

export type MeInterventionType = {
  id: string;
  code: string;
  name_it: string;
  icon: string | null;
  checklist_items: MeInterventionChecklistItem[];
};

export type MeInterventionTypesResponse = { data: MeInterventionType[] };
