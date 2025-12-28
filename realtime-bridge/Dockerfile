# odin-realtime-bridge
# -------------------
# Minimal Node service to bridge Twilio Media Streams <-> OpenAI Realtime.

FROM node:20-slim

WORKDIR /app

COPY package.json ./package.json

# Install deps (no lockfile in repo yet)
RUN npm install --omit=dev

COPY src ./src

ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
