FROM node:22-bookworm

WORKDIR /app

ENV DATABASE_PATH=/app/runtime/bot_data.db
ENV npm_config_build_from_source=true

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --include=dev \
  && npm rebuild sqlite3 --build-from-source

COPY . .

RUN npm run build
RUN npm prune --omit=dev
ENV NODE_ENV=production
RUN mkdir -p /app/runtime

VOLUME ["/app/runtime"]

CMD ["node", "dist/index.js"]
