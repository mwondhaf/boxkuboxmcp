# syntax=docker/dockerfile:1.7

# -----------------------------------------------------------------------------
# Stage 1: base image — pinned Bun 1.x on Debian slim (official recommendation).
# -----------------------------------------------------------------------------
FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# -----------------------------------------------------------------------------
# Stage 2: install — resolve dev + prod dependency trees in isolated temp dirs
# so the final image can pull only the production tree without dev deps.
# -----------------------------------------------------------------------------
FROM base AS install

RUN mkdir -p /temp/dev
COPY package.json bun.lock* /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

RUN mkdir -p /temp/prod
COPY package.json bun.lock* /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# -----------------------------------------------------------------------------
# Stage 3: prerelease — copy source + dev deps, run typecheck. No bundling;
# Bun runs TypeScript directly at runtime.
# -----------------------------------------------------------------------------
FROM base AS prerelease

COPY --from=install /temp/dev/node_modules node_modules
COPY . .

ENV NODE_ENV=production
RUN bun run typecheck

# -----------------------------------------------------------------------------
# Stage 4: release — production-only deps + source. Runs as non-root `bun` user.
# -----------------------------------------------------------------------------
FROM base AS release

COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/src ./src
COPY --from=prerelease /usr/src/app/package.json .
COPY --from=prerelease /usr/src/app/tsconfig.json .

# Required runtime env (validated at startup by src/config.ts — the container
# exits non-zero if any is missing). Pass them with `docker run -e` / compose:
#   CONVEX_URL          Convex deployment URL
#   MCP_CLIENT_SECRET   shared Bearer secret for /mcp callers
#   GOOGLE_API_KEY      Google Places + Geocoding key (must ALSO be set in Convex)
# Optional: PORT (default 3000), ALLOWED_ORIGINS
#   MCP_REQUIRE_CUSTOMER_PHONE=true  fail closed unless the caller binds a
#                                    verified phone via X-Customer-Phone
# Optional OAuth (set BOTH to let MCP clients sign in with Clerk instead of the
# shared secret — use the PRODUCTION Clerk instance keys):
#   CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY
ENV NODE_ENV=production
USER bun
EXPOSE 3000/tcp

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:' + (process.env.PORT ?? 3000) + '/health').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

ENTRYPOINT ["bun", "run", "src/index.ts"]
