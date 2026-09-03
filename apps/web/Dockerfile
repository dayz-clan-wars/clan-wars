# apps/web/Dockerfile
# ⚠️ node:22, not node:20 like apps/ingest-worker/Dockerfile. Next 16 requires
# Node ^20.9 || >=22, and pinning the newer line here leaves headroom without
# forcing a bump on the worker, which is fine where it is.
FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile
WORKDIR /repo/apps/web
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# ⚠️ Next's standalone server binds to process.env.HOSTNAME if it is set, and
# Docker sets HOSTNAME to the container ID for every container — which
# resolves to the container's own IP, not all interfaces. Left unset here,
# the server binds only to that one address: still reachable by service name
# from another container (Caddy included, since Docker's DNS resolves the
# name to the same IP), but not via localhost/127.0.0.1 from inside the
# container itself, which silently breaks in-container healthchecks and exec
# curls. Forcing 0.0.0.0 avoids depending on that coincidence.
ENV HOSTNAME=0.0.0.0
# Next's standalone output carries its own minimal node_modules, so the
# workspace and its install do not travel into the runtime image.
COPY --from=builder /repo/apps/web/.next/standalone ./
COPY --from=builder /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /repo/apps/web/public ./apps/web/public
EXPOSE 3000
# ⚠️ The standalone server lands at the package's path inside the bundle, not
# at the root — a workspace build nests it under apps/web.
CMD ["node", "apps/web/server.js"]
