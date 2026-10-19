import type { HomeTile } from '@/protocol/schema';
import {
  resolveCalendarDateInTimeZone,
  resolveWallClockInstantMilliseconds,
} from '@/time/zone';

import type {
  HomeAssistantCalendarEvent,
  HomeAssistantForecastEntry,
  HomeAssistantState,
} from '@/homeassistant/client';

// Traducción de lo que devuelve Home Assistant a lo que necesita el tablero.
//
// Todo puro: recibe estados/eventos ya leídos y devuelve datos del tablero. Los
// recortes de largo NO viven acá sino en dashboard/payload.ts, junto con los
// del resto de las tarjetas, para que haya un solo lugar donde ajustarlos.

// La etiqueta que el usuario le pone en HA a lo que quiere ver en la placa.
export const JARVIS_HOME_ASSISTANT_LABEL = 'jarvis';
export const DEFAULT_WEATHER_ENTITY_ID = 'weather.home';

export type HomeEntityKind = 'toggle' | 'sensor' | 'climate' | 'calendar' | 'weather';

// Dominio → tipo de mosaico (docs/vistas-tablero.md). Calendarios y clima con
// la etiqueta alimentan la vista Inicio, no son mosaicos.
const ENTITY_KIND_BY_DOMAIN = new Map<string, HomeEntityKind>([
  ['light', 'toggle'],
  ['switch', 'toggle'],
  ['fan', 'toggle'],
  ['input_boolean', 'toggle'],
  ['sensor', 'sensor'],
  ['binary_sensor', 'sensor'],
  ['climate', 'climate'],
  ['calendar', 'calendar'],
  ['weather', 'weather'],
]);

// Orden en la grilla: primero lo que se toca, después lo que se mira. Dentro de
// cada grupo, alfabético: `label_entities` devuelve el orden del registro de
// HA, que cambia al renombrar y haría saltar los mosaicos de lugar.
const TILE_KIND_ORDER: Readonly<Record<HomeTile['kind'], number>> = {
  toggle: 0,
  climate: 1,
  sensor: 2,
};

const UNAVAILABLE_STATE_SET = new Set(['unavailable', 'unknown']);

export function resolveEntityDomain(entityId: string): string {
  return entityId.split('.', 1)[0] ?? '';
}

export function resolveHomeEntityKind(entityId: string): HomeEntityKind | undefined {
  return ENTITY_KIND_BY_DOMAIN.get(resolveEntityDomain(entityId));
}

export function isEntityAvailable(state: HomeAssistantState | undefined): boolean {
  return state !== undefined && !UNAVAILABLE_STATE_SET.has(state.state);
}

function readNumberAttribute(
  state: HomeAssistantState,
  attributeName: string,
): number | undefined {
  const value = state.attributes[attributeName];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  // Algunas integraciones mandan los números como texto.
  if (typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function readStringAttribute(
  state: HomeAssistantState,
  attributeName: string,
): string | undefined {
  const value = state.attributes[attributeName];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function resolveEntityName(state: HomeAssistantState): string {
  const friendlyName = readStringAttribute(state, 'friendly_name');
  if (friendlyName !== undefined) {
    return friendlyName;
  }
  // Sin nombre amigable: el objeto del id con espacios ("temp_patio" → "temp patio").
  const objectId = state.entity_id.split('.').slice(1).join('.');
  return objectId.replace(/_/g, ' ').trim() || state.entity_id;
}

// Un sensor numérico de HA puede venir con muchos decimales ("18.23456"): uno
// alcanza para leerlo de reojo. Lo que no es número pasa tal cual.
export function formatSensorValue(rawState: string): string {
  const trimmed = rawState.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const decimals = trimmed.split('.')[1]?.length ?? 0;
    if (decimals > 1) {
      return String(Math.round(Number(trimmed) * 10) / 10);
    }
  }
  return trimmed;
}

// binary_sensor viene como on/off: se traduce según lo que mide. Corto a
// propósito, el valor del mosaico entra en 10 caracteres.
const BINARY_SENSOR_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  door: ['Abierta', 'Cerrada'],
  garage_door: ['Abierta', 'Cerrada'],
  window: ['Abierta', 'Cerrada'],
  opening: ['Abierto', 'Cerrado'],
  motion: ['Movimiento', 'Nada'],
  occupancy: ['Ocupado', 'Libre'],
  presence: ['En casa', 'Afuera'],
  moisture: ['Mojado', 'Seco'],
  smoke: ['¡Humo!', 'OK'],
  problem: ['Problema', 'OK'],
  connectivity: ['Conectado', 'Sin red'],
};

function formatBinarySensorValue(state: HomeAssistantState): string {
  const deviceClass = readStringAttribute(state, 'device_class') ?? '';
  const [onLabel, offLabel] = BINARY_SENSOR_LABELS[deviceClass] ?? ['Sí', 'No'];
  if (state.state === 'on') {
    return onLabel;
  }
  if (state.state === 'off') {
    return offLabel;
  }
  return state.state;
}

// Valor que se muestra cuando la entidad no responde: la placa la pinta
// apagada por `available: false`; el guion es para que el valor no quede vacío.
const UNAVAILABLE_VALUE = '—';

export function buildHomeTile(state: HomeAssistantState): HomeTile | undefined {
  const kind = resolveHomeEntityKind(state.entity_id);
  const available = isEntityAvailable(state);
  const base = {
    entityId: state.entity_id,
    name: resolveEntityName(state),
    available,
  };
  if (kind === 'toggle') {
    return { ...base, kind: 'toggle', isOn: state.state === 'on' };
  }
  if (kind === 'sensor') {
    const value = !available
      ? UNAVAILABLE_VALUE
      : resolveEntityDomain(state.entity_id) === 'binary_sensor'
        ? formatBinarySensorValue(state)
        : formatSensorValue(state.state);
    const unit = readStringAttribute(state, 'unit_of_measurement');
    return {
      ...base,
      kind: 'sensor',
      value: value.length > 0 ? value : UNAVAILABLE_VALUE,
      ...(unit === undefined || !available ? {} : { unit }),
    };
  }
  if (kind === 'climate') {
    const currentC = readNumberAttribute(state, 'current_temperature');
    const targetC = readNumberAttribute(state, 'temperature');
    return {
      ...base,
      kind: 'climate',
      ...(currentC === undefined ? {} : { currentC }),
      ...(targetC === undefined ? {} : { targetC }),
      ...(available ? { hvacMode: state.state } : {}),
    };
  }
  return undefined;
}

/**
 * Mosaicos de la vista Casa: las entidades con la etiqueta que son interruptor,
 * sensor o clima. Una entidad etiquetada sin estado (deshabilitada o borrada en
 * HA) no se muestra: no hay ni nombre para dibujarla.
 */
export function buildHomeTileList(input: {
  readonly labelledEntityIdList: readonly string[];
  readonly stateList: readonly HomeAssistantState[];
}): readonly HomeTile[] {
  const stateById = new Map(input.stateList.map((state) => [state.entity_id, state]));
  const tileList: HomeTile[] = [];
  for (const entityId of new Set(input.labelledEntityIdList)) {
    const state = stateById.get(entityId);
    if (state === undefined) {
      continue;
    }
    const tile = buildHomeTile(state);
    if (tile !== undefined) {
      tileList.push(tile);
    }
  }
  return tileList.toSorted(
    (left, right) =>
      TILE_KIND_ORDER[left.kind] - TILE_KIND_ORDER[right.kind] ||
      left.name.localeCompare(right.name, 'es'),
  );
}

/** Calendarios para la agenda: los etiquetados; si ninguno lo está, todos. */
export function selectCalendarEntityIdList(input: {
  readonly labelledEntityIdList: readonly string[];
  readonly stateList: readonly HomeAssistantState[];
}): readonly string[] {
  const labelledCalendarList = input.labelledEntityIdList.filter(
    (entityId) => resolveHomeEntityKind(entityId) === 'calendar',
  );
  if (labelledCalendarList.length > 0) {
    return [...new Set(labelledCalendarList)];
  }
  return input.stateList
    .map((state) => state.entity_id)
    .filter((entityId) => resolveHomeEntityKind(entityId) === 'calendar');
}

/** Clima: el primero etiquetado; si no, `weather.home` si existe. */
export function selectWeatherEntityId(input: {
  readonly labelledEntityIdList: readonly string[];
  readonly stateList: readonly HomeAssistantState[];
}): string | undefined {
  const labelledWeather = input.labelledEntityIdList.find(
    (entityId) => resolveHomeEntityKind(entityId) === 'weather',
  );
  if (labelledWeather !== undefined) {
    return labelledWeather;
  }
  return input.stateList.some((state) => state.entity_id === DEFAULT_WEATHER_ENTITY_ID)
    ? DEFAULT_WEATHER_ENTITY_ID
    : undefined;
}

// Condiciones de HA (https://www.home-assistant.io/integrations/weather/) en
// el castellano de la tarjeta, con las mismas palabras que usa open-meteo.
const CONDITION_LABEL_BY_CODE = new Map<string, string>([
  ['clear-night', 'Despejado'],
  ['sunny', 'Soleado'],
  ['partlycloudy', 'Parcialmente nublado'],
  ['cloudy', 'Nublado'],
  ['fog', 'Niebla'],
  ['rainy', 'Lluvia'],
  ['pouring', 'Lluvia fuerte'],
  ['lightning', 'Tormenta eléctrica'],
  ['lightning-rainy', 'Tormenta'],
  ['hail', 'Granizo'],
  ['snowy', 'Nieve'],
  ['snowy-rainy', 'Aguanieve'],
  ['windy', 'Ventoso'],
  ['windy-variant', 'Ventoso y nublado'],
  ['exceptional', 'Excepcional'],
]);

export function mapHomeAssistantConditionToSpanishLabel(conditionCode: string): string {
  return CONDITION_LABEL_BY_CODE.get(conditionCode) ?? 'Desconocido';
}

function toCelsius(value: number, unit: string | undefined): number {
  return unit === '°F' ? Math.round(((value - 32) * 5) / 9 * 10) / 10 : value;
}

function formatIsoDate(date: { year: number; month: number; day: number }): string {
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

export type HomeAssistantWeather = {
  readonly locationLabel: string;
  readonly temperatureC: number;
  readonly conditionLabel: string;
  readonly updatedAt: string;
  readonly conditionCode?: string;
  readonly minC?: number;
  readonly maxC?: number;
  readonly humidityPercent?: number;
};

/**
 * Clima de la tarjeta a partir de una entidad `weather.*` y su pronóstico
 * diario. Devuelve `undefined` si la entidad no tiene temperatura: así el
 * tablero cae al clima de open-meteo en vez de mostrar un cero.
 */
export function buildHomeAssistantWeather(input: {
  readonly state: HomeAssistantState;
  readonly dailyForecastList: readonly HomeAssistantForecastEntry[];
  readonly locationLabel: string;
  readonly timezone: string;
  readonly nowMilliseconds: number;
}): HomeAssistantWeather | undefined {
  const { state } = input;
  if (!isEntityAvailable(state)) {
    return undefined;
  }
  const unit = readStringAttribute(state, 'temperature_unit');
  const temperature = readNumberAttribute(state, 'temperature');
  if (temperature === undefined) {
    return undefined;
  }
  const humidity = readNumberAttribute(state, 'humidity');
  // El pronóstico de hoy: la entrada cuyo día local es hoy. Si no hay (algunos
  // proveedores arrancan en mañana después del mediodía), la primera.
  const todayIsoDate = formatIsoDate(
    resolveCalendarDateInTimeZone(input.timezone, input.nowMilliseconds),
  );
  const todayForecast =
    input.dailyForecastList.find((entry) => {
      const entryMilliseconds = Date.parse(entry.datetime);
      return (
        Number.isFinite(entryMilliseconds) &&
        formatIsoDate(resolveCalendarDateInTimeZone(input.timezone, entryMilliseconds)) ===
          todayIsoDate
      );
    }) ?? input.dailyForecastList[0];
  const maxC = todayForecast?.temperature ?? undefined;
  const minC = todayForecast?.templow ?? undefined;
  return {
    locationLabel: input.locationLabel,
    temperatureC: toCelsius(temperature, unit),
    conditionLabel: mapHomeAssistantConditionToSpanishLabel(state.state),
    updatedAt: state.last_updated ?? new Date(input.nowMilliseconds).toISOString(),
    conditionCode: state.state,
    ...(minC === undefined ? {} : { minC: toCelsius(minC, unit) }),
    ...(maxC === undefined ? {} : { maxC: toCelsius(maxC, unit) }),
    ...(humidity === undefined ? {} : { humidityPercent: Math.round(humidity) }),
  };
}

export type DashboardCalendarEvent = {
  readonly title: string;
  readonly startsAtMilliseconds: number;
  // Fin exclusivo. En los de todo el día es la medianoche local del día
  // siguiente al último.
  readonly endsAtMilliseconds?: number;
  readonly isAllDay?: boolean;
};

function parseIsoDateParts(isoDate: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (match === null) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

function resolveEventInstant(
  time: HomeAssistantCalendarEvent['start'] | undefined,
  timezone: string,
): { readonly milliseconds: number; readonly isAllDay: boolean } | undefined {
  if (time?.dateTime !== undefined) {
    const milliseconds = Date.parse(time.dateTime);
    return Number.isFinite(milliseconds) ? { milliseconds, isAllDay: false } : undefined;
  }
  if (time?.date !== undefined) {
    const date = parseIsoDateParts(time.date);
    if (date === undefined) {
      return undefined;
    }
    // Un evento de todo el día empieza a la medianoche LOCAL, no de UTC: si no,
    // en Buenos Aires el cumpleaños del 18 aparecería el 17 a las 21.
    return {
      milliseconds: resolveWallClockInstantMilliseconds({
        timeZone: timezone,
        date,
        hour: 0,
        minute: 0,
      }),
      isAllDay: true,
    };
  }
  return undefined;
}

export function normalizeCalendarEventList(input: {
  readonly eventList: readonly HomeAssistantCalendarEvent[];
  readonly timezone: string;
}): readonly DashboardCalendarEvent[] {
  const normalizedList: DashboardCalendarEvent[] = [];
  for (const event of input.eventList) {
    const title = event.summary.trim();
    const start = resolveEventInstant(event.start, input.timezone);
    if (title.length === 0 || start === undefined) {
      continue;
    }
    const end = resolveEventInstant(event.end, input.timezone);
    normalizedList.push({
      title,
      startsAtMilliseconds: start.milliseconds,
      ...(end === undefined ? {} : { endsAtMilliseconds: end.milliseconds }),
      ...(start.isAllDay ? { isAllDay: true } : {}),
    });
  }
  return normalizedList;
}
