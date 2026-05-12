import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';

import { AuthContext, type AuthContextValue, type AuthState } from './AuthContext';
import { useHasRole } from './useHasRole';

function makeCtxValue(state: AuthState): AuthContextValue {
  return {
    state,
    signIn: async () => {},
    signOut: () => {},
    getIdToken: async () => null,
  };
}

function wrapWith(value: AuthContextValue) {
  return ({ children }: { children: ReactNode }) => (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  );
}

describe('useHasRole', () => {
  it('returns true when authenticated user has the asked-for role', () => {
    const ctx = makeCtxValue({
      status: 'authenticated',
      user: { email: 'a@b.com', role: 'super_admin' },
    });
    const { result } = renderHook(() => useHasRole('super_admin'), { wrapper: wrapWith(ctx) });
    expect(result.current).toBe(true);
  });

  it('returns false when authenticated user has a different role', () => {
    const ctx = makeCtxValue({
      status: 'authenticated',
      user: { email: 'a@b.com', role: 'mechanic' },
    });
    const { result } = renderHook(() => useHasRole('super_admin'), { wrapper: wrapWith(ctx) });
    expect(result.current).toBe(false);
  });

  it('returns false when authenticated user has no role claim', () => {
    const ctx = makeCtxValue({
      status: 'authenticated',
      user: { email: 'a@b.com' },
    });
    const { result } = renderHook(() => useHasRole('super_admin'), { wrapper: wrapWith(ctx) });
    expect(result.current).toBe(false);
  });

  it('returns false when state is unauthenticated', () => {
    const ctx = makeCtxValue({ status: 'unauthenticated' });
    const { result } = renderHook(() => useHasRole('super_admin'), { wrapper: wrapWith(ctx) });
    expect(result.current).toBe(false);
  });

  it('returns false when state is idle (rehydration in flight)', () => {
    const ctx = makeCtxValue({ status: 'idle' });
    const { result } = renderHook(() => useHasRole('super_admin'), { wrapper: wrapWith(ctx) });
    expect(result.current).toBe(false);
  });

  it('returns false when state is authenticating', () => {
    const ctx = makeCtxValue({ status: 'authenticating' });
    const { result } = renderHook(() => useHasRole('super_admin'), { wrapper: wrapWith(ctx) });
    expect(result.current).toBe(false);
  });
});
