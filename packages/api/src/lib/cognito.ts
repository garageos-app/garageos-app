import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminLinkProviderForUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  AdminUserGlobalSignOutCommand,
  AliasExistsException,
  CognitoIdentityProviderClient,
  InvalidPasswordException,
  ListUsersCommand,
  UsernameExistsException,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';

import { env } from '../config/env.js';
import type { UserRole } from '../middleware/tenant-context.js';

// Lazy singleton — Cognito SDK clients are heavy (HTTP/2 connections,
// credential providers) and we want exactly one per Lambda warm
// container. Tests use `_resetCognitoClientForTests` to ensure
// `aws-sdk-client-mock` overrides the underlying transport on every
// test setup.
let _client: CognitoIdentityProviderClient | null = null;

export function getCognitoClient(): CognitoIdentityProviderClient {
  if (_client) return _client;
  _client = new CognitoIdentityProviderClient({ region: env.AWS_REGION });
  return _client;
}

// Test-only reset hook. Production code never imports this.
export function _resetCognitoClientForTests(): void {
  _client = null;
}

// Typed errors thrown by this module. The signup route catches by
// `name` and maps each to the appropriate HTTP error code. Using the
// `name` property keeps interop with `error-handler.ts` simple — its
// dot-separated check sees these names plain and surfaces them as-is.
export class CognitoEmailAlreadyExistsError extends Error {
  override name = 'CognitoEmailAlreadyExistsError';
}
export class CognitoInvalidPasswordError extends Error {
  override name = 'CognitoInvalidPasswordError';
}
export class CognitoUnavailableError extends Error {
  override name = 'CognitoUnavailableError';
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export async function createCustomerCognitoUser(args: {
  poolId: string;
  email: string;
  firstName: string;
  lastName: string;
  customerId: string;
}): Promise<{ cognitoSub: string }> {
  const client = getCognitoClient();
  let resp;
  try {
    resp = await client.send(
      new AdminCreateUserCommand({
        UserPoolId: args.poolId,
        Username: args.email,
        MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'email', Value: args.email },
          // BR-220: customer self-signup starts unverified. The verify-email
          // flow (auth-verify-email.ts) flips this to true after the user
          // confirms via the link.
          { Name: 'email_verified', Value: 'false' },
          { Name: 'given_name', Value: args.firstName },
          { Name: 'family_name', Value: args.lastName },
          { Name: 'custom:customer_id', Value: args.customerId },
        ],
      }),
    );
  } catch (err) {
    if (err instanceof UsernameExistsException) {
      throw new CognitoEmailAlreadyExistsError('Cognito user already exists for this email');
    }
    if (err instanceof InvalidPasswordException) {
      // AdminCreateUser does not validate password (no password is set
      // here) — but the policy applies via the pool's signup flow if the
      // SDK ever proxies it. Guard anyway for forward compat.
      throw new CognitoInvalidPasswordError('Cognito password policy violation');
    }
    throw new CognitoUnavailableError(
      err instanceof Error ? err.message : 'Cognito SDK error',
      err,
    );
  }

  const sub = resp.User?.Attributes?.find((a) => a.Name === 'sub')?.Value;
  if (!sub) {
    throw new CognitoUnavailableError('AdminCreateUser response missing sub attribute');
  }
  return { cognitoSub: sub };
}

export async function setCustomerCognitoPassword(args: {
  poolId: string;
  email: string;
  password: string;
}): Promise<void> {
  const client = getCognitoClient();
  try {
    await client.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: args.poolId,
        Username: args.email,
        Password: args.password,
        Permanent: true,
      }),
    );
  } catch (err) {
    if (err instanceof InvalidPasswordException) {
      throw new CognitoInvalidPasswordError('Cognito password policy violation');
    }
    throw new CognitoUnavailableError(
      err instanceof Error ? err.message : 'Cognito SDK error',
      err,
    );
  }
}

/** Flip Cognito user's email_verified attribute to true. Called from
 *  the verify-email route after the DB tx has consumed the token. */
export async function markCustomerEmailVerified(args: {
  poolId: string;
  email: string;
}): Promise<void> {
  const client = getCognitoClient();
  await client.send(
    new AdminUpdateUserAttributesCommand({
      UserPoolId: args.poolId,
      Username: args.email,
      UserAttributes: [{ Name: 'email_verified', Value: 'true' }],
    }),
  );
}

// F-OFF-004 — officine pool user lifecycle.
//
// Same shape as the customer helpers above, with two differences:
//   1. MessageAction=SUPPRESS at AdminCreateUser (we already sent our own
//      invite email via SES at invite-time; Cognito should not send its
//      default invitation email).
//   2. email_verified is set to 'true' immediately — the invitation flow
//      proves possession of the email by requiring the magic-link click.
//
// See spec §4.2 + §4.5 for rationale.

export interface CreateOfficineCognitoUserArgs {
  poolId: string;
  email: string;
  firstName: string;
  lastName: string;
  tenantId: string;
  role: UserRole;
  locationId: string | null;
}

export async function createOfficineCognitoUser(
  args: CreateOfficineCognitoUserArgs,
): Promise<{ cognitoSub: string }> {
  const attributes: { Name: string; Value: string }[] = [
    { Name: 'email', Value: args.email },
    { Name: 'email_verified', Value: 'true' },
    { Name: 'given_name', Value: args.firstName },
    { Name: 'family_name', Value: args.lastName },
    { Name: 'custom:tenant_id', Value: args.tenantId },
    { Name: 'custom:role', Value: args.role },
  ];
  if (args.locationId) {
    attributes.push({ Name: 'custom:location_id', Value: args.locationId });
  }

  try {
    const client = getCognitoClient();
    const out = await client.send(
      new AdminCreateUserCommand({
        UserPoolId: args.poolId,
        Username: args.email,
        UserAttributes: attributes,
        MessageAction: 'SUPPRESS',
      }),
    );
    const sub = out.User?.Attributes?.find((a) => a.Name === 'sub')?.Value;
    if (!sub) {
      throw new CognitoUnavailableError('cognito sub missing from AdminCreateUser response');
    }
    return { cognitoSub: sub };
  } catch (err) {
    if (err instanceof UsernameExistsException) {
      throw new CognitoEmailAlreadyExistsError('Cognito user already exists for this email');
    }
    throw new CognitoUnavailableError(
      err instanceof Error ? err.message : 'Cognito SDK error',
      err,
    );
  }
}

export async function setOfficineCognitoPassword(args: {
  poolId: string;
  email: string;
  password: string;
}): Promise<void> {
  try {
    const client = getCognitoClient();
    await client.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: args.poolId,
        Username: args.email,
        Password: args.password,
        Permanent: true,
      }),
    );
  } catch (err) {
    if (err instanceof InvalidPasswordException) {
      throw new CognitoInvalidPasswordError('Cognito password policy violation');
    }
    throw new CognitoUnavailableError(
      err instanceof Error ? err.message : 'Cognito SDK error',
      err,
    );
  }
}

// Update role and/or location on an existing officine Cognito user.
// Callers pass undefined for a field they don't want to touch.
// null on locationId means "clear" — Cognito attributes can't be unset,
// so we set the empty string. The tenant-context Zod schema treats
// empty string and undefined identically (custom:location_id optional).
export async function updateOfficineUserRoleAndLocation(args: {
  poolId: string;
  email: string;
  role?: UserRole;
  locationId?: string | null;
}): Promise<void> {
  const attributes: { Name: string; Value: string }[] = [];
  if (args.role !== undefined) {
    attributes.push({ Name: 'custom:role', Value: args.role });
  }
  if (args.locationId !== undefined) {
    attributes.push({
      Name: 'custom:location_id',
      Value: args.locationId === null ? '' : args.locationId,
    });
  }
  if (attributes.length === 0) return;

  try {
    const client = getCognitoClient();
    await client.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: args.poolId,
        Username: args.email,
        UserAttributes: attributes,
      }),
    );
  } catch (err) {
    throw new CognitoUnavailableError(
      err instanceof Error ? err.message : 'Cognito SDK error',
      err,
    );
  }
}

// Idempotent — swallows UserNotFoundException so callers can use this in
// rollback paths without checking whether the user was actually created.
export async function deleteCognitoUser(args: { poolId: string; email: string }): Promise<void> {
  const client = getCognitoClient();
  try {
    await client.send(
      new AdminDeleteUserCommand({ UserPoolId: args.poolId, Username: args.email }),
    );
  } catch (err) {
    if (err instanceof UserNotFoundException) return;
    throw new CognitoUnavailableError(
      err instanceof Error ? err.message : 'Cognito SDK error',
      err,
    );
  }
}

// Invalidates ALL refresh tokens for the given user in the officine pool.
// Used as a "proactive lockout" companion to soft-delete and PATCH
// status=inactive (F-OFF-004 follow-ups Item 1). Access tokens already
// in circulation remain valid until their TTL, but the reactive lookup
// in tenant-context closes that residual window at the API surface.
//
// Idempotent — swallows UserNotFoundException so callers can use this
// safely on users who never accepted their invitation (cognito_sub
// would still be populated post-accept, so this case is rare; defensive
// anyway).
//
// See docs/superpowers/specs/2026-05-20-f-off-004-followups-bundle-design.md
// Item 1 proactive section.
export async function signOutOfficineUser(args: { poolId: string; email: string }): Promise<void> {
  const client = getCognitoClient();
  try {
    await client.send(
      new AdminUserGlobalSignOutCommand({
        UserPoolId: args.poolId,
        Username: args.email,
      }),
    );
  } catch (err) {
    if (err instanceof UserNotFoundException) return;
    throw new CognitoUnavailableError(
      err instanceof Error ? err.message : 'Cognito SDK error',
      err,
    );
  }
}

// Disables the Cognito user in the officine pool. Subsequent
// AdminInitiateAuth calls return NotAuthorizedException with the
// native "User is disabled" message — same surface as a wrong
// password from outside, preserving anti-enum at the auth layer.
//
// Used in tandem with signOutOfficineUser on soft-delete and on
// status: active→inactive transitions:
//   signOutOfficineUser  → invalidates active refresh tokens
//   disableOfficineUser  → blocks re-login attempts
//
// Idempotent — swallows UserNotFoundException so callers can use
// this in best-effort post-tx paths without prior existence checks.
//
// See docs/superpowers/specs/2026-05-20-pr2-token-hash-admin-disable-design.md §2.3.
export async function disableOfficineUser(args: { poolId: string; email: string }): Promise<void> {
  const client = getCognitoClient();
  try {
    await client.send(
      new AdminDisableUserCommand({
        UserPoolId: args.poolId,
        Username: args.email,
      }),
    );
  } catch (err) {
    if (err instanceof UserNotFoundException) return;
    throw new CognitoUnavailableError(
      err instanceof Error ? err.message : 'Cognito SDK error',
      err,
    );
  }
}

// Re-enables a previously disabled Cognito user in the officine pool.
// Mirror of `disableOfficineUser` — used by the reactivation flow
// (POST /v1/users/:id/reactivate) to lift the AdminDisableUser side
// effect of the soft-delete.
//
// Idempotent: swallows UserNotFoundException so callers can use this
// in best-effort post-tx paths without prior existence checks.
//
// See docs/superpowers/specs/2026-05-21-user-reactivation-design.md §2.4.
export async function enableOfficineUser(args: { poolId: string; email: string }): Promise<void> {
  const client = getCognitoClient();
  try {
    await client.send(
      new AdminEnableUserCommand({
        UserPoolId: args.poolId,
        Username: args.email,
      }),
    );
  } catch (err) {
    if (err instanceof UserNotFoundException) return;
    throw new CognitoUnavailableError(
      err instanceof Error ? err.message : 'Cognito SDK error',
      err,
    );
  }
}

// Looks up a Cognito user in the officine pool by email. Returns
// a discriminated `{exists, sub?, attributes?}` shape rather than
// throwing on not-found, because that case is a normal control-flow
// branch for the cross-tenant invitation early-check.
//
// Throws CognitoUnavailableError on any other Cognito error so the
// caller can map to 502 `auth.cognito_unavailable`.
//
// See docs/superpowers/specs/2026-05-21-user-reactivation-design.md §4.2.
export async function getOfficineUserByEmail(args: {
  poolId: string;
  email: string;
}): Promise<{ exists: false } | { exists: true; sub: string; attributes: Record<string, string> }> {
  const client = getCognitoClient();
  try {
    const resp = await client.send(
      new AdminGetUserCommand({
        UserPoolId: args.poolId,
        Username: args.email,
      }),
    );
    const attributes: Record<string, string> = {};
    for (const a of resp.UserAttributes ?? []) {
      if (a.Name && a.Value !== undefined) attributes[a.Name] = a.Value;
    }
    const sub = attributes['sub'];
    if (!sub) {
      throw new CognitoUnavailableError('AdminGetUser response missing sub attribute');
    }
    return { exists: true, sub, attributes };
  } catch (err) {
    if (err instanceof UserNotFoundException) return { exists: false };
    if (err instanceof CognitoUnavailableError) throw err;
    throw new CognitoUnavailableError(
      err instanceof Error ? err.message : 'Cognito SDK error',
      err,
    );
  }
}

// Looks up a native (password-origin) Cognito user in the clienti pool by
// email address. Google federated users have a Username prefixed with
// "Google_" — we skip those and return only the native one.
//
// Returns {exists:false} when no native user is found (pool is empty for
// this email, or only a federated record exists).
//
// Used by the PreSignUp Lambda trigger to decide whether to call
// AdminLinkProviderForUser or let Cognito create a brand-new native user.
//
// Throws CognitoUnavailableError on SDK errors.
export async function findNativeClientiUserByEmail(args: {
  poolId: string;
  email: string;
}): Promise<{ exists: false } | { exists: true; username: string }> {
  const client = getCognitoClient();
  try {
    const resp = await client.send(
      new ListUsersCommand({
        UserPoolId: args.poolId,
        Filter: `email = "${args.email}"`,
      }),
    );
    // Google federated identities have Username starting with "Google_".
    // Native (password-origin) users use the email address as their username.
    const nativeUser = (resp.Users ?? []).find(
      (u) => u.Username !== undefined && !u.Username.startsWith('Google_'),
    );
    if (!nativeUser?.Username) return { exists: false };
    return { exists: true, username: nativeUser.Username };
  } catch (err) {
    throw new CognitoUnavailableError(
      err instanceof Error ? err.message : 'Cognito SDK error',
      err,
    );
  }
}

// Links a Google federated identity onto an existing native clienti Cognito
// user. This is the account-merge step inside the PreSignUp trigger: after
// confirming the native user exists, we bind the Google sub so subsequent
// Google sign-ins land on the same Cognito record.
//
// DestinationUser: the native Cognito user (ProviderName='Cognito').
// SourceUser:      the Google identity (ProviderName='Google', attribute
//                  name='Cognito_Subject', value=<google sub>).
//
// Idempotent: AliasExistsException means the link already exists — swallow
// it so re-runs (e.g. Lambda retries) are safe.
//
// Throws CognitoUnavailableError on any other SDK error.
export async function linkGoogleIdentityToClientiUser(args: {
  poolId: string;
  destinationUsername: string;
  googleSub: string;
}): Promise<void> {
  const client = getCognitoClient();
  try {
    await client.send(
      new AdminLinkProviderForUserCommand({
        UserPoolId: args.poolId,
        DestinationUser: {
          ProviderName: 'Cognito',
          ProviderAttributeValue: args.destinationUsername,
        },
        SourceUser: {
          ProviderName: 'Google',
          ProviderAttributeName: 'Cognito_Subject',
          ProviderAttributeValue: args.googleSub,
        },
      }),
    );
  } catch (err) {
    // AliasExistsException: the Google identity is already linked to this
    // user — treat as success so trigger retries are idempotent.
    if (err instanceof AliasExistsException) return;
    throw new CognitoUnavailableError(
      err instanceof Error ? err.message : 'Cognito SDK error',
      err,
    );
  }
}
