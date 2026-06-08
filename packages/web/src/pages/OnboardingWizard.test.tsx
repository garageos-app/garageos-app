import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const navigate = vi.fn();
const mutateAsync = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});
vi.mock('@/queries/tenantOnboarding', () => ({
  useCompleteOnboarding: () => ({ mutateAsync, isPending: false }),
}));
// Stub the heavy reused sections so the test focuses on wizard flow.
vi.mock('@/pages/LocationManagement', () => ({ LocationManagement: () => <div>SEDI</div> }));
vi.mock('@/pages/UserManagement', () => ({ UserManagement: () => <div>UTENTI</div> }));
vi.mock('@/components/settings/TenantForm', () => ({ TenantForm: () => <div>DATI</div> }));
vi.mock('@/queries/tenantMe', () => ({
  useTenantMe: () => ({
    data: { businessName: 'X', email: 'x@y.it', onboardingCompletedAt: null },
    isPending: false,
    isError: false,
  }),
}));

import { OnboardingWizard } from './OnboardingWizard';

function renderPage() {
  return render(
    <MemoryRouter>
      <OnboardingWizard />
    </MemoryRouter>,
  );
}

describe('OnboardingWizard', () => {
  beforeEach(() => {
    navigate.mockReset();
    mutateAsync.mockReset();
  });

  it('starts on step 1 (sedi) and walks forward to step 3', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(screen.getByText('SEDI')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /avanti/i }));
    expect(screen.getByText('UTENTI')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /avanti/i }));
    expect(screen.getByText('DATI')).toBeInTheDocument();
  });

  it('«Salta configurazione» navigates home WITHOUT completing', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /salta configurazione/i }));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('«Fine» completes then navigates home with flash', async () => {
    mutateAsync.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /avanti/i }));
    await user.click(screen.getByRole('button', { name: /avanti/i }));
    await user.click(screen.getByRole('button', { name: /^fine$/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(navigate).toHaveBeenCalledWith('/', { state: { flash: 'Configurazione completata.' } });
  });

  it('«Fine» best-effort: navigates home even if complete fails', async () => {
    mutateAsync.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /avanti/i }));
    await user.click(screen.getByRole('button', { name: /avanti/i }));
    await user.click(screen.getByRole('button', { name: /^fine$/i }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
  });
});
