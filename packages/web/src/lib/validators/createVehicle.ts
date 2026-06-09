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

const yearRe = /^\d{4}$/;
const intRe = /^\d+$/;
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

// RHF form schema. Numeric inputs are validated as strings here and converted
// in transformToPayload (avoids z.coerce.number() turning "" into 0).
export const VehicleFormSchema = z
  .object({
    customerMode: z.enum(['existing', 'create_new']),
    customerId: z.string().optional(),
    firstName: z.string().max(100).optional(),
    lastName: z.string().max(100).optional(),
    email: z.string().max(255).optional(),
    phone: z.string().max(30).optional(),
    taxCode: z.string().max(20).optional(),
    isBusiness: z.boolean(),
    businessName: z.string().max(200).optional(),
    vatNumber: z.string().max(20).optional(),
    vin: z.string().trim().length(17, 'Il VIN deve avere 17 caratteri'),
    plate: z.string().trim().min(1, 'Targa obbligatoria').max(10),
    plateCountry: z.string().trim().length(2, 'Codice paese a 2 lettere'),
    make: z.string().trim().min(1, 'Marca obbligatoria').max(50),
    model: z.string().trim().min(1, 'Modello obbligatorio').max(100),
    version: z.string().max(150).optional(),
    year: z.string().regex(yearRe, 'Anno non valido (AAAA)'),
    registrationDate: z.string().optional(),
    vehicleType: VehicleTypeEnum,
    fuelType: FuelTypeEnum,
    engineDisplacement: z.string().optional(),
    powerKw: z.string().optional(),
    color: z.string().max(50).optional(),
    odometerKm: z.string().regex(intRe, 'Km non validi'),
    locationId: z.string().min(1, 'Sede obbligatoria'),
  })
  .superRefine((d, ctx) => {
    if (d.customerMode === 'existing') {
      if (!d.customerId) {
        ctx.addIssue({ code: 'custom', path: ['customerId'], message: 'Seleziona un cliente' });
      }
    } else {
      if (!d.firstName?.trim())
        ctx.addIssue({ code: 'custom', path: ['firstName'], message: 'Nome obbligatorio' });
      if (!d.lastName?.trim())
        ctx.addIssue({ code: 'custom', path: ['lastName'], message: 'Cognome obbligatorio' });
      if (!d.email?.trim())
        ctx.addIssue({ code: 'custom', path: ['email'], message: 'Email obbligatoria' });
      if (d.isBusiness && !d.businessName?.trim())
        ctx.addIssue({
          code: 'custom',
          path: ['businessName'],
          message: 'Ragione sociale obbligatoria',
        });
      if (d.isBusiness && !d.vatNumber?.trim())
        ctx.addIssue({
          code: 'custom',
          path: ['vatNumber'],
          message: 'P.IVA obbligatoria per aziende',
        });
    }
    if (d.registrationDate && !dateRe.test(d.registrationDate)) {
      ctx.addIssue({ code: 'custom', path: ['registrationDate'], message: 'Data non valida' });
    }
    if (d.engineDisplacement && !intRe.test(d.engineDisplacement)) {
      ctx.addIssue({
        code: 'custom',
        path: ['engineDisplacement'],
        message: 'Cilindrata non valida',
      });
    }
    if (d.powerKw && !intRe.test(d.powerKw)) {
      ctx.addIssue({ code: 'custom', path: ['powerKw'], message: 'Potenza non valida' });
    }
  });

export type VehicleFormValues = z.infer<typeof VehicleFormSchema>;

export function transformToPayload(v: VehicleFormValues): CreateVehiclePayload {
  const opt = (s?: string) => {
    const t = s?.trim();
    return t ? t : undefined;
  };
  const optInt = (s?: string) => {
    const t = s?.trim();
    return t ? Number(t) : undefined;
  };

  const ed = optInt(v.engineDisplacement);
  const pk = optInt(v.powerKw);

  const customer: CreateVehiclePayload['customer'] =
    v.customerMode === 'existing'
      ? { mode: 'existing', customerId: v.customerId ?? '' }
      : {
          mode: 'create_new',
          firstName: (v.firstName ?? '').trim(),
          lastName: (v.lastName ?? '').trim(),
          email: (v.email ?? '').trim(),
          isBusiness: v.isBusiness,
          ...(opt(v.phone) ? { phone: opt(v.phone) } : {}),
          ...(opt(v.taxCode) ? { taxCode: opt(v.taxCode) } : {}),
          ...(v.isBusiness && opt(v.businessName) ? { businessName: opt(v.businessName) } : {}),
          ...(v.isBusiness && opt(v.vatNumber) ? { vatNumber: opt(v.vatNumber) } : {}),
        };

  return {
    vehicle: {
      vin: v.vin.trim().toUpperCase(),
      plate: v.plate.trim().toUpperCase(),
      plateCountry: v.plateCountry.trim().toUpperCase(),
      make: v.make.trim(),
      model: v.model.trim(),
      year: Number(v.year),
      vehicleType: v.vehicleType,
      fuelType: v.fuelType,
      odometerKm: Number(v.odometerKm),
      ...(opt(v.version) ? { version: opt(v.version) } : {}),
      ...(opt(v.registrationDate) ? { registrationDate: opt(v.registrationDate) } : {}),
      ...(ed !== undefined ? { engineDisplacement: ed } : {}),
      ...(pk !== undefined ? { powerKw: pk } : {}),
      ...(opt(v.color) ? { color: opt(v.color) } : {}),
    },
    customer,
    locationId: v.locationId,
    sendInvitationEmail: false, // invito app differito (SES sandbox); toggle UI disabilitato
    forceNonstandardVin: false,
  };
}
