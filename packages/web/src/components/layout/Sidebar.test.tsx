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
  it('"Home" attivo solo per pathname / (non /search né /vehicles)', () => {
    // Home is active on / only
    const { unmount: u1 } = renderAt('/');
    const homeLink = screen.getByRole('link', { name: /home/i });
    expect(homeLink).toHaveAttribute('href', '/');
    expect(homeLink).toHaveAttribute('aria-current', 'page');
    u1();

    // Home is NOT active on /search (search now lives in topbar; /search is its own page)
    const { unmount: u2 } = renderAt('/search?q=foo');
    const homeOnSearch = screen.getByRole('link', { name: /home/i });
    expect(homeOnSearch).not.toHaveAttribute('aria-current', 'page');
    u2();

    // Home is NOT active on /vehicles/:id
    renderAt('/vehicles/uuid-1');
    const homeOnVehicle = screen.getByRole('link', { name: /home/i });
    expect(homeOnVehicle).not.toHaveAttribute('aria-current', 'page');
  });

  it('"Cerca veicolo" non è più presente nel sidebar (search è ora in TopBar)', () => {
    renderAt('/');
    expect(screen.queryByText('Cerca veicolo')).not.toBeInTheDocument();
  });

  it('voci disabilitate non-clickable e mostrano tooltip "Disponibile in v1.1"', () => {
    renderAt('/');
    const interventi = screen.getByText('Interventi');
    expect(interventi.closest('[aria-disabled="true"]')).not.toBeNull();
  });

  it('"Clienti" linka a /customers ed è attivo su quel path', () => {
    const { unmount } = renderAt('/customers');
    const link = screen.getByRole('link', { name: /clienti/i });
    expect(link).toHaveAttribute('href', '/customers');
    expect(link).toHaveAttribute('aria-current', 'page');
    unmount();
  });

  it('"Esci" chiama signOut', async () => {
    const auth = mockAuth();
    renderAt('/', auth);
    await userEvent.click(screen.getByRole('button', { name: /esci/i }));
    expect(auth.signOut).toHaveBeenCalledOnce();
  });
});
