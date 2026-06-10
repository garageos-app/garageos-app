// Mirror of the API TransferDto (api/src/lib/dtos/transfer.ts). api/mobile do
// not share a package, so the shape is mirrored by hand (parity is enforced by
// the API integration tests on the serializer side).

export type TransferStatus =
  | 'pending_recipient'
  | 'pending_seller_confirmation'
  | 'pending_validation'
  | 'completed'
  | 'rejected'
  | 'expired';

export interface TransferVehicle {
  plate: string;
  make: string;
  model: string;
}

export interface Transfer {
  id: string;
  vehicleId: string;
  vehicle: TransferVehicle;
  method: string;
  status: TransferStatus;
  transferCode: string | null;
  expiresAt: string;
  createdAt: string;
  completedAt?: string;
  rejectedReason?: string;
}

export interface TransfersListResponse {
  data: Transfer[];
}

export interface TransferResponse {
  transfer: Transfer;
}
