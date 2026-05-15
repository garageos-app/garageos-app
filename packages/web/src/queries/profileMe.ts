import { useQuery } from '@tanstack/react-query';

import { useApiFetch } from '@/lib/api-client';

export interface ProfileMeDto {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'super_admin' | 'mechanic';
  tenantId: string;
  locationId: string | null;
  avatarUrl: string | null;
  phone: string | null;
  status: string;
  createdAt: string;
}

export function useProfileMe() {
  const apiFetch = useApiFetch();
  return useQuery({
    queryKey: ['users-me'],
    queryFn: () => apiFetch<ProfileMeDto>('/v1/users/me'),
    staleTime: 5 * 60 * 1000,
  });
}
