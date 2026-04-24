# syntax=docker/dockerfile:1.7

# -----------------------------------------------------------------------------
# GarageOS API container image.
#
# PR 5 ships this Dockerfile as a local smoke-test harness and a future
# option for container-image Lambda deployment. The current CDK strategy
# (APPENDICE_C §5.9) uses NodejsFunction + Lambda Web Adapter *layer* on
# managed runtime, not this image — so this file is not on the deploy
# path as of PR 5.
#
# LWA works with any Node base because the LWA binary bundles its own
# Runtime Interface Client. The binary is a no-op when the container is
# run outside AWS Lambda, so local `docker run` just serves HTTP on
# AWS_LWA_PORT (8080) via Fastify directly.
# -----------------------------------------------------------------------------

# Stage 1: builder — install the full pnpm workspace, build api, prune.
FROM public.ecr.aws/docker/library/node:22-slim AS builder

ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Skip husky install inside the container — there is no git tree here.
ENV HUSKY=0
# pnpm detects CI and skips interactive confirmations (required because
# `docker build` has no TTY).
ENV CI=true

WORKDIR /app

RUN corepack enable

# Copy the whole repo (filtered by .dockerignore). Installing after the
# copy is cheaper to reason about than staging package.jsons separately:
# pnpm materialises symlinks under each package's node_modules during
# install, and a later COPY of the package source would overwrite the
# target directory's layout on some Docker versions.
COPY . .

RUN pnpm install --frozen-lockfile

RUN pnpm --filter @garageos/api build

# Produce a self-contained folder with only api's prod deps + dist.
# `--legacy` keeps pnpm 9's default deploy behaviour (symlinks are
# resolved into a copied node_modules without requiring the api
# package to opt into inject-workspace-packages).
RUN pnpm --filter @garageos/api --prod --legacy deploy /out

# Stage 2: runtime — minimal Node image + app + LWA binary
FROM public.ecr.aws/docker/library/node:22-slim

WORKDIR /var/task

# Lambda Web Adapter (multi-arch). No-op outside AWS Lambda.
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.0.0 \
     /lambda-adapter /opt/extensions/lambda-adapter

COPY --from=builder /out/dist ./dist
COPY --from=builder /out/package.json ./
COPY --from=builder /out/node_modules ./node_modules

ENV NODE_ENV=production
ENV PORT=8080
ENV AWS_LWA_PORT=8080
ENV AWS_LWA_READINESS_CHECK_PATH=/health
ENV AWS_LWA_INVOKE_MODE=buffered

EXPOSE 8080

CMD ["node", "dist/index.js"]
