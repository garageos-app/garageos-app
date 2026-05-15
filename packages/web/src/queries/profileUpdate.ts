import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { ApiError, useApiFetch } from '@/lib/api-client';
import { translateError } from '@/lib/error-messages';
import type { ProfileMeDto } from './profileMe';

export interface ProfileUpdateBody {
  firstName?: string;
  lastName?: string;
  phone?: string | null;
}

export function useProfileUpdate() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation<ProfileMeDto, ApiError, ProfileUpdateBody>({
    mutationFn: (body) =>
      apiFetch<ProfileMeDto>('/v1/users/me', {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users-me'] });
      toast.success('Modifiche salvate');
    },
    onError: (err) => {
      toast.error(translateError(err.code, err.message));
    },
  });
}
