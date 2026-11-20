FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NITRO_PRESET=node-server
ENV VITE_GROK_EXTENSIONS=0
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NITRO_PRESET=node-server
ENV HOST=0.0.0.0
ENV PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/.output ./.output
COPY --from=build /app/scripts/migrate.mjs ./scripts/migrate.mjs
COPY --from=build /app/scripts/migration-plan.mjs ./scripts/migration-plan.mjs
COPY --from=build /app/migrations ./migrations
EXPOSE 3000
CMD ["sh", "-c", "npm run db:migrate && npm run start"]
