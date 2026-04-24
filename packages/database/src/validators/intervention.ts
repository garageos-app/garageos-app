import { z } from 'zod';

// Source: docs/APPENDICE_B_DATABASE.md §5.3 — translated to Zod 4 syntax.
// Dispute schema lives here because BR-120..BR-130 treat disputes as an
// intervention child; splitting would only duplicate a single literal enum.

// BR-071 — parts_replaced is a JSON array of objects with the fields below.
export const PartReplacedSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().max(50).optional(),
  quantity: z.number().positive(),
  notes: z.string().max(200).optional(),
});

export const CreateInterventionSchema = z.object({
  interventionTypeId: z.uuid(),
  interventionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  odometerKm: z.number().int().min(0),
  title: z.string().max(200).optional(),
  description: z.string().min(1).max(5000),
  partsReplaced: z.array(PartReplacedSchema).default([]),
  internalNotes: z.string().max(5000).optional(),
  createDeadline: z
    .object({
      enabled: z.boolean(),
      monthsFromNow: z.number().int().positive().optional(),
      kmIncrement: z.number().int().positive().optional(),
    })
    .optional(),
  // BR-068 — opt-in override when odometer decreases vs. prior intervention.
  // The rule itself (lookup + comparison) is service-layer; this flag just
  // records the operator's explicit confirmation.
  forceKmDecrease: z.boolean().default(false),
});

// BR-123 — dispute reason categories (fixed set, no `overcharge` in v1).
// BR-124 — description is 20..2000 chars.
export const CreateDisputeSchema = z.object({
  reasonCategory: z.enum(['not_performed', 'wrong_data', 'not_authorized', 'other']),
  description: z.string().min(20).max(2000),
  attachmentIds: z.array(z.uuid()).max(10).optional(),
});

export type PartReplaced = z.infer<typeof PartReplacedSchema>;
export type CreateInterventionInput = z.infer<typeof CreateInterventionSchema>;
export type CreateDisputeInput = z.infer<typeof CreateDisputeSchema>;
