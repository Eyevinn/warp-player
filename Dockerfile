ARG NODE_IMAGE=node:22-alpine

# ---- Build stage ------------------------------------------------------------
# The full dependency tree is installed here on purpose: webpack, ts-loader and
# typescript are all devDependencies, so `npm ci --omit=dev` would leave the
# image with nothing to build with.
FROM ${NODE_IMAGE} AS builder
WORKDIR /app

# Dependency layer, cached until package.json / package-lock.json change.
COPY ["package.json", "package-lock.json", "./"]
# husky's prepare script fails in a build context that has no .git directory
RUN npm pkg delete scripts.prepare \
    && npm ci

# Source layer
COPY ["tsconfig.json", "tsconfig.base.json", "webpack.config.mjs", "./"]
COPY ["src", "./src"]
RUN npm run build

# ---- Runtime stage ----------------------------------------------------------
# WARP Player is a static bundle, so the runtime image only needs a file server;
# the build toolchain and node_modules stay behind in the builder stage.
FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app

# Same static server that `npm run serve:dist` uses locally
RUN npm install -g serve@14.2.6

COPY --from=builder --chown=node:node /app/dist ./dist

USER node
EXPOSE 8080
CMD ["serve", "--single", "--listen", "tcp://0.0.0.0:8080", "dist"]
