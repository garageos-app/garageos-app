import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

// Hydrates `process.env` from an AWS Secrets Manager secret identified
// by the APP_SECRETS_ARN environment variable. Called from
// src/index.ts BEFORE any module that reads env at module load time
// (env.ts, server.ts) is imported — see index.ts for the dynamic-
// import dance that enforces this ordering.
//
// Behavior:
//   - APP_SECRETS_ARN unset → no-op (local dev / unit tests path —
//     .env.local provides the values).
//   - SM returns secret without SecretString → throws with explicit
//     message; this is a misconfiguration, not a transient failure.
//   - For each key in the parsed JSON, sets process.env[key] only
//     if not already set. Local overrides always win, which matches
//     12-factor app config precedence.
//
// `client` is injectable so unit tests pass a fake send() and verify
// the side effects without hitting AWS. Production path constructs
// a default client bound to AWS_REGION (which Lambda runtime sets
// automatically).

export async function loadSecretsIntoEnv(client?: SecretsManagerClient): Promise<void> {
  const secretArn = process.env.APP_SECRETS_ARN;
  if (!secretArn) return;

  // Pass region only when defined: `exactOptionalPropertyTypes: true`
  // forbids passing `undefined` to optional fields. Lambda runtime
  // always sets AWS_REGION; this branch matters for local dev where
  // the SDK's default provider chain handles resolution.
  const region = process.env.AWS_REGION;
  const sm = client ?? new SecretsManagerClient(region ? { region } : {});
  const response = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!response.SecretString) {
    throw new Error('APP_SECRETS_ARN secret has no SecretString');
  }

  const secrets = JSON.parse(response.SecretString) as Record<string, string>;
  for (const [key, value] of Object.entries(secrets)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
