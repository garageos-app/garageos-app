import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

const { confirmMutate, resendMutate, notifyMock } = vi.hoisted(() => ({
  confirmMutate: vi.fn(),
  resendMutate: vi.fn(),
  notifyMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/queries/passwordReset', () => ({
  useConfirmPasswordReset: () => ({ mutate: confirmMutate, isPending: false }),
  useRequestPasswordReset: () => ({ mutate: resendMutate, isPending: false }),
  notifyPasswordResetCompleted: notifyMock,
}));

import { ResetPassword } from './ResetPassword';

// /login stub echoes the flash passed via navigation state.
function LoginStub() {
  const loc = useLocation();
  const flash = (loc.state as { flash?: string } | null)?.flash;
  return <div>LOGIN flash={flash}</div>;
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/forgot-password" element={<div>FORGOT</div>} />
        <Route path="/login" element={<LoginStub />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  confirmMutate.mockReset();
  resendMutate.mockReset();
  notifyMock.mockReset();
  notifyMock.mockResolvedValue(undefined);
});

describe('ResetPassword', () => {
  it('redirects to /forgot-password when email is missing', () => {
    renderAt('/reset-password');
    expect(screen.getByText('FORGOT')).toBeInTheDocument();
  });

  it('resets and navigates to /login with a success flash on ok', async () => {
    confirmMutate.mockResolvedValue({ ok: true });
    renderAt('/reset-password?email=mario%40officina.it');
    await userEvent.type(screen.getByLabelText('Codice'), '123456');
    await userEvent.type(screen.getByLabelText('Nuova password'), 'Str0ngPw!');
    await userEvent.type(screen.getByLabelText('Conferma password'), 'Str0ngPw!');
    await userEvent.click(screen.getByRole('button', { name: 'Reimposta password' }));
    expect(confirmMutate).toHaveBeenCalledWith('mario@officina.it', '123456', 'Str0ngPw!');
    expect(
      await screen.findByText('LOGIN flash=Password aggiornata. Accedi con la nuova password.'),
    ).toBeInTheDocument();
  });

  it('blocks mismatched passwords', async () => {
    renderAt('/reset-password?email=mario%40officina.it');
    await userEvent.type(screen.getByLabelText('Codice'), '123456');
    await userEvent.type(screen.getByLabelText('Nuova password'), 'Str0ngPw!');
    await userEvent.type(screen.getByLabelText('Conferma password'), 'Different1!');
    await userEvent.click(screen.getByRole('button', { name: 'Reimposta password' }));
    expect(await screen.findByText('Le password non coincidono')).toBeInTheDocument();
    expect(confirmMutate).not.toHaveBeenCalled();
  });

  it('shows an inline error for an invalid code', async () => {
    confirmMutate.mockResolvedValue({ ok: false, code: 'code_invalid' });
    renderAt('/reset-password?email=mario%40officina.it');
    await userEvent.type(screen.getByLabelText('Codice'), '000000');
    await userEvent.type(screen.getByLabelText('Nuova password'), 'Str0ngPw!');
    await userEvent.type(screen.getByLabelText('Conferma password'), 'Str0ngPw!');
    await userEvent.click(screen.getByRole('button', { name: 'Reimposta password' }));
    expect(await screen.findByText('Codice non valido.')).toBeInTheDocument();
  });

  it('resends the code', async () => {
    resendMutate.mockResolvedValue({ ok: true });
    renderAt('/reset-password?email=mario%40officina.it');
    await userEvent.click(screen.getByRole('button', { name: 'Invia di nuovo il codice' }));
    expect(resendMutate).toHaveBeenCalledWith('mario@officina.it');
    expect(await screen.findByText(/nuovo codice/i)).toBeInTheDocument();
  });

  it('success: fires notifyPasswordResetCompleted with the email', async () => {
    confirmMutate.mockResolvedValue({ ok: true });
    renderAt('/reset-password?email=mario%40officina.it');
    await userEvent.type(screen.getByLabelText('Codice'), '123456');
    await userEvent.type(screen.getByLabelText('Nuova password'), 'Str0ngPw!');
    await userEvent.type(screen.getByLabelText('Conferma password'), 'Str0ngPw!');
    await userEvent.click(screen.getByRole('button', { name: 'Reimposta password' }));
    await waitFor(() => {
      expect(notifyMock).toHaveBeenCalledWith('mario@officina.it');
    });
  });

  it('success: still navigates to /login even if the notify rejects', async () => {
    confirmMutate.mockResolvedValue({ ok: true });
    notifyMock.mockRejectedValueOnce(new Error('boom'));
    renderAt('/reset-password?email=mario%40officina.it');
    await userEvent.type(screen.getByLabelText('Codice'), '123456');
    await userEvent.type(screen.getByLabelText('Nuova password'), 'Str0ngPw!');
    await userEvent.type(screen.getByLabelText('Conferma password'), 'Str0ngPw!');
    await userEvent.click(screen.getByRole('button', { name: 'Reimposta password' }));
    expect(
      await screen.findByText('LOGIN flash=Password aggiornata. Accedi con la nuova password.'),
    ).toBeInTheDocument();
  });
});
