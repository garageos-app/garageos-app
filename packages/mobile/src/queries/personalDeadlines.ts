// Personal deadline hooks — F-CLI-306 PR3 customer personal vehicle deadlines.
// Mirrors transfers.ts patterns (useApiClient + useQuery/useMutation/useQueryClient).
//
// Wire shapes (me-personal-deadlines.ts):
//   POST   /v1/me/personal-deadlines         → bare PersonalDeadlineDto (201)
//   GET    /v1/me/personal-deadlines          → { data: PersonalDeadlineDto[] }
//   GET    /v1/me/personal-deadlines/:id      → { personalDeadline: PersonalDeadlineDto }
//   PATCH  /v1/me/personal-deadlines/:id      → { personalDeadline: PersonalDeadlineDto }
//   POST   /v1/me/personal-deadlines/:id/complete → { personalDeadline, renewalSuggestion? }
//   DELETE /v1/me/personal-deadlines/:id      → 204 (empty)
//
// Invalidations:
//   create/update/complete/delete → ['personalDeadlines'] list
//   update/complete → also ['personalDeadlines', id] detail
//   delete → removeQueries(['personalDeadlines', id]) (entry gone from server)

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';
import type {
  PersonalDeadlineDto,
  PersonalDeadlineDetailResponse,
  PersonalDeadlinesListResponse,
  CompletePersonalDeadlineResponse,
  CreatePersonalDeadlineBody,
  UpdatePersonalDeadlineBody,
} from '@/lib/types/personalDeadline';

export function usePersonalDeadlines(filters?: { status?: string; vehicleId?: string }) {
  const api = useApiClient();
  return useQuery<PersonalDeadlinesListResponse, Error, PersonalDeadlineDto[]>({
    queryKey: ['personalDeadlines', filters ?? {}],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters?.status) params.set('status', filters.status);
      if (filters?.vehicleId) params.set('vehicleId', filters.vehicleId);
      const qs = params.toString();
      const path = qs ? `/v1/me/personal-deadlines?${qs}` : '/v1/me/personal-deadlines';
      return api.fetch<PersonalDeadlinesListResponse>(path);
    },
    select: (r) => r.data,
  });
}

export function usePersonalDeadline(id: string) {
  const api = useApiClient();
  return useQuery<PersonalDeadlineDetailResponse, Error, PersonalDeadlineDto>({
    queryKey: ['personalDeadlines', id],
    queryFn: () => api.fetch<PersonalDeadlineDetailResponse>(`/v1/me/personal-deadlines/${id}`),
    select: (r) => r.personalDeadline,
    enabled: id.length > 0,
  });
}

export function useCreatePersonalDeadline() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation<PersonalDeadlineDto, Error, CreatePersonalDeadlineBody>({
    mutationFn: (body) =>
      api.fetch<PersonalDeadlineDto>('/v1/me/personal-deadlines', {
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['personalDeadlines'] });
    },
  });
}

export function useUpdatePersonalDeadline() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation<PersonalDeadlineDto, Error, { id: string; body: UpdatePersonalDeadlineBody }>({
    mutationFn: async ({ id, body }) => {
      const r = await api.fetch<PersonalDeadlineDetailResponse>(`/v1/me/personal-deadlines/${id}`, {
        method: 'PATCH',
        body,
      });
      return r.personalDeadline;
    },
    onSuccess: (_dto, { id }) => {
      void qc.invalidateQueries({ queryKey: ['personalDeadlines'] });
      void qc.invalidateQueries({ queryKey: ['personalDeadlines', id] });
    },
  });
}

export function useCompletePersonalDeadline() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation<CompletePersonalDeadlineResponse, Error, string>({
    mutationFn: (id) =>
      // Always send a JSON body: the api-client only sets Content-Type when a
      // body is present, and the route parses request.body ?? {}.
      api.fetch<CompletePersonalDeadlineResponse>(`/v1/me/personal-deadlines/${id}/complete`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: (_res, id) => {
      void qc.invalidateQueries({ queryKey: ['personalDeadlines'] });
      void qc.invalidateQueries({ queryKey: ['personalDeadlines', id] });
    },
  });
}

export function useDeletePersonalDeadline() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => api.fetch<void>(`/v1/me/personal-deadlines/${id}`, { method: 'DELETE' }),
    onSuccess: (_v, id) => {
      void qc.invalidateQueries({ queryKey: ['personalDeadlines'] });
      qc.removeQueries({ queryKey: ['personalDeadlines', id] });
    },
  });
}
