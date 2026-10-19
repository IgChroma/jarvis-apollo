#!/usr/bin/env bash
# Compila (y opcionalmente flashea) el firmware con la URL del servidor y el
# secreto de la placa. El secreto sale del Llavero (macOS) o del Administrador
# de credenciales (Windows) a un archivo temporal 600 que se borra al terminar;
# NUNCA se escribe en sdkconfig.defaults.
#
#   firmware/build.sh [árbol]                  compila (default: JARVIS_FIRMWARE_TREE)
#   firmware/build.sh [árbol] flash [puerto]   compila y flashea
#
# Puerto: el tercer argumento o JARVIS_FLASH_PORT. En macOS el default es
# /dev/cu.usbmodem101; en Windows, sin puerto, idf.py busca la placa solo.
#
# En Windows corre desde Git Bash y llama a ESP-IDF por PowerShell (ESP-IDF no
# soporta Git Bash): JARVIS_IDF_ENV apunta al .ps1 que prepara el entorno (el
# export.ps1 de ESP-IDF o un script propio que lo llame).
#
# Ojo: el binario y el sdkconfig/build/ del árbol SÍ llevan el secreto adentro
# (la placa lo necesita). No compartas un .bin ni ese árbol.
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib.sh"
require_secret_store

TREE="${1:-${JARVIS_FIRMWARE_TREE:-$HOME/esp/jarvis-apollo-firmware}}"
ACTION="${2:-build}"
if [ "$JARVIS_OS" = macos ]; then
  PORT="${3:-${JARVIS_FLASH_PORT:-/dev/cu.usbmodem101}}"
else
  PORT="${3:-${JARVIS_FLASH_PORT:-}}"
fi
TARGET="${JARVIS_FIRMWARE_TARGET:-esp32s3}"
[ -f "$TREE/main/application.cc" ] || die "No encuentro el firmware en $TREE (corré firmware/apply.sh primero)."
[ -n "${JARVIS_APOLLO_URL:-}" ] || die "Definí JARVIS_APOLLO_URL=ws://IP-DEL-SERVIDOR:8799 en jarvis.env (sin path)."
TOKEN="$(kc_get DEVICE_SHARED_SECRET)" || die "Falta DEVICE_SHARED_SECRET: scripts/secrets.sh generate DEVICE_SHARED_SECRET"

SECRETS_DIR="$(mktemp -d)"
trap 'rm -rf "$SECRETS_DIR"' EXIT
(
  umask 077
  printf 'CONFIG_APOLLO_URL="%s"\nCONFIG_APOLLO_TOKEN="%s"\nCONFIG_APOLLO_DEVICE_ID="%s"\n' \
    "$JARVIS_APOLLO_URL" "$TOKEN" "${JARVIS_DEVICE_NAME:-jarvis}" > "$SECRETS_DIR/sdkconfig.secrets"
  # ESP32-P4: un binario para revisión < 3 no arranca en una 3.x ni al revés.
  # ESP-IDF 5.5.2 compila para < 3 salvo que se lo pidan.
  if [ "$TARGET" = esp32p4 ] && [ "${JARVIS_P4_CHIP_REV:-}" = 3 ]; then
    echo 'CONFIG_ESP32P4_SELECTS_REV_LESS_V3=n' >> "$SECRETS_DIR/sdkconfig.secrets"
  fi
)
unset TOKEN

if [ "$JARVIS_OS" = windows ]; then
  IDF_ENV="${JARVIS_IDF_ENV:-${IDF_PATH:+$IDF_PATH/export.ps1}}"
  [ -n "$IDF_ENV" ] || die "Definí JARVIS_IDF_ENV en jarvis.env: el .ps1 que prepara ESP-IDF 5.5.2 (p. ej. su export.ps1)."
  [ -f "$(cygpath -u "$IDF_ENV")" ] || die "No existe JARVIS_IDF_ENV=$IDF_ENV"
  DEFAULTS="sdkconfig.defaults;$(cygpath -m "$SECRETS_DIR/sdkconfig.secrets")"
else
  DEFAULTS="sdkconfig.defaults;$SECRETS_DIR/sdkconfig.secrets"
  # ESP-IDF en macOS necesita cmake y ninja de Homebrew (brew install cmake ninja).
  if ! command -v cmake >/dev/null 2>&1 && [ -x /opt/homebrew/bin/cmake ]; then
    PATH="/opt/homebrew/bin:$PATH"
  fi
  command -v cmake >/dev/null 2>&1 || die "Falta cmake: brew install cmake ninja"
  # export.sh elige el entorno de Python según el `python3` del PATH; si ese no es
  # con el que se instaló ESP-IDF (pasa en macOS: /usr/bin/python3 vs Homebrew),
  # falla. Con un solo entorno instalado, se usa ese.
  if [ -z "${IDF_PYTHON_ENV_PATH:-}" ]; then
    environment_list=("$HOME"/.espressif/python_env/idf*_env)
    if [ "${#environment_list[@]}" -eq 1 ] && [ -d "${environment_list[0]}" ]; then
      export IDF_PYTHON_ENV_PATH="${environment_list[0]}"
    fi
  fi
  # shellcheck disable=SC1091
  . "${IDF_PATH:-$HOME/esp/esp-idf}/export.sh" >/dev/null
fi

# idf.py con los argumentos dados, dentro del árbol. En Windows, por PowerShell
# con el entorno de JARVIS_IDF_ENV; los argumentos viajan en variables de
# entorno (uno por línea) para que una ruta con espacios no rompa nada.
run_idf() {
  if [ "$JARVIS_OS" != windows ]; then
    (cd "$TREE" && idf.py "$@")
    return
  fi
  JARVIS_PS_IDF_ENV="$(cygpath -w "$IDF_ENV")" \
  JARVIS_PS_TREE="$(cygpath -w "$TREE")" \
  JARVIS_PS_ARGS="$(printf '%s\n' "$@")" \
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command '
    $ErrorActionPreference = "Stop"
    # ESP-IDF se niega a correr si ve MSYSTEM ("MSys/Mingw is not supported"),
    # y PowerShell lo hereda de Git Bash.
    Remove-Item Env:MSYSTEM -ErrorAction SilentlyContinue
    . $env:JARVIS_PS_IDF_ENV | Out-Null
    Set-Location $env:JARVIS_PS_TREE
    $arguments = $env:JARVIS_PS_ARGS -split "`n" | Where-Object { $_ -ne "" }
    idf.py @arguments
    exit $LASTEXITCODE'
}

# Los defaults solo se aplican a lo que el sdkconfig no tenga: sin borrarlo, un
# cambio de URL o de secreto no entraría nunca. Se borra y se regenera en cada build
# (el orden es sdkconfig.defaults, sdkconfig.defaults.<target> y el de secretos).
rm -f "$TREE/sdkconfig"
run_idf -D "IDF_TARGET=$TARGET" -D "SDKCONFIG_DEFAULTS=$DEFAULTS" build || die "Falló el build."

# Control antes de flashear: si el tablero no quedó en el binario, el linker lo
# descartó en silencio (pasó: pantalla blanca sin errores de compilación).
# grep -a y no strings, que Git Bash no trae; -c y no -q, que con pipefail
# podía cortar antes de tiempo.
if [ "$(grep -a -c "tablero armado" "$TREE/build/xiaozhi.elf" || true)" = 0 ]; then
  die "El binario no tiene el tablero LVGL (revisá la placa en sdkconfig.defaults)."
fi

if [ "$ACTION" = flash ]; then
  # 460800 y no 921600: a 921600 el flasheo se corta. Y nada más puede tener el
  # puerto abierto (un monitor serie corta el flasheo a mitad).
  if [ "$JARVIS_OS" = macos ] && lsof "$PORT" >/dev/null 2>&1; then
    die "Hay otro proceso usando $PORT (¿un monitor serie?)."
  fi
  if [ -n "$PORT" ]; then
    run_idf -p "$PORT" -b 460800 flash || die "Falló el flasheo (¿un monitor serie abierto en $PORT?)."
  else
    run_idf -b 460800 flash || die "Falló el flasheo (¿la placa está conectada por USB?)."
  fi
fi
echo "✓ Firmware listo: $TREE/build/xiaozhi.bin"
