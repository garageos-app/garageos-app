import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { AuthContext, type AuthContextValue } from '@/auth/AuthContext';

const mockAuth = (overrides: Partial<AuthContextValue> = {}): AuthContextValue => ({
  state: { status: 'authenticated', user: { email: 'm@x.com' } },
  signIn: vi.fn(),
  signOut: vi.fn(),
  getIdToken: vi.fn().mockResolvedValue('jwt'),
  ...overrides,
});

function renderAt(path: string, auth = mockAuth()) {
  return render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={[path]}>
        <Sidebar />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('Sidebar', () => {
  it('"Cerca veicolo" attivo per pathname /, /search, /vehicles/:id', () => {
    for (const path of ['/', '/search?q=x&t=plate', '/vehicles/uuid-1']) {
      const { unmount } = renderAt(path);
      const link = screen.getByRole('link', { name: /cerca veicolo/i });
      expect(link).toHaveAttribute('aria-current', 'page');
      unmount();
    }
  });

  it('voci disabilitate non-clickable e mostrano tooltip "Disponibile in v1.1"', () => {
    renderAt('/');
    const interventi = screen.getByText('Interventi');
    expect(interventi.closest('[aria-disabled="true"]')).not.toBeNull();
  });

  it('"Esci" chiama signOut', async () => {
    const auth = mockAuth();
    renderAt('/', auth);
    await userEvent.click(screen.getByRole('button', { name: /esci/i }));
    expect(auth.signOut).toHaveBeenCalledOnce();
  });
});
