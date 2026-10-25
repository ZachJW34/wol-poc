# wol-poc container image.
#
# Base image verified from Docker Hub on 2026-10-21: oven/bun:latest is the official
# image for the Bun runtime and is Debian-based (so apt-get is available). The build
# pins the runtime version used by this project (Bun 1.4.2) so the image is reproducible.
FROM oven/bun:1.4.2 AS build

WORKDIR /app

# Install from the lockfile first for better layer caching.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# Gates that can run inside the image build. Build comes before test: the static-serving
# integration tests read the real dist/ tree.
RUN bun run typecheck && bun run build && bun run test

# ---------------------------------------------------------------------------
# Runtime stage: minimal, Debian-based, non-root.
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.2 AS runtime

# The wake adapter calls the external `wakeonlan` CLI by name. It is a UDP-based
# Perl tool, so it does not need root privileges inside the container.
RUN apt-get update \
  && apt-get install -y --no-install-recommends wakeonlan \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=build /app/dist ./dist
COPY src ./src

RUN useradd -r -u 10001 -m wol \
  && mkdir -p /data \
  && chown wol:wol /data

USER wol

# Loopback-only bind. The app has no host configuration; PORT is the only network setting.
# APP_ORIGIN is intentionally not defaulted here: the operator must provide the exact origin.
ENV NODE_ENV=production
ENV PORT=7123
ENV DATABASE_PATH=/data/wol.sqlite

# Metadata only: EXPOSE cannot follow a runtime variable. It must match the PORT the
# container actually runs with, otherwise tooling that trusts it points at the wrong port.
EXPOSE 7123

# No HEALTHCHECK here: the health check lives in compose.yaml, where it can read the
# service's own environment. The tradeoff is that `docker run` without compose has no
# health check at all.

CMD ["bun", "run", "start"]
