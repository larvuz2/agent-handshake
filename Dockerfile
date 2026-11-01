# Agent Handshake gateway. No dependencies, so no install step.
FROM node:22-alpine
WORKDIR /app
COPY package.json LICENSE ./
COPY bin ./bin
COPY src ./src
COPY host ./host
COPY brand ./brand
COPY examples ./examples
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production \
    PORT=7410 \
    DATA_DIR=/data
USER node
EXPOSE 7410
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
# Runs your config (HANDSHAKE_CONFIG_JSON, or a file mounted at /app/handshake.config.json).
# With no config it runs the demo.
CMD ["node", "bin/agent-handshake.js", "auto"]
