// Pure serializer for GET /v1/me/interventions/:id (F-CLI-206). The route
// resolves the Prisma rows and passes them here so this stays DB-free and
// unit-testable. camelCase wire shape, consistent
// with the other /me endpoints. interventionDate is @db.Date -> emitted
// date-only (YYYY-MM-DD), never a full ISO timestamp (see feedback
// db_date_serialized_as_iso, PR #156).

import {
  normalizePartsReplaced,
  serializeChecklistItems,
  type PartReplaced,
} from './intervention-shared.js';

// A deadline this intervention generated (Deadline.sourceInterventionId).
// dueDate is @db.Date → emitted date-only; cancelled deadlines are filtered
// out by the route query, so this only carries actionable/history rows.
export interface RawSourceDeadlineRow {
  id: string;
  dueDate: Date | null;
  dueOdometerKm: number | null;
  description: string | null;
  status: string;
  interventionType: { code: string; nameIt: string };
}

export interface RawInterventionRow {
  id: string;
  vehicleId: string;
  interventionDate: Date;
  odometerKm: number;
  description: string;
  partsReplaced: unknown;
  status: string;
  interventionType: { code: string; nameIt: string };
  tenant: { businessName: string };
  sourceDeadlines: RawSourceDeadlineRow[];
  checklistSelections: {
    checklistItemId: string | null;
    labelSnapshot: string;
    sortOrderSnapshot: number | null;
  }[];
}

export interface RawDisputeRow {
  id: string;
  reasonCategory: string;
  customerDescription: string;
  status: string;
  createdAt: Date;
  tenantResponse: string | null;
  tenantResponseAt: Date | null;
  resolvedAt: Date | null;
}

export interface ShopInterventionDetailDto {
  intervention: {
    id: string;
    vehicleId: string;
    interventionDate: string;
    odometerKm: number;
    type: { code: string; name_it: string };
    checklistItems: { id: string | null; label: string }[];
    description: string;
    partsReplaced: PartReplaced[];
    partsReplacedCount: number;
    status: string;
    isDisputed: boolean;
    tenant: { businessName: string };
    generatedDeadlines: Array<{
      id: string;
      type: { code: string; name_it: string };
      dueDate: string | null;
      dueOdometerKm: number | null;
      description: string | null;
      status: string;
    }>;
  };
  disputes: Array<{
    id: string;
    reasonCategory: string;
    customerDescription: string;
    status: string;
    createdAt: string;
    tenantResponse: string | null;
    tenantResponseAt: string | null;
    resolvedAt: string | null;
  }>;
}

export function projectShopInterventionDetail(
  row: RawInterventionRow,
  disputes: RawDisputeRow[],
): ShopInterventionDetailDto {
  const parts = normalizePartsReplaced(row.partsReplaced);
  return {
    intervention: {
      id: row.id,
      vehicleId: row.vehicleId,
      interventionDate: row.interventionDate.toISOString().slice(0, 10),
      odometerKm: row.odometerKm,
      type: { code: row.interventionType.code, name_it: row.interventionType.nameIt },
      // BR-308 / BR-303: checklist items are part of the shared maintenance
      // logbook (like partsReplaced), read from the frozen snapshot rather
      // than the live catalog — mirrors interventions-detail.ts:114-118.
      checklistItems: serializeChecklistItems(row.checklistSelections),
      description: row.description,
      partsReplaced: parts,
      partsReplacedCount: parts.length,
      status: row.status,
      isDisputed: row.status === 'disputed',
      tenant: { businessName: row.tenant.businessName },
      generatedDeadlines: row.sourceDeadlines.map((d) => ({
        id: d.id,
        type: { code: d.interventionType.code, name_it: d.interventionType.nameIt },
        dueDate: d.dueDate ? d.dueDate.toISOString().slice(0, 10) : null,
        dueOdometerKm: d.dueOdometerKm,
        description: d.description,
        status: d.status,
      })),
    },
    disputes: disputes.map((d) => ({
      id: d.id,
      reasonCategory: d.reasonCategory,
      customerDescription: d.customerDescription,
      status: d.status,
      createdAt: d.createdAt.toISOString(),
      tenantResponse: d.tenantResponse,
      tenantResponseAt: d.tenantResponseAt ? d.tenantResponseAt.toISOString() : null,
      resolvedAt: d.resolvedAt ? d.resolvedAt.toISOString() : null,
    })),
  };
}
