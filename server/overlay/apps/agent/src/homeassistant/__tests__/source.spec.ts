import { describe, expect, it } from 'bun:test';

import type {
  HomeAssistantClient,
  HomeAssistantState,
} from '@/homeassistant/client';
import {
  createHomeAssistantDashboardSource,
  HOME_ASSISTANT_UNREACHABLE_BACKOFF_MILLISECONDS,
  resolveCalendarRange,
} from '@/homeassistant/source';

const TIMEZONE = 'America/Argentina/Buenos_Aires';
const NOW = Date.UTC(2026, 9, 18, 18, 0, 0);

function createFakeClient(input: {
  labelled?: readonly string[];
  stateList?: readonly HomeAssistantState[];
  failStates?: () => boolean;
} = {}) {
  const callLog: string[] = [];
  const serviceCallList: Parameters<HomeAssistantClient['callService']>[0][] = [];
  const client: HomeAssistantClient = {
    connection: { apiBaseUrl: 'http://ha.test/api', token: 't', source: 'ha_url' },
    async listLabelEntityIds() {
      callLog.push('label');
      return input.labelled ?? [];
    },
    async listStates() {
      callLog.push('states');
      if (input.failStates?.() === true) {
        throw new Error('sin red');
      }
      return input.stateList ?? [];
    },
    async listCalendarEvents({ calendarEntityId }) {
      callLog.push(`calendar:${calendarEntityId}`);
      return [{ summary: 'Dentista', start: { dateTime: '2026-10-18T18:30:00-03:00' } }];
    },
    async getDailyForecast() {
      callLog.push('forecast');
      return [{ datetime: '2026-10-18T15:00:00+00:00', temperature: 25, templow: 11 }];
    },
    async callService(serviceCall) {
      serviceCallList.push(serviceCall);
    },
  };
  return { client, callLog, serviceCallList };
}

const stateList: HomeAssistantState[] = [
  { entity_id: 'light.living', state: 'on', attributes: { friendly_name: 'Living' } },
  { entity_id: 'calendar.casa', state: 'off', attributes: {} },
  { entity_id: 'weather.home', state: 'sunny', attributes: { temperature: 20 } },
  {
    entity_id: 'climate.dormitorio',
    state: 'cool',
    attributes: { temperature: 22, min_temp: 16, max_temp: 30 },
  },
  { entity_id: 'switch.porton', state: 'off', attributes: {} },
];

describe('resolveCalendarRange', () => {
  it('va del 1º del mes local hasta fin de mes (o una semana adelante)', () => {
    const range = resolveCalendarRange({ timezone: TIMEZONE, nowMilliseconds: NOW });
    expect(new Date(range.startMilliseconds).toISOString()).toBe('2026-10-01T03:00:00.000Z');
    expect(new Date(range.endMilliseconds).toISOString()).toBe('2026-11-01T03:00:00.000Z');
    const endOfMonth = resolveCalendarRange({
      timezone: TIMEZONE,
      nowMilliseconds: Date.UTC(2026, 9, 30, 18, 0),
    });
    expect(endOfMonth.endMilliseconds).toBe(Date.UTC(2026, 9, 30, 18, 0) + 7 * 24 * 60 * 60_000);
  });
});

describe('createHomeAssistantDashboardSource', () => {
  it('arma mosaicos, agenda y clima con mín./máx.', async () => {
    const { client } = createFakeClient({
      labelled: ['light.living', 'climate.dormitorio', 'calendar.casa'],
      stateList,
    });
    const source = createHomeAssistantDashboardSource({ client, now: () => NOW });
    const data = await source.readDashboardData({ timezone: TIMEZONE, locationLabel: 'Casa' });
    expect(data?.tileList.map((tile) => tile.entityId)).toEqual(['light.living', 'climate.dormitorio']);
    expect(data?.calendarEventList).toEqual([
      { title: 'Dentista', startsAtMilliseconds: Date.UTC(2026, 9, 18, 21, 30) },
    ]);
    expect(data?.weather).toMatchObject({ temperatureC: 20, minC: 11, maxC: 25, conditionCode: 'sunny' });
  });

  it('cachea etiqueta, calendarios y pronóstico; los estados se leen siempre', async () => {
    let now = NOW;
    const { client, callLog } = createFakeClient({ labelled: ['calendar.casa'], stateList });
    const source = createHomeAssistantDashboardSource({ client, now: () => now });
    await source.readDashboardData({ timezone: TIMEZONE, locationLabel: 'Casa' });
    now += 10_000;
    await source.readDashboardData({ timezone: TIMEZONE, locationLabel: 'Casa' });
    expect(callLog.toSorted()).toEqual(
      ['calendar:calendar.casa', 'forecast', 'label', 'states', 'states'].toSorted(),
    );
    // A los 5 min vuelve el calendario; el pronóstico (30 min) todavía no.
    now += 5 * 60_000;
    callLog.length = 0;
    await source.readDashboardData({ timezone: TIMEZONE, locationLabel: 'Casa' });
    expect(callLog.toSorted()).toEqual(['calendar:calendar.casa', 'label', 'states'].toSorted());
  });

  it('con HA caído devuelve undefined y no insiste durante el backoff', async () => {
    let now = NOW;
    let failing = true;
    const { client, callLog } = createFakeClient({ stateList, failStates: () => failing });
    const source = createHomeAssistantDashboardSource({ client, now: () => now });
    expect(await source.readDashboardData({ timezone: TIMEZONE, locationLabel: 'Casa' })).toBeUndefined();
    now += 10_000;
    expect(await source.readDashboardData({ timezone: TIMEZONE, locationLabel: 'Casa' })).toBeUndefined();
    expect(callLog).toEqual(['states']);
    failing = false;
    now += HOME_ASSISTANT_UNREACHABLE_BACKOFF_MILLISECONDS;
    expect(await source.readDashboardData({ timezone: TIMEZONE, locationLabel: 'Casa' })).toBeDefined();
  });

  it('ejecuta acciones solo sobre entidades etiquetadas', async () => {
    const { client, serviceCallList } = createFakeClient({
      labelled: ['light.living', 'climate.dormitorio'],
      stateList,
    });
    const source = createHomeAssistantDashboardSource({ client, now: () => NOW });

    expect(await source.executeTileAction({ entityId: 'light.living', action: 'toggle' })).toEqual({ ok: true });
    expect(await source.executeTileAction({ entityId: 'climate.dormitorio', action: 'climate_up' }))
      .toEqual({ ok: true });
    expect(await source.executeTileAction({ entityId: 'switch.porton', action: 'toggle' }))
      .toEqual({ ok: false, reason: 'entidad_no_habilitada' });
    expect(await source.executeTileAction({ entityId: 'light.living;rm', action: 'toggle' }))
      .toEqual({ ok: false, reason: 'entity_id_invalido' });

    expect(serviceCallList).toEqual([
      { domain: 'homeassistant', service: 'toggle', data: { entity_id: 'light.living' } },
      { domain: 'climate', service: 'set_temperature', data: { entity_id: 'climate.dormitorio', temperature: 22.5 } },
    ]);
  });
});
