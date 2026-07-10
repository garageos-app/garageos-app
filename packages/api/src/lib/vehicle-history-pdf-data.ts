import type { Prisma } from '@garageos/database';
import { z } from 'zod';

import { normalizePartsReplaced, serializeChecklistItems } from './intervention-shared.js';
import type { VehicleHistoryInterventionData } from './vehicle-history-pdf-renderer.js';

// Shared data-building for the vehicle-history PDF renderer, used by all three
// callers: the officina full-history export (vehicles-export-pdf), the customer
// export (me-vehicles-export-pdf), and the single-intervention export
// (interventions-pdf). Centralising the Prisma select + row→DTO map here keeps
// the three routes from drifting when the renderer's data shape changes.

// Prisma select for the intervention rows the renderer consumes. `tenantId` is
// included for the officina exports (grouped/anonymous modes group/label by it);
// the customer 'inline' export selects it too but the renderer ignores it there.
export const historyInterventionSelect = {
  interventionDate: true,
  odometerKm: true,
  description: true,
  partsReplaced: true,
  tenantId: true,
  checklistSelections: {
    select: { checklistItemId: true, labelSnapshot: true, sortOrderSnapshot: true },
    orderBy: [{ sortOrderSnapshot: 'asc' }, { labelSnapshot: 'asc' }],
  },
  interventionType: { select: { nameIt: true } },
  tenant: { select: { businessName: true } },
} satisfies Prisma.InterventionSelect;

type HistoryInterventionRow = Prisma.InterventionGetPayload<{
  select: typeof historyInterventionSelect;
}>;

// Map a selected intervention row to the renderer DTO. BR-303/308: checklist
// labels come from the frozen snapshot (label_snapshot/sort_order_snapshot),
// already sorted by the shared serializer — never a live catalog join.
export function buildVehicleHistoryInterventionDto(
  row: HistoryInterventionRow,
): VehicleHistoryInterventionData {
  return {
    interventionDate: row.interventionDate.toISOString().slice(0, 10),
    odometerKm: row.odometerKm,
    typeName: row.interventionType.nameIt,
    tenantName: row.tenant.businessName,
    tenantId: row.tenantId,
    checklistItems: serializeChecklistItems(row.checklistSelections).map((c) => c.label),
    description: row.description,
    partsReplaced: normalizePartsReplaced(row.partsReplaced),
  };
}

// `show_names` query param shared by the officina PDF exports (vehicles-export-pdf,
// interventions-pdf): `true` prints the officina name, `false` is anonymous.
export const pdfShowNamesQuerySchema = z.object({
  show_names: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});
