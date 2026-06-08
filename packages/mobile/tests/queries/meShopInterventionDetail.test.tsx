import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

import { useMeShopInterventionDetail } from '@/queries/meShopInterventionDetail';

const mockFetch = jest.fn();
jest.mock('@/lib/use-api-client', () => ({
  useApiClient: () => ({ fetch: mockFetch }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useMeShopInterventionDetail', () => {
  beforeEach(() => mockFetch.mockReset());

  it('GETs the intervention detail by id', async () => {
    mockFetch.mockResolvedValue({ intervention: { id: 'int-1' }, disputes: [] });
    const { result } = renderHook(() => useMeShopInterventionDetail('int-1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockFetch).toHaveBeenCalledWith('/v1/me/interventions/int-1');
    expect(result.current.data?.intervention.id).toBe('int-1');
  });

  it('is disabled when id is empty', () => {
    const { result } = renderHook(() => useMeShopInterventionDetail(''), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
