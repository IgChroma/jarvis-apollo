import { z } from 'zod';

// Cliente mínimo de la API REST de Home Assistant para el tablero.
//
// Dos formas de llegar a HA (docs/vistas-tablero.md):
//   - Dentro del add-on: el Supervisor inyecta SUPERVISOR_TOKEN y la API de HA
//     queda en http://supervisor/core/api (con `homeassistant_api: true`).
//   - Fuera de HA (el contenedor de la Pi con Raspberry Pi OS): HA_URL + HA_TOKEN,
//     un token de larga duración.
// Sin ninguna de las dos no hay cliente y el tablero sale sin las tarjetas de HA.
//
// Cada pedido tiene timeout corto: el tablero se arma cada 10 s y un HA colgado
// no puede dejar a la placa esperando. Los errores se tiran para arriba; quien
// arma el tablero los traga y la tarjeta simplemente no sale.

export const HOME_ASSISTANT_REQUEST_TIMEOUT_MILLISECONDS = 4_000;
const SUPERVISOR_CORE_API_URL = 'http://supervisor/core/api';

export type HomeAssistantConnection = {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly source: 'supervisor' | 'ha_url';
};

export type HomeAssistantFetchImplementation = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export function resolveHomeAssistantConnection(
  environment: Record<string, string | undefined>,
): HomeAssistantConnection | undefined {
  const supervisorToken = environment.SUPERVISOR_TOKEN?.trim();
  if (supervisorToken !== undefined && supervisorToken.length > 0) {
    return { apiBaseUrl: SUPERVISOR_CORE_API_URL, token: supervisorToken, source: 'supervisor' };
  }
  const homeAssistantUrl = environment.HA_URL?.trim();
  const homeAssistantToken = environment.HA_TOKEN?.trim();
  if (
    homeAssistantUrl === undefined || homeAssistantUrl.length === 0 ||
    homeAssistantToken === undefined || homeAssistantToken.length === 0
  ) {
    return undefined;
  }
  // Se acepta con o sin /api al final y con o sin barra: es lo que la gente
  // copia de la barra del navegador.
  const withoutTrailingSlash = homeAssistantUrl.replace(/\/+$/, '');
  const apiBaseUrl = withoutTrailingSlash.endsWith('/api')
    ? withoutTrailingSlash
    : `${withoutTrailingSlash}/api`;
  return { apiBaseUrl, token: homeAssistantToken, source: 'ha_url' };
}

export const homeAssistantStateSchema = z.object({
  entity_id: z.string().min(1),
  state: z.string(),
  attributes: z.record(z.unknown()).default({}),
  last_updated: z.string().optional(),
});

export type HomeAssistantState = z.infer<typeof homeAssistantStateSchema>;

// Fecha de un evento: `dateTime` para los que tienen hora, `date` para los de
// todo el día (con fin EXCLUSIVO, como en Google Calendar).
const calendarEventTimeSchema = z.object({
  dateTime: z.string().optional(),
  date: z.string().optional(),
});

// Agenda v2: `uid` (y `recurrence_id` en una repetición) es lo que pide
// `calendar/event/delete`; descripción y lugar van al detalle de la placa. HA
// los manda en null cuando no hay, por eso `nullish`.
export const homeAssistantCalendarEventSchema = z.object({
  summary: z.string().default(''),
  start: calendarEventTimeSchema,
  end: calendarEventTimeSchema.optional(),
  uid: z.string().nullish(),
  recurrence_id: z.string().nullish(),
  description: z.string().nullish(),
  location: z.string().nullish(),
});

export type HomeAssistantCalendarEvent = z.infer<typeof homeAssistantCalendarEventSchema>;

export const homeAssistantForecastEntrySchema = z.object({
  datetime: z.string().min(1),
  temperature: z.number().nullable().optional(),
  templow: z.number().nullable().optional(),
  condition: z.string().nullable().optional(),
});

export type HomeAssistantForecastEntry = z.infer<typeof homeAssistantForecastEntrySchema>;

const forecastServiceResponseSchema = z.object({
  service_response: z.record(
    z.object({ forecast: z.array(homeAssistantForecastEntrySchema).default([]) }),
  ),
});

// Formato de un id de entidad de HA: dominio.objeto, minúsculas, dígitos y
// guion bajo. Más laxo que el de HA (que además prohíbe "__" y bordes con
// "_"), pero alcanza para que un id armado a mano no llegue a una URL.
const ENTITY_ID_PATTERN = /^[a-z0-9_]+\.[a-z0-9_]+$/;

export function isValidEntityId(entityId: string): boolean {
  return ENTITY_ID_PATTERN.test(entityId);
}

export function parseLabelEntityIdList(renderedTemplate: string): readonly string[] {
  const parsed: unknown = JSON.parse(renderedTemplate);
  if (!Array.isArray(parsed)) {
    throw new Error('label_entities no devolvió una lista');
  }
  return parsed.filter(
    (entry): entry is string => typeof entry === 'string' && isValidEntityId(entry),
  );
}

export function parseStateList(rawPayload: unknown): readonly HomeAssistantState[] {
  if (!Array.isArray(rawPayload)) {
    throw new Error('/api/states no devolvió una lista');
  }
  // Una entidad rara no puede tirar abajo las demás: se descarta sola.
  const stateList: HomeAssistantState[] = [];
  for (const entry of rawPayload) {
    const parsed = homeAssistantStateSchema.safeParse(entry);
    if (parsed.success) {
      stateList.push(parsed.data);
    }
  }
  return stateList;
}

export function parseCalendarEventList(rawPayload: unknown): readonly HomeAssistantCalendarEvent[] {
  if (!Array.isArray(rawPayload)) {
    throw new Error('/api/calendars no devolvió una lista');
  }
  const eventList: HomeAssistantCalendarEvent[] = [];
  for (const entry of rawPayload) {
    const parsed = homeAssistantCalendarEventSchema.safeParse(entry);
    if (parsed.success) {
      eventList.push(parsed.data);
    }
  }
  return eventList;
}

export function parseDailyForecast(
  rawPayload: unknown,
  weatherEntityId: string,
): readonly HomeAssistantForecastEntry[] {
  const parsed = forecastServiceResponseSchema.parse(rawPayload);
  return parsed.service_response[weatherEntityId]?.forecast ?? [];
}

export type HomeAssistantClient = {
  readonly connection: HomeAssistantConnection;
  listLabelEntityIds(label: string): Promise<readonly string[]>;
  listStates(): Promise<readonly HomeAssistantState[]>;
  listCalendarEvents(input: {
    readonly calendarEntityId: string;
    readonly startIso: string;
    readonly endIso: string;
  }): Promise<readonly HomeAssistantCalendarEvent[]>;
  getDailyForecast(weatherEntityId: string): Promise<readonly HomeAssistantForecastEntry[]>;
  callService(input: {
    readonly domain: string;
    readonly service: string;
    readonly data: Readonly<Record<string, unknown>>;
  }): Promise<void>;
  // Agenda v2. Un servicio con respuesta (`todo.get_items`): devuelve
  // `service_response` tal cual, sin validar (lo valida quien lo pide).
  callServiceWithResponse(input: {
    readonly domain: string;
    readonly service: string;
    readonly data: Readonly<Record<string, unknown>>;
  }): Promise<unknown>;
  // Estado de una entidad; `undefined` si no existe (404).
  getState(entityId: string): Promise<HomeAssistantState | undefined>;
  // Un comando suelto por la API WebSocket (`calendar/event/delete` no tiene
  // servicio REST). Abre, se autentica, manda, espera el resultado y cierra.
  sendWebSocketCommand(
    command: { readonly type: string } & Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
};

// Lo mínimo del WebSocket que usa el cliente: así los tests le pasan uno falso.
export type HomeAssistantWebSocketLike = {
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
};

export type HomeAssistantWebSocketFactory = (url: string) => HomeAssistantWebSocketLike;

const SUPERVISOR_CORE_WEBSOCKET_URL = 'ws://supervisor/core/websocket';

/** URL de la API WebSocket: la del Supervisor, o la de HA_URL con ws(s) y /api/websocket. */
export function resolveHomeAssistantWebSocketUrl(connection: HomeAssistantConnection): string {
  if (connection.source === 'supervisor') {
    return SUPERVISOR_CORE_WEBSOCKET_URL;
  }
  return `${connection.apiBaseUrl.replace(/^http/, 'ws')}/websocket`;
}

export function createHomeAssistantClient(input: {
  readonly connection: HomeAssistantConnection;
  readonly fetchImpl?: HomeAssistantFetchImplementation;
  readonly webSocketFactory?: HomeAssistantWebSocketFactory;
  readonly timeoutMilliseconds?: number;
}): HomeAssistantClient {
  const fetchImplementation: HomeAssistantFetchImplementation =
    input.fetchImpl ?? ((url, init) => fetch(url, init));
  const webSocketFactory: HomeAssistantWebSocketFactory =
    input.webSocketFactory ??
    ((url) => new WebSocket(url) as unknown as HomeAssistantWebSocketLike);
  const timeoutMilliseconds =
    input.timeoutMilliseconds ?? HOME_ASSISTANT_REQUEST_TIMEOUT_MILLISECONDS;
  const { connection } = input;

  function assertServiceName(domain: string, service: string): void {
    if (!/^[a-z0-9_]+$/.test(domain) || !/^[a-z0-9_]+$/.test(service)) {
      throw new Error(`servicio inválido: ${domain}.${service}`);
    }
  }

  async function request(
    path: string,
    init: { readonly method: 'GET' | 'POST'; readonly body?: unknown },
  ): Promise<Response> {
    const response = await fetchImplementation(`${connection.apiBaseUrl}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        'Content-Type': 'application/json',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
    if (!response.ok) {
      // Sin el cuerpo: HA a veces repite el pedido, y el token nunca va al log.
      throw new Error(`Home Assistant ${init.method} ${path.split('?')[0]} respondió ${response.status}`);
    }
    return response;
  }

  return {
    connection,
    async listLabelEntityIds(label) {
      // El nombre de la etiqueta va como literal de Jinja: se escapa la comilla
      // por si alguien la configura con un apóstrofo.
      const escapedLabel = label.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const response = await request('/template', {
        method: 'POST',
        body: { template: `{{ label_entities('${escapedLabel}') | list | tojson }}` },
      });
      return parseLabelEntityIdList(await response.text());
    },
    async listStates() {
      const response = await request('/states', { method: 'GET' });
      return parseStateList(await response.json());
    },
    async listCalendarEvents({ calendarEntityId, startIso, endIso }) {
      if (!isValidEntityId(calendarEntityId)) {
        throw new Error(`id de calendario inválido: ${calendarEntityId}`);
      }
      const searchParameters = new URLSearchParams({ start: startIso, end: endIso });
      const response = await request(
        `/calendars/${calendarEntityId}?${searchParameters.toString()}`,
        { method: 'GET' },
      );
      return parseCalendarEventList(await response.json());
    },
    async getDailyForecast(weatherEntityId) {
      if (!isValidEntityId(weatherEntityId)) {
        throw new Error(`id de clima inválido: ${weatherEntityId}`);
      }
      // `weather.get_forecasts` es un servicio con respuesta: sin
      // `?return_response` HA contesta 400.
      const response = await request('/services/weather/get_forecasts?return_response', {
        method: 'POST',
        body: { entity_id: weatherEntityId, type: 'daily' },
      });
      return parseDailyForecast(await response.json(), weatherEntityId);
    },
    async callService({ domain, service, data }) {
      assertServiceName(domain, service);
      await request(`/services/${domain}/${service}`, { method: 'POST', body: data });
    },
    async callServiceWithResponse({ domain, service, data }) {
      assertServiceName(domain, service);
      const response = await request(`/services/${domain}/${service}?return_response`, {
        method: 'POST',
        body: data,
      });
      const payload: unknown = await response.json();
      return typeof payload === 'object' && payload !== null && 'service_response' in payload
        ? (payload as { service_response: unknown }).service_response
        : undefined;
    },
    async getState(entityId) {
      if (!isValidEntityId(entityId)) {
        throw new Error(`id de entidad inválido: ${entityId}`);
      }
      const response = await fetchImplementation(`${connection.apiBaseUrl}/states/${entityId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${connection.token}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMilliseconds),
      });
      if (response.status === 404) {
        return undefined;
      }
      if (!response.ok) {
        throw new Error(`Home Assistant GET /states respondió ${response.status}`);
      }
      return homeAssistantStateSchema.parse(await response.json());
    },
    sendWebSocketCommand(command) {
      // Protocolo de HA: auth_required → auth → auth_ok → comando con id →
      // result. Un comando por conexión: es para borrar un evento de vez en
      // cuando, no vale la pena mantener un socket abierto.
      const commandId = 1;
      return new Promise<unknown>((resolve, reject) => {
        let isSettled = false;
        let socket: HomeAssistantWebSocketLike | undefined;
        const timer = setTimeout(
          () => finish(new Error('WebSocket de Home Assistant: sin respuesta a tiempo')),
          timeoutMilliseconds,
        );
        function finish(error: Error | undefined, result?: unknown): void {
          if (isSettled) {
            return;
          }
          isSettled = true;
          clearTimeout(timer);
          try {
            socket?.close();
          } catch {
            // Cerrar un socket ya cerrado no importa.
          }
          if (error === undefined) {
            resolve(result);
          } else {
            reject(error);
          }
        }
        try {
          socket = webSocketFactory(resolveHomeAssistantWebSocketUrl(connection));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        const openSocket = socket;
        openSocket.onmessage = (event) => {
          let message: { type?: unknown; id?: unknown; success?: unknown; result?: unknown; error?: { message?: unknown } };
          try {
            message = JSON.parse(String(event.data)) as typeof message;
          } catch {
            finish(new Error('WebSocket de Home Assistant: respuesta ilegible'));
            return;
          }
          if (message.type === 'auth_required') {
            openSocket.send(JSON.stringify({ type: 'auth', access_token: connection.token }));
          } else if (message.type === 'auth_ok') {
            openSocket.send(JSON.stringify({ ...command, id: commandId }));
          } else if (message.type === 'auth_invalid') {
            finish(new Error('Home Assistant rechazó el token por WebSocket'));
          } else if (message.type === 'result' && message.id === commandId) {
            if (message.success === true) {
              finish(undefined, message.result);
            } else {
              const detail = typeof message.error?.message === 'string' ? message.error.message : 'error';
              finish(new Error(`Home Assistant: ${detail}`));
            }
          }
        };
        openSocket.onerror = () => finish(new Error('WebSocket de Home Assistant: error de conexión'));
        openSocket.onclose = () => finish(new Error('WebSocket de Home Assistant: se cerró antes de responder'));
      });
    },
  };
}
