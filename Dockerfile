FROM node:22-bookworm-slim

ENV NODE_ENV=production

# yt-dlp untuk mengambil audio dari video YouTube.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        python3-venv \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir yt-dlp

ENV PATH="/opt/yt-dlp/bin:${PATH}"

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

# Render menentukan port melalui environment variable PORT.
CMD ["npm", "start"]