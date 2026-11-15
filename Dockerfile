FROM node:20-bookworm-slim

# Herramientas multimedia y runtime JS que yt-dlp necesita para YouTube
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-pip ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*

# Deno es el runtime recomendado por yt-dlp para resolver desafíos JavaScript
RUN curl -fsSL https://deno.land/install.sh | sh
ENV PATH="/root/.deno/bin:${PATH}"

# Instalar yt-dlp actualizado junto con sus componentes EJS oficiales
RUN pip3 install --no-cache-dir --break-system-packages -U "yt-dlp[default]"

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm","start"]
