import { z } from 'zod';

// Web-local mirror of the backend authoritative CreateVehicleSchema
// (packages/database/src/validators/vehicle.ts). Kept web-local to keep
// @prisma/client out of the Vite bundle; createVehicle.parity.test.ts
// asserts it stays in sync with the backend at test time.
//
// NOTE: backend layers an API-only `force` flag onto this schema at the
// route boundary (vehicles.ts) — it is NOT part of this payload shape. The
// mutation hook (vehicleCreate.ts) adds `force` to the request body.

// Mirror of backend VinSchema / ItalianPlateSchema (packages/database/src/validators/common.ts)
// BR-001 — VIN: 17 characters, alphanumeric excluding I/O/Q (ISO 3779)
const VinSchema = z
  .string()
  .length(17, { message: 'Il VIN deve essere di 17 caratteri' })
  .regex(/^[A-HJ-NPR-Z0-9]{17}$/, {
    message: 'VIN contiene caratteri non validi',
  });

// Italian plate, current format (AA123BB).
const ItalianPlateSchema = z
  .string()
  .min(6)
  .max(10)
  .regex(/^[A-Z]{2}[0-9]{3}[A-Z]{2}$/, {
    message: 'Formato targa italiana non valido (esempio: AB123CD)',
  });

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
export type VehicleType = z.infer<typeof VehicleTypeEnum>;
export type FuelType = z.infer<typeof FuelTypeEnum>;

const CURRENT_YEAR = new Date().getUTCFullYear();

export const CreateVehiclePayloadSchema = z.object({
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
    z.object({ mode: z.literal('existing'), customerId: z.uuid() }),
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
      .refine((d) => !d.isBusiness || (d.businessName && d.vatNumber), {
        message: 'businessName e vatNumber obbligatori per clienti aziendali',
      }),
  ]),
  locationId: z.uuid(),
  sendInvitationEmail: z.boolean().default(true),
  forceNonstandardVin: z.boolean().default(false),
});

export type CreateVehiclePayload = z.infer<typeof CreateVehiclePayloadSchema>;
