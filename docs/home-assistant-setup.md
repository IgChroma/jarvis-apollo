# Jarvis dentro de Home Assistant

Cómo correr el servidor de Jarvis (Apollo) como **add-on de Home Assistant OS**, mostrar datos
de Home Assistant en la placa, usar **Claude** con un tope de gasto y hablar con **Piper**. Es
la alternativa a la Raspberry Pi dedicada del README: no hace falta Docker aparte ni otra
máquina, porque Home Assistant OS ya corre cada add-on en su propio contenedor.

Probado en una Raspberry Pi 4 de 4 GB con Home Assistant OS. En reposo el add-on usa ~0,3 % de
CPU y ~100 MB de RAM; durante el primer arranque puede pasar el 40 % un rato.

---

## 1. Instalar el add-on

1. **Agregar el repositorio.** En Home Assistant, abrí Configuración → Complementos →
   **Tienda de complementos** → **⋮** (arriba a la derecha) → **Repositorios**, pegá la URL del
   repo (por ejemplo `https://github.com/IgChroma/jarvis-apollo`) y tocá **Agregar**.
   - Atajo: `http://<tu-home-assistant>:8123/_my_redirect/supervisor_add_addon_repository?repository_url=<url-codificada>`.
   - Si no ves el menú ⋮, activá el **Modo avanzado** en tu perfil.
2. **Instalar.** Tocá ⋮ → **Buscar actualizaciones**, buscá **Jarvis Apollo** y tocá **Instalar**.
   La imagen se construye en la Pi, tarda varios minutos y no muestra progreso. **No toques
   Instalar dos veces.**
3. **Configurar.** En la pestaña **Configuración** completá lo obligatorio:
   - `device_shared_secret`: el mismo que lleva el firmware (`scripts/secrets.sh generate DEVICE_SHARED_SECRET`).
   - `dashboard_shared_secret`.
   - `openrouter_api_key`.

   Para copiar un secreto guardado sin tipearlo:
   `source scripts/lib.sh && require_secret_store && kc_get NOMBRE | clip`
4. **Arrancar.** En **Información**, activá **Iniciar al arrancar** y **Watchdog**, y tocá **Iniciar**.
5. **Verificar.** El **Registro** tiene que mostrar el resumen de arranque y
   `apollo_host_started`, y `http://<tu-home-assistant>:8799/health` tiene que devolver `"ok":true`.
   La placa se conecta sola si su `JARVIS_APOLLO_URL` apunta a esa IP y al puerto 8799.

**Actualizar:** Tienda → ⋮ → **Buscar actualizaciones** → **Actualizar** en el add-on.
**Reconstruir** también trae lo último de GitHub, porque la imagen baja `main` al construirse.
**No hagas las dos cosas a la vez** (ver Problemas).

---

## 2. Datos de Home Assistant en la placa

El add-on pide `homeassistant_api: true`: el Supervisor le da un token y Jarvis lee la API de
Home Assistant sin que crees un token de larga duración. El contrato completo está en
[vistas-tablero.md](vistas-tablero.md).

**Qué mostrar se elige con una etiqueta.** En Home Assistant, ponele la etiqueta **`jarvis`** a:

| Entidad | Dónde aparece |
|---|---|
| `light.*`, `switch.*`, `fan.*`, `input_boolean.*` | Vista **Casa**: interruptor (un toque prende o apaga) |
| `sensor.*`, `binary_sensor.*` | Vista **Casa**: valor y unidad |
| `climate.*` | Vista **Casa**: actual, objetivo, modo, con − y + de 0,5 °C |
| `calendar.*` | Vista **Inicio**: agenda y calendario del mes |
| `weather.*` | Vista **Inicio**: clima con mínima, máxima y humedad |

- Si ningún calendario tiene la etiqueta, se usan todos. Sin clima etiquetado, se usa `weather.home`.
- La vista Casa muestra hasta 12 mosaicos, más el dólar blue (dolarapi.com).
- Los cambios de etiqueta se ven solos en unos segundos: no hay que reflashear ni reiniciar.

### La casa por voz (add-on 0.5.0)

Con la misma conexión, Jarvis maneja por voz lo que tiene la etiqueta `jarvis` (luces,
enchufes, ventiladores, `input_boolean`, climas y losas) y lee los sensores. Son tres
herramientas del servidor (`server/overlay/apps/agent/src/tools/casa.ts`, lógica en
`homeassistant/voice.ts`), que solo existen si hay Home Assistant:

| Herramienta | Qué hace |
|---|---|
| `casa_listar` | Una línea por entidad etiquetada: nombre, entity_id, estado y, en climas, actual, objetivo, límites y modos |
| `casa_estado` | Lo mismo para una o varias entidades, por entity_id o por nombre |
| `casa_controlar` | `turn_on`, `turn_off`, `toggle` (luz, enchufe, ventilador, input_boolean, clima); `set_temperature` (clima: `temperatura` absoluta o `ajuste` en grados, opcional `modo`); `set_hvac_mode` |

Reglas (las mismas que un toque en la placa, más algunas propias de la voz):

- **Solo entidades con la etiqueta en ese momento** (la etiqueta se relee cada minuto). Un
  entity_id válido sin etiqueta se rechaza con un error que el modelo puede decir.
- **Nombres tolerantes:** "losa cuarto chicos", "la loza del cuarto de los chicos" y
  `climate.losa_cuarto_chicos` son lo mismo (sin tildes, mayúsculas, artículos ni plurales;
  "loza" = "losa"). Si el nombre encaja con dos ("la losa"), no elige: devuelve las dos y
  Jarvis pregunta. Así el pedido se resuelve en **una sola ronda**, sin listar antes.
- **Temperatura:** se limita a `min_temp`/`max_temp` (7-35 si la entidad no los informa) y se
  redondea a `target_temp_step` (0,5 por defecto; las losas de casa usan 0,1). Si se recortó,
  el resultado lo dice. "Subí 2 grados" usa `ajuste`: se suma al objetivo actual (hasta ±15).
- **Poner una temperatura no prende el equipo.** Las losas están en `off` buena parte del
  tiempo; prenderlas es gastar energía y el usuario puede querer solo dejar el objetivo listo.
  Si está apagada, se guarda el objetivo y el resultado avisa ("está apagada… ofrecé
  prenderla"). Si el pedido ya dice prenderla, el modelo manda `modo: "heat"` en la misma
  llamada.
- **Prender un clima:** si tiene un único modo de encendido, o calor sin frío (las losas:
  `heat/auto/off`), va a ese modo con `climate.set_hvac_mode`; un aire con frío y calor usa
  `climate.turn_on` y vuelve al último modo. Apagar es `hvac_mode: off`.
- **Lectura de vuelta:** después del servicio se lee el estado; si todavía no cambió, se
  relee una vez a los 0,7 s. Jarvis dice lo que muestra Home Assistant, no lo que pidió.
  También se empuja el tablero para que el mosaico cambie enseguida.
- **Sin confirmación:** nada de esto es destructivo; se deshace con otra frase.

El router tiene una intención `casa` para estas frases, y las mismas herramientas viajan con
`dispositivo` (donde caían antes) y `casa_estado` con `clima` ("¿qué temperatura hay en el
cuarto?"). Los esquemas son chicos a propósito: las tres juntas suman ~1,4 KB (una MCP típica pesa más que eso sola).

### Agenda y lista de compras (add-on 0.6.0)

El contrato con la placa está en [vistas-tablero.md](vistas-tablero.md#agenda-v2-add-on-060-eventos-tocables-agenda-por-día-y-lista-de-compras).

**Agendar por voz.** "Anotame en la agenda el jueves a las 11 el dentista" alcanza: Jarvis
guarda el evento y confirma en una frase ("Listo, el jueves 23 a las 11 en tu agenda"). El
lugar es un extra. **No** pregunta cómo vas a ir, **no** ofrece calcular la hora de salida y
**no** crea un recordatorio aparte: si querés el aviso, pedilo ("avisame cuándo salir").

- **Dónde:** en `calendar.hogar`. Se cambia con la opción **`agenda_calendar`** del add-on
  (variable `AGENDA_CALENDAR_ENTITY` fuera del add-on). Ese calendario se muestra en la placa
  aunque no tenga la etiqueta `jarvis`.
- **Cómo queda en Home Assistant:** el título es `"<emoji> <título corto>"` ("🦷 Dentista",
  hasta 18 caracteres) y la descripción lleva el título largo en la primera línea y, si
  dijiste algo más, eso después de una línea en blanco. Duración: 1 h salvo que digas otra.
  La hora se interpreta en la zona del clima (Buenos Aires por defecto) y viaja con su desfase
  (`2026-10-22T11:00:00-03:00`).
- **Íconos en la placa:** la placa no dibuja emoji. El emoji del principio del título se
  traduce a una categoría (`salud`, `auto`, `cumple`, `compras`, `casa`, `pago`, `viaje`,
  `trabajo`, `escuela`, `deporte`, `comida`, `mascota`, `reunion`, `otro`), también en los
  eventos que cargues a mano en Home Assistant ("🎂 Cumple Nico" sale con el ícono de cumple).
  Sin emoji, o con uno que no está en la tabla, es `otro`. Si el modelo elige un emoji que la
  tabla no conoce, Jarvis guarda el canónico de la categoría que eligió (🩺 para `salud`).

| Herramienta | Qué hace |
|---|---|
| `agenda_agregar` | `calendar.create_event`. Obligatorios: `fecha` (AAAA-MM-DD) y `hora` (HH:MM) o `todo_el_dia`, más `titulo_corto`, `emoji` e `icono`, que arma el modelo. Opcionales: `titulo_largo`, `lugar`, `duracion_minutos` (60), `descripcion`. Una fecha que ya pasó (más de 1 h) se rechaza: suele ser un error de año o de día |
| `agenda_listar` | Eventos de `desde` a `hasta` (hasta 31 días) de los calendarios del tablero: `id \| día hora \| título @ lugar` |
| `agenda_borrar` | Borra por `id` con el comando WebSocket `calendar/event/delete` (no hay servicio REST). Solo en calendarios que dejan borrar (bit 2 de `supported_features`: los locales sí, los de feriados no) |

- **Ids:** `<calendario sin "calendar.">:<uid>` ("hogar:01JB…"); en una repetición se agrega
  `#<recurrence_id>`, para borrar esa sola y no la serie.
- **WebSocket:** `ws://supervisor/core/websocket` dentro del add-on y `HA_URL` con
  `ws(s)://…/api/websocket` afuera, con el mismo token. Una conexión por comando.
- Sin Home Assistant estas herramientas no existen y la intención `agenda_crear` sigue con
  Google Calendar por MCP para quien lo tenga. `avisar_para_salir` ya no viaja con
  `agenda_crear`: queda en `viaje` y `recordatorio`.

**Lista de compras.** Hay dos listas: **Pendientes** (la interna de Jarvis, con el espejo de
Notion si está) y **Compras**, que con Home Assistant es `todo.shopping_list` (la de la app de
HA). `read_list`, `add_to_list` y `remove_from_list` deciden por el nombre: "compras", "lista
de compras", "súper" (y la de por defecto, sin nombre) van a Home Assistant; "pendientes" y
cualquier otra, a la interna.

- Leer: `todo.get_items` con `status: needs_action` (lo tachado no cuenta).
- Agregar: `todo.add_item`. Sacar: `todo.remove_item` por `uid` de los ítems que contienen el
  texto (sin tildes ni mayúsculas); `clearAll` saca todos los pendientes de comprar. Si la lista
  no dejara borrar pero sí editar, se marca completada con `todo.update_item`.
- En la placa, la tarjeta del centro alterna **Pendientes · Compras**; Compras se relee cada
  30 s y enseguida después de un cambio por voz.
- Si Home Assistant no responde, el error vuelve como respuesta ("no pude usar la lista de
  compras…") y la lista interna sigue andando. Lo que tenías en la lista interna "super"
  antes de 0.6.0 queda ahí (se ve con "leeme pendientes" o sin nombre): pasalo a mano.

---

## 3. Claude con tope de gasto

Con una key de la API de Anthropic, la conversación va por Claude. Sin key, o con
`claude_enabled` apagado, todo sigue por OpenRouter como antes.

1. Creá la key en **platform.claude.com → Settings → API keys**. Sirve una key normal: no hace
   falta cuenta de organización ni Admin API.
2. Pegala en la opción `anthropic_api_key` del add-on y tocá **Guardar** y **Reiniciar**.
3. El resumen de arranque tiene que decir
   `Claude: sí (usa Claude hasta gastar US$50 en el período; después OpenRouter)`.

**Niveles.** Cada turno elige uno:

| Nivel | Modelo (opción) | Cuándo |
|---|---|---|
| Rápido | `claude-haiku-5-5` (`claude_model_fast`) | Por defecto |
| Razonar | `claude-sonnet-5-5` (`claude_model_reasoning`) | Cuando el router Jev decide razonar |
| Difícil | `claude-opus-5-5` (`claude_model_hard`) | Jev ≥ 0,9 en "requiere razonar", o frases como "pensalo bien", "pensá a fondo", "pregunta difícil" |

**Tope de gasto.**
- Jarvis suma el costo de cada respuesta de Claude, calculado con su `usage` y la tabla de
  precios de `claude/pricing.ts`.
- Si el gasto del período llega a `claude_budget_usd` (default **US$50**), pasa a OpenRouter
  hasta que empiece el período siguiente.
- El período corre desde el día `claude_budget_cycle_day` (default **12**), a las 00:00 de
  Buenos Aires, hasta el mismo día del mes siguiente.
- `claude_min_remaining_percent` (default 0) deja un margen sin usar.
- Un turno que arranca bajo el tope termina en Claude aunque lo cruce.
- La cifra oficial es la de **platform.claude.com → Billing**. La suma de Jarvis no ve el gasto
  hecho con la misma cuenta fuera de Jarvis, y puede quedar algo corta si una respuesta se
  corta a mitad.

**Costo orientativo:**
- Con Haiku, una décima de centavo de dólar por turno.
- Con Sonnet u Opus, uno a pocos centavos.
- Los turnos con herramientas hacen 2–3 llamadas.

**Fallas.** Si Claude falla o rechaza un pedido, ese turno lo contesta OpenRouter sin cortar
la conversación.

**Siguen en OpenRouter:** la transcripción (Whisper), los embeddings, el router Jev y las
tareas de fondo.

En el registro, las líneas `apollo_claude_nivel`, `apollo_claude_ronda` (con `tokensCacheLeidos`,
para ver si el caché de prompt funciona) y `apollo_claude_gasto` muestran qué se usó y cuánto
lleva gastado el período.

---

## 4. Voz: Piper incluido (y Azure opcional)

**Piper** es un motor de voz local, sin internet, que viene **dentro del add-on** con la voz
`es_MX-ald-medium`. Es la voz por defecto (`tts_provider: piper`). Con `tts_provider: azure` y
sin `azure_speech_key`, Jarvis también habla con Piper.

- **Otra voz.** Poné su nombre en `piper_voice`, por ejemplo `es_AR-daniela-high.onnx` (acento
  rioplatense). Se baja de [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices)
  **en segundo plano**: mientras tanto habla la voz incluida. Cuando el registro diga
  `Voz … lista`, reiniciá el add-on una vez.
- **Rendimiento en una Pi 4.** Una voz cargada ocupa ~150–250 MB de RAM y solo usa CPU mientras
  genera cada frase. Las voces "high" son más lentas que las "medium".
- **Un Piper propio.** `piper_directory` apunta a una carpeta propia, por ejemplo `/share/piper`,
  con la estructura `piper/piper` y `voices/*.onnx`. Si ahí no hay binario, se usa el incluido.

**Azure Speech (voz es-AR "Tomás", más rápida y natural):**
1. **Cuenta.** Entrá a **portal.azure.com** y creá una cuenta gratuita (pide tarjeta para verificar).
2. **Recurso.** Tocá **Create a resource**, buscá **Speech** (Azure AI services) y tocá **Create**.
3. **Datos del recurso:**
   - Un resource group nuevo.
   - Región **Brazil South** (`brazilsouth`, la del default del add-on).
   - Plan **Free F0**: la capa gratuita alcanza para uso personal (confirmá los límites en la página de precios).
4. **Key.** Andá a **Keys and Endpoint** y copiá la **KEY 1**.
5. **Add-on.** Cargá `azure_speech_key`, `azure_speech_region` (`brazilsouth`) y
   `tts_provider: azure`, y tocá **Guardar** y **Reiniciar**. Si Azure falla, habla Piper.

---

## 5. Problemas conocidos

| Síntoma | Causa | Qué hacer |
|---|---|---|
| CPU alta todo el tiempo, `/health` no contesta, el registro repite el arranque | Se reinicia en bucle (el watchdog lo mata si tarda en arrancar) | Mirar las últimas líneas del registro. Versiones anteriores a 0.4.1 bajaban la voz extra antes de arrancar: actualizar |
| "Failed to start add-on", y el log del Supervisor dice `Image …:<versión> does not exist` | Se hicieron **Reconstruir** y **Actualizar** a la vez y quedó registrada una versión sin imagen | **Reconstruir** una vez y esperar `Build … done` sin tocar nada más. También aparece como reparación en Configuración → Sistema → Reparaciones |
| "No update available" o "Another job is running" | Un trabajo previo del add-on sigue corriendo | Esperar un par de minutos y reintentar una sola acción |
| No aparecen opciones nuevas en Configuración | La versión instalada es vieja | Tienda → ⋮ → **Buscar actualizaciones** → **Actualizar** |
| `Can't read …/firmware/…/config.json: Invalid app config` en el log del Supervisor | El Supervisor revisa todos los `config.json` del repo buscando add-ons | Inofensivo |
| `did not handle SIGTERM` al detenerlo | Jarvis no hace un apagado prolijo | Inofensivo (pendiente de arreglo) |

**Dónde mirar:**
- El **Registro** del add-on.
- Configuración → Sistema → **Registros**, eligiendo **Supervisor** arriba a la derecha para
  builds y arranques.
- `/share/jarvis-apollo/logs/apollo.log`, que sobrevive a las reconstrucciones e incluye lo que
  se habló.

---

## 6. La placa

El firmware y su compilación (macOS o Windows con Git Bash) están en el README y en
[secretos.md](secretos.md). Para que la placa encuentre el servidor del add-on:

- `JARVIS_APOLLO_URL=ws://<ip-de-home-assistant>:8799` en `jarvis.env`.
- El `DEVICE_SHARED_SECRET` del firmware tiene que ser el mismo que el `device_shared_secret`
  del add-on.

Reservá la IP de Home Assistant en el router: la placa la tiene compilada.
