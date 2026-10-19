import { describe, expect, it } from 'bun:test';

import {
  createHomeAssistantClient,
  isValidEntityId,
  parseLabelEntityIdList,
  resolveHomeAssistantConnection,
  type HomeAssistantFetchImplementation,
} from '@/homeassistant/client';

type CapturedRequest = {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: unknown;
};

function createFetchMock(respond: (url: string) => Response) {
  const requestList: CapturedRequest[] = [];
  const fetchImpl: HomeAssistantFetchImplementation = async (url, init) => {
    const headers = new Headers(init.headers);
    requestList.push({
      url,
      method: init.method ?? 'GET',
      authorization: headers.get('Authorization'),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return respond(url);
  };
  return { fetchImpl, requestList };
}

const connection = { apiBaseUrl: 'http://ha.test/api', token: 'secreto', source: 'ha_url' } as const;

// Un HA colgado: no contesta nunca, solo se entera del abort del timeout.
const neverAnsweringFetch: HomeAssistantFetchImplementation = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('timeout')));
  });

describe('resolveHomeAssistantConnection', () => {
  it('dentro del add-on usa el Supervisor', () => {
    expect(
      resolveHomeAssistantConnection({ SUPERVISOR_TOKEN: 'abc', HA_URL: 'http://otro:8123', HA_TOKEN: 'x' }),
    ).toEqual({ apiBaseUrl: 'http://supervisor/core/api', token: 'abc', source: 'supervisor' });
  });

  it('afuera usa HA_URL + HA_TOKEN, con o sin /api y barra final', () => {
    expect(resolveHomeAssistantConnection({ HA_URL: 'http://192.168.0.111:8123/', HA_TOKEN: 't' }))
      .toEqual({ apiBaseUrl: 'http://192.168.0.111:8123/api', token: 't', source: 'ha_url' });
    expect(resolveHomeAssistantConnection({ HA_URL: 'http://ha:8123/api', HA_TOKEN: 't' })?.apiBaseUrl)
      .toBe('http://ha:8123/api');
  });

  it('sin token o sin URL no hay Home Assistant', () => {
    expect(resolveHomeAssistantConnection({})).toBeUndefined();
    expect(resolveHomeAssistantConnection({ HA_URL: 'http://ha:8123' })).toBeUndefined();
    expect(resolveHomeAssistantConnection({ HA_TOKEN: 't', SUPERVISOR_TOKEN: '  ' })).toBeUndefined();
  });
});

describe('isValidEntityId / parseLabelEntityIdList', () => {
  it('acepta dominio.objeto y rechaza lo raro', () => {
    expect(isValidEntityId('light.living')).toBe(true);
    expect(isValidEntityId('sensor.temp_patio_2')).toBe(true);
    expect(isValidEntityId('light')).toBe(false);
    expect(isValidEntityId('light.living/../../config')).toBe(false);
    expect(isValidEntityId('Light.Living')).toBe(false);
    expect(isValidEntityId('light.a.b')).toBe(false);
  });

  it('parsea el JSON del template y descarta lo que no es un id', () => {
    expect(parseLabelEntityIdList('["light.living", 3, "basura", "climate.dormitorio"]'))
      .toEqual(['light.living', 'climate.dormitorio']);
    expect(() => parseLabelEntityIdList('{"no":"lista"}')).toThrow();
  });
});

describe('createHomeAssistantClient', () => {
  it('pide la etiqueta por /api/template con el token', async () => {
    const { fetchImpl, requestList } = createFetchMock(
      () => new Response('["light.living","sensor.temp_patio"]', { status: 200 }),
    );
    const client = createHomeAssistantClient({ connection, fetchImpl });

    expect(await client.listLabelEntityIds('jarvis')).toEqual(['light.living', 'sensor.temp_patio']);
    expect(requestList).toEqual([
      {
        url: 'http://ha.test/api/template',
        method: 'POST',
        authorization: 'Bearer secreto',
        body: { template: "{{ label_entities('jarvis') | list | tojson }}" },
      },
    ]);
  });

  it('lee los estados y descarta los que no tienen forma de estado', async () => {
    const { fetchImpl } = createFetchMock(() =>
      Response.json([
        { entity_id: 'light.living', state: 'on', attributes: { friendly_name: 'Living' } },
        { entity_id: 'sensor.roto' },
        { entity_id: 'switch.bomba', state: 'off' },
      ]),
    );
    const stateList = await createHomeAssistantClient({ connection, fetchImpl }).listStates();
    expect(stateList.map((state) => state.entity_id)).toEqual(['light.living', 'switch.bomba']);
    expect(stateList[1]?.attributes).toEqual({});
  });

  it('pide los eventos del calendario con el rango', async () => {
    const { fetchImpl, requestList } = createFetchMock(() =>
      Response.json([
        { summary: 'Dentista', start: { dateTime: '2026-10-18T18:30:00-03:00' }, end: { dateTime: '2026-10-18T19:30:00-03:00' } },
        { summary: 'Cumple Nico', start: { date: '2026-10-18' }, end: { date: '2026-10-19' } },
        { start: 'roto' },
      ]),
    );
    const eventList = await createHomeAssistantClient({ connection, fetchImpl }).listCalendarEvents({
      calendarEntityId: 'calendar.casa',
      startIso: '2026-10-01T03:00:00.000Z',
      endIso: '2026-11-01T03:00:00.000Z',
    });
    expect(eventList.map((event) => event.summary)).toEqual(['Dentista', 'Cumple Nico']);
    expect(requestList[0]?.url).toBe(
      'http://ha.test/api/calendars/calendar.casa?start=2026-10-01T03%3A00%3A00.000Z&end=2026-11-01T03%3A00%3A00.000Z',
    );
  });

  it('no arma una URL con un id de calendario inválido', async () => {
    const { fetchImpl, requestList } = createFetchMock(() => Response.json([]));
    await expect(
      createHomeAssistantClient({ connection, fetchImpl }).listCalendarEvents({
        calendarEntityId: '../states',
        startIso: 'a',
        endIso: 'b',
      }),
    ).rejects.toThrow();
    expect(requestList).toEqual([]);
  });

  it('pide el pronóstico diario con return_response y lee el de la entidad', async () => {
    const { fetchImpl, requestList } = createFetchMock(() =>
      Response.json({
        changed_states: [],
        service_response: {
          'weather.home': {
            forecast: [
              { datetime: '2026-10-18T15:00:00+00:00', temperature: 24.5, templow: 12, condition: 'sunny' },
            ],
          },
        },
      }),
    );
    const forecastList = await createHomeAssistantClient({ connection, fetchImpl }).getDailyForecast('weather.home');
    expect(forecastList).toEqual([
      { datetime: '2026-10-18T15:00:00+00:00', temperature: 24.5, templow: 12, condition: 'sunny' },
    ]);
    expect(requestList[0]).toMatchObject({
      url: 'http://ha.test/api/services/weather/get_forecasts?return_response',
      method: 'POST',
      body: { entity_id: 'weather.home', type: 'daily' },
    });
  });

  it('llama servicios por POST /api/services/<dominio>/<servicio>', async () => {
    const { fetchImpl, requestList } = createFetchMock(() => Response.json([]));
    await createHomeAssistantClient({ connection, fetchImpl }).callService({
      domain: 'climate',
      service: 'set_temperature',
      data: { entity_id: 'climate.dormitorio', temperature: 23 },
    });
    expect(requestList[0]).toMatchObject({
      url: 'http://ha.test/api/services/climate/set_temperature',
      method: 'POST',
      body: { entity_id: 'climate.dormitorio', temperature: 23 },
    });
  });

  it('un error de HA se tira sin el token en el mensaje', async () => {
    const { fetchImpl } = createFetchMock(() => new Response('nope', { status: 401 }));
    const client = createHomeAssistantClient({ connection, fetchImpl });
    const error = await client.listStates().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Home Assistant GET /states respondió 401');
    expect((error as Error).message).not.toContain('secreto');
  });

  it('corta por timeout si HA no contesta', async () => {
    const client = createHomeAssistantClient({
      connection,
      fetchImpl: neverAnsweringFetch,
      timeoutMilliseconds: 20,
    });
    await expect(client.listStates()).rejects.toThrow('timeout');
  });
});
