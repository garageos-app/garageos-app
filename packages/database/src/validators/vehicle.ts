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
  sendInvitationEmail: z.boolean().default(true),
  // BR-001 exception: non-standard VIN (pre-1981, agricultural, special).
  forceNonstandardVin: z.boolean().default(false),
});

// BR-006 (mandatory fields for pending vehicles) + BR-003 (customer-created
// vehicles start as pending) + BR-001 (VIN shape; ISO 3779 checksum validation
// is at route level). vehicleType and fuelType are extra vs BR-006 because
// the DB columns are NOT NULL with no defaults. forceNonstandardVin is
// deliberately absent: the BR-001 exception is mechanic-only (workshop flow).
//
// version / registrationDate / engineDisplacement / powerKw / color are
// OPTIONAL owner-declared technical fields (same shape/limits as
// CreateVehicleSchema). They are NOT authoritative: a workshop verifies and
// corrects them from the libretto at certification (BR-003 / BR-004). They
// exist here so a pre-registering owner can fill in what they read off their
// own carta di circolazione instead of leaving the detail screen half-empty.
export const CreatePendingVehicleSchema = z
  .object({
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
  })
  .strict();

// BR-024 — garage_code lookup is case-insensitive; upstream input is
// normalized to uppercase before hitting the DB.
export const ClaimVehicleSchema = z.object({
  garageCode: GarageCodeSchema.transform((s) => s.toUpperCase()),
});

// PATCH /v1/vehicles/:id (F-OFF-106). All editable fields optional;
// override flags piggyback for VIN-checksum (forceNonstandardVin) and
// duplicate-plate confirmation (force). .strict() rejects unknown
// keys (status, garageCode, certifiedAt, createdByTenantId, ...) so
// callers get a 400 instead of a silent strip. .refine ensures at
// least one editable field is present, otherwise the call is a no-op.
const EDITABLE_FIELDS = [
  'vin',
  'plate',
  'plateCountry',
  'make',
  'model',
  'version',
  'year',
  'registrationDate',
  'vehicleType',
  'fuelType',
  'engineDisplacement',
  'powerKw',
  'color',
] as const;

export const UpdateVehicleSchema = z
  .object({
    vin: VinSchema.optional(),
    plate: ItalianPlateSchema.optional(),
    plateCountry: z.string().length(2).optional(),
    make: z.string().min(1).max(50).optional(),
    model: z.string().min(1).max(100).optional(),
    version: z.string().max(150).nullable().optional(),
    year: z
      .number()
      .int()
      .min(1900)
      .max(CURRENT_YEAR + 1)
      .optional(),
    registrationDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    vehicleType: VehicleTypeEnum.optional(),
    fuelType: FuelTypeEnum.optional(),
    engineDisplacement: z.number().int().positive().nullable().optional(),
    powerKw: z.number().int().positive().nullable().optional(),
    color: z.string().max(50).nullable().optional(),
    forceNonstandardVin: z.boolean().default(false),
    force: z.boolean().default(false),
  })
  .strict()
  .refine(
    (data) => EDITABLE_FIELDS.some((k) => (data as Record<string, unknown>)[k] !== undefined),
    { message: 'Specifica almeno un campo da modificare' },
  );

// POST /v1/vehicles/:id/certify (F-OFF-107). BR-004: pending→certified
// promotion. `librettoVisioned` is a boolean (not literal(true)) so the
// route can emit the dedicated 422 vehicle.certification.libretto_required
// instead of a generic Zod 400. `corrections` covers the libretto identity
// fields only (BR-004 "dati verificati e corretti"); engineDisplacement /
// powerKw / color are corrected via PATCH /vehicles/:id (F-OFF-106).
// Override flags mirror UpdateVehicleSchema: forceNonstandardVin (BR-001
// exception, mechanic-only) and force (duplicate-plate confirmation).
export const CertifyVehicleSchema = z
  .object({
    librettoVisioned: z.boolean().default(false),
    corrections: z
      .object({
        vin: VinSchema.optional(),
        plate: ItalianPlateSchema.optional(),
        plateCountry: z.string().length(2).optional(),
        make: z.string().min(1).max(50).optional(),
        model: z.string().min(1).max(100).optional(),
        version: z.string().max(150).nullable().optional(),
        year: z
          .number()
          .int()
          .min(1900)
          .max(CURRENT_YEAR + 1)
          .optional(),
        registrationDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional(),
        vehicleType: VehicleTypeEnum.optional(),
        fuelType: FuelTypeEnum.optional(),
      })
      .strict()
      .optional(),
    forceNonstandardVin: z.boolean().default(false),
    force: z.boolean().default(false),
  })
  .strict();

export type CreateVehicleInput = z.infer<typeof CreateVehicleSchema>;
export type CreatePendingVehicleInput = z.infer<typeof CreatePendingVehicleSchema>;
export type CertifyVehicleInput = z.infer<typeof CertifyVehicleSchema>;
export type ClaimVehicleInput = z.infer<typeof ClaimVehicleSchema>;
export type UpdateVehicleInput = z.infer<typeof UpdateVehicleSchema>;
export type VehicleType = z.infer<typeof VehicleTypeEnum>;
export type FuelType = z.infer<typeof FuelTypeEnum>;
