#!/bin/bash
set -euo pipefail

PREFIX="${CONTAINER_PREFIX:-osmo-operator-}"
WEB="osmo-egprs-web"

# Find a running operator container
FIRST=$(docker ps --filter "name=${PREFIX}" --format "{{.Names}}" | head -1)
if [ -z "$FIRST" ]; then
  echo "ERROR: No operator containers found (${PREFIX}*). Start osmo_egprs first."
  exit 1
fi

# Detect Docker network
NETWORK=$(docker inspect "$FIRST" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' | grep -v '^$' | head -1)
[ -z "$NETWORK" ] && echo "ERROR: Cannot detect network for $FIRST" && exit 1

OP_COUNT=$(docker ps --filter "name=${PREFIX}" --format "{{.Names}}" | wc -l)
echo "Network: $NETWORK | Operators: $OP_COUNT"

# Cleanup previous
docker rm -f "$WEB" 2>/dev/null || true

# Build
echo "Building..."
docker build -t osmo-egprs-web -f Dockerfile . 

# Run
echo "Starting..."
docker run -d \
  --name "$WEB" \
  --network "$NETWORK" \
  -p 80:80 \
  -p 4730:4730/udp \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -e CONTAINER_PREFIX="$PREFIX" \
  -e POLL_INTERVAL=4000 \
  --restart unless-stopped \
  osmo-egprs-web

echo ""
echo "  ▸ Dashboard: http://localhost:80"
echo "  ▸ Logs:      docker logs -f $WEB"
echo "  ▸ Stop:      docker rm -f $WEB"
echo ""
echo "Run ./tshark-host.sh to send GSMTAP packets to the dashboard."
