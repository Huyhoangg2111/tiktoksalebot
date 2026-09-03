FROM node:22-bookworm

WORKDIR /app

ENV PW_SIGNER_INTERNAL_ENABLED=true
ENV PW_SIGNER_HEADLESS=true
ENV PW_SIGNER_HOST=127.0.0.1
ENV PW_SIGNER_PORT=8092
ENV PW_SIGNER_AUTO_LOGIN_ON_STARTUP=true
ENV PW_SIGNER_CHROMIUM_ARGS=--disable-dev-shm-usage,--no-zygote
ENV DATABASE_PATH=/app/runtime/bot_data.db
ENV PW_SIGNER_STATE_PATH=/app/runtime/playwright-signer/session.json
ENV npm_config_build_from_source=true

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --include=dev \
  && npm rebuild sqlite3 --build-from-source
RUN npx playwright install --with-deps chromium

COPY . .

RUN npm run build
RUN npm prune --omit=dev
ENV NODE_ENV=production
RUN mkdir -p /app/runtime/playwright-signer

VOLUME ["/app/runtime"]

CMD ["node", "dist/index.js"]
