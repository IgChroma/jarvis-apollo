import type { HomeTile, ServerToDeviceMessage } from '@/protocol/schema';
import { resolveCalendarDateInTimeZone } from '@/time/zone';

import {
  AGENDA_DASHBOARD_MAX_ENTRY_COUNT,
  AGENDA_TITLE_MAX_CHARACTER_COUNT,
  DEFAULT_AGENDA_TIMEZONE,
  buildUpcomingAgendaEntryList,
  formatLocalTime,
  isSameLocalDate,
  listEventLocalDates,
  listReminderDaysInMonth,
  type AgendaCalendarEvent,
  type AgendaReminder,
} from '@/dashboard/agenda';
import { clipDashboardText, clipDashboardTextWithin } from '@/dashboard/text';

export { clipDashboardText, clipDashboardTextWithin } from '@/dashboard/text';

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
// Agenda v2: hasta 6 entradas y título de hasta 40 (la placa pone el "…" según
// el ancho real de la columna).
export const DASHBOARD_AGENDA_MAX_ENTRY_COUNT = AGENDA_DASHBOARD_MAX_ENTRY_COUNT;
export const DASHBOARD_PENDING_MAX_ITEM_COUNT = 4;
// Medido en la placa: 34 caracteres no entraban en los 288px de la columna y
// LVGL los recortaba con puntos, que se lee peor que un corte por palabra hecho
// acá. Los ítems son notas libres y pueden ser larguísimos: en una tarjeta que
// se mira de reojo importa reconocer cuál es, no leerlo entero.
export const DASHBOARD_PENDING_MAX_CHARACTER_COUNT = 24;
export const DASHBOARD_AGENDA_MAX_CHARACTER_COUNT = AGENDA_TITLE_MAX_CHARACTER_COUNT;

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
export type DashboardShoppingTile = NonNullable<DashboardPayload['shopping']>;
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
  // Agenda v2: con id, ícono y detalle (dashboard/agenda.ts).
  readonly calendarEventList?: readonly AgendaCalendarEvent[];
  // Mosaicos de la vista Casa ya traducidos desde HA, sin recortar.
  // `undefined` = no hay Home Assistant configurado o no respondió.
  readonly homeTileList?: readonly HomeTile[];
  readonly dollarBlue?: {
    readonly buy: number;
    readonly sell: number;
    readonly updatedAtMilliseconds: number;
  };
  readonly reminderList?: readonly AgendaReminder[];
  // Lista interna de pendientes de Jarvis.
  readonly pending?: DashboardSourceList;
  // Agenda v2: la lista de compras de Home Assistant (todo.shopping_list).
  // `undefined` = sin HA o sin la lista; vacía también se manda.
  readonly shopping?: DashboardSourceList;
  readonly travel?: { readonly destinationLabel: string; readonly minutes: number };
  readonly nowMilliseconds: number;
};

export type DashboardSourceList = {
  readonly listName: string;
  readonly count: number;
  readonly itemList: readonly string[];
};

// "Sin datos" es lo que devuelve el clima cuando el proveedor falla: dejar la
// tarjeta afuera se lee mejor que mostrarla vacía.
const UNAVAILABLE_CONDITION_LABEL = 'Sin datos';

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

export function buildMonthCalendar(input: {
  readonly timezone: string;
  readonly nowMilliseconds: number;
  readonly calendarEventList: NonNullable<DashboardSourceData['calendarEventList']>;
  // Agenda v2: los días con recordatorios de Jarvis también se marcan.
  readonly reminderList?: readonly AgendaReminder[];
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

  for (const day of listReminderDaysInMonth({
    reminderList: input.reminderList ?? [],
    timezone: input.timezone,
    month: today,
  })) {
    eventDaySet.add(day);
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

function buildListCard(list: DashboardSourceList): DashboardPendingTile {
  return {
    listName: list.listName,
    count: list.count,
    itemList: list.itemList
      .slice(0, DASHBOARD_PENDING_MAX_ITEM_COUNT)
      .map((item) => clipDashboardText(item, DASHBOARD_PENDING_MAX_CHARACTER_COUNT))
      .filter((item) => item.length > 0),
  };
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

  // Agenda v2: cada entrada con id, ícono y detalle para el modal. Sin zona
  // (no se pudo resolver la ubicación) se usa la de Buenos Aires: las
  // etiquetas "hoy 11:00" necesitan una.
  payload.agendaList = buildUpcomingAgendaEntryList({
    calendarEventList: input.calendarEventList ?? [],
    reminderList: input.reminderList ?? [],
    timezone: input.timezone ?? DEFAULT_AGENDA_TIMEZONE,
    nowMilliseconds: input.nowMilliseconds,
    maximumEntryCount: DASHBOARD_AGENDA_MAX_ENTRY_COUNT,
  });

  if (input.pending !== undefined && input.pending.count > 0) {
    payload.pending = buildListCard(input.pending);
  }

  // Compras sale aunque esté vacía: la placa ofrece la pestaña solo si vino.
  if (input.shopping !== undefined) {
    payload.shopping = buildListCard(input.shopping);
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
      reminderList: input.reminderList ?? [],
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
