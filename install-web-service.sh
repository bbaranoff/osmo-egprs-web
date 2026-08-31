#!/bin/bash
# install-web-service.sh — installe le dashboard osmo-egprs-web comme service
# systemd DANS le container (osmo-operator-*), sans rebuild d'image.
#
# Idempotent. À lancer en root dans le container :
#   bash /opt/GSM/osmo-egprs-web/install-web-service.sh
#
# Le START reste géré par start-direct.sh (`systemctl restart osmo-egprs-web`) ;
# ce script ne fait qu'INSTALLER (runtime node + unit + enable) et démarre une
# fois pour vérifier.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${APP_DIR:-/opt/GSM/osmo-egprs-web}"
NODE_VERSION="${NODE_VERSION:-v20.20.2}"
UNIT_SRC="${HERE}/osmo-egprs-web.service"
UNIT_DST="/etc/systemd/system/osmo-egprs-web.service"

# ── DEUX INTERRUPTEURS, POUR LES CONTEXTES SANS SYSTEMD NI IDENTITE ─────────
# WEB_NO_TLS=1   ne genere PAS le certificat. Pour build-iso.sh, qui tourne dans
#                un chroot : une cle privee fabriquee la serait IDENTIQUE dans
#                toutes les ISO tirees de cette image, donc sans valeur - c'est
#                le raisonnement de la section 3 ci-dessous, applique au build.
#                La cle est posee plus tard, sur la machine, par osmo-web-tls
#                au premier demarrage : elle porte alors son vrai nom et ses
#                vraies adresses.
# WEB_NO_START=1 installe et `enable`, mais ne demarre pas et ne verifie pas
#                que le service tourne. Dans un chroot (build ou installeur),
#                systemd ne tourne pas : `systemctl restart` echoue toujours, et
#                avec `set -e` il ferait echouer la construction ou
#                l'installation entiere sur un service qui n'avait aucune raison
#                de demarrer la.
WEB_NO_TLS="${WEB_NO_TLS:-0}"
WEB_NO_START="${WEB_NO_START:-0}"

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

if [ "$WEB_NO_TLS" = "1" ]; then
    echo -e "  ${YELLOW}[tls] ignore (WEB_NO_TLS=1) — la cle sera posee sur la machine${NC}"
elif [ -f "$TLS_CERT" ] && openssl x509 -in "$TLS_CERT" -noout -checkend 2592000 >/dev/null 2>&1; then
    echo -e "  ${GREEN}[tls] certificat present et valable > 30 j${NC}"
else
    if ! command -v openssl >/dev/null 2>&1; then
        echo -e "  ${RED}[tls] openssl absent — HTTPS restera desarme${NC}"
    else
        # CA:TRUE, ET CE N'EST PAS UNE COQUILLE. Ce certificat est auto-signe :
        # pour que Firefox le tienne pour valable, on ne lui demande pas de
        # « faire une exception » (un clic, a refaire a chaque profil et a
        # chaque reinstallation), on l'INSTALLE comme ancre de confiance via la
        # politique d'entreprise, § 3 bis. Or NSS n'accepte comme ancre qu'un
        # certificat porteur de basicConstraints CA:TRUE - avec CA:FALSE,
        # l'import est accepte en silence et le navigateur avertit quand meme.
        # Il reste auto-signe, limite a serverAuth, valable pour ce SAN et ce
        # seul hote : il ne signe rien d'autre que lui-meme.
        #
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
            -addext "basicConstraints=critical,CA:TRUE" \
            -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
            -addext "extendedKeyUsage=serverAuth" >/dev/null 2>&1
        chmod 600 "$TLS_KEY"; chmod 644 "$TLS_CERT"
        echo -e "  ${GREEN}[tls] $TLS_CERT (825 j, auto-signe)${NC}"
    fi
fi

# ── 3 bis. Firefox : la confiance et le micro, poses UNE fois ────────────────
# Le bouton micro du dashboard tient a trois choses. Deux sont ailleurs (un
# PulseAudio joignable : osmo-pulse.service ; un contexte securise : le § 3
# ci-dessus). La troisieme est ici, et c'est celle qui ne se voit pas.
#
# CE QUI SE PASSE SANS CE BLOC. On ouvre https://<ip>:80, Firefox affiche son
# interstitiel « connexion non securisee » - le certificat est auto-signe. On
# accepte l'exception. La page s'affiche. On clique sur le micro : Firefox
# demande la permission. Si l'operateur repond « non » une fois, ou ferme la
# demande, LE REFUS EST MEMORISE : le bouton reste mort, sans message, et
# aucune trace cote serveur. C'est exactement le symptome « Firefox refuse
# l'acces au micro » - et il survit au rechargement, au redemarrage du service,
# et a la relecture du code.
#
# POURQUOI PAS DANS L'IMAGE. La politique nomme les ORIGINES exactes
# (https://<ip>:80) et le certificat de CETTE machine. Ni l'un ni l'autre
# n'existe au build. On les ecrit ici, avec la meme liste d'adresses qui vient
# de servir au SAN : une seule source, donc pas de derive entre le certificat
# et la politique qui doit lui faire confiance.
#
# POURQUOI /etc/firefox. Firefox est un SNAP sur jammy. De toute sa
# configuration d'entreprise, /etc/firefox est le seul chemin qu'il puisse lire
# hors de son bac a sable - le plug `etc-firefox` (system-files, « read:
# /etc/firefox ») est connecte par osmo-firefox-snap.service, et le profil
# AppArmor du snap ne porte que "/etc/firefox{,/,/**} rk". Une politique posee
# dans /usr/lib/firefox/distribution serait invisible.
FF_POL_DIR="/etc/firefox/policies"
FF_POL="${FF_POL_DIR}/policies.json"
FF_CERT="${FF_POL_DIR}/osmo-web-cert.pem"

if [ ! -f "$TLS_CERT" ]; then
    echo -e "  ${YELLOW}[firefox] pas de certificat — politique non ecrite${NC}"
else
    mkdir -p "$FF_POL_DIR"
    # Le snap ne lit QUE /etc/firefox : le certificat doit y etre recopie, un
    # lien vers /etc/osmo-web-tls sortirait du chemin autorise par AppArmor
    # (qui resout le lien, il ne le suit pas aveuglement).
    cp -f "$TLS_CERT" "$FF_CERT"; chmod 644 "$FF_CERT"

    # Les origines : celles auxquelles on ouvre reellement le dashboard. Le port
    # FAIT PARTIE de l'origine - « https://10.0.0.5 » et « https://10.0.0.5:80 »
    # sont deux origines distinctes pour Firefox, et le TLS ecoute ici sur 80
    # (cf. HTTPS_PORT dans l'unit). On liste donc explicitement le :80.
    origins='"https://localhost:80","https://127.0.0.1:80","http://localhost:8080"'
    for ip in $(hostname -I 2>/dev/null || true); do
        case "$ip" in *:*) continue ;; esac
        origins="${origins},\"https://${ip}:80\""
    done

    cat > "$FF_POL" <<FFPOL
{
  "policies": {
    "Certificates": {
      "ImportEnterpriseRoots": true,
      "Install": ["${FF_CERT}"]
    },
    "Permissions": {
      "Microphone": {
        "Allow": [${origins}],
        "BlockNewRequests": false,
        "Locked": false
      },
      "Camera": {
        "Allow": [${origins}],
        "BlockNewRequests": false,
        "Locked": false
      }
    },
    "DisableTelemetry": true,
    "DisableFirefoxAccounts": true,
    "OverrideFirstRunPage": "",
    "OverridePostUpdatePage": ""
  }
}
FFPOL
    chmod 644 "$FF_POL"
    echo -e "  ${GREEN}[firefox] politique posee : certificat approuve + micro autorise${NC}"
    echo -e "  ${GREEN}[firefox]   origines : $(echo "$origins" | tr -d '\"')${NC}"
fi

# ── 4. Unit systemd ──────────────────────────────────────────────────────────
[ -f "$UNIT_SRC" ] || { echo -e "${RED}[unit] introuvable : $UNIT_SRC${NC}"; exit 1; }
cp -f "$UNIT_SRC" "$UNIT_DST"
echo -e "  ${GREEN}[unit] $UNIT_DST installé${NC}"

systemctl daemon-reload 2>/dev/null || true
systemctl enable osmo-egprs-web >/dev/null 2>&1 || true

if [ "$WEB_NO_START" = "1" ]; then
    echo -e "  ${GREEN}[ok] osmo-egprs-web installe et active au boot (pas demarre ici)${NC}"
    exit 0
fi

systemctl restart osmo-egprs-web

# ── LE CONTROLE FINAL ATTEND, ET IL NE FAIT PAS ECHOUER L'UNITE ──────────────
# [2026-08-31] C'etait « sleep 2 » puis un exit 1. Deux defauts, et les deux se
# sont vus au premier demarrage du systeme installe :
#
#   1. DEUX SECONDES NE SUFFISENT PAS quand le service qu'on vient de
#      redemarrer etait en Restart=on-failure : systemd tient son RestartSec=3
#      avant de le relancer, et `is-active` rend « activating » - pas
#      « active ». On lisait donc un echec sur un service qui allait tres bien
#      trois secondes plus tard. On boucle, au lieu de deviner un delai.
#   2. exit 1 FAIT ECHOUER osmo-egprs-web-install.service, qui est un oneshot.
#      L'unite passe en `failed`, et tout ce qu'elle avait pose - certificat,
#      politique Firefox - se retrouve etiquete « echec » alors que c'est fait.
#      Le dashboard n'a pas besoin de nous pour se relever : systemd s'en
#      charge. On journalise, on ne condamne pas.
for _i in $(seq 1 15); do
    [ "$(systemctl is-active osmo-egprs-web)" = "active" ] && break
    sleep 1
done

if [ "$(systemctl is-active osmo-egprs-web)" = "active" ]; then
    echo -e "  ${GREEN}[ok] osmo-egprs-web active (enabled) — https://$(hostname -I | awk '{print $1}'):80  (TLS sur le 80 ; clair sur :8080)${NC}"
else
    echo -e "  ${YELLOW}[!] service pas encore actif — systemd le relance (Restart=on-failure)${NC}"
    echo -e "  ${YELLOW}    diagnostic : journalctl -u osmo-egprs-web -b${NC}"
    systemctl --no-pager status osmo-egprs-web | head -12 || true
fi
