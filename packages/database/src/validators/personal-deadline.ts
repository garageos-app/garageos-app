import { z } from 'zod';

// Source: docs/APPENDICE_B_DATABASE.md — personal_deadlines table (F-CLI-306).
// Mirrors the category enum defined in schema.prisma (PersonalDeadlineCategory).

export const PersonalDeadlineCategoryEnum = z.enum([
  'insurance',
  'road_tax',
  'inspection',
  'service',
  'tires',
  'timing_belt',
  'other',
]);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// CREATE — defaults present (one-shot body, never an empty PATCH body).
// .default() values are intentionally absent from UpdatePersonalDeadlineSchema:
// a default in a PATCH schema auto-populates an empty {} body and defeats the
// empty-body guard (see feedback_zod_default_under_partial_defeats_empty_body).
export const CreatePersonalDeadlineSchema = z
  .object({
    vehicleId: z.uuid(),
    category: PersonalDeadlineCategoryEnum,
    customLabel: z.string().trim().min(1).max(80).optional(),
    dueDate: z.string().regex(DATE_ONLY),
    recurrenceMonths: z.number().int().min(1).max(120).optional(),
    reminderLeadDays: z.array(z.number().int().min(0).max(365)).max(10).default([30, 7, 0]),
    reminderDailyTailDays: z.number().int().min(0).max(30).optional(),
    notifyPush: z.boolean().default(true),
    notifyEmail: z.boolean().default(true),
    notes: z.string().trim().max(500).optional(),
  })
  .strict()
  // BR-294: customLabel obbligatoria sse category === 'other'.
  .refine((d) => d.category !== 'other' || (d.customLabel != null && d.customLabel.length > 0), {
    path: ['customLabel'],
    message: 'custom_label_required',
  });

// UPDATE — tutto opzionale, NIENTE default, strict. Il check BR-294
// cross-field si fa a route-level (category può non essere nel body).
export const UpdatePersonalDeadlineSchema = z
  .object({
    category: PersonalDeadlineCategoryEnum.optional(),
    customLabel: z.string().trim().min(1).max(80).nullable().optional(),
    dueDate: z.string().regex(DATE_ONLY).optional(),
    recurrenceMonths: z.number().int().min(1).max(120).nullable().optional(),
    reminderLeadDays: z.array(z.number().int().min(0).max(365)).max(10).optional(),
    reminderDailyTailDays: z.number().int().min(0).max(30).nullable().optional(),
    notifyPush: z.boolean().optional(),
    notifyEmail: z.boolean().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export type PersonalDeadlineCategory = z.infer<typeof PersonalDeadlineCategoryEnum>;
export type CreatePersonalDeadlineInput = z.infer<typeof CreatePersonalDeadlineSchema>;
export type UpdatePersonalDeadlineInput = z.infer<typeof UpdatePersonalDeadlineSchema>;
