FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY src ./src
COPY web ./web
COPY contracts ./contracts
RUN mkdir -p /var/lib/emergency && chown -R node:node /var/lib/emergency /app
EXPOSE 8080
USER node
CMD ["node", "src/server.ts"]
