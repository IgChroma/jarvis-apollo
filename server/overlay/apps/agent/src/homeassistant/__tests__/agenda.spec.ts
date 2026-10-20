import { afterEach, describe, expect, it } from 'bun:test';

import {
  chooseAgendaEmoji,
  clipShortTitle,
  createHomeAssistantAgendaControl,
  formatZonedIsoDateTime,
  resolveAgendaCalendarEntityId,
} from '@/homeassistant/agenda';
import {
  createHomeAssistantClient,
  resolveHomeAssistantWebSocketUrl,
  type HomeAssistantWebSocketLike,
} from '@/homeassistant/client';
import { createHomeAssistantDashboardSource } from '@/homeassistant/source';
import { buildAgendaPromptNote } from '@/persona/soul';
import { createBuiltinToolDefinitionMap } from '@/tools/catalog';
import {
  agendaAddTool,
  agendaDeleteTool,
  agendaListTool,
  listAgendaToolDefinitionList,
  setHomeAgendaControl,
} from '@/tools/agenda';

// Agenda v2 por voz contra un Home Assistant falso: REST (fetch) y WebSocket.
// Nada sale a la red.

const TIMEZONE = 'America/Argentina/Buenos_Aires';
// Lunes 19 de octubre de 2026, 10:00 en Buenos Aires.
const NOW = Date.UTC(2026, 9, 19, 13, 0);
const TOKEN = 'token-de-prueba';
const context = { environment: {} as Env, nowMilliseconds: NOW };

type RecordedRequest = { readonly method: string; readonly path: string; readonly body?: unknown };

// Estados como los informa la casa del dueño: los cinco calendarios locales
// dejan crear, borrar y actualizar (supported_features 7). Uno de feriados no.
const STATE_LIST = [
  { entity_id: 'calendar.hogar', state: 'off', attributes: { friendly_name: 'Hogar', supported_features: 7 } },
  { entity_id: 'calendar.servicios', state: 'off', attributes: { friendly_name: 'Servicios', supported_features: 7 } },
  { entity_id: 'calendar.feriados', state: 'off', attributes: { friendly_name: 'Feriados', supported_features: 0 } },
  { entity_id: 'todo.shopping_list', state: '2', attributes: { friendly_name: 'Lista de compras', supported_features: 15 } },
];

const HOGAR_EVENT_LIST = [
  {
    summary: '🦷 Dentista',
    start: { dateTime: '2026-10-22T11:00:00-03:00' },
    end: { dateTime: '2026-10-22T12:00:00-03:00' },
    uid: '01JBDENTISTA',
    description: 'Turno con la dentista en OdontoSalud',
    location: 'OdontoSalud',
  },
];

function createFakeHomeAssistant(input: { readonly failCreate?: boolean; readonly stateList?: typeof STATE_LIST } = {}) {
  const requestList: RecordedRequest[] = [];
  const stateList = input.stateList ?? STATE_LIST;
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const path = url.replace('http://ha.test:8123/api', '');
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    requestList.push({ method: init.method ?? 'GET', path, ...(body === undefined ? {} : { body }) });
    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
    if (path === '/states') {
      return json(stateList);
    }
    if (path.startsWith('/states/')) {
      const state = stateList.find((entry) => entry.entity_id === path.slice('/states/'.length));
      return state === undefined ? json({ message: 'Entity not found.' }, 404) : json(state);
    }
    if (path === '/template') {
      return new Response('[]');
    }
    if (path.startsWith('/calendars/calendar.hogar')) {
      return json(HOGAR_EVENT_LIST);
    }
    if (path.startsWith('/calendars/')) {
      return json([]);
    }
    if (path === '/services/calendar/create_event') {
      return input.failCreate === true ? json({ message: 'bad' }, 400) : json([]);
    }
    return json({ message: 'no' }, 404);
  };

  const webSocketCommandList: unknown[] = [];
  const webSocketUrlList: string[] = [];
  let webSocketReply: (command: { id: number }) => unknown = (command) => ({
    id: command.id,
    type: 'result',
    success: true,
    result: null,
  });
  const webSocketFactory = (url: string): HomeAssistantWebSocketLike => {
    webSocketUrlList.push(url);
    const socket: HomeAssistantWebSocketLike = {
      onmessage: null,
      onerror: null,
      onclose: null,
      send(data) {
        const message = JSON.parse(data) as { type: string; id: number; access_token?: string };
        if (message.type === 'auth') {
          const reply = message.access_token === TOKEN ? { type: 'auth_ok' } : { type: 'auth_invalid' };
          queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(reply) }));
          return;
        }
        webSocketCommandList.push(message);
        queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(webSocketReply(message)) }));
      },
      close() {},
    };
    queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ type: 'auth_required' }) }));
    return socket;
  };
  const client = createHomeAssistantClient({
    connection: { apiBaseUrl: 'http://ha.test:8123/api', token: TOKEN, source: 'ha_url' },
    fetchImpl,
    webSocketFactory,
  });
  return {
    client,
    requestList,
    webSocketCommandList,
    webSocketUrlList,
    setWebSocketReply(reply: typeof webSocketReply) {
      webSocketReply = reply;
    },
  };
}

function createControl(fake: ReturnType<typeof createFakeHomeAssistant>, calendarEntityId = 'calendar.hogar') {
  let changeCount = 0;
  const source = createHomeAssistantDashboardSource({
    client: fake.client,
    now: () => NOW,
    agendaCalendarEntityId: calendarEntityId,
  });
  const control = createHomeAssistantAgendaControl({
    client: fake.client,
    source,
    calendarEntityId,
    resolveTimezone: async () => TIMEZONE,
    now: () => NOW,
    onChanged: () => {
      changeCount += 1;
    },
  });
  return { control, changes: () => changeCount };
}

afterEach(() => {
  setHomeAgendaControl(undefined);
});

describe('agenda_agregar', () => {
  it('"anotame el jueves a las 11 el dentista": guarda con emoji en el resumen y título largo en la descripción', async () => {
    const fake = createFakeHomeAssistant();
    const { control, changes } = createControl(fake);
    setHomeAgendaControl(control);
    const result = await agendaAddTool.handler(
      {
        fecha: '2026-10-22',
        hora: '11:00',
        titulo_corto: 'Dentista',
        emoji: '🦷',
        icono: 'salud',
        titulo_largo: 'Turno con la dentista en OdontoSalud',
        lugar: 'OdontoSalud, Ing. Maschwitz',
      },
      context,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('Agendado en Calendario Hogar: "🦷 Dentista", jueves 22 de octubre, 11:00 a 12:00, en OdontoSalud');
    const create = fake.requestList.find((request) => request.path === '/services/calendar/create_event');
    expect(create?.body).toEqual({
      entity_id: 'calendar.hogar',
      summary: '🦷 Dentista',
      start_date_time: '2026-10-22T11:00:00-03:00',
      end_date_time: '2026-10-22T12:00:00-03:00',
      description: 'Turno con la dentista en OdontoSalud',
      location: 'OdontoSalud, Ing. Maschwitz',
    });
    // Nada de recordatorios ni preguntas: una sola escritura, al calendario.
    expect(fake.requestList.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(changes()).toBe(1);
  });

  it('todo el día, duración y descripción', async () => {
    const fake = createFakeHomeAssistant();
    const { control } = createControl(fake);
    const allDay = await control.addEvent({
      date: '2026-10-24',
      allDay: true,
      shortTitle: 'Cumple Nico',
      emoji: '🎂',
      icon: 'cumple',
      description: 'Llevar torta',
    });
    expect(allDay.ok).toBe(true);
    const timed = await control.addEvent({
      date: '2026-10-20',
      time: '9:30',
      shortTitle: 'Service del auto',
      emoji: '🚗',
      icon: 'auto',
      durationMinutes: 90,
    });
    expect(timed.ok).toBe(true);
    const [allDayBody, timedBody] = fake.requestList
      .filter((request) => request.path === '/services/calendar/create_event')
      .map((request) => request.body);
    expect(allDayBody).toEqual({
      entity_id: 'calendar.hogar',
      summary: '🎂 Cumple Nico',
      start_date: '2026-10-24',
      end_date: '2026-10-25',
      // Sin título largo, la primera línea es el corto y la descripción va después.
      description: 'Cumple Nico\n\nLlevar torta',
    });
    expect(timedBody).toEqual({
      entity_id: 'calendar.hogar',
      summary: '🚗 Service del auto',
      start_date_time: '2026-10-20T09:30:00-03:00',
      end_date_time: '2026-10-20T11:00:00-03:00',
    });
  });

  it('sin hora pregunta solo la hora; una fecha pasada no se guarda', async () => {
    const fake = createFakeHomeAssistant();
    const { control } = createControl(fake);
    const noTime = await control.addEvent({ date: '2026-10-22', shortTitle: 'Dentista', icon: 'salud' });
    expect(noTime.ok).toBe(false);
    expect(noTime.summary).toContain('preguntale solo la hora');
    const past = await control.addEvent({ date: '2025-10-22', time: '11:00', shortTitle: 'Dentista', icon: 'salud' });
    expect(past.ok).toBe(false);
    expect(past.summary).toContain('ya pasó');
    const badDate = await control.addEvent({ date: '22/10', time: '11:00', shortTitle: 'Dentista', icon: 'salud' });
    expect(badDate.ok).toBe(false);
    expect(fake.requestList.some((request) => request.path === '/services/calendar/create_event')).toBe(false);
  });

  it('el calendario configurado tiene que existir; un error de HA vuelve como resultado', async () => {
    const missing = createControl(createFakeHomeAssistant(), 'calendar.nope');
    const result = await missing.control.addEvent({ date: '2026-10-22', time: '11:00', shortTitle: 'X', icon: 'otro' });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('No existe calendar.nope');
    const failing = createControl(createFakeHomeAssistant({ failCreate: true }));
    const failed = await failing.control.addEvent({ date: '2026-10-22', time: '11:00', shortTitle: 'X', icon: 'otro' });
    expect(failed.ok).toBe(false);
    expect(failed.summary).toContain('no guardó el evento');
    expect(failing.changes()).toBe(0);
  });

  it('título corto ≤ 18 sin "…", y emoji coherente con el ícono', () => {
    expect(clipShortTitle('Turno con la dentista nueva')).toBe('Turno con la');
    expect(clipShortTitle('🦷 Dentista')).toBe('Dentista');
    expect(clipShortTitle('Dentista').length).toBeLessThanOrEqual(18);
    expect(chooseAgendaEmoji({ emoji: '🦷', icon: 'salud' })).toBe('🦷');
    // Un emoji que la placa no conoce: el canónico de la categoría que eligió el modelo.
    expect(chooseAgendaEmoji({ emoji: '🧿', icon: 'salud' })).toBe('🩺');
    expect(chooseAgendaEmoji({ emoji: 'no es emoji', icon: 'comida' })).toBe('🍽️');
    expect(chooseAgendaEmoji({ emoji: '🧿', icon: 'otro' })).toBe('🧿');
    expect(chooseAgendaEmoji({ icon: 'otro' })).toBe('📌');
  });

  it('las horas viajan con el desfase de Buenos Aires', () => {
    expect(formatZonedIsoDateTime(TIMEZONE, Date.UTC(2026, 9, 22, 14, 0))).toBe('2026-10-22T11:00:00-03:00');
  });
});

describe('agenda_listar', () => {
  it('devuelve id, día, hora y título de los calendarios', async () => {
    const fake = createFakeHomeAssistant();
    setHomeAgendaControl(createControl(fake).control);
    const result = await agendaListTool.handler({ desde: '2026-10-19', hasta: '2026-10-25' }, context);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('hogar:01JBDENTISTA | jue 22/10 11:00 a 12:00 | Dentista @ OdontoSalud');
    // Sin calendarios etiquetados: todos (y el de la agenda), cada uno una vez.
    const calendarPathList = fake.requestList
      .filter((request) => request.path.startsWith('/calendars/'))
      .map((request) => request.path.split('?')[0]);
    expect(calendarPathList.toSorted()).toEqual([
      '/calendars/calendar.feriados',
      '/calendars/calendar.hogar',
      '/calendars/calendar.servicios',
    ]);
    const empty = await agendaListTool.handler({ desde: '2026-11-02' }, context);
    expect(empty.summary).toContain('No hay eventos');
  });
});

describe('agenda_borrar', () => {
  it('borra por WebSocket con el token, uid y recurrence_id', async () => {
    const fake = createFakeHomeAssistant();
    const { control, changes } = createControl(fake);
    setHomeAgendaControl(control);
    const result = await agendaDeleteTool.handler({ id: 'hogar:abc@google.com#20261019T220000Z' }, context);
    expect(result.ok).toBe(true);
    expect(fake.webSocketUrlList).toEqual(['ws://ha.test:8123/api/websocket']);
    expect(fake.webSocketCommandList).toEqual([
      {
        type: 'calendar/event/delete',
        entity_id: 'calendar.hogar',
        uid: 'abc@google.com',
        recurrence_id: '20261019T220000Z',
        id: 1,
      },
    ]);
    expect(changes()).toBe(1);
  });

  it('un calendario que no deja borrar, o un id raro, no llega al WebSocket', async () => {
    const fake = createFakeHomeAssistant();
    const { control } = createControl(fake);
    const readOnly = await control.deleteEvent('feriados:navidad');
    expect(readOnly.ok).toBe(false);
    expect(readOnly.summary).toContain('no deja borrar');
    const invalid = await control.deleteEvent('cualquier cosa');
    expect(invalid.ok).toBe(false);
    expect(fake.webSocketCommandList).toEqual([]);
  });

  it('el error de Home Assistant vuelve con su mensaje', async () => {
    const fake = createFakeHomeAssistant();
    fake.setWebSocketReply((command) => ({
      id: command.id,
      type: 'result',
      success: false,
      error: { code: 'not_found', message: 'Event not found' },
    }));
    const { control, changes } = createControl(fake);
    const result = await control.deleteEvent('hogar:01JBDENTISTA');
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Event not found');
    expect(changes()).toBe(0);
  });
});

describe('WebSocket de Home Assistant', () => {
  it('URL del Supervisor o de HA_URL', () => {
    expect(
      resolveHomeAssistantWebSocketUrl({ apiBaseUrl: 'http://supervisor/core/api', token: 't', source: 'supervisor' }),
    ).toBe('ws://supervisor/core/websocket');
    expect(
      resolveHomeAssistantWebSocketUrl({ apiBaseUrl: 'https://casa.example.com/api', token: 't', source: 'ha_url' }),
    ).toBe('wss://casa.example.com/api/websocket');
  });

  it('un token rechazado es un error, no un cuelgue', async () => {
    const fake = createFakeHomeAssistant();
    const client = createHomeAssistantClient({
      connection: { apiBaseUrl: 'http://ha.test:8123/api', token: 'otro', source: 'ha_url' },
      webSocketFactory: (url) => {
        const socket: HomeAssistantWebSocketLike = {
          onmessage: null,
          onerror: null,
          onclose: null,
          send() {
            queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ type: 'auth_invalid' }) }));
          },
          close() {},
        };
        void url;
        queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ type: 'auth_required' }) }));
        return socket;
      },
    });
    void fake;
    await expect(client.sendWebSocketCommand({ type: 'calendar/event/delete' })).rejects.toThrow('rechazó el token');
  });

  it('sin respuesta, corta por timeout', async () => {
    const client = createHomeAssistantClient({
      connection: { apiBaseUrl: 'http://ha.test:8123/api', token: TOKEN, source: 'ha_url' },
      timeoutMilliseconds: 20,
      webSocketFactory: () => ({ onmessage: null, onerror: null, onclose: null, send() {}, close() {} }),
    });
    await expect(client.sendWebSocketCommand({ type: 'ping' })).rejects.toThrow('sin respuesta');
  });
});

describe('registro de las herramientas agenda_*', () => {
  it('sin Home Assistant no existen', () => {
    expect(listAgendaToolDefinitionList()).toEqual([]);
    expect(createBuiltinToolDefinitionMap().has('agenda_agregar')).toBe(false);
    expect(buildAgendaPromptNote(['set_volume'])).toBe('');
  });

  it('con Home Assistant están, sin confirmación y con esquemas chicos', () => {
    setHomeAgendaControl(createControl(createFakeHomeAssistant()).control);
    const toolMap = createBuiltinToolDefinitionMap();
    for (const name of ['agenda_agregar', 'agenda_listar', 'agenda_borrar']) {
      const tool = toolMap.get(name);
      expect(tool?.safety).toBe('safe');
      expect(tool!.description.length).toBeLessThanOrEqual(180);
    }
    const schemaChars = listAgendaToolDefinitionList().reduce(
      (total, tool) => total + JSON.stringify(tool.parameters).length + tool.description.length,
      0,
    );
    expect(schemaChars).toBeLessThan(1500);
    const addSchema = agendaAddTool.parameters as { required: string[] };
    expect(addSchema.required).toEqual(['fecha', 'titulo_corto', 'emoji', 'icono']);
  });

  it('la nota del prompt dice que alcanza con día y hora y que no pregunte el transporte', () => {
    const note = buildAgendaPromptNote(['agenda_agregar', 'agenda_listar', 'agenda_borrar']);
    expect(note).toContain('agenda_agregar');
    expect(note).toContain('NUNCA preguntes cómo va a ir');
    expect(note).toContain('Listo, el jueves 23 a las 11 en tu agenda');
    expect(note.length).toBeLessThan(800);
  });

  it('el calendario sale de AGENDA_CALENDAR_ENTITY, con calendar.hogar por defecto', () => {
    expect(resolveAgendaCalendarEntityId({})).toBe('calendar.hogar');
    expect(resolveAgendaCalendarEntityId({ AGENDA_CALENDAR_ENTITY: 'calendar.servicios' })).toBe('calendar.servicios');
    expect(resolveAgendaCalendarEntityId({ AGENDA_CALENDAR_ENTITY: 'jardin' })).toBe('calendar.jardin');
    expect(resolveAgendaCalendarEntityId({ AGENDA_CALENDAR_ENTITY: 'calendar.con espacio' })).toBe('calendar.hogar');
  });
});
