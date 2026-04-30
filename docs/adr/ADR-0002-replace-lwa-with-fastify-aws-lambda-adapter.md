# ADR-0002: Replace AWS Lambda Web Adapter with `@fastify/aws-lambda` in-process adapter

## Status

Accepted

## Date

2026-04-29

## Context

[ADR-0001](./ADR-0001-lambda-over-app-runner.md) selected AWS Lambda + API Gateway HTTP API v2 as the runtime for the GarageOS Fastify backend on **2026-04-23**. That decision picked the [AWS Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter) (LWA) as the bridge between the Lambda invocation model and the Fastify HTTP server.

LWA was chosen on the premise of "zero application code change": the adapter ships as a Lambda extension layer, the Fastify app keeps `app.listen({ port: 8080 })`, and LWA proxies APIGW events as local HTTP requests. The runtime expected three env vars (`AWS_LWA_PORT`, `AWS_LWA_READINESS_CHECK_PATH`, `AWS_LWA_ASYNC_INIT`) plus the `AWS_LAMBDA_EXEC_WRAPPER` bootstrap script.

Between **2026-04-28 and 2026-04-29**, six PRs (#34–#39) were spent fixing LWA-specific failures on the AWS-managed Node.js runtime ZIP package:

| PR  | Symptom                                                                                                  | Root cause                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| #34 | `Fastify CORS plugin: invalid origin scheme`                                                             | LWA forwarded raw `Host` header without scheme; CORS plugin rejected.                                                   |
| #35 | Bundled function deployment > 250 MB unzipped (AWS hard limit)                                           | `prisma` CLI package (~150 MB of cross-platform engine binaries) pulled in transitively; LWA-specific bundling provided no clean way to exclude it. |
| #36 | `@prisma/studio-core` (38 MB) + WASM query compilers (5 vendors × 2 sizes × 2 formats) inflated bundle   | Same root: bundle had to ship everything Prisma touched at install time, with no LWA-side hook to trim.                 |
| #37 | `Error: Dynamic require of "path" is not supported` at Lambda boot                                       | esbuild ESM output left dynamic `require()` calls intact in transitive deps; LWA layer didn't surface a clear error frame, debugging was indirect. |
| #38 | Lambda boot ran but `/health` 502 — Fastify listening on `:3000`, LWA probing `:8080`                    | `PORT` env var (Fastify convention) and `AWS_LWA_PORT` (LWA convention) drifted; fix required hardcoding both to 8080.  |
| #39 | `bootstrap script not found` cold start failure                                                          | `AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap` path drifted between LWA layer versions; required arn pinning + manual probing.|

Each PR resolved a symptom but the underlying **impedance mismatch** between an HTTP-listening server and an event-driven runtime kept producing new failures: payload format edge cases (URL encoding, binary content-types), readiness probe vs cold-start timing, env var coupling, layer ARN management, and the implicit "two processes inside one container" topology (LWA + Node) doubling the surface area for boot failures.

PR #40 pivoted to the [`@fastify/aws-lambda`](https://github.com/fastify/aws-lambda-fastify) adapter — an in-process function that translates APIGW v2 events to Fastify request/response objects synchronously, without crossing a localhost HTTP boundary. The result was the entire LWA-related class of bugs disappearing in a single change, plus a measurable cold-start improvement (no `app.listen()`, no readiness probe roundtrip).

## Decision

**Replace AWS Lambda Web Adapter with the `@fastify/aws-lambda` in-process adapter** as the bridge between API Gateway HTTP API v2 and the Fastify backend.

Specifically:

- `packages/api/src/index.ts` imports `@fastify/aws-lambda` dynamically and exports `handler = awsLambdaFastify(app)`. The adapter awaits Fastify readiness internally on the first invocation; the wrap **must** happen before `app.ready()` to avoid `FST_ERR_DEC_AFTER_START` (Fastify rejects decorator additions once started — fixed in PR #41).
- The same `index.ts` entry handles both runtimes: in dev (no `AWS_LAMBDA_FUNCTION_NAME`), it boots a long-running HTTP server via `app.listen()`; under Lambda, the exported `handler` is invoked directly with no port binding.
- `infrastructure/lib/constructs/lambda-api.ts` no longer attaches the LWA layer (`arn:aws:lambda:${region}:753240598075:layer:LambdaAdapterLayerArm64:*`) and no longer sets `AWS_LWA_PORT`, `AWS_LWA_READINESS_CHECK_PATH`, `AWS_LWA_ASYNC_INIT`, or `AWS_LAMBDA_EXEC_WRAPPER`.
- esbuild bundling (via `NodejsFunction` L2) injects the `import { createRequire } from 'module'` shim banner to keep dynamic `require()` calls in transitive deps working under the ESM output format. This was identified during the LWA debugging cycle but is independent of the adapter choice — it stays.
- The fundamental decision of [ADR-0001](./ADR-0001-lambda-over-app-runner.md) (Lambda + API Gateway HTTP API v2 over App Runner) is **unchanged**. This ADR amends only the implementation detail of how Fastify is bridged to the Lambda invocation model.

## Alternatives considered

### Alternative A — Keep LWA and continue troubleshooting

Stay on LWA, treat the six PRs as one-off boot issues, harden the layer-ARN pinning + env var contract going forward.

- **Pro**: No additional code to maintain. The "zero code change" pitch was preserved (in theory).
- **Con**: After six PRs in two days, the empirical evidence said the problem was structural, not incidental. Each new transitive dep change risked regressing the boot path again. The "zero code change" claim had collapsed — bundling, env vars, layer ARN, and runtime wrappers all needed LWA-aware tuning.
- **Rejected**: ongoing maintenance cost outweighed the marginal abstraction benefit.

### Alternative B — Rewrite each Fastify route as a native Lambda handler

Drop Fastify under Lambda entirely. Use a thin router (or APIGW route integrations) and write each handler as `(event, context) => ...`.

- **Pro**: Zero adapter abstraction. Smallest possible cold start.
- **Con**: Loses the entire Fastify ecosystem (plugins, hooks, schema validation, error handling, JWT, sensible-errors) which the codebase already depends on. Migration cost prohibitive — would touch every route file.
- **Rejected**: not proportionate to the problem (we don't need to throw away Fastify; we just need to bridge it differently).

### Alternative C — `@fastify/aws-lambda` in-process adapter **(chosen)**

Replace LWA with the in-process adapter from the Fastify org.

- **Pro**: Fastify-native (maintained by the same org). No HTTP localhost roundtrip — APIGW event is fed directly into Fastify's internal request handling. No layer ARN management, no env var contract, no extra process inside the container. Eliminates an entire category of LWA-specific failures (PORT mismatch, EXEC_WRAPPER paths, readiness probes, host/scheme rewriting).
- **Con**: 5 lines of explicit adapter glue in `packages/api/src/index.ts` (`handler = awsLambdaFastify(app)` + import). The "zero code change" narrative is broken, but it had already broken empirically with LWA.
- **Cost / risk**: one new runtime dependency (`@fastify/aws-lambda`, maintained by the Fastify org). Cold start improved (~3-5× faster: no `listen()`, no readiness probe roundtrip).

## Consequences

### Positive

- **Reliability**: the LWA-specific failure class (six PRs in 48h) collapsed in PR #40. No similar boot failures since.
- **Cold start**: removed the `listen()` + readiness-probe roundtrip. No formal benchmark logged at the time of the swap (the goal was unblocking, not measuring), but cold-start completion observed at ~1–1.5s vs ~3–5s previously on the Frankfurt region with the same memory/architecture config.
- **Operational simplicity**: no Lambda layer ARN to pin per region, no LWA layer version drift to track, no `AWS_LAMBDA_EXEC_WRAPPER` env var. CDK construct dropped ~25 lines.
- **Debuggability**: errors surface in the Fastify error handler with full stack trace, instead of being mediated by the LWA layer process.

### Negative

- **One more runtime dep**: `@fastify/aws-lambda` is now in `packages/api/package.json` `dependencies`. Maintained by the Fastify org, low abandonment risk.
- **No "zero code change" abstraction**: the entry file explicitly imports the adapter. New contributors who model their mental picture on "Fastify is a normal HTTP server, Lambda is somehow magic" will need 30 seconds to read `index.ts`. Counter-balanced by the comments in `lambda-api.ts` and `index.ts`.
- **Tighter coupling between `packages/api` and the Lambda runtime**: less true than it appears — the same `index.ts` entry boots an HTTP server in dev when `AWS_LAMBDA_FUNCTION_NAME` is unset. Local dev path is unchanged.

### Neutral

- **Documentation impact**: `docs/APPENDICE_C_INFRASTRUCTURE.md` §5.9 updated in the same PR as this ADR to reflect the new construct. The `infrastructure/README.md` F8 step (cold-start force command) had stale `AWS_LWA_*` env vars in its example; removed.
- **ADR-0001 status**: amended to reference this ADR in its Status field. The fundamental Lambda-over-App-Runner decision stands.

## Revisit triggers

This decision should be revisited if any of the following becomes true:

- **`@fastify/aws-lambda` becomes unmaintained or the Fastify org diverges from the AWS event-format spec**: monitor releases. Fallback: the adapter is small enough (~300 lines of TS) that we can vendor it if needed.
- **APIGW evolves its event format in a way the adapter doesn't track quickly**: same fallback as above.
- **A future use case requires sustained TCP / WebSocket connections inside the API**: would not invalidate this ADR (Lambda itself is the constraint), but might motivate moving that subset of routes to a sidecar Fargate service. See ADR-0001 revisit triggers.

## References

- [ADR-0001](./ADR-0001-lambda-over-app-runner.md) — original Lambda runtime decision (amended in Status).
- [`@fastify/aws-lambda` GitHub](https://github.com/fastify/aws-lambda-fastify) — chosen adapter.
- [AWS Lambda Web Adapter GitHub](https://github.com/awslabs/aws-lambda-web-adapter) — replaced adapter.
- GarageOS repository PRs:
  - #34 — `fix(api): allow https origins in CORS allowlist`
  - #35 — `chore(infra): exclude prisma CLI from Lambda bundle`
  - #36 — `chore(infra): strip @prisma/studio-core + non-postgres WASM compilers`
  - #37 — `fix(api): inject createRequire shim banner for ESM bundle`
  - #38 — `fix(infra): align AWS_LWA_PORT with Fastify PORT`
  - #39 — `fix(infra): pin LWA layer ARN, remove AWS_LAMBDA_EXEC_WRAPPER drift`
  - #40 — `feat(api,infra): replace LWA with @fastify/aws-lambda adapter` (this swap)
  - #41 — `fix(api): wrap with awsLambdaFastify before app.ready()`
