# === Build stage ===
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src

RUN npm run build

# === Production stage ===
FROM node:22-alpine AS production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# База користувачів бота — поза ./dist, щоб новий образ не затирав файл.
# Змонтуйте volume: -v sunflower-bot-data:/data
RUN mkdir -p /data
ENV USERS_JSON_PATH=/data/users.json

ENV NODE_ENV=production
EXPOSE 10000

CMD ["node", "dist/server.js"]
