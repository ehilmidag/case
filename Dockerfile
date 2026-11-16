# syntax=docker/dockerfile:1.7

FROM node:24-alpine3.24 AS dependencies

WORKDIR /app
RUN apk upgrade --no-cache && npm install --global npm@latest
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

FROM dependencies AS build

COPY nest-cli.json tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine3.24 AS production

ENV NODE_ENV=production
WORKDIR /app
RUN apk upgrade --no-cache && npm install --global npm@latest
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000 9100
CMD ["node", "dist/main.api.js"]
