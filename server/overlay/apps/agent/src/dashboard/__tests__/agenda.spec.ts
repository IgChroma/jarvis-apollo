import { describe, expect, it } from 'bun:test';

import {
  buildAgendaDayMessage,
  formatAgendaWhenLabel,
  parseAgendaSummary,
  parseIsoLocalDate,
  resolveLocalDayRange,
} from '@/dashboard/agenda';
import { buildDashboardPayload } from '@/dashboard/payload';
import {
  normalizeCalendarEventList,
  splitCalendarDescription,
} from '@/homeassistant/entities';
import {
  encodeServerToDeviceMessage,
  parseDeviceToServerMessage,
} from '@/protocol/schema';

// Agenda v2 (docs/vistas-tablero.md): entradas tocables, agenda de un día y la
// tarjeta de compras.

const TIMEZONE = 'America/Argentina/Buenos_Aires';
// Lunes 19 de octubre de 2026, 10:00 en Buenos Aires.
const NOW = Date.UTC(2026, 9, 19, 13, 0);

// Lo que devuelve GET /api/calendars/calendar.hogar (forma real de HA).
const HOGAR_EVENT_LIST = [
  {
    summary: '🦷 Dentista',
    start: { dateTime: '2026-10-22T11:00:00-03:00' },
    end: { dateTime: '2026-10-22T12:00:00-03:00' },
    uid: '01JBDENTISTA',
    recurrence_id: null,
    description: 'Turno con la dentista en OdontoSalud\n\nLlevar la orden.',
    location: 'OdontoSalud, Ing. Maschwitz',
  },
  {
    summary: '🎂 Cumple Nico',
    start: { date: '2026-10-24' },
    end: { date: '2026-10-25' },
    uid: '01JBCUMPLE',
    description: 'Llevar torta',
    location: null,
  },
  {
    summary: 'Reunión de consorcio',
    start: { dateTime: '2026-10-19T19:00:00-03:00' },
    end: { dateTime: '2026-10-19T20:30:00-03:00' },
    uid: 'abc@google.com',
    recurrence_id: '20261019T220000Z',
  },
];

function hogarEvents() {
  return normalizeCalendarEventList({
    eventList: HOGAR_EVENT_LIST,
    timezone: TIMEZONE,
    calendarEntityId: 'calendar.hogar',
    calendarState: { entity_id: 'calendar.hogar', state: 'off', attributes: { friendly_name: 'Hogar' } },
  });
}

describe('íconos desde el emoji del título', () => {
  it('reconoce el emoji del principio, lo saca del título y elige la categoría', () => {
    expect(parseAgendaSummary('🦷 Dentista')).toEqual({ title: 'Dentista', icon: 'salud', emoji: '🦷' });
    expect(parseAgendaSummary('✈️ Viaje a Bariloche')).toMatchObject({ title: 'Viaje a Bariloche', icon: 'viaje' });
    expect(parseAgendaSummary('🏋️‍♀️ Gimnasio')).toMatchObject({ title: 'Gimnasio', icon: 'deporte' });
    expect(parseAgendaSummary('🇧🇷 Río')).toMatchObject({ title: 'Río', icon: 'viaje' });
    expect(parseAgendaSummary('🚗 Service del auto')).toMatchObject({ icon: 'auto' });
    expect(parseAgendaSummary('🛒 Súper')).toMatchObject({ icon: 'compras' });
    expect(parseAgendaSummary('💳 Vence la tarjeta')).toMatchObject({ icon: 'pago' });
    expect(parseAgendaSummary('🐶 Veterinaria')).toMatchObject({ icon: 'mascota' });
  });

  it('sin emoji, o con uno desconocido, es "otro"', () => {
    expect(parseAgendaSummary('Dentista')).toEqual({ title: 'Dentista', icon: 'otro' });
    expect(parseAgendaSummary('📌 Algo')).toMatchObject({ title: 'Algo', icon: 'otro' });
    // Un dígito es "Emoji" en Unicode pero no un pictograma: no se toca.
    expect(parseAgendaSummary('1 turno')).toEqual({ title: '1 turno', icon: 'otro' });
    // Solo un emoji: queda como título antes que una entrada vacía.
    expect(parseAgendaSummary('🎂')).toMatchObject({ title: '🎂', icon: 'cumple' });
  });
});

describe('detalle de un evento de Home Assistant', () => {
  it('los de Jarvis llevan el título largo en la primera línea de la descripción', () => {
    expect(
      splitCalendarDescription({
        title: 'Dentista',
        hasEmoji: true,
        description: 'Turno con la dentista en OdontoSalud\n\nLlevar la orden.',
      }),
    ).toEqual({ fullTitle: 'Turno con la dentista en OdontoSalud', description: 'Llevar la orden.' });
  });

  it('uno creado a mano no pierde la descripción ni inventa un título', () => {
    expect(
      splitCalendarDescription({ title: 'Cumple Nico', hasEmoji: true, description: 'Llevar torta' }),
    ).toEqual({ fullTitle: 'Cumple Nico', description: 'Llevar torta' });
    expect(
      splitCalendarDescription({ title: 'Dentista', hasEmoji: false, description: 'Dentista nuevo' }),
    ).toEqual({ fullTitle: 'Dentista', description: 'Dentista nuevo' });
  });

  it('arma id, ícono, origen y lugar', () => {
    const [dentista, cumple, consorcio] = hogarEvents();
    expect(dentista).toMatchObject({
      id: 'hogar:01JBDENTISTA',
      title: 'Dentista',
      icon: 'salud',
      fullTitle: 'Turno con la dentista en OdontoSalud',
      description: 'Llevar la orden.',
      location: 'OdontoSalud, Ing. Maschwitz',
      sourceLabel: 'Calendario Hogar',
    });
    expect(cumple).toMatchObject({ id: 'hogar:01JBCUMPLE', icon: 'cumple', isAllDay: true });
    expect(cumple.location).toBeUndefined();
    // Una repetición lleva el recurrence_id: borrar sin él borraría la serie.
    expect(consorcio.id).toBe('hogar:abc@google.com#20261019T220000Z');
    expect(consorcio.icon).toBe('otro');
  });
});

describe('agenda del tablero (Agenda v2)', () => {
  it('cada entrada trae id, ícono, cuándo y detalle; los recordatorios también', () => {
    const payload = buildDashboardPayload({
      nowMilliseconds: NOW,
      timezone: TIMEZONE,
      calendarEventList: hogarEvents(),
      reminderList: [{ id: 'r-1', text: 'Sacar la basura', dueAtMilliseconds: Date.UTC(2026, 9, 20, 12, 30) }],
    });
    expect(payload.agendaList).toEqual([
      {
        id: 'hogar:abc@google.com#20261019T220000Z',
        title: 'Reunión de consorcio',
        icon: 'otro',
        whenLabel: 'hoy 19:00',
        detail: {
          fullTitle: 'Reunión de consorcio',
          dateLabel: 'lunes 19 de octubre',
          timeLabel: '19:00 a 20:30',
          sourceLabel: 'Calendario Hogar',
        },
      },
      {
        id: 'recordatorio:r-1',
        title: 'Sacar la basura',
        icon: 'otro',
        whenLabel: 'mañana 9:30',
        detail: {
          fullTitle: 'Sacar la basura',
          dateLabel: 'martes 20 de octubre',
          timeLabel: '9:30',
          sourceLabel: 'Recordatorio de Jarvis',
        },
      },
      {
        id: 'hogar:01JBDENTISTA',
        title: 'Dentista',
        icon: 'salud',
        whenLabel: 'en 3 días',
        detail: {
          fullTitle: 'Turno con la dentista en OdontoSalud',
          dateLabel: 'jueves 22 de octubre',
          timeLabel: '11:00 a 12:00',
          location: 'OdontoSalud, Ing. Maschwitz',
          description: 'Llevar la orden.',
          sourceLabel: 'Calendario Hogar',
        },
      },
      {
        id: 'hogar:01JBCUMPLE',
        title: 'Cumple Nico',
        icon: 'cumple',
        whenLabel: 'en 5 días',
        detail: {
          fullTitle: 'Cumple Nico',
          dateLabel: 'sábado 24 de octubre',
          timeLabel: 'Todo el día',
          description: 'Llevar torta',
          sourceLabel: 'Calendario Hogar',
        },
      },
    ]);
    // Sobrevive al esquema: lo que no estuviera declarado desaparecería.
    const encoded = JSON.parse(encodeServerToDeviceMessage(payload)) as typeof payload;
    expect(encoded.agendaList).toEqual(payload.agendaList);
  });

  it('el título se recorta a 40 y la descripción a 200, con el "…" adentro', () => {
    const payload = buildDashboardPayload({
      nowMilliseconds: NOW,
      timezone: TIMEZONE,
      calendarEventList: [
        {
          title: 'Reunión larguísima con todo el equipo de mantenimiento del barrio',
          startsAtMilliseconds: NOW + 3 * 60 * 60_000,
          description: 'x'.repeat(500),
        },
      ],
    });
    const [entry] = payload.agendaList ?? [];
    expect(entry.title.length).toBeLessThanOrEqual(40);
    expect(entry.title.endsWith('…')).toBe(true);
    expect(entry.detail?.description?.length).toBe(200);
    expect(entry.detail?.sourceLabel).toBe('Calendario');
  });

  it('el calendario del mes marca también los días con recordatorios', () => {
    const payload = buildDashboardPayload({
      nowMilliseconds: NOW,
      timezone: TIMEZONE,
      calendarEventList: hogarEvents(),
      reminderList: [
        { text: 'Pagar el ABL', dueAtMilliseconds: Date.UTC(2026, 9, 28, 12, 0) },
        // Otro mes: no marca nada.
        { text: 'Turno', dueAtMilliseconds: Date.UTC(2026, 10, 3, 12, 0) },
      ],
    });
    expect(payload.monthCalendar?.eventDayList).toEqual([19, 22, 24, 28]);
  });

  it('compras viaja aparte de pendientes, aunque esté vacía', () => {
    const payload = buildDashboardPayload({
      nowMilliseconds: NOW,
      pending: { listName: 'pendientes', count: 1, itemList: ['Llamar al plomero'] },
      shopping: { listName: 'Compras', count: 6, itemList: ['Leche', 'Pan', 'Yerba', 'Queso', 'Café', 'Té'] },
    });
    expect(payload.pending).toEqual({ listName: 'pendientes', count: 1, itemList: ['Llamar al plomero'] });
    expect(payload.shopping).toEqual({ listName: 'Compras', count: 6, itemList: ['Leche', 'Pan', 'Yerba', 'Queso'] });
    const empty = buildDashboardPayload({
      nowMilliseconds: NOW,
      shopping: { listName: 'Compras', count: 0, itemList: [] },
    });
    expect(empty.shopping).toEqual({ listName: 'Compras', count: 0, itemList: [] });
    expect(JSON.parse(encodeServerToDeviceMessage(empty)).shopping).toEqual(empty.shopping);
    expect(buildDashboardPayload({ nowMilliseconds: NOW }).shopping).toBeUndefined();
  });

  it('cuándo: minutos si falta menos de una hora, después hoy/mañana/en N días', () => {
    const label = (atMilliseconds: number, isAllDay?: boolean) =>
      formatAgendaWhenLabel({ atMilliseconds, nowMilliseconds: NOW, timezone: TIMEZONE, isAllDay });
    expect(label(NOW + 40 * 60_000)).toBe('en 40 minutos');
    expect(label(NOW + 2 * 60 * 60_000)).toBe('hoy 12:00');
    expect(label(Date.UTC(2026, 9, 20, 2, 30))).toBe('hoy 23:30');
    expect(label(Date.UTC(2026, 9, 20, 3, 0))).toBe('mañana 0:00');
    expect(label(Date.UTC(2026, 9, 20, 3, 0), true)).toBe('mañana');
    expect(label(Date.UTC(2026, 9, 31, 3, 0), true)).toBe('en 12 días');
  });
});

describe('agenda de un día', () => {
  it('todo el día primero, después por hora; whenLabel es la hora', () => {
    const date = parseIsoLocalDate('2026-10-22')!;
    const message = buildAgendaDayMessage({
      date,
      timezone: TIMEZONE,
      calendarEventList: [
        ...hogarEvents(),
        // Empezó ayer y sigue hoy: cuenta como todo el día.
        {
          title: 'Congreso',
          startsAtMilliseconds: Date.UTC(2026, 9, 21, 12, 0),
          endsAtMilliseconds: Date.UTC(2026, 9, 23, 21, 0),
        },
      ],
      reminderList: [
        { id: 'r-2', text: 'Regar', dueAtMilliseconds: Date.UTC(2026, 9, 22, 11, 0) },
        { id: 'r-3', text: 'Otro día', dueAtMilliseconds: Date.UTC(2026, 9, 23, 11, 0) },
      ],
    });
    expect(message.type).toBe('agenda_day');
    expect(message.date).toBe('2026-10-22');
    expect(message.dateLabel).toBe('jueves 22 de octubre');
    expect(message.entryList.map((entry) => [entry.title, entry.whenLabel])).toEqual([
      ['Congreso', 'Todo el día'],
      ['Regar', '8:00'],
      ['Dentista', '11:00'],
    ]);
    expect(message.entryList[0].detail?.timeLabel).toBe('9:00 a 18:00 del viernes 23');
    expect(JSON.parse(encodeServerToDeviceMessage(message))).toEqual(message);
  });

  it('un día vacío va con la lista vacía, y no pasa de 12', () => {
    const date = parseIsoLocalDate('2026-11-02')!;
    expect(buildAgendaDayMessage({ date, timezone: TIMEZONE, calendarEventList: [], reminderList: [] })).toEqual({
      type: 'agenda_day',
      date: '2026-11-02',
      dateLabel: 'lunes 2 de noviembre',
      entryList: [],
    });
    const range = resolveLocalDayRange({ date, timezone: TIMEZONE });
    const busy = buildAgendaDayMessage({
      date,
      timezone: TIMEZONE,
      calendarEventList: Array.from({ length: 20 }, (_, index) => ({
        title: `Evento ${index}`,
        startsAtMilliseconds: range.startMilliseconds + index * 30 * 60_000,
      })),
      reminderList: [],
    });
    expect(busy.entryList).toHaveLength(12);
  });

  it('la fecha se valida en el servidor: el esquema acepta basura y parseIsoLocalDate la rechaza', () => {
    const message = parseDeviceToServerMessage(
      JSON.stringify({ type: 'agenda_day_request', date: 'mañana', ts: 1 }),
    );
    expect(message.type).toBe('agenda_day_request');
    expect(parseIsoLocalDate('mañana')).toBeUndefined();
    expect(parseIsoLocalDate('2026-02-30')).toBeUndefined();
    expect(parseIsoLocalDate('2026-13-01')).toBeUndefined();
    expect(parseIsoLocalDate('1890-01-01')).toBeUndefined();
    expect(parseIsoLocalDate('2026-10-23')).toMatchObject({ year: 2026, month: 10, day: 23 });
  });
});
