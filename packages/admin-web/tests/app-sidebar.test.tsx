import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/layout/AppSidebar';

const { mockSignOut } = vi.hoisted(() => ({ mockSignOut: vi.fn() }));

vi.mock('@/auth/useAuth', () => ({
  useAuth: () => ({
    signOut: mockSignOut,
    state: {
      status: 'authenticated',
      user: { email: 'admin@garageos.it', givenName: 'Mario', familyName: 'Rossi' },
    },
    signIn: vi.fn(),
    getIdToken: vi.fn(),
    completeNewPassword: vi.fn(),
  }),
}));

function renderSidebar(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => mockSignOut.mockReset());

describe('AppSidebar', () => {
  it('renders the nav items with the active item marked', () => {
    renderSidebar('/officine');
    const officine = screen.getByRole('link', { name: /officine/i });
    expect(officine).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /dashboard/i })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: /audit/i })).toBeInTheDocument();
  });

  it('shows the admin identity and signs out from the footer menu', async () => {
    const user = userEvent.setup();
    renderSidebar('/');
    expect(screen.getByText('Mario Rossi')).toBeInTheDocument();
    expect(screen.getByText('admin@garageos.it')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /mario rossi/i }));
    await user.click(await screen.findByText(/esci/i));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});
