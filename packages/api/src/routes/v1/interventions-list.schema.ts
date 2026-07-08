import { z } from 'zod';

// GET /v1/interventions — "Registro Interventi" list endpoint, PR-1 (task 1
// of 4). This module builds only the query-params Zod schema; the route
// handler that consumes it is a later task.
//
// CSV params (status, typeId, checklistItemIds, operatorId) arrive as a
// single comma-joined query string (e.g. "active,cancelled"). csvArray()
// splits on ',', trims whitespace, drops empty tokens, then validates each
// token against the given item schema — mirrors the tenant_ids pattern in
// vehicles-timeline.ts. An invalid token surfaces as a ZodError, which the
// route layer turns into a 400 VALIDATION_ERROR.
function csvArray<T extends z.ZodType<unknown, string>>(itemSchema: T) {
  return z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((token) => token.trim())
        .filter((token) => token.length > 0),
    )
    .pipe(z.array(itemSchema));
}

export const interventionsListQuerySchema = z
  .object({
    // Query strings are text; z.coerce.number() converts them, mirroring
    // interventions-recent.ts:24-26.
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    q: z.string().optional(),
    // InterventionStatus enum per schema.prisma: active | disputed | cancelled.
    status: csvArray(z.enum(['active', 'disputed', 'cancelled'])).default(['active', 'disputed']),
    typeId: csvArray(z.string().uuid()).optional(),
    checklistItemIds: csvArray(z.string().uuid()).optional(),
    operatorId: csvArray(z.string().uuid()).optional(),
    dateFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'dateFrom must be YYYY-MM-DD')
      .optional(),
    dateTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'dateTo must be YYYY-MM-DD')
      .optional(),
    sort: z.enum(['date', 'status', 'type', 'operator', 'km']).default('date'),
    order: z.enum(['asc', 'desc']).default('desc'),
  })
  // Checklist guard: filtering by checklistItemIds only makes sense when
  // scoped to exactly one intervention type (checklist items belong to a
  // single type), so require exactly one typeId whenever it's used.
  .refine((q) => !q.checklistItemIds?.length || q.typeId?.length === 1, {
    message: 'checklistItemIds requires exactly one typeId',
    path: ['checklistItemIds'],
  });

export type InterventionsListQuery = z.infer<typeof interventionsListQuerySchema>;
