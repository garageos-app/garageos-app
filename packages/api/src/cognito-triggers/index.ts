// Entry point for the clienti Cognito trigger Lambda.
//
// This module is the AWS Lambda handler — it must NOT use the
// @fastify/aws-lambda wrapper (that wraps HTTP events; Cognito triggers
// are a different contract).
//
// Responsibilities:
//   1. Cold-start: hydrate process.env from Secrets Manager once
//      (memoised via ensureSecretsLoaded). No-op when APP_SECRETS_ARN
//      is unset (local dev / unit tests).
//   2. Dispatch on event.triggerSource to the appropriate handler:
//        PreSignUp_*          → handlePreSignUp
//        TokenGeneration_*    → handlePreTokenGeneration
//        (anything else)      → return event unchanged
//   3. Return the (possibly mutated) event so Cognito processes the
//      response flags / claim overrides.
//
// The pool id is read from event.userPoolId — NOT from an env var. This
// avoids a CDK cross-stack dependency cycle where the Cognito pool ARN
// would need to be exported to the trigger Lambda's environment before
// the pool is fully created.

import { loadSecretsIntoEnv } from '../config/secrets.js';
import { handlePreSignUp, handlePreTokenGeneration } from './handlers.js';
import type { PreSignUpEvent, PreTokenGenerationEvent } from './handlers.js';

// Memoised cold-start secrets hydration. The first invocation awaits
// loadSecretsIntoEnv(); subsequent warm invocations resolve immediately.
let secretsLoaded: Promise<void> | null = null;

function ensureSecretsLoaded(): Promise<void> {
  if (secretsLoaded === null) {
    secretsLoaded = loadSecretsIntoEnv();
  }
  return secretsLoaded;
}

// Generic Cognito trigger event discriminated union. We only type the
// fields we inspect here — full types live in the handler modules.
type CognitoTriggerEvent = { triggerSource: string } & Record<string, unknown>;

export async function handler(event: CognitoTriggerEvent): Promise<CognitoTriggerEvent> {
  await ensureSecretsLoaded();

  const src = event.triggerSource;

  if (src.startsWith('PreSignUp_')) {
    // Cast through unknown: PreSignUpEvent has typed fields; CognitoTriggerEvent
    // has an index signature — they are not directly comparable without the bridge.
    return handlePreSignUp(
      event as unknown as PreSignUpEvent,
    ) as unknown as Promise<CognitoTriggerEvent>;
  }

  if (src.startsWith('TokenGeneration_')) {
    return handlePreTokenGeneration(
      event as unknown as PreTokenGenerationEvent,
    ) as unknown as Promise<CognitoTriggerEvent>;
  }

  // Unknown trigger source — return unchanged (forward-compatible).
  return event;
}
