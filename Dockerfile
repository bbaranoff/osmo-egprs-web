FROM node:20-alpine

# tshark for Wireshark-grade protocol decoding, docker-cli for container discovery
RUN apk add --no-cache \
    tshark \
    docker-cli \
    libcap \
    ffmpeg \
  && setcap cap_net_raw,cap_net_admin+eip $(which dumpcap) \
  && tshark --version | head -1

WORKDIR /app

# Dependencies
COPY server/package.json ./
RUN npm install --production

# Application
COPY server/server.js ./
COPY web/ ./web/

# Verify
RUN node -e "console.log('server.js OK')" && ls -la /app/

EXPOSE 80
EXPOSE 4729/udp

CMD ["node", "server.js"]
