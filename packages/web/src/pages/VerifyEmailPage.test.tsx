import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import VerifyEmailPage from './VerifyEmailPage';

const fetchSpy = vi.spyOn(globalThis, 'fetch');

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/verify-email" element={<VerifyEmailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('VerifyEmailPage', () => {
  beforeEach(() => {
    fetchSpy.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state while the API call is in flight', () => {
    fetchSpy.mockImplementation(() => new Promise(() => {})); // never resolves
    renderAt('/verify-email?token=abc');
    expect(screen.getByText(/Verifica in corso/i)).toBeInTheDocument();
  });

  it('shows success state on 200 response', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ customerId: 'c1', email: 'mario@example.com' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    renderAt('/verify-email?token=abc');
    await waitFor(() => {
      expect(screen.getByText(/Email verificata/i)).toBeInTheDocument();
    });
  });

  it('shows error state on 410 expired', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ type: 'auth.verify_email.token_expired', detail: 'expired' }), {
        status: 410,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    renderAt('/verify-email?token=abc');
    await waitFor(() => {
      expect(screen.getByText(/scaduto/i)).toBeInTheDocument();
    });
  });

  it('shows missing-token error when no ?token param', () => {
    renderAt('/verify-email');
    expect(screen.getByText(/Link non valido/i)).toBeInTheDocument();
  });
});
