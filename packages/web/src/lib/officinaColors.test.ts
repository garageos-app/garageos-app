import { describe, expect, it } from 'vitest';

import { buildOfficinaColorMap, officinaColor } from './officinaColors';
import type { TimelineOfficina } from '@/queries/types';

function officina(id: string, name: string): TimelineOfficina {
  return { tenant_id: id, business_name: name, viewer_is_owner: false };
}

describe('officinaColors', () => {
  it('assigns a stable color per tenant by list order', () => {
    const list = [officina('a', 'Alfa'), officina('b', 'Beta'), officina('c', 'Gamma')];
    const map = buildOfficinaColorMap(list);

    const a = officinaColor(map, 'a');
    const b = officinaColor(map, 'b');
    const c = officinaColor(map, 'c');

    // Distinct colors for distinct officine...
    expect(a.dot).not.toBe(b.dot);
    expect(b.dot).not.toBe(c.dot);
    // ...and stable across repeated builds of the same list.
    const map2 = buildOfficinaColorMap(list);
    expect(officinaColor(map2, 'a').dot).toBe(a.dot);
    expect(officinaColor(map2, 'c').dot).toBe(c.dot);
  });

  it('cycles the palette when there are more officine than colors', () => {
    const list = Array.from({ length: 10 }, (_, i) => officina(`t${i}`, `Officina ${i}`));
    const map = buildOfficinaColorMap(list);
    // 8-color palette → index 8 reuses index 0's color.
    expect(officinaColor(map, 't8').dot).toBe(officinaColor(map, 't0').dot);
  });

  it('returns a neutral fallback for an unknown tenant', () => {
    const map = buildOfficinaColorMap([officina('a', 'Alfa')]);
    const unknown = officinaColor(map, 'does-not-exist');
    expect(unknown.dot).toBe('bg-muted-foreground');
  });
});
