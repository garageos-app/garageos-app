import { z } from 'zod';

// DTOs and wire-shape helpers for the platform-admin per-tenant catalog
// visibility endpoints (GET/PUT /v1/admin/tenants/:tenantId/catalog-visibility).
//
// BR-304 (opt-out model): every GLOBAL intervention type / checklist item is
// visible to every tenant by default. A tenant only loses visibility on a
// type/item when an explicit row exists in
// tenant_intervention_type_exclusions / tenant_checklist_item_exclusions —
// there is no per-tenant "opt-in" concept. `visible` in the DTO below is
// therefore always the negation of "id is present in the exclusion set":
// `visible = !excluded`.

export type ChecklistItemVisibilityDto = {
  id: string;
  code: string;
  nameIt: string;
  sortOrder: number;
  visible: boolean;
};

export type InterventionTypeVisibilityDto = {
  id: string;
  code: string;
  nameIt: string;
  visible: boolean;
  checklistItems: ChecklistItemVisibilityDto[];
};

// Shape returned by the GET query — active global types with their active
// checklist items, ordered per the brief (nameIt asc / sortOrder asc, nameIt asc).
export type CatalogVisibilitySourceType = {
  id: string;
  code: string;
  nameIt: string;
  checklistItems: Array<{
    id: string;
    code: string;
    nameIt: string;
    sortOrder: number;
  }>;
};

// Pure: fold the two exclusion Sets into the `visible` flag on every type
// and checklist item.
export function serializeCatalogVisibility(
  types: CatalogVisibilitySourceType[],
  excludedTypeIds: Set<string>,
  excludedItemIds: Set<string>,
): InterventionTypeVisibilityDto[] {
  return types.map((type) => ({
    id: type.id,
    code: type.code,
    nameIt: type.nameIt,
    visible: !excludedTypeIds.has(type.id),
    checklistItems: type.checklistItems.map((item) => ({
      id: item.id,
      code: item.code,
      nameIt: item.nameIt,
      sortOrder: item.sortOrder,
      visible: !excludedItemIds.has(item.id),
    })),
  }));
}

// PUT body: both arrays are always required (never a partial/empty-body
// concern — the caller always sends the full desired exclusion set for an
// atomic replace).
export const PutVisibilityBody = z
  .object({
    excludedTypeIds: z.array(z.string().uuid()),
    excludedItemIds: z.array(z.string().uuid()),
  })
  .strict();

export type PutVisibilityBodyType = z.infer<typeof PutVisibilityBody>;
