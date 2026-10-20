# Customizaciones sobre Apollo

Todo lo que este repo le agrega o cambia a Apollo y a su firmware, agrupado por lo que se nota
al usarlo. Cada punto dice dónde vive el código (rutas relativas a `server/overlay/apps/agent/src/`
o a `firmware/overlay/`) y por qué se hizo así, que suele ser lo más útil.

---

## Avisos que te buscan a vos

### "¿A qué hora tengo que salir?" — `travel/departure.ts`, `tools/travel.ts`

Pedís "avisame cuándo tengo que salir para el dentista de las 3" y Jarvis te avisa
**7 minutos antes de la hora en que tenés que salir** para llegar a tiempo.

- **Tráfico a la hora de salida, no el de ahora.** El MCP de Google Maps no acepta hora de
  salida (devuelve un tiempo típico), así que se llama a la Distance Matrix por REST con
  `departure_time`, que sí devuelve `duration_in_traffic`. Decidir a las 10 de la mañana cuánto
  tardás a las 18 sin modelar tráfico da un número inútil.
- **Dos fases, porque el tráfico envejece.** Si falta más de una hora, no se fija el aviso: se
  programa un recálculo para una hora antes de salir, que recién ahí programa el aviso. Mismo
  patrón en todo el proyecto: *el schedule no dispara el aviso, dispara un cálculo*.
- **Solo cuando se pide (desde el add-on 0.6.0).** Medido con el router: "avisame cuándo tengo
  que salir" va a la intención `viaje` (0,78 a 1,0), pero "voy a ir al dentista a las tres" cae
  en `agenda_crear` (0,66). Antes la herramienta viajaba también con `agenda_crear` para
  ofrecer la salida en ese caso implícito; el dueño decidió lo contrario: agendar es "día y
  hora y listo", sin preguntar cómo va a ir. Ahora `avisar_para_salir` está en `viaje` y
  `recordatorio`, no en `agenda_crear` (ver la Agenda v2 en
  [home-assistant-setup.md](home-assistant-setup.md)). *Agregar o sacar una herramienta de una
  intención se decide midiendo a qué intención va la frase real.*
- El origen es `IDLE_TRAVEL_ORIGIN` (tu dirección, en el Llavero). Interruptor:
  `DEPARTURE_ALERTS=off`.

### Recordatorios que no se pierden — `reminders/`, `tools/reminder.ts`, `host/actor.ts`

- **Hasta 60 días** (Apollo los limitaba a 24 h: "el 7 avisame una semana antes" se rechazaba o
  quedaba para mañana).
- **Recurrentes de verdad** (`set_recurring_reminder`): "todos los días a las 19:30",
  "lunes a viernes", "todos los 5 del mes a las 10". Es un cron, no N recordatorios sueltos:
  el modelo decía "listo, todos los días" y programaba solo el primero. No crea duplicados.
- **Alarma y pantalla completa** (`reminders/alarm.ts`) para que se note desde lejos.
- **No te hablan encima** (`reminders/defer.ts`): si el aviso cae mientras estás conversando,
  se posterga de a 10 s hasta que termine el turno (con tope de 2 min).
- **Por WhatsApp si no llegó** (`reminders/whatsapp-relay.ts`): si la placa está desconectada
  cuando suena, o sonó y en 10 minutos nadie la tocó ni le habló, el aviso te llega por
  WhatsApp.

### Vencimientos por mail — `billing/`

Cada mañana y cada tarde lee Gmail por IMAP (contraseña de aplicación) **solo los mails cuyo
asunto** habla de vencer, renovar o deuda; el resto del buzón no sale de Google ni pasa por el
LLM. Cada mail pasa por el LLM, que devuelve concepto, fecha y monto; avisa el día anterior a
las 10 y el mismo día a las 9. Las intimaciones recientes se avisan en el momento.
`BILLING_SKIP_CONCEPTS` evita duplicar lo que ya tiene un recordatorio fijo.

### Opcionales (apagados por defecto)

- **Partidos de tu equipo** (`sports/fixtures.ts`): scoreboard público de ESPN (sin key),
  mirando solo las próximas 26 h porque en el fútbol argentino los partidos se reprograman
  todo el tiempo. `FOOTBALL_TEAM=Racing Club`.
- **Seguimiento de una web sin API** (`events/watch.ts`, `sports/padel.ts`): torneos nuevos de
  Premier Padel leyendo el HTML del calendario oficial. Sirve de molde para seguir cualquier
  página.

---

## Conversación

### Persona Jarvis — `persona/soul.ts`, `persona/characters.ts`, `persona/mood.ts`

- Rioplatense ("vos", nunca "tú"), cordial con ingenio seco, y **respuestas de 1 o 2
  oraciones**. No es estilo: es latencia. Cada carácter de más se paga en síntesis de voz.
- **Personajes por tono**: Jev elige en la misma llamada si la frase pide `sarcastico`
  ("¿el agua moja?"), `relator` (un gol de tu equipo), `mayordomo` ("buenas noches") o
  `normal`. Nunca hay personaje si es una queja. `PERSONAJES=off` lo apaga.
- **Cara según el tono**: el LLM cierra con `[[cara:festejo|triste|apurado|pensativo]]` y la
  mascota de la pantalla reacciona.
- **Modo conversación** (`turn/run.ts`): el micrófono se reabre después de cada respuesta para
  seguir sin repetir "Hey Jarvis", y se cierra solo a los ~3 s de silencio.
- **Agenda = calendario + recordatorios**: al preguntar "¿qué tengo hoy?" mira las dos fuentes.
  "Agendá una reunión" va a Google Calendar; "recordame" va a un recordatorio interno.

### Router de intenciones con Jev — `router/`

El cambio más grande del lado del servidor. Antes del LLM, una sola llamada a
`typesafe/jev-1.13` (por OpenRouter, ~USD 0,000014 por turno, en paralelo con la memoria) da
probabilidades para: intención, ruido, queja, razonamiento y personaje. Con eso el turno decide
qué herramientas ve el modelo (ver la tabla de niveles en
[arquitectura.md](arquitectura.md#un-turno-de-punta-a-punta)).

- **Aprende solo** (`router/learn.ts`, 04:00): etiqueta cada turno sin preguntarte nada (las
  herramientas que terminó usando el LLM dicen la intención real; usar el escape = error del
  router; quejarse del mismo tema en los 3 minutos siguientes = error), ajusta los umbrales de
  cada intención (atajo si acierta ≥ 90 %, sin LLM de por medio si ≥ 97 %), y entrena un
  **clasificador local** sobre los embeddings (`router/head.ts`) que reemplaza a Jev cuando
  demuestra ≥ 97 % de acierto en turnos que no vio.
- **Razonar solo cuando hace falta**: el LLM razonaba por defecto (+2 s por ronda). Jev decide
  si hay que encadenar pasos, calcular fechas o hacer cuentas; si no, `reasoning` apagado. Un
  A/B (`ROUTER_REASONING_EXPLORE=0.2`) invierte la decisión en el 20 % de los turnos y cada
  noche mueve el umbral según los errores medidos.
- **Dónde ganó de verdad**: el dólar pasó de 9,5 s a 3 s (una ronda en vez de dos), el ruido
  de Whisper se descarta sin gastar un turno, y "leeme los pendientes" usa la lista real en vez
  de la memoria vieja.
- Modo `shadow` para medir sin aplicar; `ROUTER_MODE=off` lo apaga.

### Claude como LLM, con tope de gasto — `claude/`

Opcional: con `ANTHROPIC_API_KEY` la conversación va a la API de Anthropic (SDK oficial
`@anthropic-ai/sdk`, por streaming, así la voz arranca con la primera oración); sin key, o con
`CLAUDE_ENABLED=off`, todo sigue por OpenRouter. STT, embeddings y Jev no cambian.

- **Tres niveles** (`claude/tier.ts`), con la misma señal de razonamiento del router (incluido
  su A/B, que ahora compara Sonnet contra Haiku): `claude-haiku-5-5` por defecto, esfuerzo `low`;
  `claude-sonnet-5-5` si el router decide razonar, esfuerzo `low`; `claude-opus-5-5` si Jev da
  ≥ 0,9 de "requiere razonar" (`CLAUDE_HARD_REASONING_THRESHOLD`) o el usuario lo pide ("pensalo
  bien", "pensá a fondo", "es una pregunta difícil"; `CLAUDE_HARD_PHRASES`), esfuerzo `medium`:
  Opus 5.5 no deja apagar el razonamiento y `medium` es su punto de partida; `high` alarga el
  turno para una respuesta que igual se dice en dos oraciones. Cada turno deja
  `apollo_claude_nivel` con el nivel y el motivo (sin el texto).
- **Una decisión por turno**: nivel y proveedor se eligen en la primera ronda y no cambian a mitad
  (el razonamiento de una ronda solo lo lee el mismo modelo). Si una ronda falla (red, 5xx, 429,
  rechazo sin fallback, corte sin texto), esa ronda y el resto del turno van por OpenRouter
  (`apollo_claude_fallback_openrouter`); el texto en vivo que Claude ya había escrito se descarta.
- **Rechazos**: Sonnet y Opus van con el fallback del lado del servidor
  (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`); Haiku no lo tiene y su rechazo
  cae directo en OpenRouter.
- **Caché de prompt**: lo estable (alma, sesión, herramientas instaladas) va primero y con punto
  de caché; foco, telemetría, memorias, hora y personaje van después. Además, caché automática de
  la cola, para que la segunda ronda de un turno con herramientas lea la primera de caché.
- **`tool_choice: required`** (`turn/claims.ts`) no se manda a Claude (Opus 5.5 y Sonnet 5.5 lo
  rechazan con un 400): la nota de sistema que acompaña la repetición ya nombra la herramienta.
- **Tope de gasto** (`claude/budget.ts`, `claude/pricing.ts`): la cuenta no tiene Admin API, así
  que cada respuesta se cotiza con su `usage` (entrada, escritura y lectura de caché, salida) y
  la tabla de precios de lista, y se anota en `api_costs` como `llm_claude`. Usa Claude hasta
  gastar `CLAUDE_BUDGET_USD` (50) en el período (del día `CLAUDE_BUDGET_CYCLE_DAY`, 12, a las
  00:00 de Buenos Aires, al mismo día del mes siguiente); después, OpenRouter hasta el período
  siguiente. `CLAUDE_MIN_REMAINING_PERCENT` (0) deja un margen. La suma se relee cada 5 minutos y
  al cambiar de período; `apollo_claude_gasto` la loguea al arrancar, cada hora y cada vez que
  cambia el nivel o el proveedor.

### "No confirmes lo que no hiciste" — `turn/claims.ts`

El modelo a veces decía "listo, te aviso mañana" sin haber programado nada, o "esta semana no
tenés nada" sin mirar el calendario. Si el pedido es de acción y no hubo herramienta, o es de
datos y no hubo consulta, la respuesta no se dice: se agrega una nota de sistema y la ronda
siguiente va con `tool_choice: 'required'`. Una pregunta de aclaración no lo dispara.

### Mensajes a otras personas — `tools/message.ts`

"Decile a Ana que llego a las 9" → WhatsApp, aunque no digas "WhatsApp". Dos candados **en
código, no en el prompt**:

1. **Lista cerrada** (`WHATSAPP_CONTACTS`, en el Llavero). Un nombre que no está no se resuelve
   contra ninguna agenda.
2. **Confirmación por voz**: `mandar_mensaje` solo arma un borrador y la frase que se dice la
   impone la herramienta (`Para Ana: "Llego a las 9". ¿Se lo mando?`), no el modelo. El envío lo
   hace `confirmar_mensaje`, que exige que tu frase del turno *inmediato siguiente* sea un "sí"
   claro (sin "no", "esperá", "cambiá"). Cualquier otro turno descarta el borrador; vence a los
   3 minutos. El modelo no puede confirmar por su cuenta.

Y `whatsapp/client.ts` espera el ack del servidor de WhatsApp antes de decir "enviado": WAHA
llegó a aceptar mensajes que nunca salieron.

### Voz — `voice/`

- **Azure Speech** (`voice/azure.ts`) con `es-AR-TomasNeural`: 4,3x más rápido que Piper en la
  Pi y en el formato exacto de la placa (sin remuestrear). El texto se escapa en el SSML (un `&`
  en la respuesta dejaba a Jarvis mudo).
- **Piper** (`voice/piper.ts`) como proceso persistente: recargar el modelo ONNX de 63 MB en cada
  respuesta era el 60 % del tiempo de voz. Remuestrea 22050 → 24000 Hz.
- **Selector con red de seguridad** (`voice/synthesize.ts`): `TTS_PROVIDER=azure|piper|elevenlabs`;
  Azure sin key o con error cae a Piper. Hay tests que fijan las cuatro rutas.
- **Filtro de alucinaciones de Whisper** (`voice/silence.ts`) y STT que devuelve vacío en vez
  de error ante silencio (antes la pantalla decía "No pude procesar ese pedido").

---

## Pantalla

### Tablero LVGL — `main/display/jarvis_dashboard_display.cc`, `dashboard/`

La idea de Apollo es una cara a pantalla completa. Acá la pantalla es un **dashboard** con dos
vistas (contrato en [vistas-tablero.md](vistas-tablero.md)), que se cambian con las pestañas
**Inicio / Casa** de la barra de arriba o **deslizando** el dedo. Deslizar ya no cambia el modo
de habla: lo resuelve la placa y no viaja al servidor.

- **Inicio:** agenda (calendario + recordatorios mezclados por hora) a la izquierda, pendientes
  (y el viaje con tráfico, si hay destino) al medio, y debajo de las dos, con el ancho de ambas,
  la **franja de conversación**: el estado del turno ("Escuchando...", "Pensando...") y hasta 4
  renglones de lo que oyó o dice Jarvis, cortados con "..." si no entra. A la derecha, el
  calendario del mes (hoy recuadrado, días con eventos en naranja y los eventos de hoy debajo),
  el clima (temperatura grande, condición con el **dólar blue promedio** al lado —(compra +
  venta) / 2, sale de `home.dollarBlue` y no se muestra si no hay—, mín./máx. y humedad cuando
  vienen de Home Assistant) y los botones Hablar/Enviar. Cuando empieza una conversación la
  pantalla vuelve sola a Inicio.
- **Casa:** grilla de hasta 12 mosaicos de Home Assistant (entidades con la etiqueta `jarvis`)
  y una franja con el dólar blue. Un toque en un interruptor lo prende o apaga; − y + mueven el
  clima 0,5 °C. La placa pinta el cambio en el acto y manda `ha_action`; el tablero que el
  servidor empuja enseguida lo confirma o lo corrige. Los sensores no se tocan y lo no
  disponible sale en gris.
- **Agenda v2** (contrato en [vistas-tablero.md](vistas-tablero.md), sección "Agenda v2"):
  - Cada evento es **un renglón**: ícono + título + "· cuándo". El título usa el ancho real de la
    columna y se corta con "..." solo si no entra; el "cuándo" se ve siempre entero.
  - Los íconos son glifos de la fuente Material Symbols de la barra (salud, auto, cumple, casa,
    viaje, escuela, reunión). Las categorías sin glifo parecido (compras, pago, trabajo, deporte,
    comida, mascota, otro) llevan un punto de color. No se sumaron fuentes.
  - Tocar un evento abre el **detalle**: título completo, fecha y horario, lugar, descripción,
    origen y botón **Cerrar** (tocar afuera de la tarjeta también cierra).
  - Tocar un **día del calendario** abre la **vista del día** (dos columnas, hasta 12 eventos
    tocables, botón **Cancelar**) y pide `agenda_day_request`. Muestra "Cargando...", "No pude
    traer la agenda" si no contesta en 5 s, o "Sin eventos".
  - Con el detalle o la vista del día abiertos, **deslizar y las pestañas no hacen nada**: se
    cierran con su botón. Si empezás a hablar se cierran solos, para que se vea la franja de
    conversación. El recordatorio y la pantalla de confirmación siguen teniendo prioridad.
  - La tarjeta del medio alterna **Pendientes / Compras** con las flechas ‹ › de la cabecera,
    que solo aparecen si llegaron las dos listas. La elección dura hasta reiniciar.
- Agenda y eventos de hoy muestran solo lo que entra entero (en la 4.3C, 800×480, entran menos
  que en la P4-7B, 1024×600). El log de arranque (`tablero armado: ...`) dice cuánto mide cada
  cosa, cuántos eventos entran y cuántos renglones tiene la franja de conversación; la línea
  `agenda v2: ...` dice lo mismo de la vista del día y del detalle.
- El servidor arma y **recorta** el contenido (`dashboard/payload.ts`) y lo manda **cada 10 s
  aunque no haya cambiado**: mandarlo solo al cambiar dejaba la pantalla vacía después de cada
  reinicio de la placa.
- Todo se crea una sola vez al arrancar (las dos vistas, los 12 mosaicos) y después solo cambia
  el texto o se muestra/esconde; un texto igual al que ya está no se vuelve a poner, porque en
  el panel RGB cualquier cambio repinta la pantalla entera.
- `DashboardPayload` se **deriva** del esquema zod del protocolo: el encoder descarta en silencio
  cualquier clave que no esté en el esquema, así que un campo nuevo sin declarar ahora es un
  error de compilación.

### Einstein (retirado) — `main/assets/einstein/`, `tools/convert-einstein.sh`

Sprite pixel art con 9 animaciones (57 frames, 150×163 RGB565A8) que vivía en una esquina del
tablero. Con las vistas Inicio/Casa **ya no se dibuja**: su lugar lo ocupa la franja de
conversación. Los frames siguen en el repo y CMake los sigue empaquetando en la partición de
assets, así que volver a usarlos no requiere regenerar nada.

### Lo que se ve durante un turno — `turn/caption.ts`, `turn/streaming.ts`

1. Lo que escuchó, entre comillas (si el STT entendió mal, se ve al instante).
2. Un cartel por herramienta ("Calculando el viaje…") con un color por familia.
3. El texto del modelo escribiéndose en vivo, y después la frase que está diciendo.

La fuente de la placa no tiene emojis: los carteles son texto y la diferencia visual la hace el
color del anillo.

### Micrófono solo cuando lo pedís — `main/application.cc`, `Kconfig.projbuild`

Por defecto la placa **no escucha la casa**: en reposo el micrófono está apagado y la palabra
de activación no corre (el modelo sigue en el binario; `CONFIG_JARVIS_ALWAYS_LISTEN=y` la
vuelve a prender). El micrófono se abre de tres maneras:

| Cómo | Qué hace |
|---|---|
| **Tocar Hablar** (pantalla o pulsador en `CONFIG_JARVIS_TALK_BUTTON_GPIO`) | Abre una ventana: espera hasta 30 s a que empieces; una vez que hablaste, envía tras 5 s de silencio. Mientras hablás se extiende. Otro toque reinicia los plazos. Tope: 3 minutos. |
| **Mantener Hablar** (o la pantalla en cualquier lado) | Push-to-talk: graba mientras está apretado, soltar envía. |
| **Tocar Enviar** | Corta la escucha y manda lo grabado, sin esperar el silencio. |

Tocar fuera de los botones con el micrófono abierto lo descarta, como antes. Mantener apretado
graba en cualquier lado salvo sobre Enviar, una pestaña o un mosaico. Si Jarvis responde
con una pregunta, el micrófono se reabre con las mismas reglas de la ventana. Los plazos se
cambian en `sdkconfig.defaults` (`CONFIG_JARVIS_TALK_WINDOW_SECONDS`,
`CONFIG_JARVIS_TALK_WINDOW_SILENCE_MS`).

### Port a la Waveshare 4.3" — `main/boards/waveshare/esp32-s3-touch-lcd-4.3c/`

Apollo solo soportaba una pantalla redonda de 1,85". El board se tomó de xiaozhi-esp32 y se le
aplicó el mismo delta que Apollo le aplica a la suya: panel **RGB paralelo** (sin `panel_io`:
el dibujado es sincrónico), touch **GT911** en vez de CST816S, `bits_per_pixel` en vez de
`in_color_format` (ESP-IDF 5.5.2), layout 800×480 y reloj de píxel a 16 MHz (a 21 MHz la PSRAM
no daba abasto con `full_refresh` y parpadeaba).

---

## Integraciones

- **Notion** (`notion/`): la base de Notion es un espejo editable de las listas. El SQLite de la
  Pi sigue siendo la fuente de verdad; la reconciliación es completa e idempotente cada 60 s
  (alta en cualquier lado, vincular en vez de duplicar, tildar "Hecho" borra, editar en Notion
  gana). Por REST con token de integración interna porque el MCP alojado de Notion exige un
  redirect HTTPS que una LAN no tiene.
- **Búsqueda web** (`search/tavily.ts`): 3 resultados y sin el texto completo de las páginas
  (la respuesta pasó de 54 mil a 4,7 mil caracteres de contexto).
- **Parlante externo y Spotify** (`speaker/output.ts`, `tools/speaker.ts`, `infra/speaker/`):
  modos `avisos` (solo avisos al parlante), `todo` o `apagado`, cambiables por voz. La placa
  recibe silencio del mismo largo para que su estado no cambie. La música baja al 18 % desde
  "Hey Jarvis" hasta el final del turno: la cancelación de eco de la placa no conoce el audio de
  la Pi.

---

## Operación

- **Costos** (`costs/ledger.ts`): cada llamada a OpenRouter guarda su `usage.cost` exacto en
  `api_costs`, y cada llamada a Claude su costo calculado (`llm_claude`, ver arriba). Más un
  tracker horario del consumo de la key de OpenRouter (`infra/costs/cost-tracker.py`).
- **Latencia medida por etapa** (`turn/run.ts`): `apollo_turn_timings` con STT, memoria,
  router, cada llamada al LLM, cada herramienta por nombre, TTS, y un `sin_medir` que si crece
  avisa que hay una etapa sin instrumentar.
- **Firmware por WiFi** (`ota/routes.ts`, `infra/publish-firmware.sh`): verifica que la versión
  grabada en el binario sea la anunciada (si no, la placa se reinstalaría en cada arranque),
  lo sube al almacén de Apollo y opcionalmente le pide a la placa que se reinicie.
- **Informe de arranque** (`protocol/schema.ts`, `main/application.cc`): motivo del último
  reinicio, nota del guardián y resumen del coredump, logueado en el servidor.
- **Guardianes de la Pi** (`infra/system/`): `disk-guard.sh` libera caché de Docker/apt/journal
  si el disco pasa el 90 % (una SD llena dejó un deploy a medias), `wifi-guard.sh` reconecta si
  la Pi pierde el router.
