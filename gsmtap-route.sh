#!/bin/bash
# Route GSMTAP and SCTP from operator containers to the web dashboard
set -euo pipefail

PREFIX="${CONTAINER_PREFIX:-osmo-operator-}"
WEB="osmo-egprs-web"

WEB_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$WEB" 2>/dev/null)
[ -z "$WEB_IP" ] && echo "ERROR: $WEB not running. Run ./start-web.sh first." && exit 1

echo "Web proxy IP: $WEB_IP"
echo ""

# Ports à rediriger
GSMTAP_PORT=4729
SCTP_PORTS="2905 29168"  # Ports SCTP courants pour Osmocom

for C in $(docker ps --filter "name=${PREFIX}" --format "{{.Names}}"); do
  echo "=== $C ==="
  
  # Vérifier si le conteneur a les outils nécessaires
  HAS_IPTABLES=$(docker exec "$C" sh -c "which iptables 2>/dev/null || echo ''")
  HAS_SOCAT=$(docker exec "$C" sh -c "which socat 2>/dev/null || echo ''")
  
  # REDIRECTION GSMTAP (UDP)
  echo -n "  GSMTAP (UDP $GSMTAP_PORT): "
  if docker exec "$C" sh -c "which iptables >/dev/null 2>&1"; then
    docker exec "$C" sh -c "
      iptables -t nat -D OUTPUT -p udp --dport $GSMTAP_PORT -j DNAT --to-destination ${WEB_IP}:${GSMTAP_PORT} 2>/dev/null || true
      iptables -t nat -A OUTPUT -p udp --dport $GSMTAP_PORT -j DNAT --to-destination ${WEB_IP}:${GSMTAP_PORT}
    " 2>/dev/null && echo "✓ iptables → $WEB_IP:$GSMTAP_PORT" || echo "✗ (besoin de NET_ADMIN)"
  else
    echo "✗ (iptables non disponible)"
  fi

  # REDIRECTION SCTP - VERSION CORRIGÉE
  for SCTP_PORT in $SCTP_PORTS; do
    echo -n "  SCTP (port $SCTP_PORT): "
    
    # Option 1: Utiliser iptables si disponible
    if docker exec "$C" sh -c "which iptables >/dev/null 2>&1"; then
      # Vérifier si le module sctp est chargé
      SCTP_AVAILABLE=$(docker exec "$C" sh -c "cat /proc/net/protocols 2>/dev/null | grep -i sctp || echo ''")
      
      if [ -n "$SCTP_AVAILABLE" ]; then
        docker exec "$C" sh -c "
          iptables -t nat -D OUTPUT -p sctp --dport $SCTP_PORT -j DNAT --to-destination ${WEB_IP}:${SCTP_PORT} 2>/dev/null || true
          iptables -t nat -A OUTPUT -p sctp --dport $SCTP_PORT -j DNAT --to-destination ${WEB_IP}:${SCTP_PORT}
        " 2>/dev/null && echo "✓ iptables sctp → $WEB_IP:$SCTP_PORT" && continue
      fi
    fi
    
    # Option 2: Utiliser socat (plus portable)
    if docker exec "$C" sh -c "which socat >/dev/null 2>&1"; then
      # Tuer les anciennes sessions socat pour ce port
      docker exec "$C" sh -c "pkill -f 'sctp.*:$SCTP_PORT' 2>/dev/null || true"
      
      # Lancer socat en arrière-plan
      docker exec -d "$C" socat \
        SCTP-LISTEN:$SCTP_PORT,fork,reuseaddr \
        SCTP-CONNECT:$WEB_IP:$SCTP_PORT
      
      echo "✓ socat sctp → $WEB_IP:$SCTP_PORT"
      continue
    fi
    
    # Option 3: Utiliser nc (netcat) si disponible avec support sctp
    if docker exec "$C" sh -c "which nc >/dev/null 2>&1"; then
      echo "⚠ nc ne supporte pas SCTP (utilisez socat ou iptables)"
    else
      echo "✗ (pas de support SCTP trouvé)"
    fi
  done

  echo ""
done

# Vérifier que le conteneur web est prêt à recevoir du SCTP
echo "=== Vérification du dashboard $WEB ==="
docker exec "$WEB" sh -c "
  echo '  Paquets réseau disponibles:'
  if command -v ss >/dev/null 2>&1; then
    echo '  Ports UDP en écoute:'
    ss -lun 2>/dev/null | grep :$GSMTAP_PORT || echo '  ⚠ Port $GSMTAP_PORT non en écoute'
  fi
  
  # Vérifier si tshark tourne
  if pgrep -f tshark >/dev/null 2>&1; then
    echo '  ✓ tshark en cours d'exécution'
  else
    echo '  ⚠ tshark ne tourne pas (démarrez la capture depuis l'interface web)'
  fi
" 2>/dev/null || echo "  Impossible de vérifier l'état du dashboard"

echo ""
echo "✅ Routage terminé"
echo "📡 Dashboard: http://$(curl -s ifconfig.me 2>/dev/null || echo 'localhost'):80"
echo "📊 Ports redirigés: UDP/$GSMTAP_PORT, SCTP/2905, SCTP/29168"
echo ""
echo "💡 Pour tester la connectivité SCTP:"
echo "   docker exec -it osmo-operator-18 bash"
echo "   # Installer lksctp-tools: apt-get update && apt-get install -y lksctp-tools"
echo "   # Tester: sctp_test -H 127.0.0.1 -P $SCTP_PORT -l"
