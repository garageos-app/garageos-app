import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useCreateCustomer } from './customersCreate';
import type { CustomerCreateResponse } from './types';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return { ...actual, useApiFetch: () => apiFetchMock };
});

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return { Wrapper, qc };
}

const created: CustomerCreateResponse = {
  id: 'c1',
  email: 'mario@example.it',
  firstName: 'Mario',
  lastName: 'Rossi',
  phone: null,
  taxCode: null,
  isBusiness: false,
  businessName: null,
  vatNumber: null,
  addressLine: null,
  city: null,
  province: null,
  postalCode: null,
  cognitoSub: null,
  status: 'active',
  createdAt: '2026-06-08T00:00:00.000Z',
  tenantRelation: {
    tenantNotes: null,
    interventionCount: 0,
    firstInterventionAt: null,
    lastInterventionAt: null,
  },
  vehicles: [],
  created: true,
};

describe('useCreateCustomer', () => {
  it('POSTs the body and returns the created customer', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce(created);
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useCreateCustomer(), { wrapper: Wrapper });

    let res: CustomerCreateResponse | undefined;
    await act(async () => {
      res = await result.current.mutateAsync({
        firstName: 'Mario',
        lastName: 'Rossi',
        email: 'mario@example.it',
        isBusiness: false,
      });
    });
    expect(apiFetchMock).toHaveBeenCalledWith('/v1/customers', {
      method: 'POST',
      body: JSON.stringify({
        firstName: 'Mario',
        lastName: 'Rossi',
        email: 'mario@example.it',
        isBusiness: false,
      }),
    });
    expect(res?.id).toBe('c1');
    expect(res?.created).toBe(true);
  });

  it('invalidates the customers list on success', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce(created);
    const { Wrapper, qc } = makeWrapper();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCreateCustomer(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        firstName: 'Mario',
        lastName: 'Rossi',
        email: 'mario@example.it',
        isBusiness: false,
      });
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['customers', 'list'] });
  });
});
