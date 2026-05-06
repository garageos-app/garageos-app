import { z } from 'zod';

const PartReplacedFormSchema = z.object({
  name: z.string().min(1, 'Nome richiesto').max(200),
  code: z.string().max(50).optional().or(z.literal('')),
  quantity: z.number().int().positive('Quantità > 0'),
  notes: z.string().max(200).optional().or(z.literal('')),
});

export const CreateInterventionFormSchema = z.object({
  interventionTypeId: z.string().uuid('Seleziona un tipo intervento'),
  interventionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data richiesta (YYYY-MM-DD)'),
  odometerKm: z.number().int().min(0, 'Km ≥ 0'),
  description: z.string().min(1, 'Descrizione richiesta').max(5000),
  title: z.string().max(200).optional().or(z.literal('')),
  internalNotes: z.string().max(5000).optional().or(z.literal('')),
  partsReplaced: z.array(PartReplacedFormSchema),
  createDeadline: z
    .object({
      enabled: z.boolean(),
      monthsFromNow: z.number().int().positive().optional(),
      kmIncrement: z.number().int().positive().optional(),
    })
    .optional(),
});

export type CreateInterventionFormValues = z.infer<typeof CreateInterventionFormSchema>;

export interface PartReplacedPayload {
  name: string;
  code?: string;
  quantity: number;
  notes?: string;
}

export interface CreateInterventionPayload {
  interventionTypeId: string;
  interventionDate: string;
  odometerKm: number;
  description: string;
  title?: string;
  internalNotes?: string;
  partsReplaced: PartReplacedPayload[];
  createDeadline?: { enabled: boolean; monthsFromNow?: number; kmIncrement?: number };
  forceKmDecrease?: boolean;
}

export function transformToPayload(
  values: CreateInterventionFormValues,
): CreateInterventionPayload {
  return {
    interventionTypeId: values.interventionTypeId,
    interventionDate: values.interventionDate,
    odometerKm: values.odometerKm,
    description: values.description,
    ...(values.title ? { title: values.title } : {}),
    ...(values.internalNotes ? { internalNotes: values.internalNotes } : {}),
    partsReplaced: (values.partsReplaced ?? []).map((p) => ({
      name: p.name,
      quantity: p.quantity,
      ...(p.code ? { code: p.code } : {}),
      ...(p.notes ? { notes: p.notes } : {}),
    })),
    ...(values.createDeadline?.enabled ? { createDeadline: values.createDeadline } : {}),
  };
}
