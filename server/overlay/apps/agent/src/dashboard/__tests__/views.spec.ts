import { describe, expect, it } from 'bun:test';

import {
  buildDashboardPayload,
  buildMonthCalendar,
  clipDashboardTextWithin,
  formatTimeAgo,
} from '@/dashboard/payload';
import type { HomeTile } from '@/protocol/schema';
import { encodeServerToDeviceMessage } from '@/protocol/schema';

// Vistas Inicio/Casa (docs/vistas-tablero.md).
const TIMEZONE = 'America/Argentina/Buenos_Aires';
// Domingo 18/10/2026 15:00 en Buenos Aires (UTC-3).
const NOW = Date.UTC(2026, 9, 18, 18, 0, 0);
const localInstant = (day: number, hour: number, minute = 0) =>
  Date.UTC(2026, 9, day, hour + 3, minute);

describe('clipDashboardTextWithin', () => {
  it('nunca pasa del máximo, con el "…" incluido', () => {
    const clipped = clipDashboardTextWithin('Aire acondicionado del dormitorio', 18);
    expect(clipped.length).toBeLessThanOrEqual(18);
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipDashboardTextWithin('Living', 18)).toBe('Living');
  });
});

describe('formatTimeAgo', () => {
  it('dice cuánto hace en el idioma de la tarjeta', () => {
    expect(formatTimeAgo(NOW - 20_000, NOW)).toBe('recién');
    expect(formatTimeAgo(NOW - 12 * 60_000, NOW)).toBe('hace 12 min');
    expect(formatTimeAgo(NOW - 3 * 60 * 60_000, NOW)).toBe('hace 3 h');
    expect(formatTimeAgo(NOW - 26 * 60 * 60_000, NOW)).toBe('hace 1 día');
  });
});

describe('buildMonthCalendar', () => {
  it('arma la grilla de octubre de 2026 en hora argentina', () => {
    const calendar = buildMonthCalendar({ timezone: TIMEZONE, nowMilliseconds: NOW, calendarEventList: [] });
    // El 1/10/2026 es jueves: 3 con 0 = lunes.
    expect(calendar).toEqual({
      year: 2026,
      month: 10,
      todayDay: 18,
      firstWeekday: 3,
      dayCount: 31,
      eventDayList: [],
      todayEventList: [],
    });
  });

  it('"hoy" es el día local aunque en UTC ya sea mañana', () => {
    // 18/10 22:30 en Buenos Aires = 19/10 01:30 UTC.
    const calendar = buildMonthCalendar({
      timezone: TIMEZONE,
      nowMilliseconds: localInstant(18, 22, 30),
      calendarEventList: [],
    });
    expect(calendar.todayDay).toBe(18);
  });

  it('marca los días con eventos (los de varios días, todos) y lista los de hoy', () => {
    const calendar = buildMonthCalendar({
      timezone: TIMEZONE,
      nowMilliseconds: NOW,
      calendarEventList: [
        { title: 'Dentista', startsAtMilliseconds: localInstant(18, 18, 30), endsAtMilliseconds: localInstant(18, 19, 30) },
        { title: 'Cumple Nico', startsAtMilliseconds: localInstant(18, 0), endsAtMilliseconds: localInstant(19, 0), isAllDay: true },
        { title: 'Desayuno', startsAtMilliseconds: localInstant(18, 9, 5) },
        { title: 'Viaje a Córdoba', startsAtMilliseconds: localInstant(22, 0), endsAtMilliseconds: localInstant(25, 0), isAllDay: true },
        { title: 'Reunión', startsAtMilliseconds: localInstant(3, 10) },
        // Del mes que viene: no marca nada en octubre.
        { title: 'Noviembre', startsAtMilliseconds: Date.UTC(2026, 10, 2, 15) },
      ],
    });
    expect(calendar.eventDayList).toEqual([3, 18, 22, 23, 24]);
    expect(calendar.todayEventList).toEqual([
      { timeLabel: '09:05', title: 'Desayuno' },
      { timeLabel: '18:30', title: 'Dentista' },
      { timeLabel: 'Todo el día', title: 'Cumple Nico' },
    ]);
  });

  it('hasta cuatro eventos de hoy, con el título recortado a 22', () => {
    const calendar = buildMonthCalendar({
      timezone: TIMEZONE,
      nowMilliseconds: NOW,
      calendarEventList: Array.from({ length: 6 }, (_, index) => ({
        title: `Evento larguísimo número ${index} de la tarde`,
        startsAtMilliseconds: localInstant(18, 10 + index),
      })),
    });
    expect(calendar.todayEventList).toHaveLength(4);
    for (const entry of calendar.todayEventList) {
      expect(entry.title.length).toBeLessThanOrEqual(22);
    }
  });
});

describe('buildDashboardPayload con Home Assistant', () => {
  const tileList: HomeTile[] = [
    { entityId: 'light.living', name: 'Living', kind: 'toggle', isOn: true, available: true },
    {
      entityId: 'sensor.consumo',
      name: 'Consumo instantáneo de la casa entera',
      kind: 'sensor',
      value: '12345.678901',
      unit: 'W',
      available: true,
    },
    { entityId: 'climate.dormitorio', name: 'Aire dormitorio', kind: 'climate', currentC: 24, targetC: 22.5, hvacMode: 'cool', available: true },
  ];

  it('la agenda mezcla eventos de HA con recordatorios, como antes', () => {
    const payload = buildDashboardPayload({
      nowMilliseconds: NOW,
      timezone: TIMEZONE,
      calendarEventList: [
        { title: 'Dentista', startsAtMilliseconds: NOW + 40 * 60_000 },
        { title: 'Ya pasó', startsAtMilliseconds: NOW - 60_000 },
      ],
      reminderList: [{ text: 'Llamar al gasista', dueAtMilliseconds: NOW + 120 * 60_000 }],
    });
    expect(payload.agendaList?.map(({ title, whenLabel }) => ({ title, whenLabel }))).toEqual([
      { title: 'Dentista', whenLabel: 'en 40 minutos' },
      { title: 'Llamar al gasista', whenLabel: 'hoy 17:00' },
    ]);
    expect(payload.monthCalendar?.eventDayList).toEqual([18]);
  });

  it('manda los mosaicos recortados y el dólar con "hace N min"', () => {
    const payload = buildDashboardPayload({
      nowMilliseconds: NOW,
      homeTileList: tileList,
      dollarBlue: { buy: 1180, sell: 1200, updatedAtMilliseconds: NOW - 12 * 60_000 },
    });
    expect(payload.home?.dollarBlue).toEqual({ buy: 1180, sell: 1200, updatedLabel: 'hace 12 min' });
    expect(payload.home?.tileList.map((tile) => tile.entityId)).toEqual([
      'light.living',
      'sensor.consumo',
      'climate.dormitorio',
    ]);
    const sensor = payload.home?.tileList[1];
    expect(sensor?.name.length).toBeLessThanOrEqual(18);
    expect(sensor?.kind === 'sensor' && sensor.value.length).toBeLessThanOrEqual(10);
  });

  it('no pasa de 12 mosaicos', () => {
    const payload = buildDashboardPayload({
      nowMilliseconds: NOW,
      homeTileList: Array.from({ length: 20 }, (_, index) => ({
        entityId: `light.l${index}`,
        name: `Luz ${index}`,
        kind: 'toggle' as const,
        isOn: false,
        available: true,
      })),
    });
    expect(payload.home?.tileList).toHaveLength(12);
  });

  it('sin HA ni dólar no hay vista Casa; con HA sin etiquetas, lista vacía', () => {
    expect(buildDashboardPayload({ nowMilliseconds: NOW }).home).toBeUndefined();
    expect(buildDashboardPayload({ nowMilliseconds: NOW, homeTileList: [] }).home).toEqual({ tileList: [] });
    expect(
      buildDashboardPayload({
        nowMilliseconds: NOW,
        dollarBlue: { buy: 1, sell: 2, updatedAtMilliseconds: NOW },
      }).home,
    ).toEqual({ tileList: [], dollarBlue: { buy: 1, sell: 2, updatedLabel: 'recién' } });
  });

  it('el clima de HA viaja con mín./máx. y el esquema no los descarta', () => {
    const weather = {
      locationLabel: 'Ing. Maschwitz',
      temperatureC: 21.4,
      conditionLabel: 'Parcialmente nublado',
      updatedAt: '2026-10-18T17:55:00.000Z',
      conditionCode: 'partlycloudy',
      minC: 12,
      maxC: 24.5,
      humidityPercent: 63,
    };
    const payload = buildDashboardPayload({
      nowMilliseconds: NOW,
      timezone: TIMEZONE,
      weather,
      homeTileList: tileList,
      dollarBlue: { buy: 1180, sell: 1200, updatedAtMilliseconds: NOW },
    });
    const decoded = JSON.parse(encodeServerToDeviceMessage(payload));
    // Ida y vuelta por el esquema: nada de lo nuevo se pierde en silencio.
    expect(decoded).toEqual(JSON.parse(JSON.stringify(payload)));
    expect(decoded.weather).toEqual(weather);
    expect(decoded.monthCalendar.todayDay).toBe(18);
    expect(decoded.home.tileList).toHaveLength(3);
  });
});
