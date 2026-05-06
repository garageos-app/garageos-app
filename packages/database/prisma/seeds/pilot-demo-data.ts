import type { FuelType, VehicleType } from '../../src/index.js';

// Static dataset for pilot demo. Deterministic keys (vatNumber, email, vin) so
// the seed is idempotent across re-runs.

export interface DemoCustomer {
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
}

export interface DemoVehicle {
  vin: string;
  plate: string;
  make: string;
  model: string;
  version: string | null;
  year: number;
  fuelType: FuelType;
  vehicleType: VehicleType;
  registrationDate: Date;
  ownerEmail: string;
}

export interface DemoIntervention {
  vehicleVin: string;
  interventionDate: string;
  interventionTypeCode: string;
  title: string;
  description: string;
  odometerKm: number;
  partsReplaced?: Array<{ name: string; code?: string; quantity: number; notes?: string }>;
}

export const TENANT = {
  vatNumber: 'IT00000000000',
  businessName: 'Officina Giuseppe Bianchi',
  email: 'info@demo-giuseppe.test',
};

export const LOCATION = {
  name: 'Sede unica',
  addressLine: 'Via Roma 1',
  city: 'Padova',
  province: 'PD',
  postalCode: '35100',
  country: 'IT',
};

export const CUSTOMERS: DemoCustomer[] = [
  {
    email: 'mario.rossi@demo-giuseppe.test',
    firstName: 'Mario',
    lastName: 'Rossi',
    phone: '+393331112233',
  },
  {
    email: 'luigi.verdi@demo-giuseppe.test',
    firstName: 'Luigi',
    lastName: 'Verdi',
    phone: '+393334445566',
  },
  { email: 'anna.bianchi@demo-giuseppe.test', firstName: 'Anna', lastName: 'Bianchi', phone: null },
];

export const VEHICLES: DemoVehicle[] = [
  {
    vin: 'VINDEMO0000000001',
    plate: 'AB123CD',
    make: 'Fiat',
    model: 'Panda',
    version: '1.2 8V',
    year: 2018,
    fuelType: 'petrol',
    vehicleType: 'car',
    registrationDate: new Date('2018-03-15'),
    ownerEmail: 'mario.rossi@demo-giuseppe.test',
  },
  {
    vin: 'VINDEMO0000000002',
    plate: 'EF456GH',
    make: 'Volkswagen',
    model: 'Golf',
    version: '2.0 TDI',
    year: 2020,
    fuelType: 'diesel',
    vehicleType: 'car',
    registrationDate: new Date('2020-06-10'),
    ownerEmail: 'luigi.verdi@demo-giuseppe.test',
  },
  {
    vin: 'VINDEMO0000000003',
    plate: 'IL789MN',
    make: 'Ducati',
    model: 'Monster 821',
    version: null,
    year: 2019,
    fuelType: 'petrol',
    vehicleType: 'motorcycle',
    registrationDate: new Date('2019-04-22'),
    ownerEmail: 'luigi.verdi@demo-giuseppe.test',
  },
  {
    vin: 'VINDEMO0000000004',
    plate: 'OP012QR',
    make: 'Renault',
    model: 'Clio',
    version: '1.0 TCe',
    year: 2022,
    fuelType: 'petrol',
    vehicleType: 'car',
    registrationDate: new Date('2022-09-05'),
    ownerEmail: 'anna.bianchi@demo-giuseppe.test',
  },
  {
    vin: 'VINDEMO0000000005',
    plate: 'ST345UV',
    make: 'Iveco',
    model: 'Daily',
    version: '35S14',
    year: 2017,
    fuelType: 'diesel',
    vehicleType: 'van',
    registrationDate: new Date('2017-11-30'),
    ownerEmail: 'anna.bianchi@demo-giuseppe.test',
  },
];

// 20 interventions distributed across 5 vehicles, dates ordered, km
// monotonically increasing per vehicle (BR-068 safe).
export const INTERVENTIONS: DemoIntervention[] = [
  // Fiat Panda (VINDEMO0000000001)
  {
    vehicleVin: 'VINDEMO0000000001',
    interventionDate: '2024-04-10',
    interventionTypeCode: 'TAGLIANDO',
    title: 'Tagliando 30k',
    description: 'Tagliando programmato a 30.000 km. Sostituzione olio, filtri, controllo livelli.',
    odometerKm: 30000,
    partsReplaced: [
      { name: 'Olio motore Selenia 5W30', code: 'SEL-5W30-4L', quantity: 4 },
      { name: 'Filtro olio', quantity: 1 },
    ],
  },
  {
    vehicleVin: 'VINDEMO0000000001',
    interventionDate: '2024-11-05',
    interventionTypeCode: 'CAMBIO_GOMME_STAGIONE',
    title: 'Gomme invernali',
    description: 'Inversione pneumatici stagionali.',
    odometerKm: 38000,
  },
  {
    vehicleVin: 'VINDEMO0000000001',
    interventionDate: '2025-04-15',
    interventionTypeCode: 'TAGLIANDO',
    title: 'Tagliando 45k',
    description: 'Tagliando programmato a 45.000 km.',
    odometerKm: 45000,
    partsReplaced: [
      { name: 'Olio motore', quantity: 4 },
      { name: 'Filtro aria', quantity: 1 },
    ],
  },
  {
    vehicleVin: 'VINDEMO0000000001',
    interventionDate: '2025-11-08',
    interventionTypeCode: 'CAMBIO_GOMME_STAGIONE',
    title: 'Gomme invernali',
    description: 'Inversione pneumatici stagionali.',
    odometerKm: 52000,
  },
  {
    vehicleVin: 'VINDEMO0000000001',
    interventionDate: '2026-02-20',
    interventionTypeCode: 'FRENI',
    title: 'Freni anteriori',
    description: 'Sostituzione pastiglie anteriori per usura.',
    odometerKm: 56000,
    partsReplaced: [{ name: 'Pastiglie freno anteriori', code: 'BREMBO-P12345', quantity: 1 }],
  },

  // VW Golf (VINDEMO0000000002)
  {
    vehicleVin: 'VINDEMO0000000002',
    interventionDate: '2024-06-15',
    interventionTypeCode: 'TAGLIANDO',
    title: 'Tagliando 60k',
    description: 'Tagliando programmato a 60.000 km Golf TDI.',
    odometerKm: 60000,
    partsReplaced: [
      { name: 'Olio motore VW 5W30 Long Life', quantity: 5 },
      { name: 'Filtro olio', quantity: 1 },
      { name: 'Filtro aria', quantity: 1 },
      { name: 'Filtro carburante', quantity: 1 },
    ],
  },
  {
    vehicleVin: 'VINDEMO0000000002',
    interventionDate: '2024-12-10',
    interventionTypeCode: 'REVISIONE',
    title: 'Revisione',
    description: 'Revisione ministeriale superata.',
    odometerKm: 68000,
  },
  {
    vehicleVin: 'VINDEMO0000000002',
    interventionDate: '2025-09-12',
    interventionTypeCode: 'DISTRIBUZIONE',
    title: 'Cinghia distribuzione',
    description:
      'Sostituzione cinghia distribuzione + pompa acqua + tendicinghia (preventivo a 80k).',
    odometerKm: 80000,
    partsReplaced: [
      { name: 'Kit distribuzione completo', code: 'INA-530055810', quantity: 1 },
      { name: 'Pompa acqua', quantity: 1 },
    ],
  },
  {
    vehicleVin: 'VINDEMO0000000002',
    interventionDate: '2026-01-08',
    interventionTypeCode: 'CAMBIO_OLIO',
    title: 'Cambio olio',
    description: 'Sostituzione olio + filtro a 88k.',
    odometerKm: 88000,
  },

  // Ducati Monster (VINDEMO0000000003)
  {
    vehicleVin: 'VINDEMO0000000003',
    interventionDate: '2024-05-20',
    interventionTypeCode: 'TAGLIANDO',
    title: 'Tagliando 12k',
    description: 'Tagliando programmato a 12.000 km Ducati.',
    odometerKm: 12000,
    partsReplaced: [
      { name: 'Olio motore Shell Ultra 5W40', quantity: 3 },
      { name: 'Filtro olio', quantity: 1 },
    ],
  },
  {
    vehicleVin: 'VINDEMO0000000003',
    interventionDate: '2025-07-18',
    interventionTypeCode: 'TAGLIANDO',
    title: 'Tagliando 18k',
    description: 'Tagliando programmato a 18.000 km.',
    odometerKm: 18000,
  },
  {
    vehicleVin: 'VINDEMO0000000003',
    interventionDate: '2025-11-30',
    interventionTypeCode: 'BATTERIA',
    title: 'Batteria',
    description: 'Sostituzione batteria avviamento.',
    odometerKm: 19500,
  },

  // Renault Clio (VINDEMO0000000004)
  {
    vehicleVin: 'VINDEMO0000000004',
    interventionDate: '2024-09-22',
    interventionTypeCode: 'CAMBIO_OLIO',
    title: 'Cambio olio 15k',
    description: 'Sostituzione olio + filtro.',
    odometerKm: 15000,
  },
  {
    vehicleVin: 'VINDEMO0000000004',
    interventionDate: '2025-05-10',
    interventionTypeCode: 'TAGLIANDO',
    title: 'Tagliando 28k',
    description: 'Tagliando programmato.',
    odometerKm: 28000,
    partsReplaced: [{ name: 'Olio motore', quantity: 4 }],
  },
  {
    vehicleVin: 'VINDEMO0000000004',
    interventionDate: '2025-11-12',
    interventionTypeCode: 'CAMBIO_GOMME_STAGIONE',
    title: 'Gomme invernali',
    description: 'Inversione pneumatici.',
    odometerKm: 35000,
  },
  {
    vehicleVin: 'VINDEMO0000000004',
    interventionDate: '2026-03-20',
    interventionTypeCode: 'FRENI',
    title: 'Freni posteriori',
    description: 'Sostituzione pastiglie posteriori.',
    odometerKm: 42000,
  },

  // Iveco Daily (VINDEMO0000000005)
  {
    vehicleVin: 'VINDEMO0000000005',
    interventionDate: '2024-07-08',
    interventionTypeCode: 'TAGLIANDO',
    title: 'Tagliando 110k',
    description: 'Tagliando per furgone uso commerciale.',
    odometerKm: 110000,
    partsReplaced: [
      { name: 'Olio motore Iveco Diesel 10W40', quantity: 8 },
      { name: 'Filtro olio', quantity: 1 },
      { name: 'Filtro aria', quantity: 1 },
      { name: 'Filtro carburante', quantity: 1 },
    ],
  },
  {
    vehicleVin: 'VINDEMO0000000005',
    interventionDate: '2024-10-15',
    interventionTypeCode: 'REVISIONE',
    title: 'Revisione',
    description: 'Revisione ministeriale.',
    odometerKm: 120000,
  },
  {
    vehicleVin: 'VINDEMO0000000005',
    interventionDate: '2025-06-22',
    interventionTypeCode: 'TAGLIANDO',
    title: 'Tagliando 140k',
    description: 'Tagliando programmato.',
    odometerKm: 140000,
  },
  {
    vehicleVin: 'VINDEMO0000000005',
    interventionDate: '2026-01-30',
    interventionTypeCode: 'FRENI',
    title: 'Pinze freno',
    description: 'Revisione pinze freno anteriori, sostituzione tubi.',
    odometerKm: 158000,
  },
];
