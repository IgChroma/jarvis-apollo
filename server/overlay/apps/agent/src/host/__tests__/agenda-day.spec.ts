import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { setHomeShoppingList } from '@/homeassistant/shopping';
import { startApolloHost, type ApolloHost } from '@/host/main';
import { setHomeAgendaControl } from '@/tools/agenda';
import { setHomeVoiceControl } from '@/tools/casa';

// Agenda v2, punta a punta: la placa pide un día (`agenda_day_request`) y el
// host contesta `agenda_day` con los eventos de un Home Assistant FALSO
// (Bun.serve local, HA_URL/HA_TOKEN). Una fecha basura se ignora.

const DEVICE_SECRET = 'device-secret';
const HA_TOKEN = 'ha-token';

let host: ApolloHost;
let homeAssistant: ReturnType<typeof Bun.serve>;
let dataDirectory: string;
const calendarRequestList: string[] = [];

beforeAll(async () => {
  homeAssistant = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.headers.get('authorization') !== `Bearer ${HA_TOKEN}`) {
        return new Response('401', { status: 401 });
      }
      if (url.pathname === '/api/states') {
        return Response.json([
          { entity_id: 'calendar.hogar', state: 'off', attributes: { friendly_name: 'Hogar', supported_features: 7 } },
        ]);
      }
      if (url.pathname === '/api/template') {
        return new Response('[]');
      }
      if (url.pathname === '/api/calendars/calendar.hogar') {
        calendarRequestList.push(`${url.searchParams.get('start')}|${url.searchParams.get('end')}`);
        return Response.json([
          {
            summary: '🦷 Dentista',
            start: { dateTime: '2026-10-22T11:00:00-03:00' },
            end: { dateTime: '2026-10-22T12:00:00-03:00' },
            uid: '01JBDENTISTA',
            description: 'Turno con la dentista en OdontoSalud',
            location: 'OdontoSalud',
          },
        ]);
      }
      return new Response('{}', { status: 404 });
    },
  });
  dataDirectory = join(tmpdir(), `apollo-agenda-${crypto.randomUUID()}`);
  host = await startApolloHost({
    APOLLO_HOST_PORT: '0',
    APOLLO_DATA_DIRECTORY: dataDirectory,
    DEVICE_SHARED_SECRET: DEVICE_SECRET,
    DASHBOARD_SHARED_SECRET: 'dashboard-secret',
    MOCK_VOICE: '1',
    HA_URL: `http://localhost:${homeAssistant.port}`,
    HA_TOKEN,
  });
});

afterAll(async () => {
  host.stop();
  void homeAssistant.stop(true);
  // El host registra las herramientas de HA a nivel módulo: se limpian para
  // no contaminar a los demás tests del mismo proceso.
  setHomeVoiceControl(undefined);
  setHomeAgendaControl(undefined);
  setHomeShoppingList(undefined);
  await rm(dataDirectory, { recursive: true, force: true }).catch(() => undefined);
});

function openDevice(): Promise<{ socket: WebSocket; messageList: { type?: string; [key: string]: unknown }[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${host.port}/agents/apollo/desk?token=${DEVICE_SECRET}`);
    const messageList: { type?: string }[] = [];
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        messageList.push(JSON.parse(event.data) as { type?: string });
      }
    });
    socket.addEventListener('open', () => resolve({ socket, messageList }));
    socket.addEventListener('error', () => reject(new Error('socket failed to open')));
  });
}

async function waitFor<T>(read: () => T | undefined, timeoutMilliseconds = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await Bun.sleep(20);
  }
  throw new Error('timeout');
}

describe('agenda_day_request', () => {
  test('contesta el día con los eventos de Home Assistant; la basura se ignora', async () => {
    const device = await openDevice();
    // La conexión termina de abrirse (tablero inicial y mensajes pendientes)
    // antes de seguir: si no, el host se cierra con esa tarea en vuelo.
    await waitFor(() => device.messageList.find((message) => message.type === 'dashboard'), 10_000).catch(
      () => undefined,
    );
    device.socket.send(JSON.stringify({ type: 'agenda_day_request', date: 'pasado mañana', ts: 1 }));
    device.socket.send(JSON.stringify({ type: 'agenda_day_request', date: '2026-02-30', ts: 2 }));
    device.socket.send(JSON.stringify({ type: 'agenda_day_request', date: '2026-10-22', ts: 3 }));
    const reply = await waitFor(() => device.messageList.find((message) => message.type === 'agenda_day'));
    expect(reply).toEqual({
      type: 'agenda_day',
      date: '2026-10-22',
      dateLabel: 'jueves 22 de octubre',
      entryList: [
        {
          id: 'hogar:01JBDENTISTA',
          title: 'Dentista',
          icon: 'salud',
          whenLabel: '11:00',
          detail: {
            fullTitle: 'Turno con la dentista en OdontoSalud',
            dateLabel: 'jueves 22 de octubre',
            timeLabel: '11:00 a 12:00',
            location: 'OdontoSalud',
            sourceLabel: 'Calendario Hogar',
          },
        },
      ],
    });
    // Medianoche a medianoche de Buenos Aires.
    expect(calendarRequestList).toContain('2026-10-22T03:00:00.000Z|2026-10-23T03:00:00.000Z');
    // Ni error a la placa ni respuesta para las fechas inválidas.
    await Bun.sleep(100);
    expect(device.messageList.filter((message) => message.type === 'agenda_day')).toHaveLength(1);
    expect(device.messageList.some((message) => message.type === 'error')).toBe(false);

    device.socket.send(JSON.stringify({ type: 'agenda_day_request', date: '2026-11-02', ts: 4 }));
    const empty = await waitFor(() =>
      device.messageList.find((message) => message.type === 'agenda_day' && message.date === '2026-11-02'),
    );
    expect(empty).toMatchObject({ dateLabel: 'lunes 2 de noviembre', entryList: [] });
    device.socket.close();
  });
});
