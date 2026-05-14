export type MeVehicleSummary = {
  id: string;
  garageCode: string;
  vin: string;
  plate: string;
  plateCountry: string;
  make: string;
  model: string;
  year: number | null;
  vehicleType: string;
  fuelType: string;
  status: 'active' | 'sold' | 'scrapped' | string;
  currentOwnership: { id: string; startedAt: string };
};

export type MeVehiclesListResponse = {
  data: MeVehicleSummary[];
  meta: { has_more: boolean; cursor?: string };
};

export type MeVehicleDetail = {
  vehicle: {
    id: string;
    garageCode: string;
    vin: string;
    plate: string;
    plateCountry: string;
    make: string;
    model: string;
    version: string | null;
    year: number | null;
    registrationDate: string | null;
    vehicleType: string;
    fuelType: string;
    engineDisplacement: number | null;
    powerKw: number | null;
    color: string | null;
    status: string;
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
      custom_type: string;
      description: string | null;
      has_attachments: boolean;
      attachments_count: number;
    };

export type TimelineResponse = {
  data: TimelineItem[];
  meta: { has_more: boolean; cursor?: string };
};
