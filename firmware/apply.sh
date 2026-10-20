#!/usr/bin/env bash
# Arma el árbol del firmware: clona apollo-firmware en el commit probado (2.7.1)
# y copia encima el overlay de Jarvis (placa Waveshare 4.3C, tablero LVGL,
# Einstein, "Hey Jarvis", guardianes, etc.).
#
#   firmware/apply.sh [destino]        (default: JARVIS_FIRMWARE_TREE de jarvis.env,
#                                       o ~/esp/jarvis-apollo-firmware)
#
# Regla: los cambios se hacen en firmware/overlay/ y se vuelve a correr esto.
# Editar el árbol de destino a mano se pierde en la próxima corrida.
#
# En Windows el destino no puede tener espacios (ESP-IDF no lo soporta).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$HERE/../jarvis.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HERE/../jarvis.env"
  set +a
fi
DEST="${1:-${JARVIS_FIRMWARE_TREE:-$HOME/esp/jarvis-apollo-firmware}}"
case "$DEST" in
  *" "*) echo "✗ El destino tiene espacios y ESP-IDF no los soporta: $DEST" >&2; exit 1 ;;
esac
UPSTREAM_URL="https://github.com/galfrevn/apollo-firmware"
UPSTREAM_COMMIT="503d506a9c85147961372d0cf0fb358ba725633b"   # v2.7.1, 2026-08-13

if [ ! -d "$DEST/.git" ]; then
  git clone "$UPSTREAM_URL" "$DEST"
fi
git -C "$DEST" checkout -q "$UPSTREAM_COMMIT"
git -C "$DEST" reset -q --hard "$UPSTREAM_COMMIT"
# build/, managed_components/ y sdkconfig quedan (están en el .gitignore de upstream).
git -C "$DEST" clean -qfd
cp -R "$HERE/overlay/." "$DEST/"

# Parche puntual sobre un archivo de upstream que el overlay no copia entero:
# la tarea de LVGL arranca con 7 KB de pila (default de esp_lvgl_port) y el
# detalle de un evento del tablero (fondo + tarjeta + encabezado + ícono, con
# texto encima) la desbordaba al dibujarse: "Stack protection fault" en
# lv_draw_rect / draw_letter (2026-10-19). 16 KB sobran en las dos placas.
# Si upstream cambia esa línea, apply.sh frena en vez de compilar sin el parche.
LVGL_PORT_FILE="$DEST/main/display/lcd_display.cc"
LVGL_PORT_LINE='lvgl_port_cfg_t port_cfg = ESP_LVGL_PORT_INIT_CONFIG();'
if [ "$(grep -cF "$LVGL_PORT_LINE" "$LVGL_PORT_FILE")" != 3 ]; then
  echo "✗ No encuentro las 3 inicializaciones de LVGL en $LVGL_PORT_FILE: revisá el parche de la pila de LVGL en firmware/apply.sh" >&2
  exit 1
fi
# Sin sed -i: la sintaxis cambia entre macOS (BSD) y Git Bash (GNU).
sed "s/$LVGL_PORT_LINE/$LVGL_PORT_LINE port_cfg.task_stack = 16 * 1024;/" "$LVGL_PORT_FILE" \
  > "$LVGL_PORT_FILE.tmp" && mv "$LVGL_PORT_FILE.tmp" "$LVGL_PORT_FILE"
echo "✓ apollo-firmware $UPSTREAM_COMMIT + overlay de Jarvis en $DEST"
echo "  Siguiente paso: firmware/build.sh \"$DEST\""
