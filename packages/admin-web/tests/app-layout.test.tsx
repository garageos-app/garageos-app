import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from '@/theme/ThemeContext';
import { AppLayout } from '@/components/layout/AppLayout';

vi.mock('@/auth/useAuth', () => ({
  useAuth: () => ({
    signOut: vi.fn(),
    state: {
      status: 'authenticated',
      user: { email: 'admin@garageos.it', givenName: 'Mario', familyName: 'Rossi' },
    },
    signIn: vi.fn(),
    getIdToken: vi.fn(),
    completeNewPassword: vi.fn(),
  }),
}));

describe('AppLayout', () => {
  it('renders the sidebar nav, topbar title, and the routed page content', () => {
    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<AppLayout />}>
              <Route path="/" element={<div>dashboard-content</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ThemeProvider>,
    );
    expect(screen.getByRole('link', { name: /officine/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('dashboard-content')).toBeInTheDocument();
  });
});
