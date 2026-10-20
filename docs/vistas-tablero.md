# Vistas del tablero: contrato entre servidor y placa

El tablero tiene **dos vistas**: Inicio y Casa. Se cambian con pestañas arriba o
deslizando el dedo a izquierda o derecha. El deslizamiento ya no cambia el modo de
habla: lo maneja la placa y no se manda como gesto.

## Qué muestra cada vista

**Inicio** (1024×600 en la P4-7B, 800×480 en la 4.3C):

- **Izquierda:** agenda. Son los próximos eventos de los calendarios de Home
  Assistant mezclados con los recordatorios de Jarvis, como hoy. La tarjeta de clima
  sale de esta columna.
- **Centro:** pendientes, como hoy.
- **Abajo de izquierda y centro**, con el ancho de las dos: una franja de conversación, que
  reemplaza a Einstein. Muestra el estado ("Escuchando", "Pensando"...) y hasta 4 renglones del
  texto de lo que oyó o dice Jarvis (`status_label_`, `notification_label_` y la burbuja de
  texto).
- **Derecha:** de arriba hacia abajo:
  - Un calendario del mes, con los días que tienen eventos marcados y hoy resaltado.
  - El clima de tu ciudad: temperatura, condición (con el dólar blue promedio al lado, si
    `home.dollarBlue` viene) y mínima/máxima del día.
  - Los botones Hablar y Enviar.

  **Einstein se elimina.**

**Casa:** una grilla de mosaicos con las entidades de Home Assistant que tienen la
etiqueta `jarvis`, más una tarjeta con el dólar blue. Hay tres tipos de mosaico:

- **Interruptor** (`light.*`, `switch.*`, `fan.*`, `input_boolean.*`): nombre y estado.
  Un toque lo prende o lo apaga.
- **Sensor** (`sensor.*`, `binary_sensor.*`): nombre, valor y unidad. No se toca.
- **Clima** (`climate.*`): nombre, temperatura actual, temperatura objetivo, modo y
  botones − y +, que mueven 0,5 °C.

## Mensaje servidor → placa: `dashboard`

Se extiende el mensaje existente con claves **opcionales**: una placa vieja las
ignora. El esquema zod de `server/overlay/apps/agent/src/protocol/schema.ts` es la
fuente de verdad, y este documento lo describe.

```jsonc
{
  "type": "dashboard",
  "clock": { "timezone": "America/Argentina/Buenos_Aires", "isoNow": "..." },   // existente
  "weather": {                       // existente, se agregan campos opcionales
    "locationLabel": "Ing. Maschwitz",
    "temperatureC": 21.4,
    "conditionLabel": "Parcialmente nublado",
    "updatedAt": "...",
    "conditionCode": "partlycloudy", // NUEVO, opcional: condición cruda de HA (sunny, rainy, cloudy...)
    "minC": 12.0,                    // NUEVO, opcional
    "maxC": 24.5,                    // NUEVO, opcional
    "humidityPercent": 63            // NUEVO, opcional
  },
  "agendaList": [ { "title": "...", "whenLabel": "en 40 minutos" } ],   // existente
  "pending": { ... },                                                   // existente
  "travel": { ... },                                                    // existente
  "monthCalendar": {                 // NUEVO, opcional
    "year": 2026, "month": 10,       // month 1-12
    "todayDay": 18,
    "firstWeekday": 3,               // día de la semana del 1º del mes, 0=lunes … 6=domingo (1/10/2026 = jueves)
    "dayCount": 31,
    "eventDayList": [3, 18, 22],     // días del mes con al menos un evento
    "todayEventList": [              // hasta 4, ya recortados
      { "timeLabel": "18:30", "title": "Dentista" },
      { "timeLabel": "Todo el día", "title": "Cumple Nico" }
    ]
  },
  "home": {                          // NUEVO, opcional: vista Casa
    "tileList": [                    // hasta 12, en el orden en que se muestran
      { "entityId": "light.living", "name": "Living", "kind": "toggle", "isOn": true, "available": true },
      { "entityId": "sensor.temp_patio", "name": "Patio", "kind": "sensor", "value": "18.2", "unit": "°C", "available": true },
      { "entityId": "climate.dormitorio", "name": "Aire dormitorio", "kind": "climate",
        "currentC": 24.0, "targetC": 22.5, "hvacMode": "cool", "available": true }
    ],
    "dollarBlue": { "buy": 1180, "sell": 1200, "updatedLabel": "hace 12 min" }   // opcional
  }
}
```

Límites que recorta el servidor (no la placa):

- `name`: 18 caracteres.
- `title` del día: 22 caracteres.
- `value`: 10 caracteres.
- `tileList`: 12 mosaicos.
- `todayEventList`: 4 eventos.

Los largos son en caracteres (no bytes) y **totales**: si el servidor corta, el "…"
cuenta dentro del límite. Un acento o el "…" ocupan más de un byte en UTF-8.

Detalles de lo que manda el servidor (implementación, `server/overlay/apps/agent/src`):

- **Mosaicos**, por tipo (`kind`): `toggle` siempre trae `isOn`; `sensor` siempre trae
  `value` (y `unit` solo si la entidad la tiene); `climate` trae `currentC`, `targetC` y
  `hvacMode` solo si los conoce. Con `available: false` el `value` de un sensor es `"—"`
  y no viene `unit` ni `hvacMode`. Un `binary_sensor` viene traducido ("Abierta",
  "Cerrada", "Movimiento", "Sí"/"No"...). Orden: interruptores, climas, sensores; cada
  grupo por nombre.
- **`monthCalendar` sale siempre**, con o sin Home Assistant (sin HA, `eventDayList` y
  `todayEventList` vacíos): la grilla del mes con hoy resaltado sirve sola. Marca los
  días con eventos de calendario y, desde la Agenda v2, también los días con recordatorios
  (`todayEventList` sigue siendo solo de calendario). En `todayEventList` van primero los que
  tienen hora, en orden, y después los de todo el día; un evento con hora que empezó
  otro día y sigue hoy cuenta como "Todo el día".
- **`home` sale si hay Home Assistant o hay dólar**: sin HA pero con dólar viene
  `"tileList": []`; con HA pero sin nada etiquetado, también `[]`. Sin ninguno de los
  dos, `home` no viene.
- `weather` con `conditionCode`/`minC`/`maxC`/`humidityPercent` sale de HA; si HA no
  tiene clima o no responde, sale el de open-meteo sin esos campos.

## Mensaje placa → servidor: `ha_action`

```jsonc
{ "type": "ha_action", "entityId": "light.living", "action": "toggle", "ts": 123 }
// action: "toggle" | "climate_up" | "climate_down"
```

El servidor llama al servicio de Home Assistant que corresponde:

- `homeassistant.toggle`.
- `climate.set_temperature` con objetivo ± 0,5.

Después **empuja el tablero enseguida**, sin esperar la vuelta de 10 s, para que el
mosaico cambie en menos de un segundo. La placa además pinta el cambio de inmediato
y la próxima actualización lo confirma o lo corrige.

## Home Assistant desde el servidor

- **Dentro del add-on** (`homeassistant_api: true` en `config.yaml`): base
  `http://supervisor/core/api`, con el token de la variable de entorno
  `SUPERVISOR_TOKEN`.
- **Fuera de Home Assistant:** `HA_URL` (por ejemplo `http://192.168.0.111:8123`) y
  `HA_TOKEN`, que es un token de larga duración y va al Llavero.
- **Sin ninguna de las dos:** las tarjetas de Home Assistant no se mandan y todo lo
  demás anda igual.

Qué se lee:

- **Estados:** `GET /api/states` (todos, un solo pedido) en cada vuelta de 10 s, sin
  caché: es lo que tiene que reflejar un toque. Si HA no contesta, se deja de
  consultar 30 s.
- **Etiqueta:** `POST /api/template` con `{{ label_entities('jarvis') | list | tojson }}`,
  cacheada 1 minuto.
- **Calendarios:** los `calendar.*` con la etiqueta. Si ninguno la tiene, todos.
  Usa `GET /api/calendars/<id>?start=…&end=…` (del 1º del mes hasta fin de mes o una
  semana adelante, lo que sea más tarde), con caché de 5 minutos.
- **Clima:** el primer `weather.*` con la etiqueta, o si no `weather.home`. El estado
  sale de la lista de `/api/states` y la mín./máx. de `weather.get_forecasts` (diario) con
  `?return_response`, cacheado 30 minutos.
- **Dólar blue:** `https://dolarapi.com/v1/dolares/blue`, cacheado 15 minutos.
- **`ha_action`:** solo sobre entidades que tienen la etiqueta en ese momento, con id
  `dominio.objeto` válido y una acción que corresponda al tipo (`toggle` para
  interruptores, `climate_up`/`climate_down` para climas, con objetivo limitado a
  `min_temp`/`max_temp` de la entidad). Lo demás se ignora con una línea de log, sin
  error a la placa; el tablero se empuja igual para que la placa deshaga lo que pintó.
- **Por voz** (`casa_listar`, `casa_estado`, `casa_controlar`): la misma etiqueta y la misma
  conexión; después de un cambio por voz también se empuja el tablero. Reglas en
  [home-assistant-setup.md](home-assistant-setup.md#la-casa-por-voz-add-on-050).

## Agenda v2 (add-on 0.6.0): eventos tocables, agenda por día y lista de compras

### Cambios en `dashboard`

**`agendaList`:** cada entrada suma campos opcionales. Una placa vieja los ignora; `title` y
`whenLabel` siguen igual.

```jsonc
{
  "id": "hogar:01JB…",          // estable: "<calendario>:<uid>" o "recordatorio:<id>"
  "title": "Dentista",          // título corto (≤ 18 caracteres)
  "icon": "salud",              // categoría para el ícono (lista cerrada, ver abajo)
  "whenLabel": "en 3 días",     // "hoy 11:00", "mañana 9:30", "en 3 días"
  "detail": {
    "fullTitle": "Turno con la dentista en OdontoSalud",
    "dateLabel": "jueves 23 de octubre",
    "timeLabel": "11:00 a 12:00",  // o "Todo el día"
    "location": "OdontoSalud, Ing. Maschwitz",   // opcional
    "description": "…",                          // opcional, ≤ 200 caracteres
    "sourceLabel": "Calendario Hogar"            // o "Recordatorio de Jarvis"
  }
}
```

- `agendaList` lleva hasta **6** entradas.
- El recorte de `title` pasa de 22 a **40 caracteres**: el "…" del final lo pone la placa
  según el ancho real de la columna.

**Íconos (`icon`):** la placa no puede dibujar emoji, porque sus fuentes no los tienen. La lista
cerrada es: `salud`, `auto`, `cumple`, `compras`, `casa`, `pago`, `viaje`, `trabajo`,
`escuela`, `deporte`, `comida`, `mascota`, `reunion`, `otro`.

- La placa traduce cada categoría a un glifo de su fuente de íconos o, si no lo hay, a una
  marca de color.
- En Home Assistant el evento se guarda con emoji en el título ("🦷 Dentista").

**`monthCalendar.eventDayList`:** suma los días con recordatorios de Jarvis, además de los de
los calendarios.

**`pending` y `shopping` (tarjeta alternable):** la tarjeta del centro alterna entre dos listas.
- **`pending`:** sigue siendo la lista interna de pendientes de Jarvis, sin cambios.
- **`shopping`:** clave **nueva**, con la misma forma (`listName`, `count`, `itemList`). Sale de
  **`todo.shopping_list`** de Home Assistant, con `listName: "Compras"` y solo los ítems sin
  completar. No viene si no hay Home Assistant o si la lista no existe.
- **En la placa:** la cabecera muestra el nombre de la lista activa entre dos flechas,
  "‹ PENDIENTES ›". Un toque firme en cualquiera de las flechas (blanco de unos 40 px) pasa a la
  otra lista. La placa recuerda la última elegida hasta reiniciar.
- **Lista ausente:** si una de las dos no vino, no se ofrece y las flechas no se muestran. Con
  `pending` presente, que falte `shopping` quiere decir "no hay lista de compras"; un mensaje sin
  `pending` (el otro emisor) deja las dos listas como estaban.

### Agenda de un día

**Placa → servidor:**

```jsonc
{ "type": "agenda_day_request", "date": "2026-10-23", "ts": 123 }
```

**Servidor → placa:**

```jsonc
{
  "type": "agenda_day",
  "date": "2026-10-23",
  "dateLabel": "jueves 23 de octubre",
  "entryList": [ /* mismas entradas que agendaList, hasta 12, ordenadas por hora */ ]
}
```

Un día sin nada llega con `entryList: []`.

### En la pantalla

- **Tocar un evento** (en la agenda de Inicio o en la de un día) abre un **detalle modal**:
  - muestra título completo, fecha, horario, lugar, descripción y origen;
  - se cierra con un botón **Cerrar**.
- **Tocar un día del calendario del mes** pide `agenda_day` y muestra la **vista de ese día**:
  - la lista de eventos, cada uno tocable;
  - un botón **Cancelar** que vuelve a Inicio.
  - Mientras espera la respuesta muestra "Cargando…"; si no llega en 5 s, "No pude traer la
    agenda".

### Voz

- **`agenda_agregar`** crea un evento en `calendar.hogar` (configurable) con
  `calendar.create_event`:
  - **Obligatorios:** fecha y hora. "Todo el día" también vale.
  - **Opcionales:** lugar, duración (default 1 h) y descripción.
  - **Los arma el modelo:** `titulo_corto` (≤ 18 caracteres), `emoji` y `icono` (de la lista
    cerrada).
  - **En Home Assistant:** el resumen guardado es `"<emoji> <titulo_corto>"` y la descripción
    lleva el título largo.
  - **Nada de preguntas extra:** no pregunta cómo va a ir ni ofrece calcular la salida, y no
    crea recordatorios aparte.
- **`agenda_listar`:** eventos de un rango de fechas.
- **`agenda_borrar`:** borra por id (`calendar/event/delete` por WebSocket). Solo en
  calendarios locales.
- **Fuera de `agenda_crear`:** `avisar_para_salir` sale de esa intención y queda solo en
  `viaje`, donde se pide explícitamente.
- **Listas:** `read_list`, `add_to_list` y `remove_from_list` deciden por el nombre de la lista.
  - **Compras** ("lista de compras", "súper", "compras"): van a `todo.shopping_list`
    (`todo.get_items`, `todo.add_item`, `todo.remove_item`) cuando hay Home Assistant.
  - **Pendientes:** siguen en la lista interna de Jarvis.

### Detalles del servidor (implementación, add-on 0.6.0)

Lo que el contrato de arriba no fija y el servidor resolvió así. Todo es aditivo: no cambia
ningún campo ni su tipo.

- **`id` de una repetición:** un evento que es una instancia de una serie lleva además
  `#<recurrence_id>` ("hogar:abc@google.com#20261019T220000Z"), porque borrar sin él borra la
  serie entera. Un evento sin `uid` (alguna integración de HA) viaja **sin `id`**. La placa
  tiene que tratar el `id` como texto opaco de hasta 200 caracteres.
- **`icon`:** el servidor lo manda siempre (`otro` si no hay emoji reconocible). Los
  recordatorios de Jarvis también derivan el ícono de un emoji inicial; casi siempre son `otro`.
- **`whenLabel` en `agendaList`:** si falta menos de una hora, "en 40 minutos" (como antes);
  si no, "hoy 11:00", "mañana 9:30" (sin el cero de adelante), y desde pasado mañana "en N
  días", contados por día de calendario. Los de todo el día: "hoy", "mañana", "en N días".
- **`whenLabel` en `agenda_day`:** como la fecha ya está en la cabecera, es la hora ("8:00")
  o "Todo el día". Van primero los de todo el día y los que empezaron otro día y siguen, y
  después el resto por hora, recordatorios incluidos.
- **Largos del detalle** (totales, con el "…"): `fullTitle` y `location` hasta 100,
  `description` hasta 200 y conserva los saltos de línea. `timeLabel`: "11:00 a 12:00",
  "11:00" si no tiene fin, "Todo el día", y "9:00 a 18:00 del viernes 23" si termina otro día.
  `dateLabel` de un evento de varios días: "jueves 22 de octubre al sábado 24 de octubre".
- **`fullTitle` y `description` de un evento de HA:** los que crea `agenda_agregar` guardan
  el título largo en la primera línea de la descripción y el resto después de una línea en
  blanco. El servidor lo separa solo si el resumen empieza con emoji y esa primera línea
  comparte una palabra con el título corto; si no, `fullTitle` es el título y la descripción
  va entera.
- **`sourceLabel`:** "Calendario " + el nombre amigable del calendario en HA ("Calendario
  Hogar"); "Recordatorio de Jarvis" para los recordatorios.
- **Qué calendarios:** la regla de siempre (los etiquetados `jarvis`; si ninguno, todos) **más
  el de `agenda_calendar`** si existe, para que lo que se agenda por voz se vea aunque no
  tenga la etiqueta. Vale para `agendaList`, `monthCalendar`, `agenda_day` y `agenda_listar`.
- **`shopping` vacía:** si la lista existe pero no tiene nada por comprar, viene con
  `count: 0` e `itemList: []`, así la pestaña se ofrece igual. `pending` vacía sigue sin venir.
- **`agenda_day_request` inválido:** una fecha que no es `AAAA-MM-DD` real (o fuera de
  2000-2100) se ignora con una línea de log; no hay respuesta ni error a la placa. Sin Home
  Assistant, o si no responde, el día llega igual con los recordatorios.
