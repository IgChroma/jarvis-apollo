import { describe, expect, it } from 'bun:test';

import {
  encodeServerToDeviceMessage,
  parseDeviceToServerMessage,
  serverToDeviceMessageSchema,
} from '@/protocol/schema';

// El ejemplo de docs/vistas-tablero.md, tal cual lo va a leer la placa.
const contractDashboard = {
  type: 'dashboard',
  clock: { timezone: 'America/Argentina/Buenos_Aires', isoNow: '2026-10-18T18:00:00.000Z' },
  weather: {
    locationLabel: 'Ing. Maschwitz',
    temperatureC: 21.4,
    conditionLabel: 'Parcialmente nublado',
    updatedAt: '2026-10-18T17:55:00.000Z',
    conditionCode: 'partlycloudy',
    minC: 12.0,
    maxC: 24.5,
    humidityPercent: 63,
  },
  agendaList: [{ title: 'Dentista', whenLabel: 'en 40 minutos' }],
  monthCalendar: {
    year: 2026,
    month: 10,
    todayDay: 18,
    firstWeekday: 3,
    dayCount: 31,
    eventDayList: [3, 18, 22],
    todayEventList: [
      { timeLabel: '18:30', title: 'Dentista' },
      { timeLabel: 'Todo el día', title: 'Cumple Nico' },
    ],
  },
  home: {
    tileList: [
      { entityId: 'light.living', name: 'Living', kind: 'toggle', isOn: true, available: true },
      { entityId: 'sensor.temp_patio', name: 'Patio', kind: 'sensor', value: '18.2', unit: '°C', available: true },
      {
        entityId: 'climate.dormitorio',
        name: 'Aire dormitorio',
        kind: 'climate',
        currentC: 24.0,
        targetC: 22.5,
        hvacMode: 'cool',
        available: true,
      },
    ],
    dollarBlue: { buy: 1180, sell: 1200, updatedLabel: 'hace 12 min' },
  },
} as const;

describe('dashboard de las vistas Inicio/Casa', () => {
  it('el ejemplo del contrato pasa por el esquema sin perder nada', () => {
    const encoded = encodeServerToDeviceMessage(
      serverToDeviceMessageSchema.parse(contractDashboard),
    );
    expect(JSON.parse(encoded)).toEqual(JSON.parse(JSON.stringify(contractDashboard)));
  });

  it('un tablero viejo (sin las claves nuevas) sigue siendo válido', () => {
    expect(
      serverToDeviceMessageSchema.parse({ type: 'dashboard', agendaList: [] }),
    ).toEqual({ type: 'dashboard', agendaList: [] });
  });

  it('rechaza mosaicos sin los campos de su tipo y más de 12', () => {
    expect(() =>
      serverToDeviceMessageSchema.parse({
        type: 'dashboard',
        home: { tileList: [{ entityId: 'light.x', name: 'X', kind: 'toggle', available: true }] },
      }),
    ).toThrow();
    expect(() =>
      serverToDeviceMessageSchema.parse({
        type: 'dashboard',
        home: {
          tileList: Array.from({ length: 13 }, (_, index) => ({
            entityId: `light.l${index}`,
            name: 'L',
            kind: 'toggle',
            isOn: false,
            available: true,
          })),
        },
      }),
    ).toThrow();
  });
});

describe('ha_action', () => {
  it('parsea las tres acciones del contrato', () => {
    for (const action of ['toggle', 'climate_up', 'climate_down'] as const) {
      expect(
        parseDeviceToServerMessage(
          JSON.stringify({ type: 'ha_action', entityId: 'light.living', action, ts: 123 }),
        ),
      ).toEqual({ type: 'ha_action', entityId: 'light.living', action, ts: 123 });
    }
  });

  it('rechaza una acción desconocida o sin entidad', () => {
    expect(() =>
      parseDeviceToServerMessage(
        JSON.stringify({ type: 'ha_action', entityId: 'light.living', action: 'open', ts: 1 }),
      ),
    ).toThrow();
    expect(() =>
      parseDeviceToServerMessage(JSON.stringify({ type: 'ha_action', entityId: '', action: 'toggle', ts: 1 })),
    ).toThrow();
  });

  it('el gesto swipe de un firmware viejo se sigue aceptando', () => {
    expect(
      parseDeviceToServerMessage(JSON.stringify({ type: 'gesture', gesture: 'swipe_left', ts: 1 })).type,
    ).toBe('gesture');
  });
});
