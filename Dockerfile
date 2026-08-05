FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY web ./web
COPY contracts ./contracts
COPY scripts ./scripts
RUN mkdir -p /var/lib/emergency && chown -R node:node /var/lib/emergency /app
EXPOSE 8080
USER node
CMD ["node", "src/server.ts"]
