// TS types + error-code map for the platform-admin per-tenant catalog
// visibility page (Task 2). Mirrors packages/api/src/lib/dtos/catalog-visibility.ts
// response shapes (see Task 1, commit 9b201119).

// GET /v1/admin/tenants/:tenantId/catalog-visibility response item — a
// checklist item nested under its parent intervention type.
export interface ChecklistItemVisibility {
  id: string;
  code: string;
  nameIt: string;
  sortOrder: number;
  visible: boolean;
}

// GET /v1/admin/tenants/:tenantId/catalog-visibility response item.
// `visible` means "not excluded for this tenant" — only ACTIVE catalog rows
// are returned (inactive types/items never reach this page).
export interface TypeVisibility {
  id: string;
  code: string;
  nameIt: string;
  visible: boolean;
  checklistItems: ChecklistItemVisibility[];
}

// Error-code → Italian message map for the catalog-visibility PUT mutation.
// Mirrors the ACTION_ERROR_MESSAGES / CATALOG_ERROR_MESSAGES pattern.
export const VISIBILITY_ERROR_MESSAGES: Record<string, string> = {
  'admin.catalog_visibility.tenant_not_found': 'Officina non trovata.',
  'admin.catalog_visibility.invalid_ref':
    'Riferimento a tipo o voce non valido. Ricarica la pagina.',
};

export const GENERIC_VISIBILITY_ERROR = 'Operazione non riuscita. Riprova.';
