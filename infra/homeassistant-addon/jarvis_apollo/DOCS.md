# Jarvis Apollo (add-on de Home Assistant)

El servidor de Jarvis (Apollo en Bun, con el overlay de este repo) corriendo como add-on de
Home Assistant OS, en lugar del contenedor de `scripts/deploy-server.sh` sobre Raspberry Pi OS.
Escucha en el **puerto 8799** del host: la placa se conecta a `ws://<ip-de-HA>:8799/...` y la
salud se ve en `http://<ip-de-HA>:8799/health`.

## Cómo se arma

No hay imagen publicada: el Supervisor construye la imagen **en la Pi** con el `Dockerfile` de
esta carpeta, que:

1. baja este repo (`IgChroma/jarvis-apollo`, rama `main`) desde GitHub,
2. corre `server/apply.sh`, que clona Apollo upstream en el commit fijo y copia el overlay,
3. arma `apps/agent` igual que `scripts/deploy-server.sh` (sin tests ni devDependencies) y hace
   `bun install --production` sobre `oven/bun:1.3-slim` (la misma base que el Dockerfile de
   upstream; trae variante arm64).

Por eso **lo que corre es lo que está subido a GitHub**, no lo que tenés sin commitear en la compu.
Las opciones de la pestaña *Configuración* se convierten en las variables del `.dev.vars` (las
mismas de `server/config.env.example` y `secrets.manifest`). Los secretos se cargan en la UI de
Home Assistant (campos de tipo contraseña) y quedan solo en la Pi.

## Instalación

Hay dos caminos; elegí uno solo (cada uno es un add-on distinto, con sus propios datos).

### A. Como repositorio (recomendado: actualizar es un clic)

Requiere que `repository.yaml` y `infra/homeassistant-addon/` estén subidos a `main`. Desde Git
Bash, sin arrastrar otros cambios que tengas en stage:

```bash
files="repository.yaml infra/homeassistant-addon infra/README.md"
git add $files
git commit -m "Add-on de Home Assistant" -- $files   # con rutas: solo commitea esas
git push
```

1. Home Assistant → **Configuración → Complementos → Tienda de complementos**.
2. Menú **⋮ → Repositorios** → pegá `https://github.com/IgChroma/jarvis-apollo` → **Agregar**.
3. Cerrá el diálogo, **⋮ → Buscar actualizaciones**, y abajo aparece **Jarvis Apollo**.
4. **Instalar**. La primera construcción tarda varios minutos en una Pi 4 (baja dos repos y los
   paquetes de npm); la página parece colgada pero sigue.

### B. Como add-on local (sin subir nada)

1. Copiá la carpeta `infra/homeassistant-addon/jarvis_apollo` entera a `/addons/jarvis_apollo`
   de Home Assistant: desde **Studio Code Server** (abrí la carpeta `/addons` y arrastrá la
   carpeta desde el Explorador de Windows) o desde el recurso compartido `addons` del add-on Samba.
2. **Tienda de complementos → ⋮ → Buscar actualizaciones** → sección **Complementos locales** →
   **Jarvis Apollo** → **Instalar**.

El código de Apollo igual sale de GitHub (`main`), así que este camino sirve aunque el add-on
no esté commiteado.

### Configurar y arrancar (los dos caminos)

1. Pestaña **Configuración**: cargá los tres obligatorios y **Guardar**:
   - `device_shared_secret`: **el mismo** que tiene compilado el firmware de la placa.
   - `dashboard_shared_secret`: el de la consola de administración.
   - `openrouter_api_key`.

   Para no escribirlos a mano, en Git Bash (Windows) se copian del Administrador de credenciales
   al portapapeles sin mostrarse:

   ```bash
   source scripts/lib.sh && require_secret_store && kc_get DEVICE_SHARED_SECRET | clip
   ```

   (pegalo en el campo, repetí con cada nombre, y al terminar copiá cualquier otra cosa para
   limpiar el portapapeles).
2. Opcionales, según lo que uses: `azure_speech_key` (voz argentina; sin ella la voz `azure` cae
   en Piper), `tavily_api_key`, `google_maps_api_key` + `idle_travel_origin`, Notion, Gmail. Los
   que no aparecen están en **Mostrar opciones de configuración opcionales no utilizadas**.
3. Pestaña **Información**: activá **Iniciar al arrancar** y **Watchdog**, y **Iniciar**.
4. Pestaña **Registro**: tiene que aparecer una línea `apollo_host_started`. El resumen de arriba
   dice qué integraciones quedaron prendidas (nunca muestra valores).
5. Abrí `http://192.168.0.111:8799/health` (o el botón **Abrir interfaz web**): responde
   `{"ok":true,...}`.

Si el firmware ya apunta a `192.168.0.111:8799` (es lo que dice tu `jarvis.env`), la placa se
conecta sola; si apunta a otra IP, hay que recompilarlo con la URL nueva.

## Actualizar

- **Cambió el código del servidor** (`server/`): subilo a `main` y en el add-on tocá
  **Reconstruir** (en el menú ⋮ de la página del add-on). El Dockerfile consulta a GitHub qué
  commit es `main` y, si cambió, baja el código nuevo.
- **Cambió el add-on** (esta carpeta): subí `version` en `config.yaml`. En el camino A, pusheá y
  Home Assistant ofrece **Actualizar**. En el camino B, copiá la carpeta de nuevo a `/addons`,
  **Buscar actualizaciones** y **Actualizar**.
- **Cambiaste opciones**: **Guardar** y **Reiniciar** (las opciones se leen al arrancar).

Reconstruir o actualizar corta la conversación en curso; los datos no se tocan.

## Datos, backups y logs

| Dónde | Qué |
|---|---|
| `/data/apollo` (interno del add-on) | `jarvis.sqlite` y `blobs/` (caché de voz, firmware OTA). Entra en los backups de Home Assistant del add-on. |
| `/share/jarvis-apollo/logs/apollo.log` | Copia del log que sobrevive a reconstrucciones (rota a `.1` al arrancar si pasa de 20 MB). Se ve desde Studio Code Server o Samba. Tiene lo que se habló: no lo compartas. Se apaga con `log_to_file`. |
| `/share/jarvis-apollo/import/` | Para traer una base vieja (ver abajo). |
| `/share/piper/` | Piper local, opcional. |

**Traer la base de la instalación anterior** (memoria, recordatorios, router): con el servidor
viejo apagado, copiá `jarvis.sqlite` (y si querés `blobs/`) del volumen `docker_apollo-data` a
`/share/jarvis-apollo/import/`. Al arrancar, si el add-on todavía no tiene base, la copia a
`/data/apollo` y renombra la carpeta a `import.usado-<fecha>`. Si ya arrancó una vez y querés
importar igual: desinstalá el add-on (borra sus datos), dejá los archivos en `import/` e
instalalo de nuevo.

## Tablero: vistas Inicio y Casa (etiqueta `jarvis`)

Desde la versión 0.2.0 el add-on tiene acceso a la API de Home Assistant
(`homeassistant_api: true`): el Supervisor le pasa un token propio y no hay que configurar
nada. Lo que se muestra en la placa se elige con una **etiqueta** de Home Assistant llamada
`jarvis` (**Configuración → Áreas, etiquetas y zonas → Etiquetas → Crear etiqueta**), que se le
pone a cada entidad desde su ventana de configuración (⚙ → **Etiquetas**):

| Entidad con la etiqueta | Dónde aparece | Qué hace |
|---|---|---|
| `light.*`, `switch.*`, `fan.*`, `input_boolean.*` | Vista **Casa**, mosaico interruptor | Un toque la prende o la apaga |
| `sensor.*`, `binary_sensor.*` | Vista **Casa**, mosaico sensor | Muestra valor y unidad; no se toca |
| `climate.*` | Vista **Casa**, mosaico clima | Temperatura actual, objetivo, modo y botones − / + (0,5 °C) |
| `calendar.*` | Vista **Inicio**: agenda y calendario del mes | Si ningún calendario tiene la etiqueta, se usan todos |
| `weather.*` | Vista **Inicio**: tarjeta de clima con mín./máx. | Si ninguno tiene la etiqueta, se usa `weather.home` |

- Entran hasta **12 mosaicos** (primero interruptores, después climas y sensores, cada grupo
  por nombre). El nombre es el *nombre amigable* de la entidad, recortado a 18 caracteres:
  conviene ponerle uno corto ("Living", "Aire dormitorio").
- Solo se pueden tocar entidades que **tienen la etiqueta en ese momento**: la placa no puede
  manejar nada que no hayas etiquetado. Sacar la etiqueta deshabilita el mosaico en menos de
  un minuto.
- La vista Casa también muestra el **dólar blue** (dolarapi.com, cada 15 min), con o sin
  Home Assistant.
- Si Home Assistant no responde, esas tarjetas desaparecen y el resto del tablero sigue igual
  (el clima vuelve a salir de open-meteo, sin mín./máx.).
- El resumen del **Registro** al arrancar dice `Home Assistant: sí` cuando el token está.

## Integraciones opcionales

Todas vienen apagadas y sin ellas el add-on arranca igual.

- **Piper (voz local de respaldo)**: bajá `piper_linux_aarch64` y la voz `es_MX-ald-medium` y
  dejalos como `/share/piper/piper/piper` y `/share/piper/voices/es_MX-ald-medium.onnx` (misma
  estructura que `~/piper` del README). Si no hay Piper ni key de Azure, el log avisa que Jarvis
  va a quedar mudo.
- **Servidores MCP (Maps, Calendar, Notion)**: en Home Assistant OS no existe la red Docker
  `jarvis-mcp`. Apollo los instala por URL desde la consola de administración, así que pueden
  correr en otra máquina de la red (`http://<ip>:<puerto>/sse`; Apollo acepta `http` hacia IPs
  privadas). Si importaste una base vieja, los MCP registrados con `http://maps-mcp:8000/sse`
  van a fallar hasta que los reinstales con la URL nueva (el supervisor los reintenta cada 60 s).
- **WhatsApp (WAHA)**: corré WAHA aparte y cargá `waha_url` (por ejemplo
  `http://<ip>:3000`), `waha_api_key`, `whatsapp_to` y, si querés, `whatsapp_contacts`.
- **Parlante externo** (`infra/speaker`): en Home Assistant OS no se puede instalar el servicio
  systemd en el host. Si lo corrés en otra máquina, cargá `speaker_url` y `speaker_token`.
- **Consola de administración**: igual que antes (`apps/console` de upstream), conectada a
  `http://192.168.0.111:8799` con el `dashboard_shared_secret`.
- **Variables sin opción propia** (`ROUTER_JEV_MODEL`, `REMINDER_ALARM_VOLUME`,
  `FIRMWARE_PUSH_DISABLED`...): en `extra_env`, como pares nombre/valor.

## Recursos en una Raspberry Pi 4 de 4 GB

- **RAM**: en Raspberry Pi OS el sistema entero con Apollo usaba ~360 MB; el proceso de Apollo
  solo es bastante menos (las llamadas pesadas —STT, LLM, embeddings, voz Azure— son en la nube).
  Con Home Assistant (~0,5–1 GB con sus add-ons habituales) sobra margen en 4 GB. Lo que más
  pesa en local es Piper, y solo si se usa.
- **Disco**: la imagen final ronda unos cientos de MB, y la construcción usa temporalmente más
  (capa de build con git y los dos repos). Si la tarjeta anda justa, revisá el espacio antes de
  reconstruir.
- **Tarjeta SD**: SQLite en modo WAL y el log en `/share` escriben seguido; con un SSD por USB
  la Pi vive más tranquila.

## Problemas comunes

- **No arranca y el registro dice "Faltan opciones obligatorias"**: cargá los tres secretos.
- **Falla la construcción con "GitHub no devolvió el commit"**: la API pública de GitHub limita
  a 60 consultas por hora por IP; esperá y reintentá.
- **La placa no conecta**: mirá `http://192.168.0.111:8799/health`; si responde, el secreto del
  firmware y `device_shared_secret` no coinciden, o `device_name` no es el del firmware (`jarvis`).
- **El puerto 8799 está ocupado**: si todavía corre el contenedor viejo en la misma máquina,
  apagalo antes.
