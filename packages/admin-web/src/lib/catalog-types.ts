// TS types + error-code map for the platform-admin intervention catalog pages
// (Task 3: CatalogoInterventi list/CRUD; Task 4: detail page + checklist items).
// Mirrors packages/api/src/lib/dtos/intervention-type-admin.ts response shapes.

// GET/POST/PATCH /v1/admin/intervention-types response item.
export interface InterventionTypeAdmin {
  id: string;
  code: string;
  nameIt: string;
  description: string | null;
  icon: string | null;
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

// Error-code → Italian message map for checklist-item CRUD mutations (Task 4).
// Looked up alongside CATALOG_ERROR_MESSAGES (e.g. the parent-type
// admin.intervention_type.not_found can also surface from the nested
// POST/GET checklist-items routes) — see CatalogoInterventoDetail.tsx.
export const CHECKLIST_ITEM_ERROR_MESSAGES: Record<string, string> = {
  'admin.checklist_item.code_conflict': 'Codice voce già esistente per questo tipo.',
  'admin.checklist_item.not_found': 'Voce non trovata.',
};
