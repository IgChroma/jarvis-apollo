import type { HomeAssistantTileAction, HomeTile } from '@/protocol/schema';
import {
  resolveCalendarDateInTimeZone,
  resolveWallClockInstantMilliseconds,
} from '@/time/zone';

import { planHomeAssistantAction, type HomeAssistantActionPlan } from '@/homeassistant/actions';
import type {
  HomeAssistantClient,
  HomeAssistantForecastEntry,
  HomeAssistantState,
} from '@/homeassistant/client';
import {
  buildHomeAssistantWeather,
  buildHomeTileList,
  JARVIS_HOME_ASSISTANT_LABEL,
  normalizeCalendarEventList,
  resolveHomeEntityKind,
  selectCalendarEntityIdList,
  selectWeatherEntityId,
  type DashboardCalendarEvent,
  type HomeAssistantWeather,
} from '@/homeassistant/entities';

// Lo que el tablero lee de Home Assistant en cada vuelta, con sus cachés.
//
// Ritmos (docs/vistas-tablero.md):
//   - estados: en cada vuelta (10 s). Es lo que tiene que reflejar un toque.
//   - etiqueta: 1 min. Cambia cuando el usuario edita HA, no en cada vuelta.
//   - calendarios: 5 min.
//   - pronóstico (mín./máx.): 30 min.
// Y si HA no contesta, se lo deja de consultar 30 s: si no, cada vuelta
// esperaría el timeout entero antes de mandar el resto del tablero.

export const HOME_ASSISTANT_LABEL_CACHE_MILLISECONDS = 60_000;
export const HOME_ASSISTANT_CALENDAR_CACHE_MILLISECONDS = 5 * 60_000;
export const HOME_ASSISTANT_FORECAST_CACHE_MILLISECONDS = 30 * 60_000;
export const HOME_ASSISTANT_UNREACHABLE_BACKOFF_MILLISECONDS = 30_000;
// Tras un error de una fuente cacheada, cuánto esperar para reintentarla.
const CACHED_SOURCE_RETRY_MILLISECONDS = 60_000;
// La agenda mira hacia adelante: si estamos el 30, el mes no alcanza.
const AGENDA_LOOKAHEAD_MILLISECONDS = 7 * 24 * 60 * 60_000;

export type HomeAssistantDashboardData = {
  readonly calendarEventList: readonly DashboardCalendarEvent[];
  readonly weather?: HomeAssistantWeather;
  readonly tileList: readonly HomeTile[];
};

export type HomeAssistantActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

type CachedEntry<Value> = {
  readonly key: string;
  readonly value: Value | undefined;
  readonly expiresAtMilliseconds: number;
};

// Celda de caché con clave: si la clave cambia (otro mes, otro calendario) se
// vuelve a leer aunque no haya vencido. Un error deja el valor anterior y
// reintenta en un minuto, en vez de martillar a HA en cada vuelta.
function createCachedCell<Value>(ttlMilliseconds: number) {
  let entry: CachedEntry<Value> | undefined;
  return {
    async read(input: {
      readonly key: string;
      readonly nowMilliseconds: number;
      readonly load: () => Promise<Value>;
      readonly onError: (error: unknown) => void;
    }): Promise<Value | undefined> {
      if (
        entry !== undefined &&
        entry.key === input.key &&
        input.nowMilliseconds < entry.expiresAtMilliseconds
      ) {
        return entry.value;
      }
      try {
        const value = await input.load();
        entry = { key: input.key, value, expiresAtMilliseconds: input.nowMilliseconds + ttlMilliseconds };
        return value;
      } catch (error) {
        input.onError(error);
        const staleValue = entry?.key === input.key ? entry.value : undefined;
        entry = {
          key: input.key,
          value: staleValue,
          expiresAtMilliseconds: input.nowMilliseconds + CACHED_SOURCE_RETRY_MILLISECONDS,
        };
        return staleValue;
      }
    },
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logWarning(message: string, detail: unknown): void {
  console.log(JSON.stringify({ level: 'warn', message, detail: describeError(detail) }));
}

/** Rango de calendario a pedir: desde el 1º del mes local hasta fin de mes o una semana adelante. */
export function resolveCalendarRange(input: {
  readonly timezone: string;
  readonly nowMilliseconds: number;
}): { readonly monthKey: string; readonly startMilliseconds: number; readonly endMilliseconds: number } {
  const today = resolveCalendarDateInTimeZone(input.timezone, input.nowMilliseconds);
  const startMilliseconds = resolveWallClockInstantMilliseconds({
    timeZone: input.timezone,
    date: { ...today, day: 1 },
    hour: 0,
    minute: 0,
  });
  const nextMonth = today.month === 12
    ? { year: today.year + 1, month: 1 }
    : { year: today.year, month: today.month + 1 };
  const nextMonthStartMilliseconds = resolveWallClockInstantMilliseconds({
    timeZone: input.timezone,
    date: { ...nextMonth, day: 1, weekday: 0 },
    hour: 0,
    minute: 0,
  });
  return {
    monthKey: `${today.year}-${today.month}`,
    startMilliseconds,
    endMilliseconds: Math.max(
      nextMonthStartMilliseconds,
      input.nowMilliseconds + AGENDA_LOOKAHEAD_MILLISECONDS,
    ),
  };
}

export type HomeAssistantDashboardSource = {
  readDashboardData(input: {
    readonly timezone: string;
    readonly locationLabel: string;
  }): Promise<HomeAssistantDashboardData | undefined>;
  executeTileAction(input: {
    readonly entityId: string;
    readonly action: HomeAssistantTileAction;
  }): Promise<HomeAssistantActionResult>;
};

export function createHomeAssistantDashboardSource(input: {
  readonly client: HomeAssistantClient;
  readonly label?: string;
  readonly now?: () => number;
}): HomeAssistantDashboardSource {
  const { client } = input;
  const label = input.label ?? JARVIS_HOME_ASSISTANT_LABEL;
  const now = input.now ?? (() => Date.now());
  const labelCell = createCachedCell<readonly string[]>(HOME_ASSISTANT_LABEL_CACHE_MILLISECONDS);
  const calendarCell = createCachedCell<readonly DashboardCalendarEvent[]>(
    HOME_ASSISTANT_CALENDAR_CACHE_MILLISECONDS,
  );
  const forecastCell = createCachedCell<readonly HomeAssistantForecastEntry[]>(
    HOME_ASSISTANT_FORECAST_CACHE_MILLISECONDS,
  );
  let unreachableUntilMilliseconds = Number.NEGATIVE_INFINITY;
  let isReachable = true;

  function noteReachability(reachable: boolean, error?: unknown): void {
    // Solo se loguean los cambios: con HA caído una línea cada 30 s llenaría el log.
    if (reachable !== isReachable) {
      console.log(
        JSON.stringify({
          level: reachable ? 'info' : 'warn',
          message: reachable ? 'home_assistant_volvio' : 'home_assistant_no_responde',
          ...(error === undefined ? {} : { detail: describeError(error) }),
        }),
      );
    }
    isReachable = reachable;
    if (!reachable) {
      unreachableUntilMilliseconds = now() + HOME_ASSISTANT_UNREACHABLE_BACKOFF_MILLISECONDS;
    }
  }

  async function readLabelledEntityIdList(): Promise<readonly string[]> {
    return (
      (await labelCell.read({
        key: label,
        nowMilliseconds: now(),
        load: () => client.listLabelEntityIds(label),
        onError: (error) => logWarning('home_assistant_etiqueta_fallo', error),
      })) ?? []
    );
  }

  async function readCalendarEventList(inputCalendar: {
    readonly calendarEntityIdList: readonly string[];
    readonly timezone: string;
  }): Promise<readonly DashboardCalendarEvent[]> {
    if (inputCalendar.calendarEntityIdList.length === 0) {
      return [];
    }
    const range = resolveCalendarRange({ timezone: inputCalendar.timezone, nowMilliseconds: now() });
    return (
      (await calendarCell.read({
        key: `${range.monthKey}|${inputCalendar.timezone}|${inputCalendar.calendarEntityIdList.join(',')}`,
        nowMilliseconds: now(),
        load: async () => {
          const resultList = await Promise.allSettled(
            inputCalendar.calendarEntityIdList.map((calendarEntityId) =>
              client.listCalendarEvents({
                calendarEntityId,
                startIso: new Date(range.startMilliseconds).toISOString(),
                endIso: new Date(range.endMilliseconds).toISOString(),
              }),
            ),
          );
          const fulfilledList = resultList.filter(
            (result): result is PromiseFulfilledResult<Awaited<ReturnType<HomeAssistantClient['listCalendarEvents']>>> =>
              result.status === 'fulfilled',
          );
          // Un calendario roto no tapa a los demás; si fallan todos, es error
          // y la celda reintenta (con el valor anterior mientras tanto).
          if (fulfilledList.length === 0) {
            const firstRejection = resultList.find((result) => result.status === 'rejected');
            throw firstRejection?.reason ?? new Error('ningún calendario respondió');
          }
          return fulfilledList.flatMap((result) =>
            normalizeCalendarEventList({ eventList: result.value, timezone: inputCalendar.timezone }),
          );
        },
        onError: (error) => logWarning('home_assistant_calendario_fallo', error),
      })) ?? []
    );
  }

  async function readWeather(inputWeather: {
    readonly weatherEntityId: string | undefined;
    readonly stateList: readonly HomeAssistantState[];
    readonly timezone: string;
    readonly locationLabel: string;
  }): Promise<HomeAssistantWeather | undefined> {
    const { weatherEntityId } = inputWeather;
    if (weatherEntityId === undefined) {
      return undefined;
    }
    const state = inputWeather.stateList.find((entry) => entry.entity_id === weatherEntityId);
    if (state === undefined) {
      return undefined;
    }
    const dailyForecastList =
      (await forecastCell.read({
        key: weatherEntityId,
        nowMilliseconds: now(),
        load: () => client.getDailyForecast(weatherEntityId),
        onError: (error) => logWarning('home_assistant_pronostico_fallo', error),
      })) ?? [];
    return buildHomeAssistantWeather({
      state,
      dailyForecastList,
      locationLabel: inputWeather.locationLabel,
      timezone: inputWeather.timezone,
      nowMilliseconds: now(),
    });
  }

  return {
    async readDashboardData({ timezone, locationLabel }) {
      if (now() < unreachableUntilMilliseconds) {
        return undefined;
      }
      // Los estados van primero y sin caché: si HA no los da, no hay nada más
      // que pedirle en esta vuelta.
      let stateList: readonly HomeAssistantState[];
      try {
        stateList = await client.listStates();
      } catch (error) {
        noteReachability(false, error);
        return undefined;
      }
      noteReachability(true);
      const labelledEntityIdList = await readLabelledEntityIdList();
      const [calendarEventList, weather] = await Promise.all([
        readCalendarEventList({
          calendarEntityIdList: selectCalendarEntityIdList({ labelledEntityIdList, stateList }),
          timezone,
        }),
        readWeather({
          weatherEntityId: selectWeatherEntityId({ labelledEntityIdList, stateList }),
          stateList,
          timezone,
          locationLabel,
        }),
      ]);
      return {
        calendarEventList,
        ...(weather === undefined ? {} : { weather }),
        tileList: buildHomeTileList({ labelledEntityIdList, stateList }),
      };
    },

    async executeTileAction({ entityId, action }) {
      // La etiqueta sale de la caché (1 min): alcanza para "hoy está
      // etiquetada" y evita un pedido extra por toque. El estado se lee fresco
      // porque el objetivo del aire tiene que ser el de ahora.
      const labelledEntityIdSet = new Set(await readLabelledEntityIdList());
      let state: HomeAssistantState | undefined;
      if (labelledEntityIdSet.has(entityId) && resolveHomeEntityKind(entityId) === 'climate') {
        try {
          state = (await client.listStates()).find((entry) => entry.entity_id === entityId);
        } catch (error) {
          return { ok: false, reason: `estado: ${describeError(error)}` };
        }
      }
      const plan: HomeAssistantActionPlan = planHomeAssistantAction({
        entityId,
        action,
        labelledEntityIdSet,
        state,
      });
      if (!plan.ok) {
        return { ok: false, reason: plan.reason };
      }
      try {
        await client.callService(plan.serviceCall);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: describeError(error) };
      }
    },
  };
}
