import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import {
  parseInterventionsParams,
  serializeInterventionsParams,
  useInterventionsList,
  type InterventionsListParams,
  type InterventionsListResponse,
} from './interventionsList';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => apiFetchMock,
}));

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const DEFAULTS: InterventionsListParams = {
  page: 1,
  q: '',
  status: [],
  typeId: [],
  checklistItemIds: [],
  operatorId: [],
  dateFrom: '',
  dateTo: '',
  sort: 'date',
  order: 'desc',
};

const SAMPLE: InterventionsListResponse = {
  items: [
    {
      id: 'i-1',
      interventionDate: '2026-07-01',
      odometerKm: 12000,
      status: 'active',
      type: { id: 't1', nameIt: 'Intervento Meccanico' },
      vehicle: { id: 'v-1', plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
      operator: { id: 'u-1', name: 'Mario Rossi' },
    },
  ],
  total: 1,
  page: 1,
  pageSize: 25,
};

describe('parseInterventionsParams', () => {
  it('parses a fully-populated query string', () => {
    const sp = new URLSearchParams(
      'page=2&q=fiat&status=active,cancelled&typeId=t1&sort=km&order=asc',
    );
    expect(parseInterventionsParams(sp)).toEqual({
      page: 2,
      q: 'fiat',
      status: ['active', 'cancelled'],
      typeId: ['t1'],
      checklistItemIds: [],
      operatorId: [],
      dateFrom: '',
      dateTo: '',
      sort: 'km',
      order: 'asc',
    });
  });

  it('returns defaults for an empty query string', () => {
    expect(parseInterventionsParams(new URLSearchParams(''))).toEqual(DEFAULTS);
  });

  it('falls back to defaults for unknown sort/order tokens', () => {
    const sp = new URLSearchParams('sort=bogus&order=sideways');
    const parsed = parseInterventionsParams(sp);
    expect(parsed.sort).toBe('date');
    expect(parsed.order).toBe('desc');
  });
});

describe('serializeInterventionsParams', () => {
  it('serializes fully-canonical params to an empty string', () => {
    expect(serializeInterventionsParams(DEFAULTS).toString()).toBe('');
  });

  it('emits only the non-default params', () => {
    const qs = serializeInterventionsParams({
      ...DEFAULTS,
      page: 3,
      status: ['cancelled'],
      typeId: ['a', 'b'],
    }).toString();
    expect(qs).toContain('page=3');
    expect(qs).toContain('status=cancelled');
    expect(qs).toContain('typeId=a%2Cb');
    expect(qs).not.toContain('sort=');
    expect(qs).not.toContain('order=');
    expect(qs).not.toContain('q=');
  });
});

describe('useInterventionsList', () => {
  it('fetches with page, pageSize and CSV filters in the URL', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValue(SAMPLE);

    const { result } = renderHook(
      () =>
        useInterventionsList({
          ...DEFAULTS,
          page: 2,
          typeId: ['t1'],
          checklistItemIds: ['c1'],
        }),
      { wrapper: wrap },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const url = apiFetchMock.mock.calls[0]![0] as string;
    expect(url.startsWith('/v1/interventions?')).toBe(true);
    expect(url).toContain('page=2');
    expect(url).toContain('pageSize=25');
    expect(url).toContain('typeId=t1');
    expect(url).toContain('checklistItemIds=c1');
  });

  it('drops checklistItemIds when typeId is not exactly one', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValue(SAMPLE);

    const { result } = renderHook(
      () =>
        useInterventionsList({
          ...DEFAULTS,
          typeId: ['t1', 't2'],
          checklistItemIds: ['c1'],
        }),
      { wrapper: wrap },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const url = apiFetchMock.mock.calls[0]![0] as string;
    expect(url).not.toContain('checklistItemIds');
  });
});
