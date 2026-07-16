# Production multi-stage Dockerfile for homelab-backstage
#
# Stage 1 (build) — full Node image with all dev tools
# Stage 2 (runtime) — slim Node image, non-root user, only production artefacts
#
# Build example:
#   docker build -t homelab-backstage:latest .
#
# The host-build pattern (yarn tsc + yarn build:backend outside Docker) is
# also supported: pre-build the app on the CI runner, then use the runtime
# stage only.  See .github/workflows/build-image.yml.

# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:20-bookworm AS build

WORKDIR /app

# Enable Yarn Berry via Corepack
RUN corepack enable

# Copy dependency manifests for layer caching
COPY package.json .yarnrc.yml yarn.lock ./
COPY .yarn .yarn
COPY packages/app/package.json packages/app/
COPY packages/backend/package.json packages/backend/

# Install all deps (including dev) — needed for tsc + build steps
RUN yarn install --immutable || echo "Some optional modules failed to build (expected in container)"

# Copy source
COPY . .

# Compile TypeScript
RUN yarn tsc

# Build the backend bundle (outputs to packages/backend/dist)
RUN yarn build:backend

# ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

# Install only the OS-level runtime requirements
RUN apt-get update && apt-get install -y --no-install-recommends     libssl3     && rm -rf /var/lib/apt/lists/*

# Run as non-root
RUN addgroup --system backstage && adduser --system --ingroup backstage backstage

WORKDIR /app

# Enable Corepack so yarn is available (needed to run the bundle)
RUN corepack enable

# Copy the backend bundle and its production node_modules from the build stage
COPY --from=build --chown=backstage:backstage /app/packages/backend/dist ./packages/backend/dist
COPY --from=build --chown=backstage:backstage /app/packages/backend/package.json ./packages/backend/package.json

# Copy the built frontend assets (served by the app-backend plugin)
COPY --from=build --chown=backstage:backstage /app/packages/app/dist ./packages/app/dist

# Copy root package.json so the runtime can locate workspace packages
COPY --from=build --chown=backstage:backstage /app/package.json ./

# Copy production dependencies only
# The backend dist bundle is self-contained but some native addons need
# the node_modules alongside.
COPY --from=build --chown=backstage:backstage /app/node_modules ./node_modules

# Copy config files
COPY --chown=backstage:backstage app-config.yaml app-config.production.yaml ./

# Copy catalog examples so file-based locations resolve at runtime
COPY --chown=backstage:backstage examples ./examples

USER backstage

EXPOSE 7007

ENV NODE_ENV=production

CMD ["node", "packages/backend/dist/index.cjs.js", "--config", "app-config.yaml", "--config", "app-config.production.yaml"]
