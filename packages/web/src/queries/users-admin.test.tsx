import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import {
  useUsers,
  useInviteUser,
  useRevokeInvitation,
  useDeleteUser,
  useReactivateUser,
} from './users-admin';
import type { AdminUser, Invitation } from './users-admin';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => apiFetchMock,
  ApiError: class ApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, status: number, message: string) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/error-messages', () => ({
  translateError: (_code: string, message: string) => message,
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrap(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const mockUser: AdminUser = {
  id: crypto.randomUUID(),
  email: 'mario@officina.test',
  firstName: 'Mario',
  lastName: 'Rossi',
  role: 'mechanic',
  locationId: null,
  status: 'active',
  createdAt: '2026-05-19T10:00:00Z',
  deletedAt: null,
};

const mockInvitation: Invitation = {
  id: crypto.randomUUID(),
  targetEmail: 'luigi@officina.test',
  firstName: 'Luigi',
  lastName: 'Verdi',
  role: 'mechanic',
  locationId: null,
  expiresAt: '2026-05-26T10:00:00Z',
  createdAt: '2026-05-19T10:00:00Z',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useUsers', () => {
  beforeEach(() => {
    apiFetchMock.mockClear();
  });

  it('returns users data on success', async () => {
    apiFetchMock.mockResolvedValueOnce({ users: [mockUser] });

    const qc = makeQc();
    const { result } = renderHook(() => useUsers(), { wrapper: wrap(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiFetchMock).toHaveBeenCalledWith('/v1/users');
    expect(result.current.data?.users[0]?.email).toBe('mario@officina.test');
  });

  it('enters error state when apiFetch rejects', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('network error'));

    const qc = makeQc();
    const { result } = renderHook(() => useUsers(), { wrapper: wrap(qc) });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useInviteUser', () => {
  beforeEach(() => {
    apiFetchMock.mockClear();
  });

  it('calls POST /v1/users/invitations and invalidates invitations on success', async () => {
    apiFetchMock.mockResolvedValueOnce({ invitation: mockInvitation });

    const qc = makeQc();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useInviteUser(), { wrapper: wrap(qc) });

    result.current.mutate({
      email: 'luigi@officina.test',
      firstName: 'Luigi',
      lastName: 'Verdi',
      role: 'mechanic',
      locationId: null,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/v1/users/invitations',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['invitations'] }),
    );
  });

  it('enters error state when POST fails', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('server error'));

    const qc = makeQc();
    const { result } = renderHook(() => useInviteUser(), { wrapper: wrap(qc) });

    result.current.mutate({
      email: 'fail@test.it',
      firstName: 'Fail',
      lastName: 'Test',
      role: 'mechanic',
      locationId: null,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// Regression guard: apiFetch hardcodes Content-Type: application/json and
// Fastify rejects DELETE requests with that header but no body. Both
// DELETE mutations must pass `body: '{}'`. See:
//   packages/web/src/queries/avatarUpload.ts:123 for prior incident.

describe('useRevokeInvitation', () => {
  beforeEach(() => {
    apiFetchMock.mockClear();
  });

  it("sends DELETE with body: '{}' so Fastify accepts the request", async () => {
    apiFetchMock.mockResolvedValueOnce(undefined);

    const qc = makeQc();
    const { result } = renderHook(() => useRevokeInvitation(), { wrapper: wrap(qc) });

    result.current.mutate('inv-id-123');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiFetchMock).toHaveBeenCalledWith('/v1/users/invitations/inv-id-123', {
      method: 'DELETE',
      body: '{}',
    });
  });
});

describe('useDeleteUser', () => {
  beforeEach(() => {
    apiFetchMock.mockClear();
  });

  it("sends DELETE with body: '{}' so Fastify accepts the request", async () => {
    apiFetchMock.mockResolvedValueOnce(undefined);

    const qc = makeQc();
    const { result } = renderHook(() => useDeleteUser(), { wrapper: wrap(qc) });

    result.current.mutate('user-id-456');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiFetchMock).toHaveBeenCalledWith('/v1/users/user-id-456', {
      method: 'DELETE',
      body: '{}',
    });
  });
});

describe('useReactivateUser', () => {
  beforeEach(() => {
    apiFetchMock.mockClear();
  });

  it('POST /v1/users/:id/reactivate con body vuoto e invalida la query users', async () => {
    apiFetchMock.mockResolvedValueOnce({
      user: { ...mockUser, status: 'active', deletedAt: null },
    });

    const qc = makeQc();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useReactivateUser(), { wrapper: wrap(qc) });

    await result.current.mutateAsync({ id: 'user-id-1', body: {} });

    expect(apiFetchMock).toHaveBeenCalledWith('/v1/users/user-id-1/reactivate', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['users'] });
    });
  });

  it('POST con role + locationId override invia il payload corretto', async () => {
    apiFetchMock.mockResolvedValueOnce({
      user: { ...mockUser, status: 'active', deletedAt: null },
    });

    const qc = makeQc();
    const { result } = renderHook(() => useReactivateUser(), { wrapper: wrap(qc) });

    await result.current.mutateAsync({
      id: 'user-id-1',
      body: { role: 'super_admin', locationId: null },
    });

    expect(apiFetchMock).toHaveBeenCalledWith('/v1/users/user-id-1/reactivate', {
      method: 'POST',
      body: JSON.stringify({ role: 'super_admin', locationId: null }),
    });
  });
});
