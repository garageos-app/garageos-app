export type VehicleStatus = 'pending' | 'certified' | 'archived';
export type VehicleType = 'auto' | 'moto' | 'commercial' | 'agricultural';
export type FuelType = 'gasoline' | 'diesel' | 'lpg' | 'cng' | 'electric' | 'hybrid';

export interface MaskedCustomer {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
}

export interface CurrentOwnership {
  id: string;
  startedAt: string;
  customer: MaskedCustomer | null;
}

export interface VehicleSearchItem {
  id: string;
  garageCode: string;
  vin: string;
  plate: string;
  plateCountry: string;
  make: string;
  model: string;
  year: number;
  vehicleType: VehicleType;
  fuelType: FuelType;
  status: VehicleStatus;
  currentOwnership: CurrentOwnership | null;
}

export interface VehicleSearchResponse {
  data: VehicleSearchItem[];
  meta: { has_more: boolean; cursor?: string };
}

export interface VehicleDetail {
  id: string;
  garageCode: string;
  vin: string;
  plate: string;
  plateCountry: string;
  make: string;
  model: string;
  version: string | null;
  year: number;
  registrationDate: string | null;
  vehicleType: VehicleType;
  fuelType: FuelType;
  engineDisplacement: number | null;
  powerKw: number | null;
  color: string | null;
  status: VehicleStatus;
  certifiedAt: string | null;
  certifiedByTenantId: string | null;
  createdAt: string;
}

export interface VehicleDetailResponse {
  vehicle: VehicleDetail;
  currentOwnership: CurrentOwnership | null;
}

// Backend (api/src/routes/v1/vehicles-timeline.ts) emits a snake_case
// discriminated union by `kind`. Keep the shape verbatim here — the
// consumer narrows via `kind` and reads the appropriate fields.

export interface ShopTimelineItem {
  kind: 'shop_intervention';
  id: string;
  intervention_date: string;
  odometer_km: number;
  type: { code: string; name_it: string };
  title: string | null;
  description: string;
  parts_replaced_count: number;
  status: string;
  is_disputed: boolean;
  tenant: { business_name: string; location_city: string };
  has_attachments: boolean;
  attachments_count: number;
}

export interface PrivateTimelineItem {
  kind: 'private_intervention';
  id: string;
  intervention_date: string;
  odometer_km: number;
  custom_type: string | null;
  description: string;
  has_attachments: boolean;
  attachments_count: number;
}

export type TimelineItem = ShopTimelineItem | PrivateTimelineItem;

export interface TimelineResponse {
  data: TimelineItem[];
  meta: {
    has_more: boolean;
    cursor?: string;
    total_interventions?: number;
    shop_count?: number;
    private_count?: number;
  };
}

export type InterventionTypeCategory =
  | 'maintenance'
  | 'tires'
  | 'repair'
  | 'inspection'
  | 'body'
  | 'other';

export interface InterventionType {
  id: string;
  code: string;
  nameIt: string;
  description: string;
  icon: string;
  category: InterventionTypeCategory;
  suggestsDeadline: boolean;
  defaultDeadlineMonths: number | null;
  defaultDeadlineKm: number | null;
  custom: boolean;
}

export interface InterventionTypesResponse {
  data: InterventionType[];
}

export interface CreateInterventionResponse {
  intervention: {
    id: string;
    vehicleId: string;
    interventionTypeId: string;
    interventionDate: string;
    odometerKm: number;
    title: string | null;
    description: string;
    status: string;
    kmAnomaly: boolean;
    interventionType: { id: string; code: string; nameIt: string };
  };
  deadline: {
    id: string;
    dueDate: string | null;
    dueOdometerKm: number | null;
    interventionTypeId: string;
    status: string;
  } | null;
}

// Returned by /v1/customers/search (PR #77). Tenant-scoped: every row
// is by construction related to the calling tenant, so PII is fully
// visible (no `redacted` discriminator like MaskedCustomer).
export interface Customer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  isBusiness: boolean;
  businessName: string | null;
  vatNumber: string | null;
  status: 'active';
}

export interface CustomerSearchResponse {
  data: Customer[];
  meta: { has_more: boolean; cursor?: string };
}

// /v1/deadlines (officina-side aggregate, F-OFF-402).
//
// `customer` follows the same MaskedCustomer shape used by
// vehicles/search: when BR-151 redacts PII, the JSON has no
// firstName/lastName fields (the type allows nullable for runtime
// truthy-check ergonomics). Mirror VehicleResultCard's pattern:
// `customer && customer.firstName && customer.lastName ? ... : '—'`.
export type DeadlineStatus = 'open' | 'completed' | 'overdue' | 'cancelled';

export interface TenantDeadlineCustomer {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  isBusiness: boolean | null;
  businessName: string | null;
  vatNumber: string | null;
}

export interface TenantDeadlineVehicle {
  id: string;
  plate: string;
  make: string;
  model: string;
  currentOwnership: { customer: TenantDeadlineCustomer | null } | null;
}

export interface TenantDeadline {
  id: string;
  vehicleId: string;
  interventionTypeId: string;
  dueDate: string | null;
  dueOdometerKm: number | null;
  description: string | null;
  isRecurring: boolean;
  status: DeadlineStatus;
  vehicle: TenantDeadlineVehicle;
  interventionType: { id: string; code: string; nameIt: string };
}

export interface DeadlinesListResponse {
  deadlines: TenantDeadline[];
  nextCursor: string | null;
}

// /v1/customers/:id detail (officina-side, BR-151 enforced via 404).
// Shape mirrors packages/api/src/lib/customer-detail-shared.ts.
export interface CustomerDetail {
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

// PATCH body: every field optional. Email is intentionally absent
// (officina cannot change customer login identity — see APPENDICE_A §2.10).
export type CustomerDetailUpdate = Partial<{
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
  tenantNotes: string | null;
}>;

// /v1/interventions/:id/disputes — F-OFF-602 read companion (PR #82).
// Mirror del DTO emesso da packages/api/src/routes/v1/interventions-disputes-list.ts.
export type DisputeReasonCategory = 'not_performed' | 'wrong_data' | 'not_authorized' | 'other';

export type DisputeStatus =
  | 'open'
  | 'responded'
  | 'resolved_by_cancellation'
  | 'escalated'
  | 'closed_by_admin';

export interface InterventionDispute {
  id: string;
  reasonCategory: DisputeReasonCategory;
  customerDescription: string;
  status: DisputeStatus;
  tenantResponse: string | null;
  tenantResponseAt: string | null;
  tenantResponseUser: { firstName: string; lastName: string } | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface InterventionDisputesResponse {
  disputes: InterventionDispute[];
}

// POST /v1/interventions/:id/dispute-response request body (PR #28). UI
// resta singola-dispute (sempre disputeId; multi-dispute fanout out of scope).
export interface DisputeResponseRequest {
  disputeId: string;
  tenantResponse: string;
}

// Response del POST dispute-response.
export interface DisputeResponseResult {
  disputes: InterventionDispute[];
  interventionStatus: 'active' | 'disputed';
}
