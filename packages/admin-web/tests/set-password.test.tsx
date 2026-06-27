import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthContext, type AuthState } from '@/auth/AuthContext';
import { SetPassword } from '@/pages/SetPassword';

// Render SetPassword inside a minimal router. The Routes setup lets us assert
// redirects without navigating to a real page.
function renderSetPassword(state: AuthState, completeNewPassword = vi.fn()) {
  return {
    completeNewPassword,
    ...render(
      <AuthContext.Provider
        value={{
          state,
          signIn: vi.fn(),
          signOut: vi.fn(),
          getIdToken: vi.fn(),
          completeNewPassword,
        }}
      >
        <MemoryRouter initialEntries={['/set-password']}>
          <Routes>
            <Route path="/set-password" element={<SetPassword />} />
            <Route path="/" element={<div>console-page</div>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SetPassword page', () => {
  it('shows a validation error and does NOT call completeNewPassword for a too-weak password', async () => {
    // 'short' is 5 chars — fails min(10), uppercase, and digit rules.
    const completeNewPassword = vi.fn();
    renderSetPassword({ status: 'new_password_required' }, completeNewPassword);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/nuova password/i), 'short');
    await user.type(screen.getByLabelText(/conferma password/i), 'short');
    await user.click(screen.getByRole('button', { name: /salva password/i }));

    // Client-side Zod validation must fire before the async submit handler.
    expect(await screen.findByText(/almeno 10 caratteri/i)).toBeInTheDocument();
    expect(completeNewPassword).not.toHaveBeenCalled();
  });

  it('calls completeNewPassword with a policy-compliant password', async () => {
    // 'NuovaPass123' satisfies: 12 chars, lowercase, uppercase, digit.
    const completeNewPassword = vi.fn().mockResolvedValue(undefined);
    renderSetPassword({ status: 'new_password_required' }, completeNewPassword);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/nuova password/i), 'NuovaPass123');
    await user.type(screen.getByLabelText(/conferma password/i), 'NuovaPass123');
    await user.click(screen.getByRole('button', { name: /salva password/i }));

    await waitFor(() => expect(completeNewPassword).toHaveBeenCalledWith('NuovaPass123'));
  });

  it('shows the auth error alert when state is unauthenticated with an error', () => {
    renderSetPassword({
      status: 'unauthenticated',
      error:
        'La password non rispetta i requisiti di sicurezza (almeno 10 caratteri, con maiuscole, minuscole e numeri).',
    });

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/almeno 10 caratteri/)).toBeInTheDocument();
  });
});
