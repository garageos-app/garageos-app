// Reducer for the timeline officina multiselect.
//
// Convention: the selection Set is the explicit set of shown officine, with
// the EMPTY set as the sentinel for "all" (the default). This keeps the
// common case (show everything) cheap and avoids initialising the set from
// async-loaded data.
//
// Invariant: you can never end up showing zero officine. Unchecking the last
// remaining officina is a no-op (kept ≥1), so the action never inverts into
// "show all" — see the bug caught in PR review.
export function toggleOfficinaSelection(
  prev: Set<string>,
  allIds: string[],
  tenantId: string,
): Set<string> {
  // Materialize the implicit "all" (empty) into a concrete set before toggling.
  const next = prev.size === 0 ? new Set(allIds) : new Set(prev);

  if (next.has(tenantId)) next.delete(tenantId);
  else next.add(tenantId);

  // Keep at least one officina shown: ignore the un-check that would empty it.
  if (next.size === 0) return prev;
  // Collapse a full selection back to the "all" sentinel.
  if (next.size === allIds.length) return new Set();
  return next;
}

// tenant_ids to send to the timeline query: empty (no server-side filter, all
// officine) when the sentinel set is empty, else the explicit subset.
export function selectionToTenantIds(selected: Set<string>): string[] {
  return selected.size === 0 ? [] : [...selected];
}
