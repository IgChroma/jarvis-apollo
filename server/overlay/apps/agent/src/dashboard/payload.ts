import { formatTimeUntil } from '@/idle/rotator';
import type { HomeTile, ServerToDeviceMessage } from '@/protocol/schema';
import { resolveCalendarDateInTimeZone } from '@/time/zone';

// Armado del tablero que se le manda a la placa.
//
// La rotación de reposo mostraba UN dato por vez porque el motor de caras solo
// sabía dibujar una franja de texto. Con LVGL la pantalla muestra todo junto, y
// eso cambia la forma del mensaje: en vez de un `caption`, un payload con una
// entrada por tarjeta.
//
// El mensaje `dashboard` YA existe en el protocolo (con `clock` y `weather`),
// solo que el firmware nunca le dio UI. Se lo extiende con las tarjetas nuevas
// en vez de inventar un mensaje paralelo, y el clima conserva la forma de
// `DeskWeatherSnapshot` para no tener dos formatos de lo mismo.
//
// El módulo es puro: recibe los datos ya resueltos y devuelve el objeto que
// viaja por el WebSocket. Los recortes viven acá y no en el firmware, porque
// ajustar un número en TypeScript es gratis y en C cuesta un reflasheo.

// Límites que impone la pantalla de 800x480 con el reparto de la opción A.
export const DASHBOARD_AGENDA_MAX_ENTRY_COUNT = 2;
export const DASHBOARD_PENDING_MAX_ITEM_COUNT = 4;
// Medido en la placa: 34 caracteres no entraban en los 288px de la columna y
// LVGL los recortaba con puntos, que se lee peor que un corte por palabra hecho
// acá. Los ítems son notas libres y pueden ser larguísimos: en una tarjeta que
// se mira de reojo importa reconocer cuál es, no leerlo entero.
export const DASHBOARD_PENDING_MAX_CHARACTER_COUNT = 24;
export const DASHBOARD_AGENDA_MAX_CHARACTER_COUNT = 22;

// Vistas Inicio/Casa (docs/vistas-tablero.md). Estos largos son TOTALES, con
// el "…" incluido: la placa los dibuja en cajas fijas y el contrato dice
// "18 caracteres", no "18 más el punto suspensivo".
export const DASHBOARD_TILE_NAME_MAX_CHARACTER_COUNT = 18;
export const DASHBOARD_TILE_VALUE_MAX_CHARACTER_COUNT = 10;
export const DASHBOARD_TILE_MAX_COUNT = 12;
export const DASHBOARD_TODAY_EVENT_TITLE_MAX_CHARACTER_COUNT = 22;
export const DASHBOARD_TODAY_EVENT_MAX_COUNT = 4;
const ALL_DAY_TIME_LABEL = 'Todo el día';

// El tipo se DERIVA del esquema del protocolo en vez de escribirse a mano.
// Así no pueden divergir, y sobre todo: agregar un campo al payload sin
// declararlo en el esquema pasa a ser un error de compilación en vez de un
// campo que `encodeServerToDeviceMessage` descarta en silencio.
export type DashboardPayload = Extract<ServerToDeviceMessage, { type: 'dashboard' }>;
export type DashboardAgendaEntry = NonNullable<DashboardPayload['agendaList']>[number];
export type DashboardPendingTile = NonNullable<DashboardPayload['pending']>;
export type DashboardTravelTile = NonNullable<DashboardPayload['travel']>;
export type DashboardWeather = NonNullable<DashboardPayload['weather']>;
export type DashboardMonthCalendar = NonNullable<DashboardPayload['monthCalendar']>;
export type DashboardHome = NonNullable<DashboardPayload['home']>;

export type DashboardSourceData = {
  // Con la forma de `DeskWeatherSnapshot` (open-meteo) o la extendida que sale
  // de Home Assistant (mín./máx., condición cruda, humedad).
  readonly weather?: DashboardWeather;
  readonly clock?: { readonly timezone: string; readonly isoNow: string };
  // Zona horaria para el calendario del mes. Sin ella no se arma: "hoy" depende
  // de dónde está la placa, no del UTC del contenedor.
  readonly timezone?: string;
  // Eventos del calendario y recordatorios se mezclan en una sola lista: para
  // quien mira la pantalla las dos cosas son "algo que se viene", y separarlas
  // en dos tarjetas gastaría el doble de espacio para la mitad de información.
  // Los eventos (de Home Assistant) además marcan los días del calendario del
  // mes; los recordatorios no, porque los timers y los avisos recurrentes
  // llenarían el mes de puntos que no son "eventos".
  readonly calendarEventList?: readonly {
    readonly title: string;
    readonly startsAtMilliseconds: number;
    // Fin exclusivo; sin fin, el evento ocupa solo su día de inicio.
    readonly endsAtMilliseconds?: number;
    readonly isAllDay?: boolean;
  }[];
  // Mosaicos de la vista Casa ya traducidos desde HA, sin recortar.
  // `undefined` = no hay Home Assistant configurado o no respondió.
  readonly homeTileList?: readonly HomeTile[];
  readonly dollarBlue?: {
    readonly buy: number;
    readonly sell: number;
    readonly updatedAtMilliseconds: number;
  };
  readonly reminderList?: readonly {
    readonly text: string;
    readonly dueAtMilliseconds: number;
  }[];
  readonly pending?: {
    readonly listName: string;
    readonly count: number;
    readonly itemList: readonly string[];
  };
  readonly travel?: { readonly destinationLabel: string; readonly minutes: number };
  readonly nowMilliseconds: number;
};

// "Sin datos" es lo que devuelve el clima cuando el proveedor falla: dejar la
// tarjeta afuera se lee mejor que mostrarla vacía.
const UNAVAILABLE_CONDITION_LABEL = 'Sin datos';

export function clipDashboardText(text: string, maximumCharacterCount: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maximumCharacterCount) {
    return collapsed;
  }
  const clipped = collapsed.slice(0, maximumCharacterCount);
  const lastSpaceIndex = clipped.lastIndexOf(' ');
  // Un corte muy al principio deja una palabra sola y se entiende menos que
  // cortar al medio de la última.
  const trimmed = lastSpaceIndex > maximumCharacterCount / 2
    ? clipped.slice(0, lastSpaceIndex)
    : clipped;
  return `${trimmed}…`;
}

/** Como `clipDashboardText`, pero el resultado (con "…") nunca pasa del máximo. */
export function clipDashboardTextWithin(text: string, maximumCharacterCount: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maximumCharacterCount) {
    return collapsed;
  }
  return clipDashboardText(collapsed, Math.max(1, maximumCharacterCount - 1));
}

/** "hace 12 min": cuánto hace que se actualizó un dato que se cachea. */
export function formatTimeAgo(atMilliseconds: number, nowMilliseconds: number): string {
  const elapsedMinutes = Math.floor((nowMilliseconds - atMilliseconds) / 60_000);
  if (elapsedMinutes < 1) {
    return 'recién';
  }
  if (elapsedMinutes < 60) {
    return `hace ${elapsedMinutes} min`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `hace ${elapsedHours} h`;
  }
  const elapsedDays = Math.floor(elapsedHours / 24);
  return elapsedDays === 1 ? 'hace 1 día' : `hace ${elapsedDays} días`;
}

type LocalDate = { readonly year: number; readonly month: number; readonly day: number };

function isSameLocalDate(left: LocalDate, right: LocalDate): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

// Aritmética de días sobre la fecha de calendario (sin horas): UTC sirve de
// "calendario puro" porque no tiene cambios de hora.
function addDays(date: LocalDate, dayCount: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + dayCount));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function compareLocalDate(left: LocalDate, right: LocalDate): number {
  return left.year - right.year || left.month - right.month || left.day - right.day;
}

// "18:30" en la zona de la placa. Con opciones explícitas y h23: el ICU del
// contenedor no tiene el AM/PM de es-AR (ver time/zone.ts).
function formatLocalTime(timezone: string, atMilliseconds: number): string {
  const partList = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(atMilliseconds));
  const readPart = (type: string) => partList.find((part) => part.type === type)?.value ?? '00';
  return `${readPart('hour')}:${readPart('minute')}`;
}

// Días locales que ocupa un evento, de su inicio a su fin exclusivo. Con tope,
// por si un evento de varios meses llega con un fin absurdo.
const MAXIMUM_EVENT_SPAN_DAY_COUNT = 62;

function listEventLocalDates(
  event: NonNullable<DashboardSourceData['calendarEventList']>[number],
  timezone: string,
): readonly LocalDate[] {
  const firstDate = resolveCalendarDateInTimeZone(timezone, event.startsAtMilliseconds);
  const endsAt = event.endsAtMilliseconds;
  const lastDate =
    endsAt !== undefined && Number.isFinite(endsAt) && endsAt > event.startsAtMilliseconds
      ? resolveCalendarDateInTimeZone(timezone, endsAt - 1)
      : firstDate;
  const dateList: LocalDate[] = [];
  for (
    let date: LocalDate = firstDate;
    compareLocalDate(date, lastDate) <= 0 && dateList.length < MAXIMUM_EVENT_SPAN_DAY_COUNT;
    date = addDays(date, 1)
  ) {
    dateList.push(date);
  }
  return dateList;
}

export function buildMonthCalendar(input: {
  readonly timezone: string;
  readonly nowMilliseconds: number;
  readonly calendarEventList: NonNullable<DashboardSourceData['calendarEventList']>;
}): DashboardMonthCalendar {
  const today = resolveCalendarDateInTimeZone(input.timezone, input.nowMilliseconds);
  // getUTCDay da 0 = domingo; la grilla arranca el lunes (0 = lunes).
  const firstWeekday = (new Date(Date.UTC(today.year, today.month - 1, 1)).getUTCDay() + 6) % 7;
  const dayCount = new Date(Date.UTC(today.year, today.month, 0)).getUTCDate();

  const eventDaySet = new Set<number>();
  const todayTimedList: { readonly atMilliseconds: number; readonly title: string }[] = [];
  const todayAllDayList: string[] = [];
  for (const event of input.calendarEventList) {
    if (!Number.isFinite(event.startsAtMilliseconds)) {
      continue;
    }
    const dateList = listEventLocalDates(event, input.timezone);
    for (const date of dateList) {
      if (date.year === today.year && date.month === today.month) {
        eventDaySet.add(date.day);
      }
    }
    if (!dateList.some((date) => isSameLocalDate(date, today))) {
      continue;
    }
    const startsToday = isSameLocalDate(dateList[0] ?? today, today);
    // Un evento con hora que empezó ayer y sigue hoy se lee como "todo el día":
    // poner la hora de ayer confunde más de lo que informa.
    if (event.isAllDay === true || !startsToday) {
      todayAllDayList.push(event.title);
    } else {
      todayTimedList.push({ atMilliseconds: event.startsAtMilliseconds, title: event.title });
    }
  }

  // Primero lo que tiene hora, en orden; después los de todo el día.
  const todayEventList = [
    ...todayTimedList
      .toSorted((left, right) => left.atMilliseconds - right.atMilliseconds)
      .map((entry) => ({
        timeLabel: formatLocalTime(input.timezone, entry.atMilliseconds),
        title: entry.title,
      })),
    ...todayAllDayList.map((title) => ({ timeLabel: ALL_DAY_TIME_LABEL, title })),
  ]
    .map((entry) => ({
      timeLabel: entry.timeLabel,
      title: clipDashboardTextWithin(entry.title, DASHBOARD_TODAY_EVENT_TITLE_MAX_CHARACTER_COUNT),
    }))
    .filter((entry) => entry.title.length > 0)
    .slice(0, DASHBOARD_TODAY_EVENT_MAX_COUNT);

  return {
    year: today.year,
    month: today.month,
    todayDay: today.day,
    firstWeekday,
    dayCount,
    eventDayList: [...eventDaySet].toSorted((left, right) => left - right),
    todayEventList,
  };
}

function clipHomeTile(tile: HomeTile): HomeTile | undefined {
  const name = clipDashboardTextWithin(tile.name, DASHBOARD_TILE_NAME_MAX_CHARACTER_COUNT);
  if (name.length === 0) {
    return undefined;
  }
  if (tile.kind === 'sensor') {
    const value = clipDashboardTextWithin(tile.value, DASHBOARD_TILE_VALUE_MAX_CHARACTER_COUNT);
    return { ...tile, name, value: value.length > 0 ? value : '—' };
  }
  return { ...tile, name };
}

export function buildHomeCard(input: {
  readonly homeTileList: DashboardSourceData['homeTileList'];
  readonly dollarBlue: DashboardSourceData['dollarBlue'];
  readonly nowMilliseconds: number;
}): DashboardHome | undefined {
  // Sin Home Assistant y sin dólar no hay vista Casa que mandar. Con HA pero
  // sin nada etiquetado sí: la lista vacía le dice a la placa "no hay
  // mosaicos", que no es lo mismo que "no sé".
  if (input.homeTileList === undefined && input.dollarBlue === undefined) {
    return undefined;
  }
  const home: DashboardHome = {
    tileList: (input.homeTileList ?? [])
      .map(clipHomeTile)
      .filter((tile): tile is HomeTile => tile !== undefined)
      .slice(0, DASHBOARD_TILE_MAX_COUNT),
  };
  if (input.dollarBlue !== undefined) {
    home.dollarBlue = {
      buy: input.dollarBlue.buy,
      sell: input.dollarBlue.sell,
      updatedLabel: formatTimeAgo(input.dollarBlue.updatedAtMilliseconds, input.nowMilliseconds),
    };
  }
  return home;
}

export function buildDashboardPayload(input: DashboardSourceData): DashboardPayload {
  const payload: DashboardPayload = { type: 'dashboard', agendaList: [] };

  if (input.clock !== undefined) {
    payload.clock = input.clock;
  }

  // El clima viaja con la forma de upstream y sin redondear: cuántos decimales
  // mostrar es decisión de la pantalla, no del servidor.
  if (
    input.weather !== undefined &&
    input.weather.conditionLabel !== UNAVAILABLE_CONDITION_LABEL
  ) {
    payload.weather = input.weather;
  }

  const upcomingList = [
    ...(input.calendarEventList ?? []).map((event) => ({
      title: event.title,
      atMilliseconds: event.startsAtMilliseconds,
    })),
    ...(input.reminderList ?? []).map((reminder) => ({
      title: reminder.text,
      atMilliseconds: reminder.dueAtMilliseconds,
    })),
  ]
    .filter((entry) => Number.isFinite(entry.atMilliseconds))
    // Lo que ya pasó no es agenda. El recordatorio que suena justo ahora lo
    // anuncia la voz, no hace falta que además ocupe la tarjeta.
    .filter((entry) => entry.atMilliseconds > input.nowMilliseconds)
    .sort((left, right) => left.atMilliseconds - right.atMilliseconds)
    .slice(0, DASHBOARD_AGENDA_MAX_ENTRY_COUNT);

  payload.agendaList = upcomingList.map((entry) => ({
    title: clipDashboardText(entry.title, DASHBOARD_AGENDA_MAX_CHARACTER_COUNT),
    whenLabel: formatTimeUntil(entry.atMilliseconds, input.nowMilliseconds),
  }));

  if (input.pending !== undefined && input.pending.count > 0) {
    payload.pending = {
      listName: input.pending.listName,
      count: input.pending.count,
      itemList: input.pending.itemList
        .slice(0, DASHBOARD_PENDING_MAX_ITEM_COUNT)
        .map((item) => clipDashboardText(item, DASHBOARD_PENDING_MAX_CHARACTER_COUNT))
        .filter((item) => item.length > 0),
    };
  }

  if (input.travel !== undefined) {
    payload.travel = {
      label: input.travel.destinationLabel,
      minutes: Math.round(input.travel.minutes),
    };
  }

  // El calendario del mes sale aunque no haya Home Assistant: la grilla con hoy
  // resaltado sirve sola, y así la columna derecha no queda con un hueco.
  if (input.timezone !== undefined) {
    payload.monthCalendar = buildMonthCalendar({
      timezone: input.timezone,
      nowMilliseconds: input.nowMilliseconds,
      calendarEventList: input.calendarEventList ?? [],
    });
  }

  const home = buildHomeCard({
    homeTileList: input.homeTileList,
    dollarBlue: input.dollarBlue,
    nowMilliseconds: input.nowMilliseconds,
  });
  if (home !== undefined) {
    payload.home = home;
  }

  return payload;
}

/**
 * Compara dos tableros por contenido. La placa se repinta con cada mensaje, así
 * que mandar uno idéntico es trabajo y parpadeo al pedo: el supervisor solo
 * empuja cuando algo cambió de verdad.
 */
export function isSameDashboardPayload(
  left: DashboardPayload,
  right: DashboardPayload,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
