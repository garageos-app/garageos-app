# @garageos/api

GarageOS backend — Fastify + TypeScript + Pino, running on AWS Lambda via the [Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter).

## Status

PR 5 (this scaffold) ships the skeleton: Fastify instance, structured logging, Zod-validated env, RFC 7807 error handler, and `/health`. Later PRs add Prisma integration (PR 6), Cognito auth (PR 7), and business endpoints under `/v1/`.

## Scripts

| Command | What it does |
|---|---|
| `pnpm --filter @garageos/api dev` | `tsx watch` with hot-reload on `src/` (dev only) |
| `pnpm --filter @garageos/api build` | Compile TypeScript to `dist/` |
| `pnpm --filter @garageos/api start` | Run the compiled server (`node dist/index.js`) |
| `pnpm --filter @garageos/api typecheck` | `tsc --noEmit` over `src/` and `tests/` |
| `pnpm --filter @garageos/api test:unit` | Vitest, no network |

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

> The current deployment strategy (APPENDICE_C §5.9) uses the AWS CDK `NodejsFunction` construct with the Lambda Web Adapter **layer**, not this container image. This Dockerfile is kept as a local tool and a future-proof deploy option.

## API conventions (applied here, propagated to PR 7+)

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

Implemented in `src/plugins/error-handler.ts`.

### 2. Versioning — `/v1/` for business endpoints, root for operational

Business endpoints (users, vehicles, interventions, …) live under `/v1/`. Operational endpoints — `/health`, future `/metrics` — stay at root because they're consumed by infra (LWA readiness probe, ALB health checks, Prometheus scrape) and are not part of the versioned public surface. The prefix constant lives in `src/config/constants.ts`; the first `/v1/...` route lands in PR 7.

### 3. `X-Request-ID` correlation

APPENDICE_A §1.3: every request carries an `X-Request-ID`. The server accepts a client-supplied UUID and auto-generates one otherwise. The id is attached to every log line under the `request_id` key (matching the Problem Details field name) and echoed back on the response. Configured in `src/server.ts` via Fastify's native `requestIdHeader` / `genReqId`.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` in Lambda, `test` in vitest |
| `PORT` | `3100` | Dev only. Lambda/Docker override to `8080` (LWA default) |
| `LOG_LEVEL` | `info` | Pino levels: `trace` / `debug` / `info` / `warn` / `error` / `fatal` / `silent` |
| `APP_VERSION` | `unknown` | Set by deploy pipeline (git SHA or tag); surfaced by `/health` |
| `AWS_REGION` | — | Provided by Lambda runtime |

Validation happens at module load via Zod (`src/config/env.ts`) — a missing or mistyped variable aborts startup with a descriptive error.

## Logging

Pino is used in JSON mode by default. In `NODE_ENV=development` the `pino-pretty` transport is enabled (human-readable, colorised). In `NODE_ENV=test` the logger is silenced by the unit-test setup file to keep vitest output clean.

## Structure

```
src/
├── index.ts              Entry point: buildServer() + listen + graceful shutdown
├── server.ts             Fastify factory (logger, request-id, plugins, routes)
├── config/
│   ├── env.ts            Zod env validation
│   └── constants.ts      API_VERSION_PREFIX, ERROR_TYPE_BASE_URL, media types
├── plugins/
│   └── error-handler.ts  RFC 7807 error + 404 handlers
└── routes/
    └── health.ts         GET /health
tests/unit/
├── setup.ts              Silence the logger in tests
└── routes/
    └── health.test.ts    4 tests: health, 404, request-id auto, request-id preserved
```
