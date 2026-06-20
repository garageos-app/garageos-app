// Entry point for the clienti Cognito trigger Lambda.
//
// This module is the AWS Lambda handler — it must NOT use the
// @fastify/aws-lambda wrapper (that wraps HTTP events; Cognito triggers
// are a different contract).
//
// Boot sequence (mirrors packages/api/src/index.ts pattern):
//   Step 1 — top-level await loadSecretsIntoEnv():
//     Hydrates process.env from Secrets Manager before any module that
//     reads env at load time is evaluated. At Lambda init time only
//     APP_SECRETS_ARN / NODE_EXTRA_CA_CERTS / NODE_ENV are present in
//     the environment; DATABASE_URL and COGNITO_* are injected by this
//     step. Without it, parseEnv() in config/env.ts throws ZodError and
//     createClient() in @garageos/database throws "DATABASE_URL is not
//     set" — crashing every cold start.
//   Step 2 — dynamic import('./handlers.js'):
//     handlers.ts transitively pulls in ../lib/cognito.js (→ config/env.js
//     runs parseEnv() at module load) and @garageos/database (→
//     packages/database/src/client.ts calls createClient() at module load).
//     Both must be deferred until step 1 has populated the env.
//
// Dispatch logic:
//   triggerSource startsWith 'PreSignUp_'        → handlePreSignUp
//   triggerSource startsWith 'TokenGeneration_'  → handlePreTokenGeneration
//   (anything else)                              → return event unchanged
//
// The pool id is read from event.userPoolId — NOT from an env var. This
// avoids a CDK cross-stack dependency cycle where the Cognito pool ARN
// would need to be exported to the trigger Lambda's environment before
// the pool is fully created.

import { loadSecretsIntoEnv } from '../config/secrets.js';
import type { PreSignUpEvent, PreTokenGenerationEvent } from './handlers.js';

// Step 1: hydrate process.env from Secrets Manager once per container init.
// Top-level await (ESM) — runs exactly once; subsequent warm invocations
// skip this module-evaluation entirely (the export is already resolved).
await loadSecretsIntoEnv();

// Step 2: dynamic-import every module that reads env at module-load time.
// Static imports would evaluate config/env.ts and @garageos/database before
// step 1 had populated the environment, causing a cold-start crash.
const { handlePreSignUp, handlePreTokenGeneration } = await import('./handlers.js');

// Generic Cognito trigger event discriminated union. We only type the
// fields we inspect here — full types live in the handler modules.
type CognitoTriggerEvent = { triggerSource: string } & Record<string, unknown>;

export async function handler(event: CognitoTriggerEvent): Promise<CognitoTriggerEvent> {
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
