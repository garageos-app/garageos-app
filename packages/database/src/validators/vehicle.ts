import { z } from 'zod';

import { GarageCodeSchema, ItalianPlateSchema, VinSchema } from './common.js';

// Source: docs/APPENDICE_B_DATABASE.md §5.2 — kept enum order and field set
// verbatim. `plateCountry` defaults to 'IT'; we do not restrict to ISO 3166-1
// here because the DB column is VARCHAR(2) and the service layer validates
// the country list it actually supports.

export const VehicleTypeEnum = z.enum(['car', 'motorcycle', 'van', 'truck', 'agricultural']);
export const FuelTypeEnum = z.enum([
  'petrol',
  'diesel',
  'electric',
  'hybrid',
  'lpg',
  'methane',
  'hydrogen',
  'other',
]);

// BR-007 — year must be between 1900 and current year + 1.
// Evaluated at module load; acceptable because the upper bound only matters
// within ±1 year and the server restarts on deploys.
const CURRENT_YEAR = new Date().getUTCFullYear();

export const CreateVehicleSchema = z.object({
  vehicle: z.object({
    vin: VinSchema,
    plate: ItalianPlateSchema,
    plateCountry: z.string().length(2).default('IT'),
    make: z.string().min(1).max(50),
    model: z.string().min(1).max(100),
    version: z.string().max(150).optional(),
    year: z
      .number()
      .int()
      .min(1900)
      .max(CURRENT_YEAR + 1),
    registrationDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    vehicleType: VehicleTypeEnum,
    fuelType: FuelTypeEnum,
    engineDisplacement: z.number().int().positive().optional(),
    powerKw: z.number().int().positive().optional(),
    color: z.string().max(50).optional(),
    odometerKm: z.number().int().min(0),
  }),
  customer: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('existing'),
      customerId: z.uuid(),
    }),
    z
      .object({
        mode: z.literal('create_new'),
        firstName: z.string().min(1).max(100),
        lastName: z.string().min(1).max(100),
        email: z.email(),
        phone: z.string().max(30).optional(),
        taxCode: z.string().max(20).optional(),
        isBusiness: z.boolean().default(false),
        businessName: z.string().max(200).optional(),
        vatNumber: z.string().max(20).optional(),
      })
      .refine((data) => !data.isBusiness || (data.businessName && data.vatNumber), {
        message: 'businessName e vatNumber obbligatori per clienti aziendali',
      }),
  ]),
  locationId: z.uuid(),
  sendInvitationEmail: z.boolean().default(true),
  // BR-001 exception: non-standard VIN (pre-1981, agricultural, special).
  forceNonstandardVin: z.boolean().default(false),
});

// BR-024 — garage_code lookup is case-insensitive; upstream input is
// normalized to uppercase before hitting the DB.
export const ClaimVehicleSchema = z.object({
  garageCode: GarageCodeSchema.transform((s) => s.toUpperCase()),
});

export type CreateVehicleInput = z.infer<typeof CreateVehicleSchema>;
export type ClaimVehicleInput = z.infer<typeof ClaimVehicleSchema>;
export type VehicleType = z.infer<typeof VehicleTypeEnum>;
export type FuelType = z.infer<typeof FuelTypeEnum>;
