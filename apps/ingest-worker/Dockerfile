# apps/ingest-worker/Dockerfile
FROM node:20-alpine
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/ingest-worker ./apps/ingest-worker
RUN pnpm install --frozen-lockfile
WORKDIR /repo/apps/ingest-worker
CMD ["pnpm", "start"]
