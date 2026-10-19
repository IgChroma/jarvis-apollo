# Funciones comunes de los scripts. Se carga con:
#   source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
#
# Regla de la casa: un secreto nunca se escribe en un archivo de tu compu ni
# viaja como argumento de un comando (quedaría en el historial y en `ps`). Sale
# del almacén de secretos a una variable en memoria y de ahí por stdin a donde
# tenga que ir. El almacén es el Llavero en macOS y el Administrador de
# credenciales en Windows (Git Bash); en este repo "Llavero" nombra a los dos.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$REPO_ROOT/secrets.manifest"

# Configuración local, NO secreta (IP de la Pi, URL del servidor). Ver jarvis.env.example.
if [ -f "$REPO_ROOT/jarvis.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/jarvis.env"
  set +a
fi

JARVIS_KEYCHAIN_SERVICE="${JARVIS_KEYCHAIN_SERVICE:-jarvis}"
# Carpetas en la Pi, relativas al home del usuario remoto.
JARVIS_PI_APOLLO_DIR="${JARVIS_PI_APOLLO_DIR:-apollo-server}"
JARVIS_PI_MCP_DIR="${JARVIS_PI_MCP_DIR:-mcp-servers}"
JARVIS_PI_WHATSAPP_DIR="${JARVIS_PI_WHATSAPP_DIR:-whatsapp}"

die() { echo "✗ $*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) JARVIS_OS=macos ;;
  MINGW* | MSYS* | CYGWIN*) JARVIS_OS=windows ;;
  *) JARVIS_OS=other ;;
esac

require_secret_store() {
  [ "$JARVIS_OS" = macos ] || [ "$JARVIS_OS" = windows ] ||
    die "Los secretos viven en el Llavero de macOS o en el Administrador de credenciales de Windows."
  # Carga el almacén en ESTE shell: los $(kc_get ...) corren en subshells y
  # heredan el arreglo, en vez de llamar a PowerShell una vez por secreto.
  if [ "$JARVIS_OS" = windows ]; then
    wincred_load
  fi
}

# python3 en macOS y Linux; en Windows "python3" suele ser el atajo de la Store
# que no corre nada, así que se prueba antes de elegirlo.
jarvis_python() {
  local candidate
  for candidate in python3 python py; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 9))' >/dev/null 2>&1; then
      echo "$candidate"
      return
    fi
  done
  die "Falta Python 3.9 o más nuevo."
}

require_pi() {
  [ -n "${JARVIS_PI:-}" ] || die "Definí JARVIS_PI=usuario@ip-de-la-pi en jarvis.env (copiá jarvis.env.example)."
}

# Filas útiles del manifiesto: NOMBRE DESTINOS NIVEL DESCRIPCIÓN
manifest_rows() { grep -vE '^[[:space:]]*(#|$)' "$MANIFEST"; }

manifest_has() { manifest_rows | awk '{print $1}' | grep -qx "$1"; }

# Nombres cuyo campo DESTINOS incluye $1 (apollo, mcp, whatsapp, ...).
manifest_names_for() {
  manifest_rows | awk -v target="$1" '{
    count = split($2, list, ",")
    for (i = 1; i <= count; i++) if (list[i] == target) print $1
  }'
}

manifest_level() { manifest_rows | awk -v name="$1" '$1 == name {print $3}'; }

# --- Windows: Administrador de credenciales vía scripts/wincred.ps1 ---------
# Se lee todo de una vez (una sola llamada a PowerShell) a un arreglo en memoria;
# put y delete lo mantienen al día.
declare -A _JARVIS_WINCRED=()
_JARVIS_WINCRED_LOADED=0

wincred() {
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
    -File "$(cygpath -w "$REPO_ROOT/scripts/wincred.ps1")" "$@"
}

wincred_load() {
  [ "$_JARVIS_WINCRED_LOADED" = 1 ] && return
  local name encoded
  while IFS=$'\t' read -r name encoded; do
    [ -n "$name" ] && _JARVIS_WINCRED["$name"]="$encoded"
  done < <(wincred dump "$JARVIS_KEYCHAIN_SERVICE" | tr -d '\r')
  _JARVIS_WINCRED_LOADED=1
}

kc_has() {
  case "$JARVIS_OS" in
    macos) security find-generic-password -s "$JARVIS_KEYCHAIN_SERVICE" -a "$1" >/dev/null 2>&1 ;;
    windows) wincred_load; [ -n "${_JARVIS_WINCRED[$1]+set}" ] ;;
    *) return 1 ;;
  esac
}

kc_get() {
  case "$JARVIS_OS" in
    macos) security find-generic-password -s "$JARVIS_KEYCHAIN_SERVICE" -a "$1" -w 2>/dev/null ;;
    windows)
      wincred_load
      [ -n "${_JARVIS_WINCRED[$1]+set}" ] || return 1
      printf '%s' "${_JARVIS_WINCRED[$1]}" | base64 -d
      ;;
    *) return 1 ;;
  esac
}

# Guarda el valor que llega por stdin (cualquier carácter).
kc_put_stdin() {
  local name="$1" value
  case "$JARVIS_OS" in
    macos)
      value="$(cat)"
      kc_put_token "$name" "$value"
      ;;
    windows)
      value="$(cat)"
      printf '%s' "$value" | wincred put "$JARVIS_KEYCHAIN_SERVICE" "$name"
      if [ "$_JARVIS_WINCRED_LOADED" = 1 ]; then
        _JARVIS_WINCRED["$name"]="$(printf '%s' "$value" | base64 | tr -d '\n')"
      fi
      ;;
    *) die "No hay almacén de secretos en este sistema." ;;
  esac
}

# Guarda un valor SIN espacios ni comillas (hex, base64). En macOS va a
# `security -i` por stdin: printf es un builtin, así que el valor no aparece en
# ningún argv.
kc_put_token() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[A-Za-z0-9+/=_.-]+$ ]] || die "kc_put_token: $name tiene caracteres no permitidos"
  if [ "$JARVIS_OS" = windows ]; then
    printf '%s' "$value" | kc_put_stdin "$name"
    return
  fi
  printf 'add-generic-password -U -s %s -a %s -l %s -w %s\n' \
    "$JARVIS_KEYCHAIN_SERVICE" "$name" "$JARVIS_KEYCHAIN_SERVICE.$name" "$value" | security -i >/dev/null
}

# Pide el valor oculto (dos veces) y lo guarda.
kc_put_prompt() {
  local name="$1" first second
  if [ "$JARVIS_OS" = macos ]; then
    # -w al final, sin valor: lo pide el propio security, oculto. Así acepta
    # cualquier carácter (espacios, comas) y no pasa por argv ni por el historial.
    security add-generic-password -U -s "$JARVIS_KEYCHAIN_SERVICE" -a "$name" \
      -l "$JARVIS_KEYCHAIN_SERVICE.$name" -w
    return
  fi
  IFS= read -r -s -p "Valor: " first; echo
  IFS= read -r -s -p "Otra vez: " second; echo
  [ "$first" = "$second" ] || die "No coinciden; no se guardó nada."
  [ -n "$first" ] || die "Vacío; no se guardó nada."
  printf '%s' "$first" | kc_put_stdin "$name"
}

kc_delete() {
  case "$JARVIS_OS" in
    macos) security delete-generic-password -s "$JARVIS_KEYCHAIN_SERVICE" -a "$1" >/dev/null ;;
    windows)
      wincred delete "$JARVIS_KEYCHAIN_SERVICE" "$1" || die "$1 no estaba guardado."
      if [ "$_JARVIS_WINCRED_LOADED" = 1 ]; then unset '_JARVIS_WINCRED[$1]'; fi
      ;;
    *) die "No hay almacén de secretos en este sistema." ;;
  esac
}

# Línea para un env_file de docker compose. Sin comillas si no hacen falta (así
# `grep ^X= | cut -d= -f2-` sigue andando en la Pi); con comillas simples, que
# compose toma literal (sin interpolar $), si el valor tiene espacios o símbolos.
env_line() {
  local name="$1" value="$2"
  if [[ "$value" =~ ^[A-Za-z0-9_./:@+=,-]*$ ]]; then
    printf '%s=%s\n' "$name" "$value"
  elif [[ "$value" != *"'"* && "$value" != *$'\n'* ]]; then
    printf "%s='%s'\n" "$name" "$value"
  else
    die "$name tiene comillas simples o saltos de línea: docker compose no lo puede leer literal."
  fi
}
