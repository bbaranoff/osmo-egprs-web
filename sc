#!/bin/bash
# pulse-gsm-setup.sh — Crée un sink PulseAudio virtuel pour mobile (OsmocomBB)
#
# Problème résolu :
#   mobile + io-handler gapk ouvre le device ALSA "default" en exclusif
#   → bloque toute l'audio du desktop (Linphone, navigateur, etc.)
#
# Solution :
#   1. Créer un null-sink PulseAudio dédié "gsm_audio"
#   2. Loopback gsm_audio.monitor → default sink (audio audible)
#   3. ALSA asound.conf route "gsm_out"/"gsm_in" vers ce sink
#   4. mobile.cfg pointe sur gsm_out / gsm_in
#
# Résultat :
#   - mobile décode le GSM-FR sur son propre sink (pas d'exclusion)
#   - Le son est redirigé vers les HP via loopback PulseAudio
#   - Linphone, navigateur, etc. gardent l'accès au default sink
#
# Usage :
#   source /scripts/pulse-gsm-setup.sh   (depuis run.sh)
#   pulse-gsm-setup.sh status            (diagnostic)
#   pulse-gsm-setup.sh teardown          (nettoyage)

set -euo pipefail

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'
RED='\033[0;31m'; NC='\033[0m'

GSM_SINK_NAME="gsm_audio"
GSM_SINK_DESC="GSM-Audio-Mobile"
LOOPBACK_LATENCY_MS=50
ASOUND_CONF="/etc/asound.conf"
STATE_FILE="/var/run/pulse-gsm.state"

# ── Vérifications ─────────────────────────────────────────────────────────────
_check_pulse() {
    if ! command -v pactl >/dev/null 2>&1; then
        echo -e "${RED}[pulse-gsm] pactl introuvable — installer pulseaudio-utils${NC}" >&2
        return 1
    fi
    if ! pactl info >/dev/null 2>&1; then
        echo -e "${RED}[pulse-gsm] PulseAudio inaccessible${NC}" >&2
        echo -e "${YELLOW}  PULSE_SERVER=${PULSE_SERVER:-<non défini>}${NC}" >&2
        return 1
    fi
    return 0
}

_sink_exists() {
    pactl list short sinks 2>/dev/null | grep -q "${GSM_SINK_NAME}" 2>/dev/null
}

# ── Setup ─────────────────────────────────────────────────────────────────────
pulse_gsm_setup() {
    echo -e "${CYAN}[pulse-gsm] Configuration audio isolée pour mobile${NC}"

    if ! _check_pulse; then
        echo -e "${YELLOW}[pulse-gsm] PulseAudio absent — fallback ALSA null${NC}"
        _setup_alsa_null_fallback
        return 1
    fi

    # 1. Null-sink dédié
    if _sink_exists; then
        echo -e "  ${GREEN}✓${NC} Sink ${GSM_SINK_NAME} existe déjà"
    else
        local mod_id
        mod_id=$(pactl load-module module-null-sink \
            sink_name="${GSM_SINK_NAME}" \
            sink_properties=device.description="${GSM_SINK_DESC}" \
            rate=8000 \
            channels=1 \
            2>/dev/null) || true

        if _sink_exists; then
            echo -e "  ${GREEN}✓${NC} Sink ${GSM_SINK_NAME} créé (module ${mod_id:-?})"
            echo "null_sink_module=${mod_id}" > "$STATE_FILE"
        else
            echo -e "  ${RED}✗${NC} Échec création sink"
            _setup_alsa_null_fallback
            return 1
        fi
    fi

    # 2. Loopback → default sink (rend le GSM audible sur les HP)
    local existing_loopback
    existing_loopback=$(pactl list short modules 2>/dev/null \
        | grep "module-loopback" \
        | grep "${GSM_SINK_NAME}" || true)

    if [ -n "$existing_loopback" ]; then
        echo -e "  ${GREEN}✓${NC} Loopback déjà actif"
    else
        local lb_id
        lb_id=$(pactl load-module module-loopback \
            source="${GSM_SINK_NAME}.monitor" \
            latency_msec="${LOOPBACK_LATENCY_MS}" \
            2>/dev/null) || true

        if [ -n "$lb_id" ]; then
            echo -e "  ${GREEN}✓${NC} Loopback → HP (latence ${LOOPBACK_LATENCY_MS}ms, module ${lb_id})"
            echo "loopback_module=${lb_id}" >> "$STATE_FILE"
        else
            echo -e "  ${YELLOW}⚠${NC} Loopback échoué — le son GSM ne sortira pas sur les HP"
            echo -e "  ${YELLOW}  (la signalisation fonctionne, juste pas d'audio baseband)${NC}"
        fi
    fi

    # 3. Config ALSA → PulseAudio sink dédié
    _setup_alsa_pulse_routing

    echo -e "${GREEN}[pulse-gsm] Audio GSM isolée — desktop libre${NC}"
    return 0
}

# ── ALSA routing vers le sink PulseAudio GSM ──────────────────────────────────
_setup_alsa_pulse_routing() {
    cat > "${ASOUND_CONF}" << 'ASOUNDEOF'
# asound.conf — Routage ALSA pour osmo_egprs
# Généré par pulse-gsm-setup.sh
#
# "gsm_out" / "gsm_in" → sink PulseAudio dédié (pas le default)
# "default" → PulseAudio default (desktop, Linphone, etc.)

# ── GSM output (mobile → HP via loopback) ────────────────────────────────────
pcm.gsm_out {
    type pulse
    device gsm_audio
}

# ── GSM input (micro → mobile via loopback monitor) ──────────────────────────
pcm.gsm_in {
    type pulse
    device gsm_audio.monitor
}

# ── Default reste sur PulseAudio normal ──────────────────────────────────────
pcm.!default {
    type pulse
}

ctl.!default {
    type pulse
}
ASOUNDEOF

    echo -e "  ${GREEN}✓${NC} ${ASOUND_CONF} : gsm_out/gsm_in → ${GSM_SINK_NAME}"
}

# ── Fallback si PulseAudio absent ─────────────────────────────────────────────
_setup_alsa_null_fallback() {
    # Envoie l'audio mobile vers /dev/null via plugin ALSA null
    cat > "${ASOUND_CONF}" << 'ASOUNDEOF'
# asound.conf — Fallback sans PulseAudio
# mobile audio → null (pas de son baseband, pas de blocage desktop)

pcm.gsm_out {
    type null
}

pcm.gsm_in {
    type null
}

pcm.!default {
    type hw
    card 0
}

ctl.!default {
    type hw
    card 0
}
ASOUNDEOF

    echo -e "  ${YELLOW}⚠${NC} ${ASOUND_CONF} : gsm_out/gsm_in → null (fallback)"
    # Exporter les noms pour mobile.cfg
    export GSM_ALSA_OUTPUT="gsm_out"
    export GSM_ALSA_INPUT="gsm_in"
}

# ── Teardown ──────────────────────────────────────────────────────────────────
pulse_gsm_teardown() {
    echo -e "${CYAN}[pulse-gsm] Nettoyage...${NC}"

    if [ -f "$STATE_FILE" ]; then
        while IFS='=' read -r key val; do
            [ -z "$val" ] && continue
            pactl unload-module "$val" 2>/dev/null && \
                echo -e "  ${GREEN}✓${NC} Module ${val} déchargé" || true
        done < "$STATE_FILE"
        rm -f "$STATE_FILE"
    fi

    # Fallback : chercher par nom
    if _check_pulse 2>/dev/null; then
        pactl list short modules 2>/dev/null | grep "${GSM_SINK_NAME}" | while read -r mod_id _rest; do
            pactl unload-module "$mod_id" 2>/dev/null || true
        done
    fi

    rm -f "${ASOUND_CONF}"
    echo -e "${GREEN}[pulse-gsm] Nettoyé${NC}"
}

# ── Status ────────────────────────────────────────────────────────────────────
pulse_gsm_status() {
    echo -e "${CYAN}── Audio GSM — État ──${NC}"

    if ! _check_pulse 2>/dev/null; then
        echo -e "  PulseAudio : ${RED}inaccessible${NC}"
    else
        echo -e "  PulseAudio : ${GREEN}OK${NC}"

        if _sink_exists; then
            echo -e "  Sink ${GSM_SINK_NAME} : ${GREEN}actif${NC}"
            pactl list sinks 2>/dev/null | grep -A2 "${GSM_SINK_NAME}" \
                | grep -E "State:|Name:" | sed 's/^/    /'
        else
            echo -e "  Sink ${GSM_SINK_NAME} : ${YELLOW}absent${NC}"
        fi

        local lb_count
        lb_count=$(pactl list short modules 2>/dev/null \
            | grep "module-loopback" | grep -c "${GSM_SINK_NAME}" || echo 0)
        echo -e "  Loopback : ${lb_count} actif(s)"

        echo ""
        echo -e "  ${CYAN}Sinks PulseAudio :${NC}"
        pactl list short sinks 2>/dev/null | sed 's/^/    /'
    fi

    echo ""
    if [ -f "${ASOUND_CONF}" ]; then
        echo -e "  ${ASOUND_CONF} :"
        grep -E "^pcm\.|device " "${ASOUND_CONF}" 2>/dev/null | sed 's/^/    /'
    else
        echo -e "  ${ASOUND_CONF} : ${YELLOW}absent${NC}"
    fi
}

# ── Noms des devices pour mobile.cfg ──────────────────────────────────────────
# Appelé depuis run.sh pour récupérer les bons noms ALSA
pulse_gsm_output_dev() { echo "gsm_out"; }
pulse_gsm_input_dev()  { echo "gsm_in"; }

# ── CLI dispatch ──────────────────────────────────────────────────────────────
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    CMD="${1:-setup}"
    case "$CMD" in
        setup)    pulse_gsm_setup ;;
        teardown) pulse_gsm_teardown ;;
        status)   pulse_gsm_status ;;
        devices)  echo "output=$(pulse_gsm_output_dev) input=$(pulse_gsm_input_dev)" ;;
        *)        echo "Usage: $0 {setup|teardown|status|devices}"; exit 1 ;;
    esac
fi
