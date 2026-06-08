import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const apiFetch = vi.fn();
const invalidateQueries = vi.fn();

vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => apiFetch,
  ApiError: class ApiError extends Error {},
}));

import { useCompleteOnboarding } from './tenantOnboarding';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  qc.invalidateQueries = invalidateQueries as never;
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useCompleteOnboarding', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    invalidateQueries.mockReset();
  });

  it('POSTs to the complete endpoint and invalidates tenants-me', async () => {
    apiFetch.mockResolvedValue({});
    const { result } = renderHook(() => useCompleteOnboarding(), { wrapper });
    await result.current.mutateAsync();
    expect(apiFetch).toHaveBeenCalledWith('/v1/tenants/me/onboarding/complete', { method: 'POST' });
    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['tenants-me'] }),
    );
  });
});
