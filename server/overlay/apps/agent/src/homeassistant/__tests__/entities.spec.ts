import { describe, expect, it } from 'bun:test';

import type { HomeAssistantState } from '@/homeassistant/client';
import {
  buildHomeAssistantWeather,
  buildHomeTileList,
  formatSensorValue,
  normalizeCalendarEventList,
  resolveHomeEntityKind,
  selectCalendarEntityIdList,
  selectWeatherEntityId,
} from '@/homeassistant/entities';

const TIMEZONE = 'America/Argentina/Buenos_Aires';
// 18/10/2026 15:00 en Buenos Aires (UTC-3).
const NOW = Date.UTC(2026, 9, 18, 18, 0, 0);

function state(
  entityId: string,
  value: string,
  attributes: Record<string, unknown> = {},
): HomeAssistantState {
  return { entity_id: entityId, state: value, attributes };
}

describe('resolveHomeEntityKind', () => {
  it('mapea el dominio al tipo de mosaico del contrato', () => {
    expect(resolveHomeEntityKind('light.living')).toBe('toggle');
    expect(resolveHomeEntityKind('switch.bomba')).toBe('toggle');
    expect(resolveHomeEntityKind('fan.techo')).toBe('toggle');
    expect(resolveHomeEntityKind('input_boolean.visitas')).toBe('toggle');
    expect(resolveHomeEntityKind('sensor.temp')).toBe('sensor');
    expect(resolveHomeEntityKind('binary_sensor.puerta')).toBe('sensor');
    expect(resolveHomeEntityKind('climate.aire')).toBe('climate');
    expect(resolveHomeEntityKind('calendar.casa')).toBe('calendar');
    expect(resolveHomeEntityKind('weather.home')).toBe('weather');
    expect(resolveHomeEntityKind('lock.puerta')).toBeUndefined();
  });
});

describe('buildHomeTileList', () => {
  const stateList = [
    state('sensor.temp_patio', '18.234', { friendly_name: 'Patio', unit_of_measurement: '°C' }),
    state('light.living', 'on', { friendly_name: 'Living' }),
    state('climate.dormitorio', 'cool', {
      friendly_name: 'Aire dormitorio',
      current_temperature: 24,
      temperature: 22.5,
    }),
    state('switch.bomba', 'unavailable', { friendly_name: 'Bomba' }),
    state('binary_sensor.puerta', 'on', { friendly_name: 'Puerta', device_class: 'door' }),
    state('calendar.casa', 'off', { friendly_name: 'Casa' }),
    state('weather.home', 'sunny', { temperature: 20 }),
    state('lock.puerta', 'locked'),
    state('light.sin_nombre', 'off'),
  ];

  it('arma interruptores, sensores y climas; calendarios y clima no son mosaicos', () => {
    const tileList = buildHomeTileList({
      labelledEntityIdList: stateList.map((entry) => entry.entity_id),
      stateList,
    });
    expect(tileList).toEqual([
      { entityId: 'switch.bomba', name: 'Bomba', available: false, kind: 'toggle', isOn: false },
      { entityId: 'light.living', name: 'Living', available: true, kind: 'toggle', isOn: true },
      { entityId: 'light.sin_nombre', name: 'sin nombre', available: true, kind: 'toggle', isOn: false },
      {
        entityId: 'climate.dormitorio',
        name: 'Aire dormitorio',
        available: true,
        kind: 'climate',
        currentC: 24,
        targetC: 22.5,
        hvacMode: 'cool',
      },
      { entityId: 'sensor.temp_patio', name: 'Patio', available: true, kind: 'sensor', value: '18.2', unit: '°C' },
      { entityId: 'binary_sensor.puerta', name: 'Puerta', available: true, kind: 'sensor', value: 'Abierta' },
    ]);
  });

  it('solo muestra lo etiquetado, y lo etiquetado sin estado no aparece', () => {
    const tileList = buildHomeTileList({
      labelledEntityIdList: ['light.living', 'light.borrada', 'light.living'],
      stateList,
    });
    expect(tileList.map((tile) => tile.entityId)).toEqual(['light.living']);
  });

  it('un sensor sin datos sale no disponible, con guion y sin unidad', () => {
    const [tile] = buildHomeTileList({
      labelledEntityIdList: ['sensor.x'],
      stateList: [state('sensor.x', 'unknown', { unit_of_measurement: '%' })],
    });
    expect(tile).toEqual({ entityId: 'sensor.x', name: 'x', available: false, kind: 'sensor', value: '—' });
  });
});

describe('formatSensorValue', () => {
  it('redondea a un decimal solo si hace falta', () => {
    expect(formatSensorValue('18.234')).toBe('18.2');
    expect(formatSensorValue('18.2')).toBe('18.2');
    expect(formatSensorValue('1013')).toBe('1013');
    expect(formatSensorValue('-0.06')).toBe('-0.1');
    expect(formatSensorValue('encendido')).toBe('encendido');
  });
});

describe('selectCalendarEntityIdList / selectWeatherEntityId', () => {
  const stateList = [
    state('calendar.casa', 'off'),
    state('calendar.feriados', 'off'),
    state('weather.home', 'sunny'),
    state('weather.otro', 'rainy'),
  ];

  it('usa los calendarios etiquetados; si no hay ninguno, todos', () => {
    expect(selectCalendarEntityIdList({ labelledEntityIdList: ['calendar.casa', 'light.x'], stateList }))
      .toEqual(['calendar.casa']);
    expect(selectCalendarEntityIdList({ labelledEntityIdList: ['light.x'], stateList }))
      .toEqual(['calendar.casa', 'calendar.feriados']);
  });

  it('usa el clima etiquetado, si no weather.home, si no nada', () => {
    expect(selectWeatherEntityId({ labelledEntityIdList: ['weather.otro'], stateList })).toBe('weather.otro');
    expect(selectWeatherEntityId({ labelledEntityIdList: [], stateList })).toBe('weather.home');
    expect(selectWeatherEntityId({ labelledEntityIdList: [], stateList: [] })).toBeUndefined();
  });
});

describe('buildHomeAssistantWeather', () => {
  const weatherState: HomeAssistantState = {
    entity_id: 'weather.home',
    state: 'partlycloudy',
    attributes: { temperature: 21.4, humidity: 62.6, temperature_unit: '°C' },
    last_updated: '2026-10-18T17:55:00+00:00',
  };

  it('toma la mín./máx. del pronóstico de hoy en la zona local', () => {
    const weather = buildHomeAssistantWeather({
      state: weatherState,
      dailyForecastList: [
        // 17/10 21:00 en Buenos Aires: es ayer aunque en UTC ya sea 18.
        { datetime: '2026-10-18T00:00:00+00:00', temperature: 30, templow: 20 },
        { datetime: '2026-10-18T15:00:00+00:00', temperature: 24.5, templow: 12 },
      ],
      locationLabel: 'Ing. Maschwitz',
      timezone: TIMEZONE,
      nowMilliseconds: NOW,
    });
    expect(weather).toEqual({
      locationLabel: 'Ing. Maschwitz',
      temperatureC: 21.4,
      conditionLabel: 'Parcialmente nublado',
      updatedAt: '2026-10-18T17:55:00+00:00',
      conditionCode: 'partlycloudy',
      minC: 12,
      maxC: 24.5,
      humidityPercent: 63,
    });
  });

  it('sin pronóstico sale sin mín./máx.; sin temperatura o no disponible, nada', () => {
    const withoutForecast = buildHomeAssistantWeather({
      state: weatherState,
      dailyForecastList: [],
      locationLabel: 'Casa',
      timezone: TIMEZONE,
      nowMilliseconds: NOW,
    });
    expect(withoutForecast?.minC).toBeUndefined();
    expect(withoutForecast?.maxC).toBeUndefined();
    expect(
      buildHomeAssistantWeather({
        state: { ...weatherState, attributes: {} },
        dailyForecastList: [],
        locationLabel: 'Casa',
        timezone: TIMEZONE,
        nowMilliseconds: NOW,
      }),
    ).toBeUndefined();
    expect(
      buildHomeAssistantWeather({
        state: { ...weatherState, state: 'unavailable' },
        dailyForecastList: [],
        locationLabel: 'Casa',
        timezone: TIMEZONE,
        nowMilliseconds: NOW,
      }),
    ).toBeUndefined();
  });

  it('convierte de Fahrenheit si HA está en °F', () => {
    const weather = buildHomeAssistantWeather({
      state: { ...weatherState, attributes: { temperature: 68, temperature_unit: '°F' } },
      dailyForecastList: [],
      locationLabel: 'Casa',
      timezone: TIMEZONE,
      nowMilliseconds: NOW,
    });
    expect(weather?.temperatureC).toBe(20);
  });
});

describe('normalizeCalendarEventList', () => {
  it('los de todo el día empiezan a la medianoche local', () => {
    const eventList = normalizeCalendarEventList({
      eventList: [
        { summary: 'Cumple Nico', start: { date: '2026-10-18' }, end: { date: '2026-10-19' } },
        { summary: 'Dentista', start: { dateTime: '2026-10-18T18:30:00-03:00' } },
        { summary: '   ', start: { dateTime: '2026-10-18T18:30:00-03:00' } },
        { summary: 'Sin fecha', start: {} },
      ],
      timezone: TIMEZONE,
    });
    expect(eventList).toEqual([
      {
        title: 'Cumple Nico',
        startsAtMilliseconds: Date.UTC(2026, 9, 18, 3, 0),
        endsAtMilliseconds: Date.UTC(2026, 9, 19, 3, 0),
        isAllDay: true,
      },
      { title: 'Dentista', startsAtMilliseconds: Date.UTC(2026, 9, 18, 21, 30) },
    ]);
  });
});
