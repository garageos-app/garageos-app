import { z } from 'zod';

// Web-local shared base schema for the `partsReplaced` items in
// intervention forms. Mirror of the backend authoritative schema in
// packages/database/src/validators/intervention.ts (BR-071).
//
// Kept as a web-local copy (rather than imported from @garageos/database)
// to avoid pulling @prisma/client into the Vite bundle. The parity test
// in parts-replaced.parity.test.ts asserts that this schema stays in sync
// with the backend at test time.
//
// The quantity policy (integer-only vs decimal-permissive) is overridden
// by the consumers — see intervention.ts (create form) and
// editIntervention.ts (edit form).

export const BasePartReplacedSchema = z.object({
  name: z.string().min(1, 'Nome ricambio obbligatorio').max(200),
  code: z.string().max(50).optional(),
  quantity: z.number().positive('Quantità > 0'),
  notes: z.string().max(200).optional(),
});

export type BasePartReplaced = z.infer<typeof BasePartReplacedSchema>;
