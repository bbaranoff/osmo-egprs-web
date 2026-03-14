#!/bin/bash
# Lance tshark sur l'hôte et envoie les lignes au conteneur web via UDP
# Usage: ./tshark-host.sh [host] [port]
# Par défaut : localhost 4730

set -euo pipefail

HOST="${1:-localhost}"
PORT="${2:-4730}"

echo "Envoi des paquets tshark vers $HOST:$PORT"
echo "Assurez-vous que le conteneur web tourne et que le port $PORT est accessible."

# Vérifier que tshark est installé
if ! command -v tshark >/dev/null 2>&1; then
  echo "Erreur : tshark n'est pas installé sur l'hôte."
  exit 1
fi

# Lancer tshark et envoyer chaque ligne en UDP
tshark -i any -f "udp port 4729" -l -n | while read line; do
  echo "$line" | nc -u -w0 "$HOST" "$PORT"
done
