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
//
// Fastify's default querystring parser turns repeated keys (?typeId=a&typeId=b)
// into a JS array rather than a CSV string. The z.preprocess below normalizes
// an incoming array to a CSV string (joining with ',') before the existing
// string-based split/trim/validate pipeline runs, so both wire shapes work.
function csvArray<T extends z.ZodType<unknown, string>>(itemSchema: T) {
  return z.preprocess(
    (value) => (Array.isArray(value) ? value.join(',') : value),
    z
      .string()
      .transform((value) =>
        value
          .split(',')
          .map((token) => token.trim())
          .filter((token) => token.length > 0),
      )
      .pipe(z.array(itemSchema)),
  );
}

// InterventionStatus enum per schema.prisma: active | disputed | cancelled.
const STATUS_VALUES = ['active', 'disputed', 'cancelled'] as const;
type StatusValue = (typeof STATUS_VALUES)[number];
const DEFAULT_STATUS: StatusValue[] = ['active', 'disputed'];

export const interventionsListQuerySchema = z
  .object({
    // Query strings are text; z.coerce.number() converts them, mirroring
    // interventions-recent.ts:24-26.
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    q: z.string().optional(),
    // .default() only fires when the `status` key is entirely absent from the
    // query string. A web client that clears every status chip instead sends
    // `status=` (or whitespace), which csvArray parses to a valid-but-empty
    // array — and the handler's `status: { in: [] }` would then match no rows
    // at all. The trailing .transform maps that empty-after-parse case back to
    // the same default set, while an invalid token (e.g. "bogus") still throws
    // inside csvArray's own pipe, before this transform ever runs.
    status: csvArray(z.enum(STATUS_VALUES))
      .default(DEFAULT_STATUS)
      .transform((value) => (value.length === 0 ? DEFAULT_STATUS : value)),
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
