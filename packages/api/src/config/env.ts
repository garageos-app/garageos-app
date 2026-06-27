import { z } from 'zod';

// Runtime environment validation. Parse fails fast at module load:
// if a required variable is missing or mistyped, the process aborts
// with a descriptive Zod error instead of failing later at a random
// point in request handling.
//
// PORT defaults to 3100 for local dev (chosen to avoid conflicts with
// other local services). Not read in Lambda: the @fastify/aws-lambda
// adapter is in-process so there is no port binding (see ADR-0002 /
// APPENDICE_C §5.9). The local Dockerfile still exports PORT=8080 for
// container smoke tests.
//
// PR 7 adds Cognito auth configuration. AWS_REGION was optional in
// PR 6 (Lambda runtime provides it automatically); it is now required
// because src/plugins/auth.ts derives the JWKS URI and issuer from it
// together with the pool IDs. The *_JWKS_URL_OVERRIDE vars are test-
// only hooks used by integration tests (tests/helpers/jwks-server.ts)
// to redirect the verifier at a local mock — production leaves them
// unset and the verifier uses the real Cognito JWKS endpoint.
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3100),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  // Surfaced by GET /health. Set by the deploy pipeline (git SHA or
  // semver tag) — unknown locally is fine.
  APP_VERSION: z.string().default('unknown'),
  // Required as of PR 7: the auth plugin derives the Cognito issuer
  // and JWKS URI from this plus the pool IDs. Lambda runtime supplies
  // it automatically; local dev must set it in .env.
  AWS_REGION: z
    .string()
    .regex(
      /^[a-z]{2}-[a-z]+-\d$/,
      'AWS_REGION must match `<region>-<name>-<n>` (e.g. eu-central-1)',
    ),
  // Supabase transaction pooler URL (port 6543) consumed by the Prisma
  // Client at runtime. The database plugin fails fast at boot if this
  // is missing — see APPENDICE_C §6.3 and packages/database/.env.example.
  DATABASE_URL: z
    .string()
    .refine(
      (v) => v.startsWith('postgres://') || v.startsWith('postgresql://'),
      'DATABASE_URL must be a postgres:// or postgresql:// connection string',
    ),
  // Supabase direct session URL (port 5432) used by the Prisma CLI for
  // migrations. The runtime server never opens this; keep optional so
  // Lambda containers that only run the HTTP service don't need it.
  DIRECT_URL: z.string().optional(),

  // --- Cognito (PR 7) ---
  COGNITO_OFFICINE_POOL_ID: z
    .string()
    .regex(
      /^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]+$/,
      'COGNITO_OFFICINE_POOL_ID must match `<region>_<id>` (e.g. eu-central-1_ABC123)',
    ),
  COGNITO_OFFICINE_CLIENT_ID: z.string().min(1),
  COGNITO_CLIENTI_POOL_ID: z
    .string()
    .regex(
      /^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]+$/,
      'COGNITO_CLIENTI_POOL_ID must match `<region>_<id>` (e.g. eu-central-1_XYZ789)',
    ),
  COGNITO_CLIENTI_CLIENT_ID: z.string().min(1),
  // Test-only overrides. Production path derives the JWKS URI from the
  // pool ID: `https://cognito-idp.<region>.amazonaws.com/<pool>/.well-known/jwks.json`.
  // Integration tests set these to a local mock server URL so the
  // aws-jwt-verify hydrate step hits the mock instead of AWS.
  COGNITO_OFFICINE_JWKS_URL_OVERRIDE: z.string().url().optional(),
  COGNITO_CLIENTI_JWKS_URL_OVERRIDE: z.string().url().optional(),

  // --- Platform-admins Cognito pool (Slice 0) ---
  // Optional so the cognito-trigger Lambda (which reuses parseEnv) does not
  // crash on cold start before the operator populates the secret — the
  // documented #217 failure mode. A later task builds the JWT verifier for
  // this pool conditionally on these three being present.
  COGNITO_PLATFORM_ADMINS_POOL_ID: z
    .string()
    .regex(
      /^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]+$/,
      'COGNITO_PLATFORM_ADMINS_POOL_ID must match `<region>_<id>` (e.g. eu-central-1_PLT999)',
    )
    .optional(),
  COGNITO_PLATFORM_ADMINS_CLIENT_ID: z.string().min(1).optional(),
  COGNITO_PLATFORM_ADMINS_JWKS_URL_OVERRIDE: z.string().url().optional(),

  // --- S3 (F-OFF-305 attachments) ---
  // The bucket that stores workshop attachment uploads. Name is injected
  // from AWS Secrets Manager / environment at Lambda cold start.
  // Unit tests set a placeholder in tests/unit/setup.ts; the S3 client
  // is always mocked with aws-sdk-client-mock so no real bucket is hit.
  S3_ATTACHMENTS_BUCKET: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;

// Factory used by tests to validate arbitrary env snapshots without
// going through a dynamic import cache-bust dance. Production / normal
// consumers import `env` (parsed once at module load).
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}

export const env: Env = parseEnv();
