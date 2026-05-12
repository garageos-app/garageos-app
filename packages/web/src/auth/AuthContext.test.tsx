import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { userFromIdToken } from './AuthContext';

// Builds the minimal idToken shape userFromIdToken consumes — a thin
// stand-in for CognitoIdToken with a payload bag of claims.
function makeIdToken(payload: Record<string, unknown>) {
  return { payload };
}

describe('userFromIdToken', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('extracts role and tenantId when both claims are valid', () => {
    const user = userFromIdToken(
      makeIdToken({
        email: 'mario@example.com',
        given_name: 'Mario',
        family_name: 'Rossi',
        'custom:role': 'super_admin',
        'custom:tenant_id': '11111111-1111-1111-1111-111111111111',
      }),
    );
    expect(user.email).toBe('mario@example.com');
    expect(user.givenName).toBe('Mario');
    expect(user.familyName).toBe('Rossi');
    expect(user.role).toBe('super_admin');
    expect(user.tenantId).toBe('11111111-1111-1111-1111-111111111111');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('accepts mechanic as a valid role', () => {
    const user = userFromIdToken(
      makeIdToken({
        email: 'meccanico@example.com',
        'custom:role': 'mechanic',
        'custom:tenant_id': '22222222-2222-2222-2222-222222222222',
      }),
    );
    expect(user.role).toBe('mechanic');
  });

  it('treats unknown role values as undefined and warns once', () => {
    const user = userFromIdToken(
      makeIdToken({
        email: 'support@example.com',
        'custom:role': 'support_agent',
        'custom:tenant_id': '33333333-3333-3333-3333-333333333333',
      }),
    );
    expect(user.role).toBeUndefined();
    expect(user.tenantId).toBe('33333333-3333-3333-3333-333333333333');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('AuthContext: unknown custom:role claim, ignoring', {
      raw: 'support_agent',
    });
  });

  it('treats missing role and missing tenantId as undefined without warning', () => {
    const user = userFromIdToken(
      makeIdToken({
        email: 'legacy@example.com',
      }),
    );
    expect(user.email).toBe('legacy@example.com');
    expect(user.role).toBeUndefined();
    expect(user.tenantId).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('treats empty-string tenantId as undefined', () => {
    const user = userFromIdToken(
      makeIdToken({
        email: 'mario@example.com',
        'custom:role': 'super_admin',
        'custom:tenant_id': '',
      }),
    );
    expect(user.tenantId).toBeUndefined();
  });
});
