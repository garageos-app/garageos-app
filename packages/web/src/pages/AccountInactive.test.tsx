import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AccountInactive } from './AccountInactive';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const signOutMock = vi.fn();
vi.mock('@/auth/useAuth', () => ({
  useAuth: () => ({
    state: { status: 'account_inactive' as const },
    signOut: signOutMock,
  }),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AccountInactive page', () => {
  beforeEach(() => {
    signOutMock.mockClear();
  });

  it('renders the generic terminal message and the back-to-login button', () => {
    render(<AccountInactive />);
    expect(screen.getByText(/Il tuo accesso non è al momento disponibile/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Torna al login/i })).toBeInTheDocument();
  });

  it('calls signOut when "Torna al login" is clicked', async () => {
    render(<AccountInactive />);
    await userEvent.click(screen.getByRole('button', { name: /Torna al login/i }));
    expect(signOutMock).toHaveBeenCalledOnce();
  });
});
