FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ src/

EXPOSE 3457

CMD ["node", "src/boot.js"]
