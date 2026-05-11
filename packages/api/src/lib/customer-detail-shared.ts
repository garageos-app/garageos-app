import type { Prisma } from '@garageos/database';

// Select shape used by both GET and PATCH (after re-query).
// Centralised so the two handlers stay in sync.
export const customerDetailSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  taxCode: true,
  isBusiness: true,
  businessName: true,
  vatNumber: true,
  addressLine: true,
  city: true,
  province: true,
  postalCode: true,
  cognitoSub: true,
  status: true,
  createdAt: true,
  tenantRelations: {
    select: {
      tenantNotes: true,
      interventionCount: true,
      firstInterventionAt: true,
      lastInterventionAt: true,
    },
  },
  ownerships: {
    where: { endedAt: null },
    select: {
      vehicle: {
        select: {
          id: true,
          plate: true,
          make: true,
          model: true,
          year: true,
        },
      },
    },
  },
} as const satisfies Prisma.CustomerSelect;

// Concrete row shape Prisma returns when select=customerDetailSelect.
// The CTR array is filtered to the calling tenant by the where clause
// in the route handler — never empty when the outer find succeeds.
export interface CustomerDetailRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  taxCode: string | null;
  isBusiness: boolean;
  businessName: string | null;
  vatNumber: string | null;
  addressLine: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  cognitoSub: string | null;
  status: 'active' | 'pending_verification' | 'deleted';
  createdAt: Date;
  tenantRelations: Array<{
    tenantNotes: string | null;
    interventionCount: number;
    firstInterventionAt: Date | null;
    lastInterventionAt: Date | null;
  }>;
  ownerships: Array<{
    vehicle: {
      id: string;
      plate: string;
      make: string;
      model: string;
      year: number;
    };
  }>;
}

export interface CustomerDetailDto {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  taxCode: string | null;
  isBusiness: boolean;
  businessName: string | null;
  vatNumber: string | null;
  addressLine: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  cognitoSub: string | null;
  status: 'active';
  createdAt: string;
  tenantRelation: {
    tenantNotes: string | null;
    interventionCount: number;
    firstInterventionAt: string | null;
    lastInterventionAt: string | null;
  };
  vehicles: Array<{
    id: string;
    plate: string;
    make: string;
    model: string;
    year: number;
  }>;
}

export function projectCustomerDetail(row: CustomerDetailRow): CustomerDetailDto {
  // The outer find always filters by tenantRelations.some({tenantId}),
  // so tenantRelations[0] is guaranteed present. Defensive bracket
  // access keeps tsc strict-happy without runtime cost.
  const ctr = row.tenantRelations[0]!;
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    phone: row.phone,
    taxCode: row.taxCode,
    isBusiness: row.isBusiness,
    businessName: row.businessName,
    vatNumber: row.vatNumber,
    addressLine: row.addressLine,
    city: row.city,
    province: row.province,
    postalCode: row.postalCode,
    cognitoSub: row.cognitoSub,
    status: 'active',
    createdAt: row.createdAt.toISOString(),
    tenantRelation: {
      tenantNotes: ctr.tenantNotes,
      interventionCount: ctr.interventionCount,
      firstInterventionAt: ctr.firstInterventionAt?.toISOString() ?? null,
      lastInterventionAt: ctr.lastInterventionAt?.toISOString() ?? null,
    },
    vehicles: row.ownerships.map((o) => ({
      id: o.vehicle.id,
      plate: o.vehicle.plate,
      make: o.vehicle.make,
      model: o.vehicle.model,
      year: o.vehicle.year,
    })),
  };
}
