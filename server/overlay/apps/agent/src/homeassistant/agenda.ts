import {
  AGENDA_CANONICAL_EMOJI_BY_ICON,
  addDays,
  formatAgendaDateLabel,
  formatEventTimeLabel,
  formatIsoLocalDate,
  isSingleEmoji,
  parseIsoLocalDate,
  resolveAgendaIconForEmoji,
  splitLeadingEmoji,
  weekdayOf,
} from '@/dashboard/agenda';
import { isValidEntityId, type HomeAssistantClient } from '@/homeassistant/client';
import {
  parseCalendarEventId,
  resolveCalendarSourceLabel,
  type DashboardCalendarEvent,
} from '@/homeassistant/entities';
import type { HomeAssistantDashboardSource } from '@/homeassistant/source';
import type { AgendaIcon } from '@/protocol/schema';
import {
  resolveCalendarDateInTimeZone,
  resolveTimeZoneOffsetMilliseconds,
  resolveWallClockInstantMilliseconds,
} from '@/time/zone';

// Agenda v2 por voz: agenda_agregar, agenda_listar y agenda_borrar
// (tools/agenda.ts) sobre los calendarios de Home Assistant.
//
// Decisión del dueño (2026-10-19): "anotame en la agenda el jueves a las 11"
// alcanza para guardar. El lugar es un extra. Jarvis NO pregunta cómo va a ir,
// NO ofrece calcular la salida y NO crea un recordatorio aparte: si quiere
// eso, lo pide él.
//
// Dónde se escribe: un solo calendario, `calendar.hogar` salvo que la opción
// `agenda_calendar` (AGENDA_CALENDAR_ENTITY) diga otro. El resumen guardado es
// "<emoji> <título corto>" ("🦷 Dentista"): el emoji es para la app de HA y la
// placa lo traduce a una categoría de ícono (dashboard/agenda.ts). La
// descripción lleva el título largo en la primera línea y, si hay, la
// descripción después de una línea en blanco (así la lee entities.ts).

export const DEFAULT_AGENDA_CALENDAR_ENTITY_ID = 'calendar.hogar';
export const AGENDA_SHORT_TITLE_MAX_CHARACTER_COUNT = 18;
export const AGENDA_DEFAULT_DURATION_MINUTES = 60;
export const AGENDA_LIST_MAX_DAY_COUNT = 31;
const AGENDA_LIST_MAX_LINE_COUNT = 30;
// Algo agendado hace más de una hora es casi seguro un error de fecha (el año,
// "el jueves" que ya pasó): se avisa en vez de guardarlo en el pasado.
const PAST_TOLERANCE_MILLISECONDS = 60 * 60_000;

// CalendarEntityFeature de Home Assistant.
const CALENDAR_FEATURE_CREATE = 1;
const CALENDAR_FEATURE_DELETE = 2;

export function resolveAgendaCalendarEntityId(environment: Record<string, string | undefined>): string {
  const configured = environment.AGENDA_CALENDAR_ENTITY?.trim().toLowerCase();
  if (configured !== undefined && configured.length > 0) {
    const entityId = configured.startsWith('calendar.') ? configured : `calendar.${configured}`;
    if (isValidEntityId(entityId)) {
      return entityId;
    }
    console.log(
      JSON.stringify({ level: 'warn', message: 'agenda_calendar_invalido', valor: configured }),
    );
  }
  return DEFAULT_AGENDA_CALENDAR_ENTITY_ID;
}

export type AgendaVoiceResult = {
  readonly ok: boolean;
  readonly summary: string;
};

export type AgendaAddRequest = {
  readonly date: string;
  readonly time?: string;
  readonly allDay?: boolean;
  readonly shortTitle: string;
  readonly emoji?: string;
  readonly icon: AgendaIcon;
  readonly longTitle?: string;
  readonly location?: string;
  readonly durationMinutes?: number;
  readonly description?: string;
};

export type HomeAgendaControl = {
  readonly calendarEntityId: string;
  addEvent(request: AgendaAddRequest): Promise<AgendaVoiceResult>;
  listEvents(request: { readonly from: string; readonly to?: string }): Promise<AgendaVoiceResult>;
  deleteEvent(eventId: string): Promise<AgendaVoiceResult>;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseClock(text: string): { readonly hour: number; readonly minute: number } | undefined {
  const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? '0');
  return hour <= 23 && minute <= 59 ? { hour, minute } : undefined;
}

/** "Dentista con la doctora" → "Dentista con la" si no entra: corte por palabra, sin "…" (va a HA). */
export function clipShortTitle(text: string): string {
  const collapsed = splitLeadingEmoji(text.replace(/\s+/g, ' ').trim()).rest;
  if (collapsed.length <= AGENDA_SHORT_TITLE_MAX_CHARACTER_COUNT) {
    return collapsed;
  }
  const clipped = collapsed.slice(0, AGENDA_SHORT_TITLE_MAX_CHARACTER_COUNT);
  const lastSpaceIndex = clipped.lastIndexOf(' ');
  return (lastSpaceIndex > AGENDA_SHORT_TITLE_MAX_CHARACTER_COUNT / 2 ? clipped.slice(0, lastSpaceIndex) : clipped).trim();
}

/**
 * El emoji que se guarda. Si el del modelo se reconoce, ese (y el ícono de la
 * placa sale de él). Si no se reconoce, el canónico del `icono` que eligió el
 * modelo: así la placa muestra la categoría correcta. Con `otro`, el del modelo
 * tal cual (o 📌 si no mandó uno válido).
 */
export function chooseAgendaEmoji(input: { readonly emoji?: string; readonly icon: AgendaIcon }): string {
  const candidate = input.emoji?.trim();
  const validEmoji = candidate !== undefined && isSingleEmoji(candidate) ? candidate : undefined;
  if (validEmoji !== undefined && resolveAgendaIconForEmoji(validEmoji) !== 'otro') {
    return validEmoji;
  }
  if (input.icon === 'otro' && validEmoji !== undefined) {
    return validEmoji;
  }
  return AGENDA_CANONICAL_EMOJI_BY_ICON[input.icon];
}

/** Instante con el desfase de la zona: "2026-10-23T11:00:00-03:00". */
export function formatZonedIsoDateTime(timezone: string, atMilliseconds: number): string {
  const offsetMilliseconds = resolveTimeZoneOffsetMilliseconds(timezone, atMilliseconds);
  const wallClock = new Date(atMilliseconds + offsetMilliseconds).toISOString().slice(0, 19);
  const offsetMinutes = Math.round(offsetMilliseconds / 60_000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absoluteMinutes = Math.abs(offsetMinutes);
  const offsetLabel = `${sign}${String(Math.floor(absoluteMinutes / 60)).padStart(2, '0')}:${String(absoluteMinutes % 60).padStart(2, '0')}`;
  return `${wallClock}${offsetLabel}`;
}

function buildStoredDescription(request: AgendaAddRequest, shortTitle: string): string | undefined {
  const longTitle = request.longTitle?.replace(/\s+/g, ' ').trim() ?? '';
  const description = request.description?.trim() ?? '';
  if (longTitle.length === 0 && description.length === 0) {
    return undefined;
  }
  // Primera línea: el título largo (o el corto, si solo vino descripción).
  const firstLine = longTitle.length > 0 ? longTitle : shortTitle;
  return description.length > 0 ? `${firstLine}\n\n${description}` : firstLine;
}

const SHORT_WEEKDAY_LIST = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

function formatEventLine(event: DashboardCalendarEvent, timezone: string): string {
  const date = resolveCalendarDateInTimeZone(timezone, event.startsAtMilliseconds);
  const dayLabel = `${SHORT_WEEKDAY_LIST[weekdayOf(date)]} ${String(date.day)}/${String(date.month)}`;
  const place = event.location === undefined ? '' : ` @ ${event.location}`;
  return `${event.id ?? 'sin id'} | ${dayLabel} ${formatEventTimeLabel(event, timezone)} | ${event.title}${place}`;
}

export function createHomeAssistantAgendaControl(input: {
  readonly client: HomeAssistantClient;
  readonly source: Pick<HomeAssistantDashboardSource, 'readAgendaEventList'>;
  readonly calendarEntityId?: string;
  readonly resolveTimezone: () => Promise<string>;
  readonly now?: () => number;
  // Después de agendar o borrar: caché del calendario y tablero al día.
  readonly onChanged?: () => void;
}): HomeAgendaControl {
  const { client } = input;
  const calendarEntityId = input.calendarEntityId ?? DEFAULT_AGENDA_CALENDAR_ENTITY_ID;
  const now = input.now ?? (() => Date.now());

  async function readCalendarFeatures(entityId: string): Promise<
    { readonly ok: true; readonly features: number; readonly sourceLabel: string } | { readonly ok: false; readonly summary: string }
  > {
    try {
      const state = await client.getState(entityId);
      if (state === undefined) {
        return {
          ok: false,
          summary: `No existe ${entityId} en Home Assistant (se cambia con la opción agenda_calendar del add-on).`,
        };
      }
      return {
        ok: true,
        features: Number(state.attributes.supported_features ?? 0),
        sourceLabel: resolveCalendarSourceLabel(state, entityId),
      };
    } catch (error) {
      return { ok: false, summary: `Home Assistant no responde: ${describeError(error)}` };
    }
  }

  return {
    calendarEntityId,

    async addEvent(request) {
      const date = parseIsoLocalDate(request.date);
      if (date === undefined) {
        return { ok: false, summary: `Fecha inválida "${request.date}": usá AAAA-MM-DD.` };
      }
      const isAllDay = request.allDay === true && (request.time === undefined || request.time.trim().length === 0);
      const clock = request.time === undefined ? undefined : parseClock(request.time);
      if (!isAllDay && clock === undefined) {
        return {
          ok: false,
          summary:
            request.time === undefined
              ? 'Falta la hora (o todo_el_dia: true). Si no la dijo, preguntale solo la hora.'
              : `Hora inválida "${request.time}": usá HH:MM.`,
        };
      }
      const shortTitle = clipShortTitle(request.shortTitle);
      if (shortTitle.length === 0) {
        return { ok: false, summary: 'Falta titulo_corto.' };
      }
      const durationMinutes = request.durationMinutes ?? AGENDA_DEFAULT_DURATION_MINUTES;
      if (!Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > 24 * 60) {
        return { ok: false, summary: 'duracion_minutos tiene que estar entre 1 y 1440.' };
      }

      let timezone: string;
      try {
        timezone = await input.resolveTimezone();
      } catch {
        timezone = 'America/Argentina/Buenos_Aires';
      }
      const today = resolveCalendarDateInTimeZone(timezone, now());
      const startMilliseconds = resolveWallClockInstantMilliseconds({
        timeZone: timezone,
        date,
        hour: clock?.hour ?? 0,
        minute: clock?.minute ?? 0,
      });
      const isPast = isAllDay
        ? formatIsoLocalDate(date) < formatIsoLocalDate(today)
        : startMilliseconds < now() - PAST_TOLERANCE_MILLISECONDS;
      if (isPast) {
        return {
          ok: false,
          summary: `${formatAgendaDateLabel(date)} ${String(date.year)} ya pasó. Revisá el día o el año (hoy es ${formatIsoLocalDate(today)}).`,
        };
      }

      const calendar = await readCalendarFeatures(calendarEntityId);
      if (!calendar.ok) {
        return calendar;
      }
      if ((calendar.features & CALENDAR_FEATURE_CREATE) === 0) {
        return { ok: false, summary: `${calendarEntityId} no deja crear eventos.` };
      }

      const emoji = chooseAgendaEmoji({ emoji: request.emoji, icon: request.icon });
      const summary = `${emoji} ${shortTitle}`;
      const description = buildStoredDescription(request, shortTitle);
      const location = request.location?.replace(/\s+/g, ' ').trim();
      const endMilliseconds = startMilliseconds + durationMinutes * 60_000;
      const timing = isAllDay
        ? { start_date: formatIsoLocalDate(date), end_date: formatIsoLocalDate(addDays(date, 1)) }
        : {
            start_date_time: formatZonedIsoDateTime(timezone, startMilliseconds),
            end_date_time: formatZonedIsoDateTime(timezone, endMilliseconds),
          };
      try {
        await client.callService({
          domain: 'calendar',
          service: 'create_event',
          data: {
            entity_id: calendarEntityId,
            summary,
            ...timing,
            ...(description === undefined ? {} : { description }),
            ...(location === undefined || location.length === 0 ? {} : { location }),
          },
        });
      } catch (error) {
        return { ok: false, summary: `Home Assistant no guardó el evento: ${describeError(error)}` };
      }
      input.onChanged?.();
      const timeLabel = formatEventTimeLabel(
        isAllDay
          ? { title: shortTitle, startsAtMilliseconds: startMilliseconds, isAllDay: true }
          : { title: shortTitle, startsAtMilliseconds: startMilliseconds, endsAtMilliseconds: endMilliseconds },
        timezone,
      );
      const placeLabel = location === undefined || location.length === 0 ? '' : `, en ${location}`;
      return {
        ok: true,
        summary:
          `Agendado en ${calendar.sourceLabel}: "${summary}", ${formatAgendaDateLabel(date)}, ${timeLabel}${placeLabel}. ` +
          'Confirmalo en una frase corta, sin preguntar nada más.',
      };
    },

    async listEvents(request) {
      const fromDate = parseIsoLocalDate(request.from);
      const toDate = request.to === undefined ? fromDate : parseIsoLocalDate(request.to);
      if (fromDate === undefined || toDate === undefined) {
        return { ok: false, summary: 'Fechas inválidas: usá AAAA-MM-DD.' };
      }
      if (formatIsoLocalDate(toDate) < formatIsoLocalDate(fromDate)) {
        return { ok: false, summary: '"hasta" es anterior a "desde".' };
      }
      const lastDate = addDays(fromDate, AGENDA_LIST_MAX_DAY_COUNT - 1);
      const clippedToDate = formatIsoLocalDate(toDate) > formatIsoLocalDate(lastDate) ? lastDate : toDate;
      let timezone: string;
      try {
        timezone = await input.resolveTimezone();
      } catch {
        timezone = 'America/Argentina/Buenos_Aires';
      }
      const startMilliseconds = resolveWallClockInstantMilliseconds({
        timeZone: timezone,
        date: { ...fromDate },
        hour: 0,
        minute: 0,
      });
      const nextDay = addDays(clippedToDate, 1);
      const endMilliseconds = resolveWallClockInstantMilliseconds({
        timeZone: timezone,
        date: { ...nextDay, weekday: weekdayOf(nextDay) },
        hour: 0,
        minute: 0,
      });
      let eventList: readonly DashboardCalendarEvent[];
      try {
        eventList = await input.source.readAgendaEventList({ timezone, startMilliseconds, endMilliseconds });
      } catch (error) {
        return { ok: false, summary: `Home Assistant no responde: ${describeError(error)}` };
      }
      const rangeLabel =
        formatIsoLocalDate(fromDate) === formatIsoLocalDate(clippedToDate)
          ? formatAgendaDateLabel(fromDate)
          : `${formatAgendaDateLabel(fromDate)} al ${formatAgendaDateLabel(clippedToDate)}`;
      const sortedList = eventList
        .filter((event) => (event.endsAtMilliseconds ?? event.startsAtMilliseconds + 1) > startMilliseconds)
        .filter((event) => event.startsAtMilliseconds < endMilliseconds)
        .toSorted((left, right) => left.startsAtMilliseconds - right.startsAtMilliseconds);
      if (sortedList.length === 0) {
        return { ok: true, summary: `No hay eventos en el calendario del ${rangeLabel}.` };
      }
      const lineList = sortedList.slice(0, AGENDA_LIST_MAX_LINE_COUNT).map((event) => formatEventLine(event, timezone));
      const extra = sortedList.length - lineList.length;
      return {
        ok: true,
        summary:
          `Eventos del ${rangeLabel} (id | día hora | título):\n${lineList.join('\n')}` +
          (extra > 0 ? `\n(y ${String(extra)} más)` : ''),
      };
    },

    async deleteEvent(eventId) {
      const parsed = parseCalendarEventId(eventId.trim());
      if (parsed === undefined) {
        return { ok: false, summary: `Id inválido "${eventId}": sacalo de agenda_listar.` };
      }
      const calendar = await readCalendarFeatures(parsed.calendarEntityId);
      if (!calendar.ok) {
        return calendar;
      }
      // Solo los calendarios locales (y los que HA deja editar) informan el
      // bit de borrar; uno de Google suscripto o de feriados, no.
      if ((calendar.features & CALENDAR_FEATURE_DELETE) === 0) {
        return {
          ok: false,
          summary: `${calendar.sourceLabel} no deja borrar eventos desde Jarvis: hay que hacerlo en la app del calendario.`,
        };
      }
      try {
        await client.sendWebSocketCommand({
          type: 'calendar/event/delete',
          entity_id: parsed.calendarEntityId,
          uid: parsed.uid,
          ...(parsed.recurrenceId === undefined ? {} : { recurrence_id: parsed.recurrenceId }),
        });
      } catch (error) {
        return { ok: false, summary: `Home Assistant no borró el evento: ${describeError(error)}` };
      }
      input.onChanged?.();
      return { ok: true, summary: `Borrado de ${calendar.sourceLabel}.` };
    },
  };
}
