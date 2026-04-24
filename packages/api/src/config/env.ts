import { z } from 'zod';

// Runtime environment validation. Parse fails fast at module load:
// if a required variable is missing or mistyped, the process aborts
// with a descriptive Zod error instead of failing later at a random
// point in request handling.
//
// PORT defaults to 3100 for local dev (chosen to avoid conflicts with
// other local services). In Lambda, LWA layer sets AWS_LWA_PORT=8080
// and the Dockerfile exports PORT=8080 — see packages/api/Dockerfile
// and APPENDICE_C §5.9.
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3100),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  // Surfaced by GET /health. Set by the deploy pipeline (git SHA or
  // semver tag) — unknown locally is fine.
  APP_VERSION: z.string().default('unknown'),
  // Provided by Lambda runtime, unused locally.
  AWS_REGION: z.string().optional(),
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
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);
