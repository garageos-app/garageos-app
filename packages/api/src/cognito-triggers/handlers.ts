// Pure handler logic for the clienti Cognito trigger Lambda.
//
// This module is intentionally free of AWS boot-time side effects so it
// can be imported in unit tests without triggering SDK initialisation.
// All AWS/DB calls are injected via the module-level mocks in tests.
//
// Two operations are dispatched by index.ts based on triggerSource:
//   PreSignUp_ExternalProvider  → handlePreSignUp
//   TokenGeneration_*           → handlePreTokenGeneration
//
// See docs/superpowers/specs/2026-06-20-mobile-google-signin-design.md

import { withContext } from '@garageos/database';

import { provisionCustomer } from '../lib/customer-provisioning.js';
import {
  findNativeClientiUserByEmail,
  linkGoogleIdentityToClientiUser,
  updateClientiUserAttribute,
} from '../lib/cognito.js';

// ---------------------------------------------------------------------------
// Minimal event shapes — @types/aws-lambda is NOT a direct dependency of this
// package (it arrives transitively via @fastify/aws-lambda). We define only
// the fields we read so TypeScript stays strict without importing the full
// types package.
// ---------------------------------------------------------------------------

/** Subset of the Cognito PreSignUp trigger event we care about. */
export interface PreSignUpEvent {
  triggerSource: string;
  userPoolId: string;
  userName: string;
  request: {
    userAttributes: Record<string, string>;
  };
  response: {
    autoConfirmUser: boolean;
    autoVerifyEmail?: boolean;
  };
}

/** Subset of the Cognito Pre-Token-Generation V1 trigger event we care about. */
export interface PreTokenGenerationEvent {
  triggerSource: string;
  userPoolId: string;
  userName: string;
  request: {
    userAttributes: Record<string, string>;
  };
  response: {
    claimsOverrideDetails?: {
      claimsToAddOrOverride: Record<string, string>;
    };
  };
}

// ---------------------------------------------------------------------------
// handlePreSignUp
// ---------------------------------------------------------------------------

/**
 * Handles PreSignUp Cognito trigger events.
 *
 * For PreSignUp_ExternalProvider (Google):
 *   - Always sets autoConfirmUser = true so Cognito auto-confirms the
 *     Google-federated user (no manual confirmation email needed).
 *   - Sets autoVerifyEmail = true ONLY when Google asserts email_verified
 *     === 'true'. This matters so the native-account merge path below is
 *     only attempted on verified addresses.
 *
 * SECURITY BOUNDARY (BR — anti-account-takeover):
 *   The native-account merge (AdminLinkProviderForUser) is gated strictly on
 *   email_verified === 'true'. If Google did NOT assert the email as
 *   verified, we must NOT call findNativeClientiUserByEmail or
 *   linkGoogleIdentityToClientiUser — doing so would let an attacker create a
 *   Google account for an unverified email and hijack the native account.
 *
 * For all other PreSignUp sources (e.g. PreSignUp_SignUp): return untouched.
 */
export async function handlePreSignUp(event: PreSignUpEvent): Promise<PreSignUpEvent> {
  if (event.triggerSource !== 'PreSignUp_ExternalProvider') {
    return event;
  }

  // Normalise email: provisionCustomer contract requires trimmed + lowercased
  // (see packages/api/src/lib/customer-provisioning.ts — "Caller normalises").
  // Google-asserted emails may contain uppercase or surrounding whitespace;
  // failing to normalise here would break the BR-220 advisory-lock key
  // (keyed on "signup:<email>"), create duplicate Customer rows, and miss
  // the native-account merge.
  const email = (event.request.userAttributes['email'] ?? '').trim().toLowerCase();
  const emailVerified = event.request.userAttributes['email_verified'];

  // Always auto-confirm Google federated users.
  event.response.autoConfirmUser = true;

  if (emailVerified === 'true') {
    // Safe to mark the email as verified and attempt native-account merge.
    event.response.autoVerifyEmail = true;

    // Attempt to link this Google identity to an existing native account.
    const lookup = await findNativeClientiUserByEmail({
      poolId: event.userPoolId,
      email,
    });

    if (lookup.exists) {
      // Extract the Google sub from "Google_<sub>" username format.
      const googleSub = event.userName.replace(/^Google_/, '');
      await linkGoogleIdentityToClientiUser({
        poolId: event.userPoolId,
        destinationUsername: lookup.username,
        googleSub,
      });
    }
  }
  // If emailVerified !== 'true', autoVerifyEmail stays false and no link
  // attempt is made. This is the security guard — do not weaken it.

  return event;
}

// ---------------------------------------------------------------------------
// handlePreTokenGeneration
// ---------------------------------------------------------------------------

/**
 * Handles Pre-Token-Generation Cognito trigger events for the clienti pool.
 *
 * Always injects custom:customer_id into the ID token claims so the mobile
 * app and API can identify the customer without a separate lookup.
 *
 * Hot-path optimisation: if the attribute is already present in
 * userAttributes (password-login path, or a federated refresh after the
 * first sign-in has persisted the attribute), return immediately with NO
 * DB call. This keeps password logins fast and avoids redundant
 * provisionCustomer calls on refresh.
 *
 * Cold path (federated first issuance):
 *   1. Call provisionCustomer (idempotent find-or-create-or-promote).
 *   2. Best-effort persist custom:customer_id on the Cognito user so the
 *      next refresh hits the hot path. Persist failure is logged, not fatal
 *      — the claim is always injected regardless.
 */
export async function handlePreTokenGeneration(
  event: PreTokenGenerationEvent,
): Promise<PreTokenGenerationEvent> {
  const attrs = event.request.userAttributes;
  const existingCustomerId = attrs['custom:customer_id'];

  if (existingCustomerId && existingCustomerId.length > 0) {
    // Hot path: attribute already present — inject and return (no DB call).
    event.response.claimsOverrideDetails = {
      claimsToAddOrOverride: { 'custom:customer_id': existingCustomerId },
    };
    return event;
  }

  // Cold path: first federated issuance — provision the customer row.
  // Normalise email: provisionCustomer contract requires trimmed + lowercased
  // (see packages/api/src/lib/customer-provisioning.ts — "Caller normalises").
  // Google-asserted emails may contain uppercase or surrounding whitespace.
  const email = (attrs['email'] ?? '').trim().toLowerCase();
  const firstName = attrs['given_name'] ?? '';
  const lastName = attrs['family_name'] ?? '';

  const result = await withContext({ role: 'admin' }, (tx) =>
    provisionCustomer(
      tx,
      { email, firstName, lastName },
      { auditMetadata: { provider: 'google' } },
    ),
  );

  const customerId = result.customer.id;

  // Best-effort persist so subsequent refreshes use the hot path.
  try {
    await updateClientiUserAttribute({
      poolId: event.userPoolId,
      username: event.userName,
      name: 'custom:customer_id',
      value: customerId,
    });
  } catch (err) {
    // Non-fatal: the claim is injected anyway. Log so we can monitor
    // and investigate if this starts failing at scale.
    console.warn(
      JSON.stringify({
        msg: 'pre-token-generation: failed to persist custom:customer_id',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  // Inject the claim into the token.
  event.response.claimsOverrideDetails = {
    claimsToAddOrOverride: { 'custom:customer_id': customerId },
  };

  return event;
}
