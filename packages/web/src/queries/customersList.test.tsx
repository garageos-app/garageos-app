import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useCustomersList } from './customersList';
import type { CustomerListResponse } from './types';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return { ...actual, useApiFetch: () => apiFetchMock };
});

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return { Wrapper };
}

const page1: CustomerListResponse = {
  data: [
    {
      id: 'c1',
      firstName: 'Mario',
      lastName: 'Rossi',
      phone: '+39 333 1234567',
      isBusiness: false,
      businessName: null,
      vehicleCount: 2,
      lastInterventionAt: '2026-05-01T10:00:00.000Z',
    },
  ],
  meta: { has_more: true, cursor: 'CUR1' },
};

describe('useCustomersList', () => {
  it('fetches /v1/customers with limit and no q by default', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce(page1);
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useCustomersList(''), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith('/v1/customers?limit=20');
    expect(result.current.data?.pages[0]?.data[0]?.id).toBe('c1');
  });

  it('includes q when provided (trimmed)', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce(page1);
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useCustomersList('  ross '), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith('/v1/customers?q=ross&limit=20');
  });

  it('passes meta.cursor as the next page param', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce(page1);
    apiFetchMock.mockResolvedValueOnce({ data: [], meta: { has_more: false } });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useCustomersList(''), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(apiFetchMock).toHaveBeenLastCalledWith('/v1/customers?limit=20&cursor=CUR1');
  });
});
