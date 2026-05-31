import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useSearchParams } from 'react-router-dom';

const mutate = vi.fn();
vi.mock('@/queries/passwordReset', () => ({
  useRequestPasswordReset: () => ({ mutate, isPending: false }),
}));

import { ForgotPassword } from './ForgotPassword';

// Destination stub that echoes the email query so we can assert real navigation.
function ResetStub() {
  const [params] = useSearchParams();
  return <div>RESET email={params.get('email')}</div>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/forgot-password']}>
      <Routes>
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetStub />} />
        <Route path="/login" element={<div>LOGIN</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => mutate.mockReset());

describe('ForgotPassword', () => {
  it('navigates to /reset-password with the email on ok', async () => {
    mutate.mockResolvedValue({ ok: true });
    renderPage();
    await userEvent.type(screen.getByLabelText('Email'), 'mario@officina.it');
    await userEvent.click(screen.getByRole('button', { name: 'Invia codice' }));
    expect(mutate).toHaveBeenCalledWith('mario@officina.it');
    expect(await screen.findByText('RESET email=mario@officina.it')).toBeInTheDocument();
  });

  it('still navigates for an unknown email (anti-enumeration, no leak)', async () => {
    mutate.mockResolvedValue({ ok: true }); // wrapper silences UserNotFound → ok
    renderPage();
    await userEvent.type(screen.getByLabelText('Email'), 'ghost@nope.it');
    await userEvent.click(screen.getByRole('button', { name: 'Invia codice' }));
    expect(await screen.findByText('RESET email=ghost@nope.it')).toBeInTheDocument();
  });

  it('shows a rate-limit error and does not navigate', async () => {
    mutate.mockResolvedValue({ ok: false, code: 'rate_limited' });
    renderPage();
    await userEvent.type(screen.getByLabelText('Email'), 'mario@officina.it');
    await userEvent.click(screen.getByRole('button', { name: 'Invia codice' }));
    expect(await screen.findByText(/Troppi tentativi/)).toBeInTheDocument();
    expect(screen.queryByText(/^RESET/)).not.toBeInTheDocument();
  });

  it('blocks an invalid email format', async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText('Email'), 'notanemail');
    await userEvent.click(screen.getByRole('button', { name: 'Invia codice' }));
    expect(await screen.findByText("Inserisci un'email valida")).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });
});
