FROM node:20-alpine

# Seulement docker-cli pour la découverte des conteneurs
RUN apk add --no-cache docker-cli

WORKDIR /app

# Dependencies
COPY server/package.json ./
RUN npm install --production

# Application
COPY server/server.js ./
COPY web/ ./web/

EXPOSE 80
EXPOSE 4730/udp

CMD ["node", "server.js", "--verbose"]
