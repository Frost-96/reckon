FROM node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc

ENV CI=true
RUN npm install --global pnpm@12.11.2 && npm cache clean --force

WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --prod

COPY . .
RUN pnpm install --offline --frozen-lockfile --prod

USER node
