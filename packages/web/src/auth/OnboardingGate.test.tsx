import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const authState = {
  value: { status: 'authenticated', user: { role: 'super_admin' } } as Record<string, unknown>,
};
const tenantQ = { value: { data: undefined as unknown, isPending: true, isError: false } };

vi.mock('@/auth/useAuth', () => ({ useAuth: () => ({ state: authState.value }) }));
vi.mock('@/queries/tenantMe', () => ({ useTenantMe: () => tenantQ.value }));

import { OnboardingGate } from './OnboardingGate';
import { markOnboardingSkipped } from '@/lib/onboardingSkip';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<OnboardingGate />}>
          <Route path="/" element={<div>APP</div>} />
        </Route>
        <Route path="/onboarding" element={<div>WIZARD</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OnboardingGate', () => {
  beforeEach(() => {
    sessionStorage.clear();
    authState.value = { status: 'authenticated', user: { role: 'super_admin' } };
    tenantQ.value = { data: undefined, isPending: false, isError: false };
  });

  it('redirects un-onboarded super_admin to /onboarding', () => {
    tenantQ.value = { data: { onboardingCompletedAt: null }, isPending: false, isError: false };
    renderAt('/');
    expect(screen.getByText('WIZARD')).toBeInTheDocument();
  });

  it('does NOT redirect un-onboarded super_admin who skipped this session', () => {
    markOnboardingSkipped();
    tenantQ.value = { data: { onboardingCompletedAt: null }, isPending: false, isError: false };
    renderAt('/');
    expect(screen.getByText('APP')).toBeInTheDocument();
    expect(screen.queryByText('WIZARD')).not.toBeInTheDocument();
  });

  it('renders app for super_admin with onboarding completed', () => {
    tenantQ.value = {
      data: { onboardingCompletedAt: '2026-06-08T10:00:00Z' },
      isPending: false,
      isError: false,
    };
    renderAt('/');
    expect(screen.getByText('APP')).toBeInTheDocument();
  });

  it('renders app for mechanics (never gated)', () => {
    authState.value = { status: 'authenticated', user: { role: 'mechanic' } };
    tenantQ.value = { data: undefined, isPending: false, isError: false };
    renderAt('/');
    expect(screen.getByText('APP')).toBeInTheDocument();
  });

  it('shows spinner (no redirect) while tenant query is loading for super_admin', () => {
    tenantQ.value = { data: undefined, isPending: true, isError: false };
    renderAt('/');
    expect(screen.queryByText('WIZARD')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders app (fail-open) when tenant query errors', () => {
    tenantQ.value = { data: undefined, isPending: false, isError: true };
    renderAt('/');
    expect(screen.getByText('APP')).toBeInTheDocument();
  });
});
