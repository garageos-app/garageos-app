// Unit tests for cognito-triggers/handlers.ts.
//
// Security boundary under test: the PreSignUp trigger must NEVER link a
// Google identity to a native account unless Google asserts email_verified
// === 'true'. This is an anti-account-takeover guard (see brief Task 2).
//
// All AWS/DB side effects are mocked — these are pure-logic unit tests.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Module mocks (hoisted to top of file by vitest) ---

vi.mock('@garageos/database', () => ({
  withContext: vi.fn(),
}));

vi.mock('../../../src/lib/customer-provisioning.js', () => ({
  provisionCustomer: vi.fn(),
}));

vi.mock('../../../src/lib/cognito.js', () => ({
  findNativeClientiUserByEmail: vi.fn(),
  linkGoogleIdentityToClientiUser: vi.fn(),
  updateClientiUserAttribute: vi.fn(),
}));

// --- Imports after mocks ---

import { withContext } from '@garageos/database';
import {
  handlePreSignUp,
  handlePreTokenGeneration,
} from '../../../src/cognito-triggers/handlers.js';
import { provisionCustomer } from '../../../src/lib/customer-provisioning.js';
import {
  findNativeClientiUserByEmail,
  linkGoogleIdentityToClientiUser,
  updateClientiUserAttribute,
} from '../../../src/lib/cognito.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const POOL_ID = 'eu-central-1_TESTPOOL';

/** Minimal PreSignUp event shape for ExternalProvider (Google). */
function makePreSignUpEvent(overrides: {
  triggerSource?: string;
  userName?: string;
  emailVerified?: string;
  email?: string;
}) {
  return {
    triggerSource: overrides.triggerSource ?? 'PreSignUp_ExternalProvider',
    userPoolId: POOL_ID,
    userName: overrides.userName ?? 'Google_123456789012345678901',
    request: {
      userAttributes: {
        email: overrides.email ?? 'mario@example.it',
        email_verified: overrides.emailVerified ?? 'true',
      },
    },
    response: {
      autoConfirmUser: false,
      autoVerifyEmail: false,
    },
  };
}

/** Minimal Pre-Token-Generation event shape. */
function makeTokenGenEvent(overrides: {
  customerId?: string;
  email?: string;
  given_name?: string;
  family_name?: string;
}) {
  return {
    triggerSource: 'TokenGeneration_Authentication',
    userPoolId: POOL_ID,
    userName: overrides.email ?? 'mario@example.it',
    request: {
      userAttributes: {
        email: overrides.email ?? 'mario@example.it',
        'custom:customer_id': overrides.customerId ?? '',
        given_name: overrides.given_name ?? 'Mario',
        family_name: overrides.family_name ?? 'Rossi',
      },
    },
    response: {
      claimsOverrideDetails: undefined as
        | { claimsToAddOrOverride: Record<string, string> }
        | undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// handlePreSignUp
// ---------------------------------------------------------------------------

describe('handlePreSignUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PreSignUp_ExternalProvider, verified, native user exists — links identity, sets autoConfirmUser + autoVerifyEmail', async () => {
    vi.mocked(findNativeClientiUserByEmail).mockResolvedValue({
      exists: true,
      username: 'mario@example.it',
    });
    vi.mocked(linkGoogleIdentityToClientiUser).mockResolvedValue(undefined);

    const event = makePreSignUpEvent({
      userName: 'Google_987654321098765432109',
      emailVerified: 'true',
      email: 'mario@example.it',
    });

    const result = await handlePreSignUp(event as never);

    // Security: linking must have happened
    expect(findNativeClientiUserByEmail).toHaveBeenCalledTimes(1);
    expect(findNativeClientiUserByEmail).toHaveBeenCalledWith({
      poolId: POOL_ID,
      email: 'mario@example.it',
    });
    expect(linkGoogleIdentityToClientiUser).toHaveBeenCalledTimes(1);
    expect(linkGoogleIdentityToClientiUser).toHaveBeenCalledWith({
      poolId: POOL_ID,
      destinationUsername: 'mario@example.it',
      googleSub: '987654321098765432109',
    });

    // Response flags
    expect(result.response.autoConfirmUser).toBe(true);
    expect(result.response.autoVerifyEmail).toBe(true);
  });

  it('PreSignUp_ExternalProvider, email_verified=false — does NOT call findNativeClientiUserByEmail or link; autoConfirmUser=true, autoVerifyEmail=false (security guard)', async () => {
    const event = makePreSignUpEvent({
      emailVerified: 'false',
      email: 'attacker@evil.it',
    });

    const result = await handlePreSignUp(event as never);

    // Security: no lookup, no link
    expect(findNativeClientiUserByEmail).not.toHaveBeenCalled();
    expect(linkGoogleIdentityToClientiUser).not.toHaveBeenCalled();

    expect(result.response.autoConfirmUser).toBe(true);
    expect(result.response.autoVerifyEmail).toBe(false);
  });

  it('PreSignUp_ExternalProvider, verified, no native user — no link; auto-confirm + auto-verify true', async () => {
    vi.mocked(findNativeClientiUserByEmail).mockResolvedValue({ exists: false });

    const event = makePreSignUpEvent({
      emailVerified: 'true',
      email: 'new@example.it',
    });

    const result = await handlePreSignUp(event as never);

    expect(findNativeClientiUserByEmail).toHaveBeenCalledTimes(1);
    expect(linkGoogleIdentityToClientiUser).not.toHaveBeenCalled();
    expect(result.response.autoConfirmUser).toBe(true);
    expect(result.response.autoVerifyEmail).toBe(true);
  });

  it('PreSignUp_SignUp (non-external source) — returns event untouched, no helper calls', async () => {
    const event = makePreSignUpEvent({ triggerSource: 'PreSignUp_SignUp' });
    const originalResponse = { ...event.response };

    const result = await handlePreSignUp(event as never);

    expect(findNativeClientiUserByEmail).not.toHaveBeenCalled();
    expect(linkGoogleIdentityToClientiUser).not.toHaveBeenCalled();
    // response unchanged
    expect(result.response).toEqual(originalResponse);
  });

  it('email normalization — uppercase + whitespace in Google attribute is lowercased + trimmed before lookup', async () => {
    vi.mocked(findNativeClientiUserByEmail).mockResolvedValue({ exists: false });

    const event = makePreSignUpEvent({
      emailVerified: 'true',
      email: '  Mario@Example.IT  ',
    });

    await handlePreSignUp(event as never);

    // provisionCustomer contract: email must be trimmed + lowercased
    expect(findNativeClientiUserByEmail).toHaveBeenCalledWith({
      poolId: POOL_ID,
      email: 'mario@example.it',
    });
  });
});

// ---------------------------------------------------------------------------
// handlePreTokenGeneration
// ---------------------------------------------------------------------------

describe('handlePreTokenGeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // withContext mock: invoke the callback with a fake tx object.
    // Cast to `never` to bridge the PrismaClient ↔ unknown type gap in
    // test code without weakening production types.
    vi.mocked(withContext).mockImplementation(async (_ctx, fn) => fn({} as never));
  });

  it('attribute already present — injects existing id, no DB call (idempotency / password-login path)', async () => {
    const existingId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const event = makeTokenGenEvent({ customerId: existingId });

    const result = await handlePreTokenGeneration(event as never);

    expect(withContext).not.toHaveBeenCalled();
    expect(provisionCustomer).not.toHaveBeenCalled();
    // Claim is still injected from the existing attribute
    expect(result.response.claimsOverrideDetails?.claimsToAddOrOverride['custom:customer_id']).toBe(
      existingId,
    );
  });

  it('attribute absent — calls provisionCustomer with email/firstName/lastName + auditMetadata.provider=google; injects claim; calls persist helper', async () => {
    const newCustomerId = 'a1b2c3d4-0000-4000-8000-e1f2a3b4c5d6';
    vi.mocked(provisionCustomer).mockResolvedValue({
      customer: {
        id: newCustomerId,
        email: 'luigi@example.it',
        firstName: 'Luigi',
        lastName: 'Verdi',
        phone: null,
        cognitoSub: null,
        appInstalled: false,
        notificationPreferences: [],
      } as never,
      outcome: 'created',
    });
    vi.mocked(updateClientiUserAttribute).mockResolvedValue(undefined);

    const event = makeTokenGenEvent({
      customerId: '', // absent
      email: 'luigi@example.it',
      given_name: 'Luigi',
      family_name: 'Verdi',
    });

    const result = await handlePreTokenGeneration(event as never);

    // DB path: withContext must have been called
    expect(withContext).toHaveBeenCalledTimes(1);

    // provisionCustomer args
    expect(provisionCustomer).toHaveBeenCalledTimes(1);
    const [, input, opts] = vi.mocked(provisionCustomer).mock.calls[0]!;
    expect(input).toEqual({ email: 'luigi@example.it', firstName: 'Luigi', lastName: 'Verdi' });
    expect((opts as { auditMetadata?: { provider: string } }).auditMetadata?.provider).toBe(
      'google',
    );

    // Claim injected
    expect(result.response.claimsOverrideDetails?.claimsToAddOrOverride['custom:customer_id']).toBe(
      newCustomerId,
    );

    // Persist helper called (best-effort)
    expect(updateClientiUserAttribute).toHaveBeenCalledTimes(1);
    expect(updateClientiUserAttribute).toHaveBeenCalledWith({
      poolId: POOL_ID,
      username: event.userName,
      name: 'custom:customer_id',
      value: newCustomerId,
    });
  });

  it('idempotency — second call with attribute already present does NOT re-invoke provisionCustomer', async () => {
    const persistedId = 'deadbeef-dead-4ead-dead-beefdeadbeef';

    // First call: attribute absent → provision
    vi.mocked(provisionCustomer).mockResolvedValue({
      customer: { id: persistedId } as never,
      outcome: 'created',
    });
    vi.mocked(updateClientiUserAttribute).mockResolvedValue(undefined);

    const event1 = makeTokenGenEvent({ customerId: '' });
    await handlePreTokenGeneration(event1 as never);
    expect(provisionCustomer).toHaveBeenCalledTimes(1);

    // Second call: attribute present (simulating persist having taken effect)
    vi.clearAllMocks();
    // withContext should not be called this time (attribute is now present)
    vi.mocked(withContext).mockImplementation(async (_ctx, fn) => fn({} as never));

    const event2 = makeTokenGenEvent({ customerId: persistedId });
    await handlePreTokenGeneration(event2 as never);
    expect(provisionCustomer).not.toHaveBeenCalled();
    expect(withContext).not.toHaveBeenCalled();
  });

  it('email normalization — uppercase + whitespace in Google attribute is lowercased + trimmed before provisionCustomer', async () => {
    const newCustomerId = 'b2c3d4e5-0000-4000-8000-f1a2b3c4d5e6';
    vi.mocked(provisionCustomer).mockResolvedValue({
      customer: {
        id: newCustomerId,
        email: 'mario@example.it',
        firstName: 'Mario',
        lastName: 'Rossi',
        phone: null,
        cognitoSub: null,
        appInstalled: false,
        notificationPreferences: [],
      } as never,
      outcome: 'created',
    });
    vi.mocked(updateClientiUserAttribute).mockResolvedValue(undefined);

    const event = makeTokenGenEvent({
      customerId: '', // cold path
      email: '  Mario@Example.IT  ',
      given_name: 'Mario',
      family_name: 'Rossi',
    });

    await handlePreTokenGeneration(event as never);

    // provisionCustomer contract: email must be trimmed + lowercased
    const [, input] = vi.mocked(provisionCustomer).mock.calls[0]!;
    expect((input as { email: string }).email).toBe('mario@example.it');
  });

  it('persist failure is logged but not fatal — claim is still injected', async () => {
    const customerId = '12345678-1234-4234-b234-123456789012';
    vi.mocked(provisionCustomer).mockResolvedValue({
      customer: { id: customerId } as never,
      outcome: 'created',
    });
    // Persist throws
    vi.mocked(updateClientiUserAttribute).mockRejectedValue(new Error('Cognito SDK error'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const event = makeTokenGenEvent({ customerId: '' });
    const result = await handlePreTokenGeneration(event as never);

    // Claim is still injected despite persist failure
    expect(result.response.claimsOverrideDetails?.claimsToAddOrOverride['custom:customer_id']).toBe(
      customerId,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});
