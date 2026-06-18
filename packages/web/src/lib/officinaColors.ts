import type { TimelineOfficina } from '@/queries/types';

// Per-officina color assignment for the vehicle timeline. Each officina in
// the vehicle's history gets a stable color (dot + left border) reused by
// the timeline rows and the officina filter, so the same workshop reads the
// same color in both places. Colors are assigned by the officine list order
// (the API sorts by business_name), so they don't shift as timeline pages
// load.
//
// Tailwind cannot tree-shake dynamically-built class names, so every class
// string is a literal here.
export interface OfficinaColor {
  /** Small status dot (works on light + dark). */
  dot: string;
  /** Left accent border for non-owned rows. */
  border: string;
}

const PALETTE: OfficinaColor[] = [
  { dot: 'bg-blue-500', border: 'border-l-blue-400' },
  { dot: 'bg-violet-500', border: 'border-l-violet-400' },
  { dot: 'bg-amber-500', border: 'border-l-amber-400' },
  { dot: 'bg-rose-500', border: 'border-l-rose-400' },
  { dot: 'bg-teal-500', border: 'border-l-teal-400' },
  { dot: 'bg-orange-500', border: 'border-l-orange-400' },
  { dot: 'bg-cyan-500', border: 'border-l-cyan-400' },
  { dot: 'bg-fuchsia-500', border: 'border-l-fuchsia-400' },
];

const FALLBACK: OfficinaColor = { dot: 'bg-muted-foreground', border: 'border-l-border' };

export type OfficinaColorMap = Map<string, OfficinaColor>;

// Build a tenantId → color map. The order is the API's (business_name asc),
// so the assignment is deterministic and stable across page loads. With more
// officine than palette entries the colors cycle (acceptable: a single
// vehicle visiting >8 distinct workshops is rare, and the names disambiguate).
export function buildOfficinaColorMap(officine: TimelineOfficina[]): OfficinaColorMap {
  const map: OfficinaColorMap = new Map();
  officine.forEach((o, i) => {
    map.set(o.tenant_id, PALETTE[i % PALETTE.length]!);
  });
  return map;
}

export function officinaColor(map: OfficinaColorMap, tenantId: string): OfficinaColor {
  return map.get(tenantId) ?? FALLBACK;
}
