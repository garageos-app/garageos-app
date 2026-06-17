export type MeVehicleSummary = {
  id: string;
  garageCode: string | null;
  vin: string;
  plate: string;
  plateCountry: string;
  make: string;
  model: string;
  year: number;
  vehicleType: string;
  fuelType: string;
  status: 'pending' | 'certified' | 'archived' | (string & {});
  currentOwnership: { id: string; startedAt: string };
};

export type MeVehiclesListResponse = {
  data: MeVehicleSummary[];
  meta: { has_more: boolean; cursor?: string };
};

export type MeVehicleDetail = {
  vehicle: {
    id: string;
    garageCode: string | null;
    vin: string;
    plate: string;
    plateCountry: string;
    make: string;
    model: string;
    version: string | null;
    year: number;
    registrationDate: string | null;
    vehicleType: string;
    fuelType: string;
    engineDisplacement: number | null;
    powerKw: number | null;
    color: string | null;
    status: 'pending' | 'certified' | 'archived' | (string & {});
    certifiedAt: string | null;
    createdAt: string;
  };
  currentOwnership: { id: string; startedAt: string };
};

export type TimelineItem =
  | {
      kind: 'shop_intervention';
      id: string;
      intervention_date: string;
      odometer_km: number;
      type: { id: string; code: string; name_it: string };
      title: string;
      description: string | null;
      parts_replaced_count: number;
      status: string;
      is_disputed: boolean;
      wiki_window_open: boolean;
      tenant: { business_name: string; location_city: string };
      has_attachments: boolean;
      attachments_count: number;
    }
  | {
      kind: 'private_intervention';
      id: string;
      intervention_date: string;
      odometer_km: number;
      custom_type: string | null;
      description: string | null;
      has_attachments: boolean;
      attachments_count: number;
    };

// POST /v1/me/vehicles/claim response (F-CLI-101). The vehicle projection is
// claimVehicleSelect server-side; only vehicle.id is consumed by the UI today.
export type ClaimVehicleResponse = {
  vehicle: {
    id: string;
    garageCode: string;
    make: string;
    model: string;
    year: number | null;
    plate: string | null;
  };
  ownership: { id: string; startedAt: string };
  status: 'claimed' | 'already_owned';
};

// POST /v1/me/vehicles/pending request/response (F-CLI-104 customer
// pre-registration). plateCountry is not sent by the client — the API
// defaults it to 'IT'. Pending vehicles have no garageCode yet.
//
// version / registrationDate / engineDisplacement / powerKw / color are
// optional owner-declared technical fields: a pre-registering owner may copy
// them off their carta di circolazione. They stay non-authoritative until a
// workshop certifies the vehicle (BR-003/BR-004). Sent only when non-empty.
export type CreatePendingVehicleRequest = {
  vin: string;
  plate: string;
  make: string;
  model: string;
  year: number;
  vehicleType: string;
  fuelType: string;
  version?: string;
  registrationDate?: string; // YYYY-MM-DD
  engineDisplacement?: number;
  powerKw?: number;
  color?: string;
};

export type CreatePendingVehicleResponse = {
  vehicle: {
    id: string;
    garageCode: null;
    vin: string;
    plate: string;
    plateCountry: string;
    make: string;
    model: string;
    year: number;
    vehicleType: string;
    fuelType: string;
    status: 'pending';
  };
  ownership: { id: string; startedAt: string };
};

export type TimelineResponse = {
  data: TimelineItem[];
  meta: {
    has_more: boolean;
    cursor?: string;
    total_interventions: number;
    shop_count: number;
    private_count: number;
  };
};
