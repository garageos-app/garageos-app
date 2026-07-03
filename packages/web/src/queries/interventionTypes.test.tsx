import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useInterventionTypes } from './interventionTypes';
import type { InterventionTypesResponse } from './types';

vi.mock('@/lib/api-client', () => ({
  useApiFetch: () =>
    vi.fn(async (path: string) => {
      if (path === '/v1/intervention-types') {
        return {
          data: [
            {
              id: 'uuid-1',
              code: 'TAGLIANDO',
              nameIt: 'Tagliando',
              description: '',
              icon: 'wrench',
              suggestsDeadline: true,
              defaultDeadlineMonths: 12,
              defaultDeadlineKm: 15000,
              custom: false,
            },
          ],
        } as InterventionTypesResponse;
      }
      throw new Error(`unexpected ${path}`);
    }),
}));

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useInterventionTypes', () => {
  it('fetches and returns the data array', async () => {
    const { result } = renderHook(() => useInterventionTypes(), { wrapper: wrap });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.data[0]?.code).toBe('TAGLIANDO');
  });
});
