import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useCustomerSearch } from './customerSearch';
import type { CustomerSearchResponse } from './types';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => apiFetchMock,
}));

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useCustomerSearch', () => {
  it('does not fire the query when q is shorter than 2 chars', () => {
    apiFetchMock.mockClear();
    const { result } = renderHook(() => useCustomerSearch('a'), { wrapper: wrap });
    expect(result.current.fetchStatus).toBe('idle');
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('does not fire the query when q is empty', () => {
    apiFetchMock.mockClear();
    const { result } = renderHook(() => useCustomerSearch(''), { wrapper: wrap });
    expect(result.current.fetchStatus).toBe('idle');
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('fires the query and returns data when q is at least 2 chars', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce({
      data: [
        {
          id: 'cust-1',
          firstName: 'Mario',
          lastName: 'Rossi',
          email: 'mario@example.it',
          phone: null,
          isBusiness: false,
          businessName: null,
          vatNumber: null,
          status: 'active',
        },
      ],
      meta: { has_more: false },
    } satisfies CustomerSearchResponse);

    const { result } = renderHook(() => useCustomerSearch('mar'), { wrapper: wrap });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiFetchMock).toHaveBeenCalledWith('/v1/customers/search?q=mar&limit=20');
    expect(result.current.data?.data[0]?.firstName).toBe('Mario');
  });
});
