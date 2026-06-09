import type { Prisma } from '@garageos/database';

// Select shared by every /me/transfers response. No recipient PII: in the
// physical_code flow toCustomerId is null until acceptance (PR2), and even
// later BR-045/BR-151 keep the other party's anagrafica hidden.
export const TRANSFER_SELECT = {
  id: true,
  vehicleId: true,
  method: true,
  status: true,
  transferCode: true,
  expiresAt: true,
  completedAt: true,
  rejectedReason: true,
  createdAt: true,
  vehicle: { select: { plate: true, make: true, model: true } },
} as const satisfies Prisma.VehicleTransferSelect;

type TransferRow = Prisma.VehicleTransferGetPayload<{ select: typeof TRANSFER_SELECT }>;

export interface TransferDto {
  id: string;
  vehicleId: string;
  vehicle: { plate: string; make: string; model: string };
  method: string;
  status: string;
  transferCode: string | null;
  expiresAt: string;
  createdAt: string;
  completedAt?: string;
  rejectedReason?: string;
}

// DB enum TransferMethod describes WHO initiated; the client speaks the
// API-facing method (HOW the recipient is reached). Only initiated_by_seller
// reaches this serializer in the customer flow -> expose it as physical_code.
function mapMethod(method: string): string {
  return method === 'initiated_by_seller' ? 'physical_code' : method;
}

export function serializeTransfer(row: TransferRow): TransferDto {
  const dto: TransferDto = {
    id: row.id,
    vehicleId: row.vehicleId,
    vehicle: { plate: row.vehicle.plate, make: row.vehicle.make, model: row.vehicle.model },
    method: mapMethod(row.method),
    status: row.status,
    transferCode: row.transferCode,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
  if (row.completedAt) dto.completedAt = row.completedAt.toISOString();
  if (row.rejectedReason) dto.rejectedReason = row.rejectedReason;
  return dto;
}
