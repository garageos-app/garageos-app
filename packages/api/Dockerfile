# syntax=docker/dockerfile:1.7

# -----------------------------------------------------------------------------
# GarageOS API container image.
#
# PR 5 shipped this Dockerfile as a local smoke-test harness and a future
# option for container-image Lambda deployment. The current CDK strategy
# (APPENDICE_C §5.9) uses NodejsFunction + Lambda Web Adapter *layer* on
# managed runtime, which bundles the app via esbuild — so this image is
# explicitly off the deploy path.
#
# Runtime strategy: `tsx src/index.ts`. Using tsx (not `tsc` + `node`)
# sidesteps two Node-ESM issues introduced by cross-package imports:
#   1) @garageos/database exposes src/*.ts directly (no dist). Node 22
#      refuses to strip types under node_modules; tsx handles it fine.
#   2) The Prisma 7 generated client uses Bundler-style imports without
#      explicit .js extensions; tsx resolves them transparently.
# When this image is ever put on the deploy path, the replacement is a
# bundler stage (esbuild / tsup) that inlines both packages into a
# single .mjs — same approach CDK NodejsFunction uses.
#
# LWA works with any Node base because the LWA binary bundles its own
# Runtime Interface Client. The binary is a no-op when the container is
# run outside AWS Lambda, so local `docker run` just serves HTTP on
# AWS_LWA_PORT (8080) via Fastify directly.
# -----------------------------------------------------------------------------

# Stage 1: builder — install the full pnpm workspace, generate Prisma, deploy.
FROM public.ecr.aws/docker/library/node:22-slim AS builder

ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV HUSKY=0
ENV CI=true

WORKDIR /app

RUN corepack enable

COPY . .

RUN pnpm install --frozen-lockfile

# @garageos/database imports its PrismaClient from prisma/generated/
# (gitignored). Generation is schema-only (no DB connection needed).
RUN pnpm --filter @garageos/database db:generate

# Produce a self-contained folder under /out/ with api's prod deps +
# source (no build — we ship TypeScript and let tsx transform at
# runtime, see header). `--legacy` keeps pnpm 9's default deploy
# behaviour (symlinks resolved into a copied node_modules).
RUN pnpm --filter @garageos/api --prod --legacy deploy /out

# Stage 2: runtime — minimal Node image + app source + LWA binary
FROM public.ecr.aws/docker/library/node:22-slim

WORKDIR /var/task

# Lambda Web Adapter (multi-arch). No-op outside AWS Lambda.
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.0.0 \
     /lambda-adapter /opt/extensions/lambda-adapter

COPY --from=builder /out/src ./src
COPY --from=builder /out/package.json ./
COPY --from=builder /out/node_modules ./node_modules

ENV NODE_ENV=production
ENV PORT=8080
ENV AWS_LWA_PORT=8080
ENV AWS_LWA_READINESS_CHECK_PATH=/health
ENV AWS_LWA_INVOKE_MODE=buffered

EXPOSE 8080

# tsx lives in the api's `dependencies` so pnpm deploy includes its
# CLI shim under node_modules/.bin.
CMD ["node_modules/.bin/tsx", "src/index.ts"]
