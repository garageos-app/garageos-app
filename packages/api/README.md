# @garageos/api

GarageOS backend — Fastify + TypeScript + Pino, running on AWS Lambda via the [`@fastify/aws-lambda`](https://github.com/fastify/aws-lambda-fastify) in-process adapter (see [ADR-0002](../../docs/adr/ADR-0002-replace-lwa-with-fastify-aws-lambda-adapter.md)).

## Status

PR 7 introduces Cognito JWT authentication, minimal security headers (helmet), the first `/v1/` business endpoints (`/v1/users/me`, `/v1/tenants/me`), and refactors the tenant-context middleware to pull its claims from the verified JWT instead of the `X-Tenant-ID` / `X-User-ID` headers used in PR 6. The JWT verification uses [`aws-jwt-verify`](https://github.com/awslabs/aws-jwt-verify) with one verifier per Cognito pool (officine + clienti); pool is detected from the token's `iss` claim.

**Breaking contract change from PR 6**: `request.userId` is now the Cognito `sub` (string, VARCHAR(100)), not a DB-issued UUID. Handlers that need the database `User.id` must look it up via `users.cognitoSub === request.userId`.

## Scripts

| Command | What it does |
|---|---|
| `pnpm --filter @garageos/api dev` | `tsx watch` with hot-reload on `src/` (dev only) |
| `pnpm --filter @garageos/api build` | Compile TypeScript to `dist/` |
| `pnpm --filter @garageos/api start` | Run the compiled server (`node dist/index.js`) |
| `pnpm --filter @garageos/api typecheck` | `tsc --noEmit` over `src/` and `tests/` |
| `pnpm --filter @garageos/api test:unit` | Vitest, no network |
| `pnpm --filter @garageos/api test:integration` | Vitest against a Testcontainers Postgres (Docker required) |

## Local run

```bash
pnpm --filter @garageos/api build
node packages/api/dist/index.js
# in another terminal
curl http://localhost:3100/health
# → {"status":"ok","timestamp":"2026-04-24T...","version":"unknown"}
```

Env defaults are documented in `.env.example`. Copy to `.env` if you need to override (`.env` is gitignored).

## Docker (optional local smoke)

The `Dockerfile` builds a container that serves the same HTTP API on port `8080`. It includes the Lambda Web Adapter binary at `/opt/extensions/lambda-adapter` so the image is ready for container-image Lambda deployment as a future option; outside AWS Lambda the binary is inert and the Node process serves HTTP directly.

```bash
# From the monorepo root
docker build -f packages/api/Dockerfile -t garageos-api:local .
docker run --rm -p 9000:8080 --name gapi garageos-api:local
curl http://localhost:9000/health
```

Port `9000` avoids conflicts with other services bound to `8080` on the host.

> The current deployment strategy (APPENDICE_C §5.9) uses the AWS CDK `NodejsFunction` construct with the in-process `@fastify/aws-lambda` adapter (ADR-0002), not this container image. This Dockerfile is kept as a local tool and a future-proof deploy option — note that the LWA bits inside it (binary at `/opt/extensions/lambda-adapter`, `AWS_LWA_*` env vars) are stale relative to the active runtime and would need to be replaced by an `aws-lambda-ric` setup if this image were ever placed on the container-image Lambda deploy path.

> **Runtime note (PR 6):** the container runs `tsx src/index.ts` rather than compiling to `dist/` with `tsc` + running Node. This sidesteps two ESM quirks introduced by importing `@garageos/database` at runtime: Node 22 rejects type-stripping of `.ts` files under `node_modules`, and the Prisma 7 generated client uses Bundler-style imports (no `.js` extensions) that Node ESM does not accept. When this image moves onto the deploy path, it will add a bundler stage (esbuild / tsup) — the same approach CDK `NodejsFunction` takes.

## Authentication

All `/v1/*` endpoints require a valid Cognito **ID token** in the `Authorization` header:

```
Authorization: Bearer eyJraWQ...
```

The API sits behind two Cognito User Pools (see `docs/APPENDICE_C_INFRASTRUCTURE.md` §5.5 and `docs/GarageOS-Specifiche.md` §5.5.1):

- **officine** — tenant users (super_admin, mechanic). Claims: `custom:tenant_id`, `custom:role`, optional `custom:location_id` (BR-204 super_admin without a location).
- **clienti** — customer end-users (mobile app). Claim: `custom:customer_id`.

The auth plugin (`src/plugins/auth.ts`) wraps [`aws-jwt-verify`](https://github.com/awslabs/aws-jwt-verify)'s `JwtRsaVerifier` — one per pool — and dispatches incoming tokens based on their `iss` claim. The verifier checks:

- RS256 signature against the pool's JWKS (lazily fetched and cached)
- Issuer (`iss`) matches the expected `https://cognito-idp.<region>.amazonaws.com/<pool-id>`
- Audience (`aud`) matches the configured client id
- Expiration (`exp`) is in the future
- `token_use === 'id'` (access tokens are rejected — they lack the `custom:*` claims)

### Pre-handler chain for officine-only endpoints

```
requireAuth → requireOfficinaPool → tenantContext → route handler
```

- `requireAuth` — decorates `request.jwt` and `request.authPool`, 401 on any verifier failure (body is always a generic message; the real reason is logged server-side).
- `requireOfficinaPool` — 403 if `authPool === 'clienti'`.
- `tenantContext` — Zod-validates the officine claims and decorates `request.tenantId`, `request.userId` (= Cognito sub), `request.userRole`, `request.locationId`.

Route handlers then call `app.withContext({ tenantId }, tx => ...)` to activate Postgres RLS for the query.

### Testing with a JWT locally

A helper at `packages/api/tests/helpers/jwt.ts` generates a coherent RS256 key pair and signs tokens with the right claims shape. Use it from an ad-hoc script when you need a valid JWT for curl / Postman:

```typescript
import { initKeys, signTestToken } from './tests/helpers/jwt.ts';

await initKeys();
const token = await signTestToken({
  pool: 'officine',
  sub: '<cognito-sub-string>',
  tenantId: '<tenant-uuid>',
  role: 'mechanic',
});
console.log(token);
```

The running server must have been started with the auth plugin pre-seeded with the matching public JWK (that's what the integration test fixture does). Against a real Cognito user pool you just pass the `Authorization: Bearer …` header from whatever client you use to log in (Amplify, Hosted UI, etc).

## Endpoints

**Operational (no auth):**

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness + DB ping. 200 ok / 503 degraded. Consumed by ALB / external health checks. Not versioned. |

**Business (require Bearer ID token, officine pool):**

| Method | Path | Feature | Notes |
|---|---|---|---|
| GET | `/v1/users/me` | F-OFF-007 | Current user profile, lookup via `cognitoSub`. |
| GET | `/v1/tenants/me` | F-OFF-007 | Current tenant info, lookup via `tenantId` claim. |

Both endpoints return a minimal safe projection: `cognitoSub`, `deletedAt`, `updatedAt`, and `settings` are never exposed.

## API conventions (applied here, propagated to PR 8+)

Three conventions from `docs/APPENDICE_A_API.md` are baked in at the scaffold level so future endpoints inherit them automatically.

### 1. Error format — RFC 7807 Problem Details

Every failure — validation errors, 4xx from `@fastify/sensible`, unhandled 5xx, 404 — responds with `application/problem+json` and the shape defined in APPENDICE_A §4.1:

```json
{
  "type": "https://api.garageos.it/errors/VALIDATION_ERROR",
  "title": "Request validation failed",
  "status": 400,
  "detail": "body/email must match format \"email\"",
  "instance": "/v1/users",
  "request_id": "01HKX...",
  "errors": [{ "field": "email", "code": "format", "message": "must match format \"email\"" }]
}
```

Implemented in `src/plugins/error-handler.ts`. Prisma `P2025` (row not found via `findUniqueOrThrow` / `findFirstOrThrow`) is translated to a 404 `NOT_FOUND` response — important for endpoints gated by RLS, where a hidden row looks identical to a missing row.

### 2. Versioning — `/v1/` for business endpoints, root for operational

Business endpoints live under `/v1/`. Operational endpoints — `/health`, future `/metrics` — stay at root because they're consumed by infra (ALB health checks, Prometheus scrape) and are not part of the versioned public surface. The prefix constant lives in `src/config/constants.ts`.

### 3. `X-Request-ID` correlation

APPENDICE_A §1.3: every request carries an `X-Request-ID`. The server accepts a client-supplied UUID and auto-generates one otherwise. The id is attached to every log line under the `request_id` key (matching the Problem Details field name) and echoed back on the response. Configured in `src/server.ts` via Fastify's native `requestIdHeader` / `genReqId`.

### 4. Security headers — minimal for JSON API

`src/plugins/helmet.ts` registers `@fastify/helmet` with: HSTS (1 year + `includeSubDomains`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy: same-site`. CSP and COEP are disabled because this service never returns HTML. Helmet is registered *first* in `buildServer()` so Problem Details error responses also carry the headers.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | no | `development` | `production` in Lambda, `test` in vitest |
| `PORT` | no | `3100` | Dev only. Not read in Lambda (the `@fastify/aws-lambda` adapter is in-process — no port binding). The Dockerfile still pins it to `8080` for local container smoke. |
| `LOG_LEVEL` | no | `info` | Pino levels: `trace` / `debug` / `info` / `warn` / `error` / `fatal` / `silent` |
| `APP_VERSION` | no | `unknown` | Set by deploy pipeline (git SHA or tag); surfaced by `/health` |
| `AWS_REGION` | **yes** | — | Promoted from optional in PR 7 — the auth plugin derives Cognito issuer + JWKS URI from it. |
| `DATABASE_URL` | **yes** | — | Supabase transaction pooler URL (port 6543). Consumed by the Prisma Client. |
| `DIRECT_URL` | no | — | Used by the Prisma CLI for migrations only; the api runtime never opens this. |
| `COGNITO_OFFICINE_POOL_ID` | **yes** | — | e.g. `eu-central-1_ABC123`. |
| `COGNITO_OFFICINE_CLIENT_ID` | **yes** | — | Cognito app client id for the officine pool. |
| `COGNITO_CLIENTI_POOL_ID` | **yes** | — | e.g. `eu-central-1_XYZ789`. |
| `COGNITO_CLIENTI_CLIENT_ID` | **yes** | — | Cognito app client id for the clienti pool. |
| `COGNITO_OFFICINE_JWKS_URL_OVERRIDE` | no | — | Test/dev escape hatch. Override the derived JWKS URI — e.g. to point at a staging pool. |
| `COGNITO_CLIENTI_JWKS_URL_OVERRIDE` | no | — | Same for the clienti pool. |

Validation happens at module load via Zod (`src/config/env.ts`) — a missing or mistyped variable aborts startup with a descriptive error.

## Logging

Pino is used in JSON mode by default. In `NODE_ENV=development` the `pino-pretty` transport is enabled (human-readable, colorised). In `NODE_ENV=test` the logger is silenced by the unit-test setup file to keep vitest output clean.

## Structure

```
src/
├── index.ts                     Entry point: buildServer() + listen + graceful shutdown
├── server.ts                    Fastify factory (plugins, routes, request-id)
├── config/
│   ├── env.ts                   Zod env validation + parseEnv factory
│   └── constants.ts             API_VERSION_PREFIX, ERROR_TYPE_BASE_URL, media types
├── middleware/
│   ├── require-auth.ts          Extract Bearer token, verify via jwtVerifier
│   ├── require-officina-pool.ts 403 for clienti-pool requests
│   └── tenant-context.ts        Extract officine claims from request.jwt
├── plugins/
│   ├── auth.ts                  Cognito JWT verifier (aws-jwt-verify, one per pool)
│   ├── helmet.ts                Minimal security headers (HSTS, noSniff, frameguard, CORP)
│   ├── database.ts              Prisma + withContext decorators (fastify-plugin)
│   └── error-handler.ts         RFC 7807 error handler + Prisma P2025 → 404
└── routes/
    ├── health.ts                GET /health — DB ping
    └── v1/
        ├── users.ts             GET /v1/users/me
        └── tenants.ts           GET /v1/tenants/me
tests/
├── helpers/
│   └── jwt.ts                   RS256 keypair + signTestToken
├── unit/
│   ├── setup.ts                 Silences logger + seeds env placeholders + awaits initKeys
│   ├── config/env.test.ts
│   ├── middleware/{require-auth,require-officina-pool,tenant-context}.test.ts
│   ├── plugins/{auth,helmet,database}.test.ts
│   └── routes/
│       ├── health.test.ts
│       └── v1/{users,tenants}.test.ts
└── integration/
    ├── globalSetup.ts           Postgres container + migrate + seed + app_test role + key handoff
    ├── setup.ts                 Per-worker pgAdmin client + worker-side initKeys
    ├── helpers.ts               resetDb, createTenantWithLocation, createUser
    ├── fixtures.ts              buildTestServer() pre-seeded with test JWKs
    ├── health.test.ts
    ├── auth.test.ts             Auth chain — failure paths + pool routing
    ├── users-me.test.ts         Full-chain + RLS cross-tenant isolation
    └── tenants-me.test.ts       Full-chain + response shape
```

## Integration tests

```bash
pnpm --filter @garageos/api test:integration
```

Spins up `postgres:15-alpine` via Testcontainers, applies migrations and seed from `@garageos/database`, creates a non-superuser `app_test` role (so Row Level Security policies actually apply — `FORCE ROW LEVEL SECURITY` does not cover superusers), and runs the suite. First run takes ~10–15 s while the image is pulled; subsequent runs are faster. Docker must be running.

Integration tests do **not** hit a real Cognito endpoint. JWT signing happens in-process and the plugin's JWKS cache is pre-seeded with the matching public JWKs — `aws-jwt-verify` 5.x's built-in HTTP client only accepts `https://` URLs, so a loopback mock server is not an option. Production is unaffected: the JWKS is lazily fetched from AWS on first use.
