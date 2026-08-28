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

# ── 3. Certificat TLS auto-signe ─────────────────────────────────────────────
# server.js:1161-1183 n'arme le listener HTTPS QUE si ces deux fichiers existent.
# Sans eux il journalise « HTTPS non arme : certificat absent » et sert en clair
# -- et le bouton micro reste refuse par le navigateur, car getUserMedia n'existe
# que dans un contexte securise (https:// ou http://localhost).
#
# POURQUOI ICI ET PAS DANS LE Dockerfile : une cle privee generee au build serait
# identique pour quiconque tire l'image. On la genere donc a l'installation, une
# fois, dans le container. Corollaire assume : elle ne survit pas a un
# `docker rm` -- relancer ce script apres recreation du container.
#
# Idempotent : si le certificat est encore valable plus de 30 jours, on n'y
# touche pas (regenerer ferait re-avertir le navigateur pour rien).
# Le certificat vit DANS l'application, pas dans /etc : il appartient a ce
# dashboard et a lui seul, et il se deplace, se sauvegarde et se supprime avec
# lui. `tls/` est dans le .gitignore -- une cle privee publiee laisserait
# n'importe qui se faire passer pour la console.
TLS_DIR="/etc/osmo-web-tls"
TLS_CERT="${TLS_DIR}/cert.pem"
TLS_KEY="${TLS_DIR}/key.pem"

if [ -f "$TLS_CERT" ] && openssl x509 -in "$TLS_CERT" -noout -checkend 2592000 >/dev/null 2>&1; then
    echo -e "  ${GREEN}[tls] certificat present et valable > 30 j${NC}"
else
    if ! command -v openssl >/dev/null 2>&1; then
        echo -e "  ${RED}[tls] openssl absent — HTTPS restera desarme${NC}"
    else
        # SAN : sans « subjectAltName », les navigateurs modernes refusent le
        # certificat meme apres acceptation de l'exception (le CN seul n'est
        # plus regarde depuis Chrome 58). On y met localhost, la boucle locale
        # et TOUTES les adresses IPv4 du container, decouvertes a l'execution.
        # ⚠️ Si docker reattribue une autre IP au container, elle ne sera plus
        # dans le SAN : relancer ce script (il regenerera, cf. la garde 30 j
        # qu'il faut alors contourner avec `rm -f $TLS_CERT`).
        san="DNS:localhost,DNS:$(hostname),IP:127.0.0.1"
        for ip in $(hostname -I 2>/dev/null || true); do
            case "$ip" in *:*) continue ;; esac      # IPv6 : pas de SAN IP ici
            san="${san},IP:${ip}"
        done
        echo -e "  ${YELLOW}[tls] generation d'un certificat auto-signe (SAN: ${san})${NC}"
        mkdir -p "$TLS_DIR"; chmod 700 "$TLS_DIR"
        openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
            -keyout "$TLS_KEY" -out "$TLS_CERT" \
            -subj "/CN=osmo-egprs-web" \
            -addext "subjectAltName=${san}" \
            -addext "basicConstraints=critical,CA:FALSE" \
            -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
            -addext "extendedKeyUsage=serverAuth" >/dev/null 2>&1
        chmod 600 "$TLS_KEY"; chmod 644 "$TLS_CERT"
        echo -e "  ${GREEN}[tls] $TLS_CERT (825 j, auto-signe)${NC}"
    fi
fi

# ── 4. Unit systemd ──────────────────────────────────────────────────────────
[ -f "$UNIT_SRC" ] || { echo -e "${RED}[unit] introuvable : $UNIT_SRC${NC}"; exit 1; }
cp -f "$UNIT_SRC" "$UNIT_DST"
echo -e "  ${GREEN}[unit] $UNIT_DST installé${NC}"

systemctl daemon-reload
systemctl enable osmo-egprs-web >/dev/null 2>&1 || true
systemctl restart osmo-egprs-web
sleep 2

if [ "$(systemctl is-active osmo-egprs-web)" = "active" ]; then
    echo -e "  ${GREEN}[ok] osmo-egprs-web active (enabled) — https://$(hostname -I | awk '{print $1}'):80  (TLS sur le 80 ; clair sur :8080)${NC}"
else
    echo -e "  ${RED}[ko] service non actif — journalctl -u osmo-egprs-web${NC}"
    systemctl --no-pager status osmo-egprs-web | head -12 || true
    exit 1
fi
