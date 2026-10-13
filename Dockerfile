# llm-relay —— 零依赖 Node 服务，无需 npm install
# 国内服务器拉不动 docker.io 时，在 .env 设 IMAGE_REGISTRY=<镜像站>/library（见 .env.example）
ARG IMAGE_REGISTRY=docker.io/library
FROM ${IMAGE_REGISTRY}/node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# 只拷贝运行所需代码；config.json 不打进镜像（含明文 key，运行时放 /data 卷）
COPY server.js convert.js proxyFetch.js ./
COPY public ./public

# /data = 配置与 key 池状态持久化目录（RELAY_CONFIG_DIR）
RUN mkdir -p /data && chown node:node /data
ENV RELAY_CONFIG_DIR=/data \
    RELAY_HOST=0.0.0.0 \
    RELAY_PORT=8787

USER node
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${RELAY_PORT}/" >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
