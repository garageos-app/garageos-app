import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { ApiError, useApiFetch } from '@/lib/api-client';
import { translateError } from '@/lib/error-messages';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AdminUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'super_admin' | 'mechanic';
  status: 'active' | 'inactive';
  createdAt: string;
  deletedAt: string | null;
}

export interface Invitation {
  id: string;
  targetEmail: string;
  firstName: string;
  lastName: string;
  role: 'super_admin' | 'mechanic';
  expiresAt: string;
  createdAt: string;
}

/** Shape returned by GET /v1/invitations/:token (public, pre-accept read). */
export interface InvitationPublicView {
  targetEmail: string;
  firstName: string;
  lastName: string;
  role: 'super_admin' | 'mechanic';
  tenantName: string;
  expiresAt: string;
}

export interface InviteUserBody {
  email: string;
  firstName: string;
  lastName: string;
  role: 'super_admin' | 'mechanic';
}

export interface UpdateUserBody {
  role?: 'super_admin' | 'mechanic';
  status?: 'active' | 'inactive';
}

export interface ReactivateUserBody {
  role?: 'super_admin' | 'mechanic';
}

export interface AcceptInvitationBody {
  password: string;
}

// ─── Query hooks ──────────────────────────────────────────────────────────────

/** GET /v1/users — list all tenant users (super_admin only). */
export function useUsers() {
  const apiFetch = useApiFetch();
  return useQuery({
    queryKey: ['users'],
    queryFn: () => apiFetch<{ users: AdminUser[] }>('/v1/users'),
  });
}

/** GET /v1/users/invitations — list pending invitations (super_admin only). */
export function useInvitations() {
  const apiFetch = useApiFetch();
  return useQuery({
    queryKey: ['invitations'],
    queryFn: () => apiFetch<{ invitations: Invitation[] }>('/v1/users/invitations'),
  });
}

/**
 * GET /v1/invitations/:token — public read of an invitation before acceptance.
 * Uses a plain fetch (no Authorization header) because the endpoint is public.
 */
export function useInvitation(token: string) {
  return useQuery({
    queryKey: ['invitation-public', token],
    queryFn: async () => {
      const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';
      const res = await fetch(`${baseUrl}/v1/invitations/${token}`, {
        headers: { 'Content-Type': 'application/json' },
      });
      const body = (await res.json().catch(() => ({}))) as {
        code?: unknown;
        detail?: unknown;
        message?: unknown;
        invitation?: unknown;
      };
      if (!res.ok) {
        const code = typeof body?.code === 'string' ? body.code : `http.${res.status}`;
        const message =
          typeof body?.detail === 'string'
            ? body.detail
            : typeof body?.message === 'string'
              ? body.message
              : `Errore ${res.status}`;
        throw new ApiError(code, res.status, message);
      }
      return body.invitation as InvitationPublicView;
    },
    enabled: Boolean(token),
    retry: false,
  });
}

// ─── Mutation hooks ───────────────────────────────────────────────────────────

/** POST /v1/users/invitations — send an invitation to a new user. */
export function useInviteUser() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation<{ invitation: Invitation }, ApiError, InviteUserBody>({
    mutationFn: (body) =>
      apiFetch<{ invitation: Invitation }>('/v1/users/invitations', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['invitations'] });
      toast.success('Invito inviato');
    },
    onError: (err) => {
      toast.error(translateError(err.code, err.message));
    },
  });
}

/** DELETE /v1/users/invitations/:id — revoke a pending invitation. */
export function useRevokeInvitation() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    // body: '{}' — apiFetch hardcodes Content-Type: application/json and
    // Fastify rejects requests with that header but no body. See
    // queries/avatarUpload.ts:123 for the same workaround.
    mutationFn: (id) =>
      apiFetch<void>(`/v1/users/invitations/${id}`, { method: 'DELETE', body: '{}' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['invitations'] });
      toast.success('Invito revocato');
    },
    onError: (err) => {
      toast.error(translateError(err.code, err.message));
    },
  });
}

/** PATCH /v1/users/:id — update role / locationId / status of a user. */
export function useUpdateUser() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation<{ user: AdminUser }, ApiError, { id: string; body: UpdateUserBody }>({
    mutationFn: ({ id, body }) =>
      apiFetch<{ user: AdminUser }>(`/v1/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      toast.success('Utente aggiornato');
    },
    onError: (err) => {
      toast.error(translateError(err.code, err.message));
    },
  });
}

/** DELETE /v1/users/:id — soft-delete a user (sets deletedAt). */
export function useDeleteUser() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    // body: '{}' — apiFetch hardcodes Content-Type: application/json and
    // Fastify rejects requests with that header but no body.
    mutationFn: (id) => apiFetch<void>(`/v1/users/${id}`, { method: 'DELETE', body: '{}' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      toast.success('Utente rimosso');
    },
    onError: (err) => {
      toast.error(translateError(err.code, err.message));
    },
  });
}

/** POST /v1/users/:id/reactivate — re-enable a soft-deleted user (BR-212). */
export function useReactivateUser() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation<{ user: AdminUser }, ApiError, { id: string; body: ReactivateUserBody }>({
    mutationFn: ({ id, body }) =>
      apiFetch<{ user: AdminUser }>(`/v1/users/${id}/reactivate`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      toast.success('Utente riattivato');
    },
    onError: (err) => {
      toast.error(translateError(err.code, err.message));
    },
  });
}

/**
 * POST /v1/invitations/:token/accept — public mutation to accept an invitation
 * and set the account password. Uses a plain fetch (no Authorization header).
 */
export function useAcceptInvitation() {
  return useMutation<void, ApiError, { token: string; body: AcceptInvitationBody }>({
    mutationFn: async ({ token, body }) => {
      const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';
      const res = await fetch(`${baseUrl}/v1/invitations/${token}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const resBody = (await res.json().catch(() => ({}))) as {
        code?: unknown;
        detail?: unknown;
        message?: unknown;
      };
      if (!res.ok) {
        const code = typeof resBody?.code === 'string' ? resBody.code : `http.${res.status}`;
        const message =
          typeof resBody?.detail === 'string'
            ? resBody.detail
            : typeof resBody?.message === 'string'
              ? resBody.message
              : `Errore ${res.status}`;
        throw new ApiError(code, res.status, message);
      }
    },
  });
}
