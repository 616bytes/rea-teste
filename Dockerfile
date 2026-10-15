# syntax=docker/dockerfile:1

FROM node:24.18.0-bookworm-slim

ENV CI=1

RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
        ca-certificates \
        g++ \
        git \
        make \
        procps \
        python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

RUN npm ci \
    && npm run build:cached

ENTRYPOINT ["node", "scripts/rea.mjs"]
CMD ["mcp"]
