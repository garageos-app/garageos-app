import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PasswordForm } from './PasswordForm';
import * as changePasswordModule from '@/queries/changePassword';
import type { UseChangePasswordResult } from '@/queries/changePassword';

// Stub sonner to avoid ESM imports in JSDOM.
const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (msg: string) => toastSuccessMock(msg),
    error: (msg: string) => toastErrorMock(msg),
  },
}));

const getIdTokenMock = vi.fn();
vi.mock('@/auth/useAuth', () => ({
  useAuth: () => ({ getIdToken: getIdTokenMock }),
}));

describe('PasswordForm', () => {
  let mutate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mutate = vi.fn();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    getIdTokenMock.mockReset();
    getIdTokenMock.mockResolvedValue('id-token-xyz');
    vi.spyOn(changePasswordModule, 'notifyPasswordChanged').mockResolvedValue(undefined);
    vi.spyOn(changePasswordModule, 'useChangePassword').mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as UseChangePasswordResult);
  });

  it('renders 3 password fields and helper text', () => {
    render(<PasswordForm />);
    expect(screen.getByLabelText('Password attuale')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Nuova password')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Conferma nuova password')).toHaveAttribute('type', 'password');
    expect(
      screen.getByText('Almeno 10 caratteri, una maiuscola, una minuscola, un numero.'),
    ).toBeInTheDocument();
  });

  it('Submit button disabled when pristine', () => {
    render(<PasswordForm />);
    expect(screen.getByRole('button', { name: 'Cambia password' })).toBeDisabled();
  });

  it('shows inline error when newPassword fails policy', async () => {
    const user = userEvent.setup();
    render(<PasswordForm />);
    await user.type(screen.getByLabelText('Password attuale'), 'OldPass123');
    await user.type(screen.getByLabelText('Nuova password'), 'weak');
    await user.type(screen.getByLabelText('Conferma nuova password'), 'weak');
    await user.click(screen.getByRole('button', { name: 'Cambia password' }));
    await waitFor(() => {
      expect(screen.getByText('Almeno 10 caratteri')).toBeInTheDocument();
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('shows inline error when new and confirm mismatch', async () => {
    const user = userEvent.setup();
    render(<PasswordForm />);
    await user.type(screen.getByLabelText('Password attuale'), 'OldPass123');
    await user.type(screen.getByLabelText('Nuova password'), 'NewPass456');
    await user.type(screen.getByLabelText('Conferma nuova password'), 'Different789');
    await user.click(screen.getByRole('button', { name: 'Cambia password' }));
    await waitFor(() => {
      expect(screen.getByText('Le password non coincidono')).toBeInTheDocument();
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('success path: calls mutate, shows toast, resets form', async () => {
    mutate.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<PasswordForm />);
    await user.type(screen.getByLabelText('Password attuale'), 'OldPass123');
    await user.type(screen.getByLabelText('Nuova password'), 'NewPass456');
    await user.type(screen.getByLabelText('Conferma nuova password'), 'NewPass456');
    await user.click(screen.getByRole('button', { name: 'Cambia password' }));
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith('OldPass123', 'NewPass456');
    });
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith('Password aggiornata.');
    });
    // After reset, oldPassword should be cleared
    expect(screen.getByLabelText('Password attuale')).toHaveValue('');
  });

  it('wrong_old_password: sets inline error on oldPassword', async () => {
    mutate.mockResolvedValue({ ok: false, code: 'wrong_old_password' });
    const user = userEvent.setup();
    render(<PasswordForm />);
    await user.type(screen.getByLabelText('Password attuale'), 'Wrong12345');
    await user.type(screen.getByLabelText('Nuova password'), 'NewPass456');
    await user.type(screen.getByLabelText('Conferma nuova password'), 'NewPass456');
    await user.click(screen.getByRole('button', { name: 'Cambia password' }));
    await waitFor(() => {
      expect(screen.getByText('Password attuale non corretta')).toBeInTheDocument();
    });
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('password_too_weak from Cognito: sets inline error on newPassword', async () => {
    mutate.mockResolvedValue({ ok: false, code: 'password_too_weak' });
    const user = userEvent.setup();
    render(<PasswordForm />);
    await user.type(screen.getByLabelText('Password attuale'), 'OldPass123');
    await user.type(screen.getByLabelText('Nuova password'), 'NewPass456');
    await user.type(screen.getByLabelText('Conferma nuova password'), 'NewPass456');
    await user.click(screen.getByRole('button', { name: 'Cambia password' }));
    await waitFor(() => {
      expect(screen.getByText('La password non rispetta i requisiti')).toBeInTheDocument();
    });
  });

  it('rate_limited: shows toast error', async () => {
    mutate.mockResolvedValue({ ok: false, code: 'rate_limited' });
    const user = userEvent.setup();
    render(<PasswordForm />);
    await user.type(screen.getByLabelText('Password attuale'), 'OldPass123');
    await user.type(screen.getByLabelText('Nuova password'), 'NewPass456');
    await user.type(screen.getByLabelText('Conferma nuova password'), 'NewPass456');
    await user.click(screen.getByRole('button', { name: 'Cambia password' }));
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('Troppi tentativi, riprova tra qualche minuto.');
    });
  });

  it('not_authenticated: shows toast error', async () => {
    mutate.mockResolvedValue({ ok: false, code: 'not_authenticated' });
    const user = userEvent.setup();
    render(<PasswordForm />);
    await user.type(screen.getByLabelText('Password attuale'), 'OldPass123');
    await user.type(screen.getByLabelText('Nuova password'), 'NewPass456');
    await user.type(screen.getByLabelText('Conferma nuova password'), 'NewPass456');
    await user.click(screen.getByRole('button', { name: 'Cambia password' }));
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith("Sessione scaduta. Effettua di nuovo l'accesso.");
    });
  });

  it('unknown error: shows generic toast error', async () => {
    mutate.mockResolvedValue({ ok: false, code: 'unknown' });
    const user = userEvent.setup();
    render(<PasswordForm />);
    await user.type(screen.getByLabelText('Password attuale'), 'OldPass123');
    await user.type(screen.getByLabelText('Nuova password'), 'NewPass456');
    await user.type(screen.getByLabelText('Conferma nuova password'), 'NewPass456');
    await user.click(screen.getByRole('button', { name: 'Cambia password' }));
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('Impossibile contattare il server. Riprova.');
    });
  });

  it('button shows pending label and disabled when isPending', () => {
    vi.spyOn(changePasswordModule, 'useChangePassword').mockReturnValue({
      mutate,
      isPending: true,
    } as unknown as UseChangePasswordResult);
    render(<PasswordForm />);
    const btn = screen.getByRole('button', { name: 'Aggiornamento...' });
    expect(btn).toBeDisabled();
  });

  it('success: fires notifyPasswordChanged with the id token', async () => {
    mutate.mockResolvedValue({ ok: true });
    const notifySpy = vi
      .spyOn(changePasswordModule, 'notifyPasswordChanged')
      .mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<PasswordForm />);
    await user.type(screen.getByLabelText('Password attuale'), 'OldPass123');
    await user.type(screen.getByLabelText('Nuova password'), 'NewPass456');
    await user.type(screen.getByLabelText('Conferma nuova password'), 'NewPass456');
    await user.click(screen.getByRole('button', { name: 'Cambia password' }));
    await waitFor(() => {
      expect(notifySpy).toHaveBeenCalledWith('id-token-xyz');
    });
  });

  it('success: still shows toast even if the notify rejects (best-effort)', async () => {
    mutate.mockResolvedValue({ ok: true });
    vi.spyOn(changePasswordModule, 'notifyPasswordChanged').mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    render(<PasswordForm />);
    await user.type(screen.getByLabelText('Password attuale'), 'OldPass123');
    await user.type(screen.getByLabelText('Nuova password'), 'NewPass456');
    await user.type(screen.getByLabelText('Conferma nuova password'), 'NewPass456');
    await user.click(screen.getByRole('button', { name: 'Cambia password' }));
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith('Password aggiornata.');
    });
  });
});
