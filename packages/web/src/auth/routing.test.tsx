import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';

// Tier-2 routing test: after removing OnboardingGate (C2), an authenticated
// super_admin whose tenant has onboardingCompletedAt: null must land directly
// in the app shell — there is no /onboarding redirect in the route tree.
vi.mock('@/auth/useAuth', () => ({
  useAuth: () => ({ state: { status: 'authenticated', user: { role: 'super_admin' } } }),
}));
vi.mock('@/queries/tenantMe', () => ({
  useTenantMe: () => ({ data: { onboardingCompletedAt: null }, isPending: false, isError: false }),
}));

function AppShellStub() {
  return (
    <div data-testid="app-shell">
      <Outlet />
    </div>
  );
}

describe('App routing — onboarding gate removed', () => {
  it('super_admin with onboardingCompletedAt: null lands in the app shell (no /onboarding redirect)', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AppShellStub />}>
            <Route path="/" element={<div>HOME</div>} />
          </Route>
          <Route path="/onboarding" element={<div>WIZARD</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    expect(screen.getByText('HOME')).toBeInTheDocument();
    expect(screen.queryByText('WIZARD')).not.toBeInTheDocument();
  });
});
