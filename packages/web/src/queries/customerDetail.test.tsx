import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useCustomerDetail, useUpdateCustomer } from './customerDetail';
import type { CustomerDetail } from './types';
import { ApiError } from '@/lib/api-client';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return {
    ...actual,
    useApiFetch: () => apiFetchMock,
  };
});

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return { Wrapper, qc };
}

const sampleDetail: CustomerDetail = {
  id: 'cust-abc',
  email: 'mario@example.it',
  firstName: 'Mario',
  lastName: 'Rossi',
  phone: '+39 333 1234567',
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
  createdAt: '2026-01-01T00:00:00.000Z',
  tenantRelation: {
    tenantNotes: null,
    interventionCount: 0,
    firstInterventionAt: null,
    lastInterventionAt: null,
  },
  vehicles: [],
};

describe('useCustomerDetail', () => {
  it('fetches /v1/customers/:id and exposes the DTO', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce(sampleDetail);

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useCustomerDetail('cust-abc'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith('/v1/customers/cust-abc');
    expect(result.current.data?.firstName).toBe('Mario');
  });

  it('surfaces 404 errors as ApiError', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockRejectedValueOnce(
      new ApiError('customer.not_found', 404, 'Cliente non trovato'),
    );

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useCustomerDetail('cust-missing'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ApiError).code).toBe('customer.not_found');
  });

  it('does not fire when id is empty', () => {
    apiFetchMock.mockClear();
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useCustomerDetail(''), { wrapper: Wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('useUpdateCustomer', () => {
  it('PATCHes the body and invalidates the 4 expected query keys on success', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce({ ...sampleDetail, firstName: 'Marco' });

    const { Wrapper, qc } = makeWrapper();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateCustomer('cust-abc'), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({ firstName: 'Marco' });
    });

    expect(apiFetchMock).toHaveBeenCalledWith('/v1/customers/cust-abc', {
      method: 'PATCH',
      body: JSON.stringify({ firstName: 'Marco' }),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['customer-detail', 'cust-abc'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['customer-search'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['vehicle-search'] });
  });

  it('does not invalidate on mutation error', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockRejectedValueOnce(
      new ApiError('customer.not_found', 404, 'Cliente non trovato'),
    );

    const { Wrapper, qc } = makeWrapper();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateCustomer('cust-abc'), { wrapper: Wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ firstName: 'Marco' })).rejects.toBeInstanceOf(
        ApiError,
      );
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
