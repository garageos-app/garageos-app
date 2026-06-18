import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ProfileForm } from './ProfileForm';
import * as profileUpdateModule from '@/queries/profileUpdate';
import type { ProfileMeDto } from '@/queries/profileMe';

// AvatarSection has its own test suite; stub it here to avoid
// pulling in useAuth/useApiFetch dependencies outside this unit's scope.
vi.mock('./AvatarSection', () => ({
  AvatarSection: () => <div data-testid="avatar-section-stub" />,
}));

const baseProfile: ProfileMeDto = {
  id: 'u-1',
  email: 'u@t.test',
  firstName: 'Mario',
  lastName: 'Rossi',
  role: 'mechanic',
  tenantId: 't-1',
  locationId: null,
  avatarUrl: null,
  phone: '+39 333 1112233',
  status: 'active',
  createdAt: '2026-05-15T00:00:00Z',
  tenant: { businessName: 'Matula' },
  location: null,
};

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe('ProfileForm', () => {
  let mockMutate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockMutate = vi.fn().mockResolvedValue({ ...baseProfile, firstName: 'Marco' });
    vi.spyOn(profileUpdateModule, 'useProfileUpdate').mockReturnValue({
      mutateAsync: mockMutate,
      isPending: false,
    } as unknown as ReturnType<typeof profileUpdateModule.useProfileUpdate>);
  });

  it('renders defaultValues from profile prop', () => {
    render(wrap(<ProfileForm profile={baseProfile} />));
    expect(screen.getByLabelText('Nome')).toHaveValue('Mario');
    expect(screen.getByLabelText('Cognome')).toHaveValue('Rossi');
    expect(screen.getByLabelText('Telefono')).toHaveValue('+39 333 1112233');
  });

  it('Save button disabled when form is pristine', () => {
    render(wrap(<ProfileForm profile={baseProfile} />));
    expect(screen.getByRole('button', { name: 'Salva' })).toBeDisabled();
  });

  it('submits only dirty fields as diff', async () => {
    render(wrap(<ProfileForm profile={baseProfile} />));
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Marco' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(mockMutate).toHaveBeenCalledTimes(1));
    expect(mockMutate).toHaveBeenCalledWith({ firstName: 'Marco' });
  });

  it('shows validation error for empty firstName', async () => {
    render(wrap(<ProfileForm profile={baseProfile} />));
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => {
      expect(screen.getByText('Nome obbligatorio')).toBeInTheDocument();
    });
    expect(mockMutate).not.toHaveBeenCalled();
  });
});
