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
