import type { UserRole } from '../middleware/tenant-context.js';

/**
 * Resolve the effective location filter for a tenant-scoped list endpoint.
 *
 * BR-205 — visibilità cross-location:
 *  - mechanic   → forced to their own location; the `location_id` query
 *                 param is ignored. A mechanic always has a location
 *                 (BR-204); if somehow absent, returns undefined (no
 *                 filter) rather than throwing — defensive only.
 *  - super_admin → the query param when present, otherwise undefined
 *                 (= all sedi of the tenant, the pre-F-OFF-503 behavior).
 *
 * Returns the location id to filter on, or `undefined` for "no location
 * filter". Callers spread `...(loc ? { locationId: loc } : {})` into the
 * Prisma `where`.
 */
export function resolveLocationFilter(
  role: UserRole,
  userLocationId: string | undefined,
  queryLocationId: string | undefined,
): string | undefined {
  if (role === 'mechanic') return userLocationId;
  return queryLocationId;
}
