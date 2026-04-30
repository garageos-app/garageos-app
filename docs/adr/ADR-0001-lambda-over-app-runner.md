# ADR-0001: Adopt AWS Lambda + API Gateway HTTP API instead of AWS App Runner for backend runtime

## Status

Accepted (adapter implementation amended on 2026-04-29 — see [ADR-0002](./ADR-0002-replace-lwa-with-fastify-aws-lambda-adapter.md)). The fundamental Lambda + API Gateway HTTP API v2 over App Runner decision recorded below stands.

## Date

2026-04-23

## Context

During initial infrastructure planning for GarageOS v1 (documented in `docs/APPENDICE_C_INFRASTRUCTURE.md` up to v1.0), we selected **AWS App Runner** as the runtime for the Fastify backend.

App Runner was chosen for its simplicity:
- Managed scaling with minimal configuration.
- Docker-native deploy (single `apprunner update-service` from ECR).
- Automatic HTTPS termination and custom domain binding.
- No VPC or network stack to design.
- Predictable monthly cost (~25-40 € for a pilot workload).

On **2026-04-23**, during the PR 3 bootstrap session, we discovered via web search of the official AWS documentation that AWS announced:

> "AWS App Runner will no longer be open to new customers starting April 30, 2026. Existing customers can continue to use the service as normal."

Source: [AWS App Runner availability change](https://docs.aws.amazon.com/apprunner/latest/dg/service-source-code-nodejs-releases.html).

This announcement arrived **7 days before the enrollment deadline**. The AWS GarageOS account had not yet been created, so we had a narrow window to either:

1. Create the AWS account immediately and subscribe to App Runner before the deadline (preserving the chosen architecture), or
2. Reconsider the runtime choice.

Additional context that weighed on the decision:

- **GarageOS expected traffic at pilot scale is very low**: 100k–800k requests/month across 10–50 workshops, ~500–3000 vehicles, ~200–1500 customers (derived from `GarageOS-Specifiche.md` §1.2). Most of this volume fits comfortably within AWS Lambda's permanent free tier (1M requests/month + 400k GB-seconds/month).
- **Lambda is AWS's most invested compute service**: deprecation risk is near zero for the foreseeable future, in contrast to App Runner which is being wound down to existing customers only.
- **The Fastify application can run on Lambda with minimal refactoring** thanks to the [AWS Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter), which lets HTTP servers (Fastify, Express, etc.) run inside a Lambda function without converting each route to a Lambda handler.
- **Cold start is a known downside of Lambda**, but the GarageOS workload is not latency-critical at sub-500ms level (workshop management app, not real-time trading). Cold start can be mitigated with EventBridge-based scheduled warming (~$0/month, well within free tier) if needed post-MVP.

## Decision

**Adopt AWS Lambda + API Gateway HTTP API v2 + AWS Lambda Web Adapter** as the runtime for the GarageOS Fastify backend.

Specifically:

- The backend API (`packages/api`) is packaged as a single AWS Lambda function, bundled via esbuild (through the CDK `NodejsFunction` L2 construct).
- The Fastify application runs inside the Lambda container via the AWS Lambda Web Adapter layer (listens on `:8080`, the Adapter proxies incoming Lambda events as HTTP requests).
- The public HTTPS endpoint is provided by **API Gateway HTTP API v2** (not REST API v1), chosen for its ~70% cost advantage (~$1.00/M requests vs $3.50/M) and sufficient feature set for REST traffic.
- Custom domain (`api.garageos.it`) is bound natively via CDK (`aws-cdk-lib/aws-apigatewayv2` `DomainName` + `ApiMapping` constructs), without the manual post-deploy step previously required by App Runner.
- Lambda configuration:
  - Memory: **1024 MB** (adequate for Fastify + Prisma with a 10–20 connection pool).
  - Architecture: **arm64 (Graviton)** — 20% cost reduction vs x86 with full Node.js compatibility.
  - Timeout: **30 seconds**.
  - Runtime: **Node.js 22.x** (upgrade to Node.js 24 planned for v1.1+ once AWS CDK managed runtime support stabilizes).
  - Reserved concurrency: **100** (cap to protect against runaway invocations; adjustable upward).
- Scheduled warming: **EventBridge Scheduler** invokes the Lambda every 5 minutes, Mon–Sat 08:00–20:00 Europe/Rome, with a synthetic `{source: "warming"}` event that returns without touching the database. Cost: negligible (within free tier).
- No VPC: the Lambda runs outside any VPC and reaches Supabase PostgreSQL via the public internet. This avoids NAT Gateway costs (~33 €/month) and simplifies networking.

## Alternatives considered

### Alternative A — Subscribe to App Runner before 2026-04-30

Create the AWS account within 7 days, enroll in App Runner, keep the original plan.

- **Pro**: Zero refactoring. Existing infrastructure documentation (v1.0 of `APPENDICE_C_INFRASTRUCTURE.md`) stays valid.
- **Con**: Bets the architecture on a service AWS has publicly de-prioritized. No new features or investment expected. Risk of full deprecation in 1–3 years with forced migration under time pressure.
- **Cost at pilot scale**: ~25–40 €/month.

### Alternative B — AWS ECS Fargate

Run the Fastify container on ECS with Fargate launch type, behind an Application Load Balancer.

- **Pro**: Future-proof AWS service (not deprecated). Docker model preserved. Fine-grained networking and scaling control.
- **Con**: Significantly more infrastructure (VPC, subnets, security groups, ALB, NAT Gateway for outbound to Supabase). Higher fixed cost (~70–80 €/month minimum for HA).
- **Cost at pilot scale**: ~70–80 €/month. Overkill for the traffic volume.

### Alternative C — AWS Lambda + API Gateway HTTP API **(chosen)**

Run Fastify inside Lambda via the AWS Lambda Web Adapter.

- **Pro**: Extremely low cost at pilot volume (free tier covers up to ~2M req/month with chosen config). Scale-to-zero. Future-proof (AWS flagship compute service). Minimal application code changes.
- **Con**: Cold start (~200–500ms on first request after idle; mitigable with scheduled warming). Lambda-specific constraints: 15-minute max execution time, 10 MB max payload, bundling-based deploy model.
- **Cost at pilot scale**: ~0,50–4,15 €/month (see `APPENDICE_C_INFRASTRUCTURE.md` §11.4 for detailed breakdown).

### Alternative D — Third-party PaaS (Railway, Fly.io, Render)

Deploy the Docker container on an external PaaS provider.

- **Pro**: Comparable or lower cost than App Runner. Excellent developer experience.
- **Con**: Breaks the "all AWS + Supabase DB only" architectural coherence established earlier. Adds a second vendor with separate DPA, contract, and operational surface. Loses AWS ecosystem integrations (IAM, CloudWatch cross-service visibility).
- **Rejected** without deep analysis: the coherence cost outweighs the marginal savings.

## Consequences

### Positive

- **Cost**: Pilot operating cost for compute drops from ~25–40 €/month (App Runner) to ~0,50–4,15 €/month (Lambda). Savings of roughly **350 €/year at pilot medium**, scaling with traffic.
- **Scale behavior**: Lambda scales instantly from 0 to hundreds of concurrent executions, ideal for GarageOS's expected pattern ("all workshops open at 08:00, burst in traffic"). No idle cost during nights, weekends (except Saturday), and holidays.
- **Deploy time**: esbuild-based bundling produces zip artifacts in ~30–60s vs ~3–5 min for Docker build + ECR push. Faster CI/CD loop.
- **Operational simplicity**: No VPC, no subnets, no NAT Gateway, no task definitions, no container orchestration. The infrastructure footprint is smaller and easier to reason about.
- **Future-proof**: Alignment with AWS's strategic direction. Less risk of another forced migration within the project's expected lifetime.
- **Custom domain management**: Fully declarative in CDK (no more manual `apprunner associate-custom-domain` step documented in the old §10.3 of the infrastructure appendix, which is removed in v1.1).

### Negative

- **Cold start latency**: First request after idle adds ~200–500ms. Mitigated by scheduled warming during business hours. If residual impact is observed post-MVP, provisioned concurrency is available (~5–8 €/month for 1 warm instance).
- **Payload limit (10 MB)**: Relevant for vehicle service attachments (photos, PDFs). Mitigation: uploads flow directly from the client to S3 via pre-signed URLs (already documented in `APPENDICE_A_API.md` §8), so the Lambda never sees the full binary payload. No change needed.
- **Execution time limit (15 min)**: Not a concern for synchronous API requests. Long-running workflows (e.g., bulk export jobs) should be decomposed into Step Functions or SQS-backed workers if ever needed — not currently planned.
- **Local development loop**: Fastify can still be run standalone (`pnpm dev`) in development. For integration tests that simulate Lambda, the `serverless-offline` or `lambda-local` tools are available if needed. Expected minor learning curve.
- **Bundling complexity**: Native dependencies (e.g., Prisma engines) require careful configuration in the `NodejsFunction` `bundling.externalModules` and `bundling.nodeModules` fields. Documented in `APPENDICE_C_INFRASTRUCTURE.md` §5.9.
- **Lambda-specific pricing variables**: Unlike App Runner's flat hourly cost, Lambda pricing combines requests + compute duration + downstream services (API Gateway, CloudWatch Logs). The math is more complex but the total is substantially lower at the expected volume.

### Neutral

- **Documentation impact**: `APPENDICE_C_INFRASTRUCTURE.md` updated to v1.1 (see PR 3.5). Future CDK stacks (PR 8+) will implement the Lambda-based architecture described there.
- **Team skill**: Lambda is a widely-known service in the Node.js community. No specialized hiring or training implications.
- **Monitoring**: Metrics shift from App Runner namespace (`AWS/AppRunner`) to `AWS/Lambda` + `AWS/ApiGateway`. CloudWatch alarms updated accordingly in `APPENDICE_C_INFRASTRUCTURE.md` §5.11.

## Revisit triggers

This decision should be revisited if any of the following becomes true:

- **Traffic crosses ~30M requests/month sustained**: Above this threshold, Lambda's per-request pricing becomes less favorable than running Fastify on Fargate or EC2. At the projected GarageOS growth rate (~500 workshops / ~50k vehicles), this is several years away.
- **Cold start latency becomes user-visible and unacceptable**: If metrics show p95 latency above 2s and users report impact, consider provisioned concurrency or migration to a long-running container service.
- **AWS deprecates Lambda Web Adapter or significantly changes Lambda pricing**: Low-probability event but monitored via AWS announcements.
- **Feature requirements emerge that Lambda cannot serve** (e.g., long-lived WebSocket connections that exceed 15-minute limit, or low-latency inter-service communication requiring sustained TCP connections). These would likely be better served by a sidecar Fargate service rather than migrating the whole API.

## References

- `docs/APPENDICE_C_INFRASTRUCTURE.md` — infrastructure design (v1.1 reflects this ADR).
- [AWS App Runner availability change announcement](https://docs.aws.amazon.com/apprunner/latest/dg/service-source-code-nodejs-releases.html).
- [AWS Lambda Web Adapter GitHub](https://github.com/awslabs/aws-lambda-web-adapter).
- [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/).
- [AWS API Gateway HTTP API pricing](https://aws.amazon.com/api-gateway/pricing/).
- GarageOS repository PRs: #3 (monorepo baseline), #[3.5] (Appendice C update to Lambda).
