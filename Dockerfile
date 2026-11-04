# CivicEye API image. Build from civiceye_server_side/: docker build -t civiceye-api .
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S civiceye && adduser -S civiceye -G civiceye
COPY --from=build --chown=civiceye:civiceye /app/node_modules ./node_modules
COPY --from=build --chown=civiceye:civiceye /app/dist ./dist
COPY --from=build --chown=civiceye:civiceye /app/prisma ./prisma
COPY --from=build --chown=civiceye:civiceye /app/package.json ./package.json
USER civiceye
EXPOSE 4000
CMD ["node", "dist/main.js"]
