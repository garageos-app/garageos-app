// TS types + error-code map for the platform-admin intervention catalog pages
// (Task 3: CatalogoInterventi list/CRUD; Task 4: detail page + checklist items).
// Mirrors packages/api/src/lib/dtos/intervention-type-admin.ts response shapes.

// `as const` tuple (not just a typed array) so it can be passed directly to
// z.enum(CATEGORY_VALUES) in the validator — z.enum needs the literal tuple,
// not a widened string[] type.
export const CATEGORY_VALUES = [
  'maintenance',
  'repair',
  'tires',
  'body',
  'inspection',
  'other',
] as const;

export type InterventionCategory = (typeof CATEGORY_VALUES)[number];

export const CATEGORY_LABELS: Record<InterventionCategory, string> = {
  maintenance: 'Manutenzione',
  repair: 'Riparazione',
  tires: 'Gomme',
  body: 'Carrozzeria',
  inspection: 'Revisione',
  other: 'Altro',
};

// GET/POST/PATCH /v1/admin/intervention-types response item.
export interface InterventionTypeAdmin {
  id: string;
  code: string;
  nameIt: string;
  description: string | null;
  icon: string | null;
  category: InterventionCategory;
  suggestsDeadline: boolean;
  defaultDeadlineMonths: number | null;
  defaultDeadlineKm: number | null;
  active: boolean;
  checklistItemCount: number;
  createdAt: string;
  updatedAt: string;
}

// GET/POST/PATCH /v1/admin/intervention-types/:id/checklist-items response item
// (reused by Task 4's checklist item CRUD on the detail page).
export interface ChecklistItemAdmin {
  id: string;
  interventionTypeId: string;
  code: string;
  nameIt: string;
  sortOrder: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// Error-code → Italian message map for catalog CRUD mutations.
// Mirrors the ACTION_ERROR_MESSAGES pattern in tenant-actions.ts.
export const CATALOG_ERROR_MESSAGES: Record<string, string> = {
  'admin.intervention_type.code_conflict': 'Codice tipo già esistente.',
  'admin.intervention_type.in_use': 'Tipo in uso: disattivalo dalla modifica invece di eliminarlo.',
  'admin.intervention_type.not_found': 'Tipo non trovato.',
};

export const GENERIC_CATALOG_ERROR = 'Operazione non riuscita. Riprova.';
