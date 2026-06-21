#!/bin/bash
# install-web-service.sh — installe le dashboard osmo-egprs-web comme service
# systemd DANS le container (osmo-operator-*), sans rebuild d'image.
#
# Idempotent. À lancer en root dans le container :
#   bash /opt/osmo-egprs-web/install-web-service.sh
#
# Le START reste géré par start-direct.sh (`systemctl restart osmo-egprs-web`) ;
# ce script ne fait qu'INSTALLER (runtime node + unit + enable) et démarre une
# fois pour vérifier.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${APP_DIR:-/opt/osmo-egprs-web}"
NODE_VERSION="${NODE_VERSION:-v20.20.2}"
UNIT_SRC="${HERE}/osmo-egprs-web.service"
UNIT_DST="/etc/systemd/system/osmo-egprs-web.service"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

[ "$(id -u)" -eq 0 ] || { echo -e "${RED}Root requis${NC}"; exit 1; }

# ── 1. Runtime Node.js ───────────────────────────────────────────────────────
if command -v node >/dev/null 2>&1; then
    echo -e "  ${GREEN}[node] présent : $(node --version)${NC}"
else
    echo -e "  ${YELLOW}[node] absent — installation ${NODE_VERSION} dans /opt/node${NC}"
    tarball="node-${NODE_VERSION}-linux-x64.tar.xz"
    url="https://nodejs.org/dist/${NODE_VERSION}/${tarball}"
    if command -v curl >/dev/null 2>&1; then curl -fsSL "$url" -o "/tmp/${tarball}"
    elif command -v wget >/dev/null 2>&1; then wget -q "$url" -O "/tmp/${tarball}"
    else echo -e "${RED}[node] ni curl ni wget — impossible de télécharger node${NC}"; exit 1; fi
    mkdir -p /opt/node
    tar -xJf "/tmp/${tarball}" -C /opt/node --strip-components=1
    rm -f "/tmp/${tarball}"
    ln -sf /opt/node/bin/node /usr/local/bin/node
    ln -sf /opt/node/bin/npm  /usr/local/bin/npm
    ln -sf /opt/node/bin/npx  /usr/local/bin/npx
    echo -e "  ${GREEN}[node] installé : $(node --version)${NC}"
fi

# ── 2. Dépendances JS (ws) ───────────────────────────────────────────────────
if [ -d "$APP_DIR" ] && [ ! -d "$APP_DIR/node_modules/ws" ]; then
    echo -e "  ${YELLOW}[deps] npm install dans $APP_DIR${NC}"
    ( cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund ) || \
        echo -e "  ${YELLOW}[deps] npm install a échoué (offline ?) — on continue${NC}"
fi

# ── 3. Unit systemd ──────────────────────────────────────────────────────────
[ -f "$UNIT_SRC" ] || { echo -e "${RED}[unit] introuvable : $UNIT_SRC${NC}"; exit 1; }
cp -f "$UNIT_SRC" "$UNIT_DST"
echo -e "  ${GREEN}[unit] $UNIT_DST installé${NC}"

systemctl daemon-reload
systemctl enable osmo-egprs-web >/dev/null 2>&1 || true
systemctl restart osmo-egprs-web
sleep 2

if [ "$(systemctl is-active osmo-egprs-web)" = "active" ]; then
    echo -e "  ${GREEN}[ok] osmo-egprs-web active (enabled) — http://<ip>:8080${NC}"
else
    echo -e "  ${RED}[ko] service non actif — journalctl -u osmo-egprs-web${NC}"
    systemctl --no-pager status osmo-egprs-web | head -12 || true
    exit 1
fi
