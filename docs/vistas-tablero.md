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
  `todayEventList` vacíos): la grilla del mes con hoy resaltado sirve sola. Marca solo
  eventos de calendario, no recordatorios. En `todayEventList` van primero los que
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
