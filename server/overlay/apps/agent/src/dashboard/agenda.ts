import { formatTimeUntil } from '@/idle/rotator';
import type { AgendaEntry, AgendaIcon } from '@/protocol/schema';
import {
  resolveCalendarDateInTimeZone,
  resolveWallClockInstantMilliseconds,
  type CalendarDate,
} from '@/time/zone';

import { clipDashboardTextWithin } from '@/dashboard/text';

// Agenda v2 (docs/vistas-tablero.md): las entradas tocables de la agenda, las
// del tablero y las de la vista de un día, con su detalle ya armado. Todo puro:
// recibe eventos y recordatorios ya leídos y devuelve lo que viaja a la placa.

export const DEFAULT_AGENDA_TIMEZONE = 'America/Argentina/Buenos_Aires';

// Límites (en caracteres, con el "…" incluido). El título lo recorta del todo
// la placa según el ancho real; el servidor solo pone un techo.
export const AGENDA_TITLE_MAX_CHARACTER_COUNT = 40;
export const AGENDA_FULL_TITLE_MAX_CHARACTER_COUNT = 100;
export const AGENDA_LOCATION_MAX_CHARACTER_COUNT = 100;
export const AGENDA_DESCRIPTION_MAX_CHARACTER_COUNT = 200;
export const AGENDA_DASHBOARD_MAX_ENTRY_COUNT = 6;
export const AGENDA_DAY_MAX_ENTRY_COUNT = 12;
export const AGENDA_ALL_DAY_LABEL = 'Todo el día';
export const AGENDA_REMINDER_SOURCE_LABEL = 'Recordatorio de Jarvis';
const AGENDA_DEFAULT_SOURCE_LABEL = 'Calendario';
const HOUR_MILLISECONDS = 60 * 60_000;

// Un evento de calendario ya traducido desde Home Assistant. `title` viene SIN
// el emoji del principio: el emoji se convirtió en `icon`.
export type AgendaCalendarEvent = {
  readonly title: string;
  readonly startsAtMilliseconds: number;
  // Fin exclusivo. En los de todo el día es la medianoche local del día
  // siguiente al último.
  readonly endsAtMilliseconds?: number;
  readonly isAllDay?: boolean;
  // "<calendario>:<uid>" (más "#<recurrence_id>" en una repetición).
  readonly id?: string;
  readonly icon?: AgendaIcon;
  readonly fullTitle?: string;
  readonly description?: string;
  readonly location?: string;
  readonly sourceLabel?: string;
};

export type AgendaReminder = {
  readonly id?: string;
  readonly text: string;
  readonly dueAtMilliseconds: number;
};

// ---- Íconos ----
//
// La placa no dibuja emoji: cada evento viaja con una categoría de una lista
// cerrada. Los que crea Jarvis llevan el emoji en el título ("🦷 Dentista"); los
// creados a mano en Home Assistant, si empiezan con un emoji conocido, también.

const EMOJI_LIST_BY_ICON: Readonly<Record<Exclude<AgendaIcon, 'otro'>, string>> = {
  salud: '🦷🩺💊🏥💉🩻🧠🤒🩹🚑🧑‍⚕️👨‍⚕️👩‍⚕️👁👓🦴🫀🫁🧪🩸',
  auto: '🚗🚙🚘🚕🛞⛽🔧🏎🛻🚐🏍🛵🚦🅿',
  cumple: '🎂🎉🎈🎁🥳🎊🍾',
  compras: '🛒🛍🏪🧺',
  casa: '🏠🏡🔨🧹🪴🌱🔌💡🚿🛠🪛🧯🪚🛋🛏🚪🪟🧽🌳🌿',
  pago: '💰💳💵💸🧾🏦💲🪙📑',
  viaje: '✈🧳🚆🚄🚌🏖🗺🏨🚢⛴🛫🛬🏝⛰🏕🗽🚞',
  trabajo: '💼💻🖥📊📈📉🏢⌨🖨📇',
  escuela: '🏫🎒📚✏🎓📖📝🖍📐',
  deporte: '⚽🎾🏀🏐🏃🚴🏋🧘🏓⛳🏉🥅🏸🏈🥊🤸⛷🏄🏆🥋',
  comida: '🍽🍕🍔🍷🍻☕🥩🍝🍣🥗🍖🍺🥂🍜🌮🥘🍳🧉',
  mascota: '🐶🐕🐱🐈🐾🦮🐩🐹🐰🐦🐟🐴',
  reunion: '👥🤝📅📞🗓🗣👪💬📆🎤📹',
};

// Emoji que usa Jarvis si el modelo manda uno que no se reconoce.
export const AGENDA_CANONICAL_EMOJI_BY_ICON: Readonly<Record<AgendaIcon, string>> = {
  salud: '🩺',
  auto: '🚗',
  cumple: '🎂',
  compras: '🛒',
  casa: '🏠',
  pago: '💳',
  viaje: '✈️',
  trabajo: '💼',
  escuela: '📚',
  deporte: '⚽',
  comida: '🍽️',
  mascota: '🐾',
  reunion: '👥',
  otro: '📌',
};

// Se indexa por el PRIMER punto de código: "✈️" es ✈ + U+FE0F, "🏋️‍♀️" empieza
// con 🏋. Un emoji compuesto cae en la categoría de su primera pieza.
const ICON_BY_FIRST_CODE_POINT: ReadonlyMap<number, AgendaIcon> = (() => {
  const map = new Map<number, AgendaIcon>();
  for (const [icon, emojiText] of Object.entries(EMOJI_LIST_BY_ICON) as [AgendaIcon, string][]) {
    for (const character of emojiText) {
      const codePoint = character.codePointAt(0);
      // Los modificadores y uniones de los compuestos no indexan nada.
      if (codePoint !== undefined && codePoint !== 0x200d && codePoint !== 0xfe0f && !map.has(codePoint)) {
        map.set(codePoint, icon);
      }
    }
  }
  return map;
})();

// Un emoji al principio: pictograma con sus variantes, tonos de piel y uniones
// (ZWJ), o una bandera (dos letras regionales).
const LEADING_EMOJI_PATTERN =
  /^\s*((?:\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier}|‍\p{Extended_Pictographic}️?)*)|(?:\p{Regional_Indicator}{2}))\s*/u;

export function splitLeadingEmoji(text: string): { readonly emoji?: string; readonly rest: string } {
  const match = LEADING_EMOJI_PATTERN.exec(text);
  if (match === null) {
    return { rest: text.trim() };
  }
  return { emoji: match[1], rest: text.slice(match[0].length).trim() };
}

/** ¿Es exactamente UN emoji (con sus modificadores)? */
export function isSingleEmoji(text: string): boolean {
  const { emoji, rest } = splitLeadingEmoji(text);
  return emoji !== undefined && rest.length === 0;
}

export function resolveAgendaIconForEmoji(emoji: string | undefined): AgendaIcon {
  if (emoji === undefined) {
    return 'otro';
  }
  const firstCodePoint = emoji.codePointAt(0);
  if (firstCodePoint === undefined) {
    return 'otro';
  }
  // Una bandera al principio es casi siempre un viaje.
  if (firstCodePoint >= 0x1f1e6 && firstCodePoint <= 0x1f1ff) {
    return 'viaje';
  }
  return ICON_BY_FIRST_CODE_POINT.get(firstCodePoint) ?? 'otro';
}

/**
 * "🦷 Dentista" → título "Dentista", ícono salud. Sin emoji, o con uno que no
 * está en la lista, el ícono es `otro`. Un resumen que es solo un emoji queda
 * como título (mejor eso que una entrada sin nombre).
 */
export function parseAgendaSummary(summary: string): {
  readonly title: string;
  readonly icon: AgendaIcon;
  readonly emoji?: string;
} {
  const trimmed = summary.trim();
  const { emoji, rest } = splitLeadingEmoji(trimmed);
  return {
    title: rest.length > 0 ? rest : trimmed,
    icon: resolveAgendaIconForEmoji(emoji),
    ...(emoji === undefined ? {} : { emoji }),
  };
}

// ---- Fechas locales ----

export type LocalDate = { readonly year: number; readonly month: number; readonly day: number };

const WEEKDAY_NAME_LIST = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTH_NAME_LIST = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

export function isSameLocalDate(left: LocalDate, right: LocalDate): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

// Aritmética de días sobre la fecha de calendario (sin horas): UTC sirve de
// "calendario puro" porque no tiene cambios de hora.
export function addDays(date: LocalDate, dayCount: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + dayCount));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export function compareLocalDate(left: LocalDate, right: LocalDate): number {
  return left.year - right.year || left.month - right.month || left.day - right.day;
}

function daysBetween(from: LocalDate, to: LocalDate): number {
  return Math.round(
    (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) /
      (24 * HOUR_MILLISECONDS),
  );
}

export function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** "2026-10-23" → fecha, o `undefined` si no es una fecha real (30 de febrero, basura). */
export function parseIsoLocalDate(text: string): CalendarDate | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1) {
    return undefined;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }
  return { year, month, day, weekday: date.getUTCDay() };
}

export function formatIsoLocalDate(date: LocalDate): string {
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

/** "jueves 23 de octubre". */
export function formatAgendaDateLabel(date: LocalDate): string {
  return `${WEEKDAY_NAME_LIST[weekdayOf(date)]} ${date.day} de ${MONTH_NAME_LIST[date.month - 1]}`;
}

// "9:30" / "18:30" en la zona de la placa. Opciones explícitas y h23: el ICU
// del contenedor no tiene el AM/PM de es-AR (ver time/zone.ts).
function readLocalClock(timezone: string, atMilliseconds: number): { hour: number; minute: number } {
  const partList = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(atMilliseconds));
  const readPart = (type: string) => Number(partList.find((part) => part.type === type)?.value ?? '0');
  return { hour: readPart('hour') % 24, minute: readPart('minute') };
}

/** "18:30", con dos cifras (la del día de hoy en el calendario del mes). */
export function formatLocalTime(timezone: string, atMilliseconds: number): string {
  const { hour, minute } = readLocalClock(timezone, atMilliseconds);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** "9:30": la hora de la agenda, sin el cero de adelante. */
export function formatAgendaClock(timezone: string, atMilliseconds: number): string {
  const { hour, minute } = readLocalClock(timezone, atMilliseconds);
  return `${String(hour)}:${String(minute).padStart(2, '0')}`;
}

// Días locales que ocupa un evento, de su inicio a su fin exclusivo. Con tope,
// por si un evento de varios meses llega con un fin absurdo.
const MAXIMUM_EVENT_SPAN_DAY_COUNT = 62;

export function listEventLocalDates(
  event: Pick<AgendaCalendarEvent, 'startsAtMilliseconds' | 'endsAtMilliseconds'>,
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

// ---- Etiquetas ----

/**
 * Cuándo, para la agenda de Inicio: "en 40 minutos" si falta menos de una hora,
 * "hoy 11:00", "mañana 9:30", y de pasado mañana en adelante "en 3 días" (por
 * días de calendario, no por horas). Los de todo el día: "hoy", "mañana".
 */
export function formatAgendaWhenLabel(input: {
  readonly atMilliseconds: number;
  readonly nowMilliseconds: number;
  readonly timezone: string;
  readonly isAllDay?: boolean;
}): string {
  const today = resolveCalendarDateInTimeZone(input.timezone, input.nowMilliseconds);
  const date = resolveCalendarDateInTimeZone(input.timezone, input.atMilliseconds);
  const dayDifference = daysBetween(today, date);
  const isAllDay = input.isAllDay === true;
  if (
    !isAllDay &&
    input.atMilliseconds > input.nowMilliseconds &&
    input.atMilliseconds - input.nowMilliseconds < HOUR_MILLISECONDS
  ) {
    return formatTimeUntil(input.atMilliseconds, input.nowMilliseconds);
  }
  if (dayDifference <= 0) {
    return isAllDay ? 'hoy' : `hoy ${formatAgendaClock(input.timezone, input.atMilliseconds)}`;
  }
  if (dayDifference === 1) {
    return isAllDay ? 'mañana' : `mañana ${formatAgendaClock(input.timezone, input.atMilliseconds)}`;
  }
  return `en ${String(dayDifference)} días`;
}

function formatEventDateLabel(event: AgendaCalendarEvent, timezone: string): string {
  const dateList = listEventLocalDates(event, timezone);
  const firstDate = dateList[0] ?? resolveCalendarDateInTimeZone(timezone, event.startsAtMilliseconds);
  const lastDate = dateList[dateList.length - 1] ?? firstDate;
  if (isSameLocalDate(firstDate, lastDate)) {
    return formatAgendaDateLabel(firstDate);
  }
  return `${formatAgendaDateLabel(firstDate)} al ${formatAgendaDateLabel(lastDate)}`;
}

/** "11:00 a 12:00", "11:00" sin fin, "Todo el día". */
export function formatEventTimeLabel(event: AgendaCalendarEvent, timezone: string): string {
  if (event.isAllDay === true) {
    return AGENDA_ALL_DAY_LABEL;
  }
  const startLabel = formatAgendaClock(timezone, event.startsAtMilliseconds);
  const endsAt = event.endsAtMilliseconds;
  if (endsAt === undefined || !Number.isFinite(endsAt) || endsAt <= event.startsAtMilliseconds) {
    return startLabel;
  }
  const endLabel = formatAgendaClock(timezone, endsAt);
  const startDate = resolveCalendarDateInTimeZone(timezone, event.startsAtMilliseconds);
  const endDate = resolveCalendarDateInTimeZone(timezone, endsAt);
  if (isSameLocalDate(startDate, endDate)) {
    return `${startLabel} a ${endLabel}`;
  }
  return `${startLabel} a ${endLabel} del ${WEEKDAY_NAME_LIST[weekdayOf(endDate)]} ${String(endDate.day)}`;
}

// ---- Entradas ----

function clipOptional(text: string | undefined, maximumCharacterCount: number): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const clipped = clipDashboardTextWithin(text, maximumCharacterCount);
  return clipped.length > 0 ? clipped : undefined;
}

// La descripción conserva los saltos de línea que tenga, solo se recorta el
// total. clipDashboardTextWithin los aplasta: para el detalle se los respeta.
function clipDescription(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const normalized = text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (normalized.length === 0) {
    return undefined;
  }
  if (normalized.length <= AGENDA_DESCRIPTION_MAX_CHARACTER_COUNT) {
    return normalized;
  }
  return `${normalized.slice(0, AGENDA_DESCRIPTION_MAX_CHARACTER_COUNT - 1).trimEnd()}…`;
}

export function buildCalendarAgendaEntry(input: {
  readonly event: AgendaCalendarEvent;
  readonly whenLabel: string;
  readonly timezone: string;
}): AgendaEntry | undefined {
  const { event } = input;
  const title = clipDashboardTextWithin(event.title, AGENDA_TITLE_MAX_CHARACTER_COUNT);
  if (title.length === 0) {
    return undefined;
  }
  const fullTitle =
    clipOptional(event.fullTitle, AGENDA_FULL_TITLE_MAX_CHARACTER_COUNT) ??
    clipDashboardTextWithin(event.title, AGENDA_FULL_TITLE_MAX_CHARACTER_COUNT);
  const location = clipOptional(event.location, AGENDA_LOCATION_MAX_CHARACTER_COUNT);
  const description = clipDescription(event.description);
  return {
    ...(event.id === undefined || event.id.length > 200 ? {} : { id: event.id }),
    title,
    icon: event.icon ?? 'otro',
    whenLabel: input.whenLabel,
    detail: {
      fullTitle,
      dateLabel: formatEventDateLabel(event, input.timezone),
      timeLabel: formatEventTimeLabel(event, input.timezone),
      ...(location === undefined ? {} : { location }),
      ...(description === undefined ? {} : { description }),
      sourceLabel: event.sourceLabel ?? AGENDA_DEFAULT_SOURCE_LABEL,
    },
  };
}

export function buildReminderAgendaEntry(input: {
  readonly reminder: AgendaReminder;
  readonly whenLabel: string;
  readonly timezone: string;
}): AgendaEntry | undefined {
  const { reminder } = input;
  const parsed = parseAgendaSummary(reminder.text);
  const title = clipDashboardTextWithin(parsed.title, AGENDA_TITLE_MAX_CHARACTER_COUNT);
  if (title.length === 0) {
    return undefined;
  }
  const id = reminder.id === undefined ? undefined : `recordatorio:${reminder.id}`;
  return {
    ...(id === undefined || id.length > 200 ? {} : { id }),
    title,
    icon: parsed.icon,
    whenLabel: input.whenLabel,
    detail: {
      fullTitle: clipDashboardTextWithin(parsed.title, AGENDA_FULL_TITLE_MAX_CHARACTER_COUNT),
      dateLabel: formatAgendaDateLabel(
        resolveCalendarDateInTimeZone(input.timezone, reminder.dueAtMilliseconds),
      ),
      timeLabel: formatAgendaClock(input.timezone, reminder.dueAtMilliseconds),
      sourceLabel: AGENDA_REMINDER_SOURCE_LABEL,
    },
  };
}

/**
 * La agenda de Inicio: lo que viene (eventos y recordatorios mezclados, lo que
 * ya empezó no), en orden, hasta 6.
 */
export function buildUpcomingAgendaEntryList(input: {
  readonly calendarEventList: readonly AgendaCalendarEvent[];
  readonly reminderList: readonly AgendaReminder[];
  readonly timezone: string;
  readonly nowMilliseconds: number;
  readonly maximumEntryCount?: number;
}): AgendaEntry[] {
  const candidateList = [
    ...input.calendarEventList.map((event) => ({
      atMilliseconds: event.startsAtMilliseconds,
      build: () =>
        buildCalendarAgendaEntry({
          event,
          timezone: input.timezone,
          whenLabel: formatAgendaWhenLabel({
            atMilliseconds: event.startsAtMilliseconds,
            nowMilliseconds: input.nowMilliseconds,
            timezone: input.timezone,
            isAllDay: event.isAllDay,
          }),
        }),
    })),
    ...input.reminderList.map((reminder) => ({
      atMilliseconds: reminder.dueAtMilliseconds,
      build: () =>
        buildReminderAgendaEntry({
          reminder,
          timezone: input.timezone,
          whenLabel: formatAgendaWhenLabel({
            atMilliseconds: reminder.dueAtMilliseconds,
            nowMilliseconds: input.nowMilliseconds,
            timezone: input.timezone,
          }),
        }),
    })),
  ]
    .filter((candidate) => Number.isFinite(candidate.atMilliseconds))
    // Lo que ya pasó no es agenda. El recordatorio que suena justo ahora lo
    // anuncia la voz, no hace falta que además ocupe la tarjeta.
    .filter((candidate) => candidate.atMilliseconds > input.nowMilliseconds)
    .sort((left, right) => left.atMilliseconds - right.atMilliseconds);
  const entryList: AgendaEntry[] = [];
  const maximumEntryCount = input.maximumEntryCount ?? AGENDA_DASHBOARD_MAX_ENTRY_COUNT;
  for (const candidate of candidateList) {
    if (entryList.length >= maximumEntryCount) {
      break;
    }
    const entry = candidate.build();
    if (entry !== undefined) {
      entryList.push(entry);
    }
  }
  return entryList;
}

/**
 * Lo de un día: los eventos que lo tocan (también los que empezaron antes y
 * siguen) y los recordatorios que suenan ese día. Primero los de todo el día
 * (o que vienen de otro día), después el resto por hora; hasta 12.
 *
 * En la vista de un día la fecha ya está en la cabecera: `whenLabel` es la
 * hora ("11:00") o "Todo el día", no "en 3 días".
 */
export function buildAgendaDayEntryList(input: {
  readonly date: LocalDate;
  readonly calendarEventList: readonly AgendaCalendarEvent[];
  readonly reminderList: readonly AgendaReminder[];
  readonly timezone: string;
}): AgendaEntry[] {
  type Candidate = { readonly rank: number; readonly atMilliseconds: number; readonly entry: AgendaEntry | undefined };
  const candidateList: Candidate[] = [];
  for (const event of input.calendarEventList) {
    if (!Number.isFinite(event.startsAtMilliseconds)) {
      continue;
    }
    const dateList = listEventLocalDates(event, input.timezone);
    if (!dateList.some((date) => isSameLocalDate(date, input.date))) {
      continue;
    }
    const startsThatDay = isSameLocalDate(dateList[0] ?? input.date, input.date);
    const isWholeDay = event.isAllDay === true || !startsThatDay;
    candidateList.push({
      rank: isWholeDay ? 0 : 1,
      atMilliseconds: event.startsAtMilliseconds,
      entry: buildCalendarAgendaEntry({
        event,
        timezone: input.timezone,
        whenLabel: isWholeDay
          ? AGENDA_ALL_DAY_LABEL
          : formatAgendaClock(input.timezone, event.startsAtMilliseconds),
      }),
    });
  }
  for (const reminder of input.reminderList) {
    if (!Number.isFinite(reminder.dueAtMilliseconds)) {
      continue;
    }
    const date = resolveCalendarDateInTimeZone(input.timezone, reminder.dueAtMilliseconds);
    if (!isSameLocalDate(date, input.date)) {
      continue;
    }
    candidateList.push({
      rank: 1,
      atMilliseconds: reminder.dueAtMilliseconds,
      entry: buildReminderAgendaEntry({
        reminder,
        timezone: input.timezone,
        whenLabel: formatAgendaClock(input.timezone, reminder.dueAtMilliseconds),
      }),
    });
  }
  return candidateList
    .toSorted((left, right) => left.rank - right.rank || left.atMilliseconds - right.atMilliseconds)
    .map((candidate) => candidate.entry)
    .filter((entry): entry is AgendaEntry => entry !== undefined)
    .slice(0, AGENDA_DAY_MAX_ENTRY_COUNT);
}

/** Días del mes local de hoy con algún recordatorio (para `eventDayList`). */
export function listReminderDaysInMonth(input: {
  readonly reminderList: readonly AgendaReminder[];
  readonly timezone: string;
  readonly month: { readonly year: number; readonly month: number };
}): readonly number[] {
  const daySet = new Set<number>();
  for (const reminder of input.reminderList) {
    if (!Number.isFinite(reminder.dueAtMilliseconds)) {
      continue;
    }
    const date = resolveCalendarDateInTimeZone(input.timezone, reminder.dueAtMilliseconds);
    if (date.year === input.month.year && date.month === input.month.month) {
      daySet.add(date.day);
    }
  }
  return [...daySet];
}

// ---- La vista de un día ----

export type AgendaDayMessage = {
  readonly type: 'agenda_day';
  readonly date: string;
  readonly dateLabel: string;
  readonly entryList: AgendaEntry[];
};

/** Medianoche local del día y del siguiente: el rango a pedirle a los calendarios. */
export function resolveLocalDayRange(input: {
  readonly date: LocalDate;
  readonly timezone: string;
}): { readonly startMilliseconds: number; readonly endMilliseconds: number } {
  const nextDay = addDays(input.date, 1);
  return {
    startMilliseconds: resolveWallClockInstantMilliseconds({
      timeZone: input.timezone,
      date: { ...input.date, weekday: weekdayOf(input.date) },
      hour: 0,
      minute: 0,
    }),
    endMilliseconds: resolveWallClockInstantMilliseconds({
      timeZone: input.timezone,
      date: { ...nextDay, weekday: weekdayOf(nextDay) },
      hour: 0,
      minute: 0,
    }),
  };
}

/** Respuesta a `agenda_day_request` (docs/vistas-tablero.md). Un día vacío va con `entryList: []`. */
export function buildAgendaDayMessage(input: {
  readonly date: LocalDate;
  readonly timezone: string;
  readonly calendarEventList: readonly AgendaCalendarEvent[];
  readonly reminderList: readonly AgendaReminder[];
}): AgendaDayMessage {
  return {
    type: 'agenda_day',
    date: formatIsoLocalDate(input.date),
    dateLabel: formatAgendaDateLabel(input.date),
    entryList: buildAgendaDayEntryList(input),
  };
}
