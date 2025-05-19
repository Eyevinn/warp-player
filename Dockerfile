ARG NODE_IMAGE=node:20-alpine

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
EXPOSE 8080
RUN mkdir /app
RUN chown node:node /app
USER node
WORKDIR /app
COPY --chown=node:node ["package.json", "package-lock.json*", "tsconfig*.json", "webpack.config.js", "./"]
COPY --chown=node:node ["src", "./src"]
# Delete prepare script to avoid errors from husky
RUN npm pkg delete scripts.prepare \
    && npm ci --omit=dev
# Build for production
RUN npm run build
CMD [ "npm", "run", "start" ]