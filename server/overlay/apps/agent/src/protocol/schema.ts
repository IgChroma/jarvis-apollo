import { z } from 'zod';

export const deskUiStateSchema = z.enum([
  'idle',
  'listening',
  'thinking',
  'confirm',
  'speaking',
  'focus',
  'dashboard',
]);

export type DeskUiStateName = z.infer<typeof deskUiStateSchema>;

export const deskFaceEmotionSchema = z.enum([
  'neutral',
  'curious',
  'focused',
  'questioning',
  'talking',
  'calm',
]);

export type DeskFaceEmotionName = z.infer<typeof deskFaceEmotionSchema>;

// Los swipes quedan en el esquema aunque el firmware de las vistas Inicio/Casa
// ya no los manda (los usa para cambiar de vista, docs/vistas-tablero.md): una
// placa con firmware viejo los sigue mandando y no tiene que recibir un error.
export const deviceGestureSchema = z.enum([
  'tap',
  'double_tap',
  'swipe_left',
  'swipe_right',
]);

export const deskSoundEffectSchema = z.enum(['ding', 'chime', 'error', 'low_battery']);

export type DeskSoundEffectName = z.infer<typeof deskSoundEffectSchema>;

export const confirmCloseReasonSchema = z.enum(['resolved', 'expired', 'orphaned']);

export type ConfirmCloseReasonName = z.infer<typeof confirmCloseReasonSchema>;

// Lo que se puede hacer desde un mosaico de la vista Casa.
export const homeAssistantTileActionSchema = z.enum([
  'toggle',
  'climate_up',
  'climate_down',
]);

export type HomeAssistantTileAction = z.infer<typeof homeAssistantTileActionSchema>;

// Mosaicos de la vista Casa. Un union por `kind` en vez de un objeto con todo
// opcional: así un mosaico de interruptor sin `isOn` es un error de compilación
// en el servidor y no una tarjeta que la placa dibuja a medias.
const homeTileBaseShape = {
  entityId: z.string().min(1),
  name: z.string().min(1),
  available: z.boolean(),
};

export const homeTileSchema = z.discriminatedUnion('kind', [
  z.object({
    ...homeTileBaseShape,
    kind: z.literal('toggle'),
    isOn: z.boolean(),
  }),
  z.object({
    ...homeTileBaseShape,
    kind: z.literal('sensor'),
    value: z.string().min(1),
    unit: z.string().min(1).optional(),
  }),
  z.object({
    ...homeTileBaseShape,
    kind: z.literal('climate'),
    currentC: z.number().optional(),
    targetC: z.number().optional(),
    hvacMode: z.string().min(1).optional(),
  }),
]);

export type HomeTile = z.infer<typeof homeTileSchema>;

// Agenda v2 (docs/vistas-tablero.md): categoría del ícono de un evento. La
// placa no tiene emoji en sus fuentes; traduce cada categoría a un glifo propio.
export const AGENDA_ICON_LIST = [
  'salud',
  'auto',
  'cumple',
  'compras',
  'casa',
  'pago',
  'viaje',
  'trabajo',
  'escuela',
  'deporte',
  'comida',
  'mascota',
  'reunion',
  'otro',
] as const;

export const agendaIconSchema = z.enum(AGENDA_ICON_LIST);

export type AgendaIcon = z.infer<typeof agendaIconSchema>;

// Una entrada de agenda: la del tablero (`agendaList`) y la de la vista de un
// día (`agenda_day`). `id`, `icon` y `detail` son opcionales: una placa vieja
// los ignora y sigue dibujando `title` + `whenLabel`.
export const agendaEntrySchema = z.object({
  id: z.string().min(1).max(200).optional(),
  title: z.string().min(1),
  icon: agendaIconSchema.optional(),
  whenLabel: z.string().min(1),
  detail: z
    .object({
      fullTitle: z.string().min(1),
      dateLabel: z.string().min(1),
      timeLabel: z.string().min(1),
      location: z.string().min(1).optional(),
      description: z.string().min(1).max(200).optional(),
      sourceLabel: z.string().min(1),
    })
    .optional(),
});

export type AgendaEntry = z.infer<typeof agendaEntrySchema>;

// Tarjeta de lista del centro: pendientes (interna) y compras (Home Assistant).
const listCardSchema = z.object({
  listName: z.string().min(1),
  count: z.number().int().nonnegative(),
  itemList: z.array(z.string().min(1)),
});

export const deviceToServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    deviceId: z.string().min(1),
    ts: z.number().int().nonnegative(),
    // Lo que sabe hacer este firmware. "reminder_seen": avisa cuando se
    // descarta un recordatorio de la pantalla.
    features: z.array(z.string().max(40)).max(20).optional(),
  }),
  // El recordatorio a pantalla completa se descartó (toque o empezar a hablar).
  z.object({
    type: z.literal('reminder_seen'),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('hold_start'),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('hold_end'),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('wake'),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('audio_end'),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('listen_cancel'),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('gesture'),
    gesture: deviceGestureSchema,
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('confirm'),
    ok: z.boolean(),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('text_input'),
    text: z.string().min(1),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('abort'),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('telemetry'),
    battery: z.number().int().nonnegative().max(100).optional(),
    charging: z.boolean().optional(),
    volume: z.number().int().nonnegative().optional(),
    wifiRssi: z.number().int().optional(),
    firmwareVersion: z.string().min(1).optional(),
    ts: z.number().int().nonnegative(),
  }),
  // Al conectarse después de un arranque, la placa cuenta por qué se reinició:
  // el motivo del chip (energía, pánico, watchdog, esp_restart), lo que anotó el
  // guardián del firmware antes de reiniciar, y el resumen del volcado si hubo un
  // cuelgue. Sin esto una placa que "se quedó muda" y volvió no deja rastro.
  z.object({
    type: z.literal('boot_report'),
    resetReason: z.string().min(1).max(40),
    guardianReason: z.string().max(200).optional(),
    crash: z
      .object({
        task: z.string().max(40).optional(),
        pc: z.string().max(20).optional(),
        backtrace: z.string().max(600).optional(),
      })
      .optional(),
    firmwareVersion: z.string().min(1).max(40).optional(),
  }),
  z.object({
    type: z.literal('mcp'),
    payload: z.object({
      jsonrpc: z.literal('2.0'),
      id: z.number().int(),
      result: z.unknown().optional(),
      error: z
        .object({
          code: z.number().int().optional(),
          message: z.string().min(1),
        })
        .optional(),
    }),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('playback_ack'),
    sequence: z.number().int().nonnegative(),
    playedMilliseconds: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
  }),
  // Un toque en un mosaico de la vista Casa (docs/vistas-tablero.md). El
  // `entityId` se acepta como texto cualquiera a propósito: el formato y si la
  // entidad está habilitada los valida el servidor al ejecutar
  // (homeassistant/actions.ts). Rechazarlo acá le mostraría a la placa un
  // "Mensaje no reconocido" por un mosaico viejo que quedó en pantalla.
  z.object({
    type: z.literal('ha_action'),
    entityId: z.string().min(1).max(255),
    action: homeAssistantTileActionSchema,
    ts: z.number().int().nonnegative(),
  }),
  // Tocar un día del calendario del mes (Agenda v2). La fecha se acepta como
  // texto cualquiera y la valida el servidor (host/actor.ts): una basura se
  // ignora con una línea de log en vez de devolverle un error a la placa.
  z.object({
    type: z.literal('agenda_day_request'),
    date: z.string().min(1).max(40),
    ts: z.number().int().nonnegative(),
  }),
]);

export type DeviceToServerMessage = z.infer<typeof deviceToServerMessageSchema>;

export const serverToDeviceMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ui_state'),
    state: deskUiStateSchema,
    speechMode: z.string().min(1),
    caption: z.string().optional(),
    focusRemainingSec: z.number().int().nonnegative().optional(),
    // Epoch seconds: ui_state pushes are event-driven, so the device needs the
    // whole window to count down locally between pushes.
    focusStartedAt: z.number().int().nonnegative().optional(),
    focusEndsAt: z.number().int().nonnegative().optional(),
    emotion: deskFaceEmotionSchema.optional(),
    accentColor: z.string().optional(),
    // Ánimo de la respuesta ([[cara:...]] del modelo): la cara de Einstein lo
    // usa mientras habla. Firmware viejo lo ignora.
    mood: z.enum(['festejo', 'triste', 'apurado', 'pensativo']).optional(),
  }),
  z.object({
    type: z.literal('confirm_request'),
    id: z.string().min(1),
    summary: z.string().min(1),
    expiresAt: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('confirm_close'),
    id: z.string().min(1),
    reason: confirmCloseReasonSchema,
  }),
  z.object({
    type: z.literal('tts_start'),
    format: z.enum(['mp3', 'wav', 'pcm']),
    // Optional since tts_end closes runs; firmware before 2.7.0 treats a
    // missing total as an empty run, so keep sending it whenever it is known.
    bytes: z.number().int().nonnegative().optional(),
    sequence: z.number().int().nonnegative().optional(),
    sampleRate: z.number().int().positive().optional(),
    channels: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('tts_end'),
  }),
  z.object({
    type: z.literal('tts_aborted'),
  }),
  z.object({
    type: z.literal('timer'),
    // Epoch seconds; both absent means clear whatever arc is showing.
    endsAt: z.number().int().nonnegative().optional(),
    durationSeconds: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('turn_end'),
    expectsReply: z.boolean(),
  }),
  z.object({
    type: z.literal('error'),
    code: z.string().min(1),
    message: z.string().min(1),
  }),
  // Tablero de la pantalla. `clock` y `weather` ya existían pero eran
  // obligatorios: pasan a opcionales porque una tarjeta puede no tener dato
  // (el clima se cae, todavía no hay destino de viaje) y el resto tiene que
  // poder viajar igual. Las tarjetas nuevas son las de la opción A del diseño.
  //
  // OJO: `encodeServerToDeviceMessage` hace `schema.parse()`, que DESCARTA las
  // claves que no estén acá. Un campo que se agregue al payload y no a este
  // esquema desaparece en silencio.
  z.object({
    type: z.literal('dashboard'),
    clock: z
      .object({
        timezone: z.string().min(1),
        isoNow: z.string().min(1),
      })
      .optional(),
    weather: z
      .object({
        locationLabel: z.string().min(1),
        temperatureC: z.number(),
        conditionLabel: z.string().min(1),
        updatedAt: z.string().min(1),
        // Vistas Inicio/Casa: salen del clima de Home Assistant. Con open-meteo
        // (sin HA) no vienen y la placa no dibuja la mín./máx.
        conditionCode: z.string().min(1).optional(),
        minC: z.number().optional(),
        maxC: z.number().optional(),
        humidityPercent: z.number().optional(),
      })
      .optional(),
    agendaList: z.array(agendaEntrySchema).max(6).optional(),
    // Lista interna de pendientes de Jarvis.
    pending: listCardSchema.optional(),
    // Agenda v2: lista de compras de Home Assistant (todo.shopping_list). No
    // viene sin HA o sin la lista; vacía viene con count 0.
    shopping: listCardSchema.optional(),
    travel: z
      .object({
        label: z.string().min(1),
        minutes: z.number().int().nonnegative(),
      })
      .optional(),
    // Calendario del mes de la vista Inicio. Viaja armado (primer día de la
    // semana, cantidad de días) para que la placa no haga aritmética de fechas.
    monthCalendar: z
      .object({
        year: z.number().int(),
        month: z.number().int().min(1).max(12),
        todayDay: z.number().int().min(1).max(31),
        // 0 = lunes … 6 = domingo: la grilla argentina arranca el lunes.
        firstWeekday: z.number().int().min(0).max(6),
        dayCount: z.number().int().min(28).max(31),
        eventDayList: z.array(z.number().int().min(1).max(31)),
        todayEventList: z
          .array(
            z.object({
              timeLabel: z.string().min(1),
              title: z.string().min(1),
            }),
          )
          .max(4),
      })
      .optional(),
    // Vista Casa: mosaicos de Home Assistant y el dólar blue.
    home: z
      .object({
        tileList: z.array(homeTileSchema).max(12),
        dollarBlue: z
          .object({
            buy: z.number(),
            sell: z.number(),
            updatedLabel: z.string().min(1),
          })
          .optional(),
      })
      .optional(),
  }),
  // Respuesta a `agenda_day_request`: lo de ese día, hasta 12 entradas.
  z.object({
    type: z.literal('agenda_day'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dateLabel: z.string().min(1),
    entryList: z.array(agendaEntrySchema).max(12),
  }),
  z.object({
    type: z.literal('background_result'),
    summary: z.string().min(1),
    prompt: z.string().min(1),
    documentKey: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('reminder'),
    message: z.string().min(1),
  }),
  z.object({
    type: z.literal('play_effect'),
    name: deskSoundEffectSchema,
  }),
  z.object({
    type: z.literal('mcp'),
    payload: z.object({
      jsonrpc: z.literal('2.0'),
      // The device's McpServer silently drops string ids, so the integer
      // constraint here is what keeps every request answerable.
      id: z.number().int(),
      method: z.string().min(1),
      params: z.record(z.unknown()).optional(),
    }),
  }),
]);

export type ServerToDeviceMessage = z.infer<typeof serverToDeviceMessageSchema>;

export function parseDeviceToServerMessage(
  rawMessageText: string,
): DeviceToServerMessage {
  return deviceToServerMessageSchema.parse(JSON.parse(rawMessageText));
}

export function encodeServerToDeviceMessage(message: ServerToDeviceMessage): string {
  return JSON.stringify(serverToDeviceMessageSchema.parse(message));
}
