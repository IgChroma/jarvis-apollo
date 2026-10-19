#!/usr/bin/env bash
# Arranque del add-on: opciones de la UI → variables de Apollo, importación
# opcional de una base vieja, y bun como proceso principal.
set -euo pipefail

OPTIONS_FILE=/data/options.json
DATA_DIR="${APOLLO_DATA_DIRECTORY:-/data/apollo}"
SHARE_DIR=/share/jarvis-apollo
LOG_MAX_BYTES=$((20 * 1024 * 1024))

log() { echo "[jarvis-addon] $*" >&2; }

# Los valores nunca pasan por el log: options-env.mjs imprime `export ...` por
# stdout (capturado acá) y solo nombres por stderr.
env_script="$(bun /opt/jarvis-addon/options-env.mjs "$OPTIONS_FILE")" || {
  log "Configuración incompleta: el add-on no arranca."
  exit 1
}
eval "$env_script"
unset env_script

export APOLLO_DATA_DIRECTORY="$DATA_DIR"
export APOLLO_HOST_PORT=8799
# SUPERVISOR_TOKEN (homeassistant_api: true) ya viene en el entorno del
# contenedor y `exec bun` lo hereda: Apollo lo usa para leer Home Assistant en
# http://supervisor/core/api. No se toca ni se loguea.
if [ -z "${SUPERVISOR_TOKEN:-}" ]; then
  log "Sin SUPERVISOR_TOKEN: el tablero sale sin las tarjetas de Home Assistant."
fi
mkdir -p "$DATA_DIR"
device_name="${APOLLO_DEVICE_NAME:-desk}"

# Importación única de una instalación anterior (el volumen de Docker de la Pi
# con Raspberry Pi OS): dejá <dispositivo>.sqlite (y blobs/ si querés la caché de
# voz y el firmware OTA) en /share/jarvis-apollo/import/. Solo se copia si el
# add-on todavía no tiene base; después la carpeta se renombra a import.usado-<fecha>.
import_dir="$SHARE_DIR/import"
if [ -f "$import_dir/$device_name.sqlite" ] && [ ! -f "$DATA_DIR/$device_name.sqlite" ]; then
  log "Importando $import_dir/$device_name.sqlite a $DATA_DIR"
  for suffix in "" -wal -shm; do
    if [ -f "$import_dir/$device_name.sqlite$suffix" ]; then
      cp -p "$import_dir/$device_name.sqlite$suffix" "$DATA_DIR/"
    fi
  done
  if [ -d "$import_dir/blobs" ]; then
    mkdir -p "$DATA_DIR/blobs"
    cp -a "$import_dir/blobs/." "$DATA_DIR/blobs/"
  fi
  mv "$import_dir" "$import_dir.usado-$(date +%Y%m%d-%H%M%S)"
elif [ -f "$import_dir/$device_name.sqlite" ]; then
  log "Hay una base en $import_dir pero $DATA_DIR ya tiene una: no se importa nada."
fi

# Una voz de Piper que no vino en la imagen se baja una sola vez de Hugging Face
# (rhasspy/piper-voices) a /data/piper-voices. Si no se puede, se usa la de la imagen.
if [ -n "${JARVIS_PIPER_VOICE_DOWNLOAD:-}" ]; then
  voice_file="$JARVIS_PIPER_VOICE_DOWNLOAD"
  voice_base="${voice_file%.onnx}"
  language_region="${voice_base%%-*}"
  voice_rest="${voice_base#*-}"
  voice_quality="${voice_rest##*-}"
  voice_speaker="${voice_rest%-*}"
  voice_url="https://huggingface.co/rhasspy/piper-voices/resolve/main/${language_region%%_*}/${language_region}/${voice_speaker}/${voice_quality}/${voice_file}"
  mkdir -p /data/piper-voices
  log "Bajando la voz de Piper $voice_file (una sola vez)..."
  if VOICE_URL="$voice_url" VOICE_TARGET="/data/piper-voices/$voice_file" bun -e '
      const url = process.env.VOICE_URL;
      const target = process.env.VOICE_TARGET;
      for (const suffix of ["", ".json"]) {
        const response = await fetch(url + suffix);
        if (!response.ok) throw new Error(`${response.status} ${url + suffix}`);
        await Bun.write(target + suffix + ".tmp", response);
      }'; then
    mv -f "/data/piper-voices/$voice_file.tmp" "/data/piper-voices/$voice_file"
    mv -f "/data/piper-voices/$voice_file.json.tmp" "/data/piper-voices/$voice_file.json"
    log "Voz $voice_file lista."
  else
    rm -f /data/piper-voices/*.tmp
    log "No se pudo bajar $voice_file: uso la voz de la imagen (es_MX-ald-medium)."
    export PIPER_VOICE_MODEL=/opt/piper/voices/es_MX-ald-medium.onnx
  fi
fi
unset JARVIS_PIPER_VOICE_DOWNLOAD

# Piper es la red de seguridad de Azure: si no está, avisar (sin voz no hay asistente).
if [ "${TTS_PROVIDER:-elevenlabs}" != elevenlabs ] && [ -n "${PIPER_BINARY:-}" ] && [ ! -x "$PIPER_BINARY" ]; then
  if [ "${TTS_PROVIDER}" = piper ] || [ -z "${AZURE_SPEECH_KEY:-}" ]; then
    log "ATENCIÓN: no encuentro Piper en $PIPER_BINARY y no hay otra voz configurada: Jarvis va a quedar mudo."
  else
    log "Piper no está en $PIPER_BINARY: si Azure falla no hay voz de respaldo (opcional)."
  fi
fi

cd /app
log "Apollo arranca en el puerto $APOLLO_HOST_PORT, datos en $DATA_DIR"

# Los logs además van a /share: actualizar o reconstruir el add-on borra los de
# la UI, y ya pasó perder justo la evidencia del turno que se estaba mirando.
# `exec` deja a bun como proceso principal (el SIGTERM le llega a él);
# tee cuelga de una sustitución de proceso. El log rota (un .1) al arrancar si
# pasa de 20 MB.
if [ "${JARVIS_ADDON_LOG_TO_FILE:-on}" = on ] && [ -d /share ]; then
  mkdir -p "$SHARE_DIR/logs"
  log_file="$SHARE_DIR/logs/apollo.log"
  if [ -f "$log_file" ] && [ "$(stat -c %s "$log_file")" -gt "$LOG_MAX_BYTES" ]; then
    mv -f "$log_file" "$log_file.1"
  fi
  unset JARVIS_ADDON_LOG_TO_FILE
  exec bun src/host/main.ts > >(tee -a "$log_file") 2>&1
fi
unset JARVIS_ADDON_LOG_TO_FILE
exec bun src/host/main.ts
