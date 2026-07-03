import type { Prisma } from '@garageos/database';
import { z } from 'zod';

// DTOs for the platform-admin intervention-type catalog CRUD
// (GET/POST/PATCH/DELETE /v1/admin/intervention-types). See BR-306:
// catalogo scrivibile solo dal platform admin (requirePlatformAdminsPool +
// RLS is_admin_role()).
//
// This differs from the officine-facing catalog select in
// packages/api/src/routes/v1/intervention-types.ts:
//   - includes inactive rows (admin manages the whole catalog)
//   - includes _count.checklistItems (surfaced as checklistItemCount)
//   - no `custom` derived flag (admin only manages GLOBAL rows, tenantId
//     is never selected/exposed here)
//
// CHECKLIST_ITEM_ADMIN_SELECT / serializeChecklistItemAdmin are also
// defined here (not in a separate file) because Task 2 (admin checklist
// item CRUD) imports them directly — see task-1-brief.md.

export const CodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{0,49}$/, 'Codice non valido: usa lettere maiuscole, cifre e underscore');

export const INTERVENTION_TYPE_ADMIN_SELECT = {
  id: true,
  code: true,
  nameIt: true,
  description: true,
  icon: true,
  suggestsDeadline: true,
  defaultDeadlineMonths: true,
  defaultDeadlineKm: true,
  active: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { checklistItems: true } },
} as const satisfies Prisma.InterventionTypeSelect;

type InterventionTypeAdminRow = Prisma.InterventionTypeGetPayload<{
  select: typeof INTERVENTION_TYPE_ADMIN_SELECT;
}>;

export type InterventionTypeAdminDto = {
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
  createdAt: Date;
  updatedAt: Date;
};

// Pure: flatten Prisma's _count.checklistItems into checklistItemCount.
export function serializeInterventionTypeAdmin(
  row: InterventionTypeAdminRow,
): InterventionTypeAdminDto {
  const { _count, ...rest } = row;
  return { ...rest, checklistItemCount: _count.checklistItems };
}

export const CHECKLIST_ITEM_ADMIN_SELECT = {
  id: true,
  interventionTypeId: true,
  code: true,
  nameIt: true,
  sortOrder: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.InterventionChecklistItemSelect;

export type ChecklistItemAdminDto = Prisma.InterventionChecklistItemGetPayload<{
  select: typeof CHECKLIST_ITEM_ADMIN_SELECT;
}>;

// Pure: the checklist-item select already matches the response shape 1:1 —
// this identity function exists so callers have a single stable import
// (consistent with serializeInterventionTypeAdmin) and so a future shape
// change only needs one edit site.
export function serializeChecklistItemAdmin(row: ChecklistItemAdminDto): ChecklistItemAdminDto {
  return row;
}
