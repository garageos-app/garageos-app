import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

import { useCreateDispute } from '@/queries/createDispute';

const mockFetch = jest.fn();
jest.mock('@/lib/use-api-client', () => ({
  useApiClient: () => ({ fetch: mockFetch }),
}));

const invalidateSpy = jest.fn();
function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.invalidateQueries = invalidateSpy as never;
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('useCreateDispute', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    invalidateSpy.mockReset();
  });

  it('POSTs the dispute and invalidates the detail + timeline', async () => {
    mockFetch.mockResolvedValue({ dispute: { id: 'd-1' }, interventionStatus: 'disputed' });
    const { result } = renderHook(() => useCreateDispute('int-1', 'veh-1'), {
      wrapper: makeWrapper(),
    });
    await result.current.mutateAsync({ reasonCategory: 'wrong_data', description: 'x'.repeat(25) });
    expect(mockFetch).toHaveBeenCalledWith('/v1/interventions/int-1/dispute', {
      method: 'POST',
      body: { reasonCategory: 'wrong_data', description: 'x'.repeat(25) },
    });
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['me', 'intervention', 'int-1'] }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['vehicle', 'veh-1', 'timeline'] });
  });
});
