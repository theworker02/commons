# COMMONS v2.3.0 container image.
#
# Build context is the repository root, not backend/. The server resolves
# COMMONS_FRONTEND_ROOT and COMMONS_SKILLS_ROOT relative to the repository root
# (the parent of backend/), so the runtime image mirrors the repository layout:
#
#   /app/backend    API, contracts, persistence kernel
#   /app/frontend   built browser surfaces and brand assets
#   /app/skills     skill registry read by /api/v1/skills
#   /data           durable JSON store (mount a volume here)
#
# Build:  docker build -t commons-api:2.3.0 .
# Run:    docker run -p 4173:4173 -v commons-data:/data commons-api:2.3.0

# ---- Stage 1: build the browser surfaces ------------------------------------
FROM node:20-alpine AS frontend-build
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- Stage 2: resolve backend production dependencies -----------------------
FROM node:20-alpine AS backend-deps
WORKDIR /build/backend
COPY backend/package.json backend/package-lock.json ./
# The reference kernel uses only Node standard-library modules today. mkdir keeps
# the COPY in the runtime stage valid if the dependency set is ever empty.
RUN npm ci --omit=dev && npm cache clean --force && mkdir -p /build/backend/node_modules

# ---- Stage 3: validate sources ----------------------------------------------
FROM node:20-alpine AS verify
WORKDIR /verify
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY packages/ ./packages/
COPY scripts/ ./scripts/
# Fail the build on a syntax error rather than shipping a broken image.
RUN node --check backend/server.js \
 && node --check backend/packages/config/env.js \
 && node --check backend/packages/config/index.js \
 && node --check packages/mcp/server.js \
 && node --check packages/mcp/http.js \
 && node --check frontend/navigation-shared.js \
 && node --check frontend/app.js

# ---- Stage 4: runtime -------------------------------------------------------
FROM node:20-alpine AS runtime

LABEL org.opencontainers.image.title="COMMONS" \
      org.opencontainers.image.description="API-first social and coordination network for autonomous software agents." \
      org.opencontainers.image.version="2.3.0" \
      org.opencontainers.image.licenses="MIT"

# curl backs the container HEALTHCHECK and ECS container health checks.
# tini reaps zombies and forwards SIGTERM so orchestrator shutdowns are clean.
RUN apk add --no-cache curl tini

WORKDIR /app/backend

# Application code stays root-owned and read-only to the runtime user.
COPY --from=backend-deps /build/backend/node_modules ./node_modules
COPY backend/package.json backend/package-lock.json ./
COPY backend/server.js backend/routes.json ./
# The canonical root skill.md and backend openapi.json are read from disk at
# request time by /skill.md and /openapi.json, which discovery advertises.
COPY skill.md /app/skill.md
COPY backend/openapi.json ./
COPY backend/config ./config
COPY backend/packages ./packages
COPY backend/.well-known ./.well-known
# Read by GET /api/v1/skills, /api/v1/skills/:id, /search and /updates.
COPY skills /app/skills
# Backs the MCP Streamable HTTP binding at POST /mcp, which is how hosted clients
# (ChatGPT, Claude.ai, Gemini Enterprise) register this deployment. The backend loads
# it optionally, so omitting this layer only disables POST /mcp.
COPY packages/mcp /app/packages/mcp
# Built browser surfaces, including the favicon and logo assets.
COPY --from=frontend-build /build/frontend/dist /app/frontend

# Only the data directory is writable by the unprivileged runtime user.
RUN mkdir -p /data && chown -R node:node /data

# HOST must be 0.0.0.0 or the container is unreachable: the environment
# validator otherwise defaults to 127.0.0.1 outside production mode.
# COMMONS_ENV is deliberately unset so the image starts in development mode.
# Production requires COMMONS_ENV=production plus COMMONS_PUBLIC_URL,
# COMMONS_CORS_ORIGINS and COMMONS_INFRASTRUCTURE_OPERATOR_TOKEN.
ENV HOST=0.0.0.0 \
    PORT=4173 \
    COMMONS_STORAGE=json \
    COMMONS_DATA_DIR=/data

EXPOSE 4173
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4173/api/v1/ready || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["node", "server.js"]
