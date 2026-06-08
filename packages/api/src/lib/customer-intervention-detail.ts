// Pure serializer for GET /v1/me/interventions/:id (F-CLI-206). The route
// resolves the Prisma rows and the attachments count, then passes them here
// so this stays DB-free and unit-testable. camelCase wire shape, consistent
// with the other /me endpoints. interventionDate is @db.Date -> emitted
// date-only (YYYY-MM-DD), never a full ISO timestamp (see feedback
// db_date_serialized_as_iso, PR #156).

export interface RawInterventionRow {
  id: string;
  vehicleId: string;
  interventionDate: Date;
  odometerKm: number;
  title: string | null;
  description: string;
  partsReplaced: unknown;
  status: string;
  interventionType: { code: string; nameIt: string };
  tenant: { businessName: string };
  location: { city: string } | null;
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
    title: string | null;
    description: string;
    partsReplacedCount: number;
    status: string;
    isDisputed: boolean;
    tenant: { businessName: string; locationCity: string | null };
    attachmentsCount: number;
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
  attachmentsCount: number,
): ShopInterventionDetailDto {
  return {
    intervention: {
      id: row.id,
      vehicleId: row.vehicleId,
      interventionDate: row.interventionDate.toISOString().slice(0, 10),
      odometerKm: row.odometerKm,
      type: { code: row.interventionType.code, name_it: row.interventionType.nameIt },
      title: row.title,
      description: row.description,
      partsReplacedCount: Array.isArray(row.partsReplaced) ? row.partsReplaced.length : 0,
      status: row.status,
      isDisputed: row.status === 'disputed',
      tenant: { businessName: row.tenant.businessName, locationCity: row.location?.city ?? null },
      attachmentsCount,
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
