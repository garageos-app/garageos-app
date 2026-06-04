// Request body for POST /v1/me/vehicles/:id/private-interventions. The mobile
// form always sends intervention_type_id: null + free-text custom_type.
export type CreatePrivateInterventionBody = {
  intervention_date: string; // YYYY-MM-DD
  odometer_km: number | null;
  intervention_type_id: string | null;
  custom_type: string | null;
  description: string;
};

// snake_case response (serializer projectDetail).
export type PrivateInterventionDetail = {
  id: string;
  vehicle_id: string;
  intervention_date: string;
  odometer_km: number | null;
  type: { id: string; name_it: string } | null;
  custom_type: string | null;
  description: string;
  created_at: string;
  updated_at: string;
  attachments: unknown[];
};
