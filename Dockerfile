FROM node:20-bookworm-slim

# Pacotes mínimos + ferramentas de build para dependências npm que compilam no Railway.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    openssl \
    git \
    python3 \
    make \
    g++ \
    fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
ENV NPM_CONFIG_LEGACY_PEER_DEPS=true
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_FUND=false

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --legacy-peer-deps --no-audit --no-fund
COPY . .

EXPOSE 3000
CMD ["npm", "start"]
