FROM node:20-alpine

# tshark (utilise dumpcap pour la capture), docker-cli, parec/pactl
RUN apk add --no-cache \
    wireshark \
    docker-cli \
    libcap \
    pulseaudio-utils \
    tshark \
  && setcap cap_net_raw,cap_net_admin+eip $(which dumpcap) \
  && tshark --version | head -1

WORKDIR /app

COPY server/package.json ./
RUN npm install --production

COPY server/server.js ./
COPY web/ ./web/

RUN node --check server.js && echo "server.js OK" && ls -la /app/

EXPOSE 80
EXPOSE 4729/udp

CMD ["node", "server.js"]
