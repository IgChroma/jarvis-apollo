import { afterEach, describe, expect, it } from 'bun:test';

import { createHomeAssistantClient } from '@/homeassistant/client';
import {
  createHomeAssistantShoppingList,
  isShoppingListName,
  parseTodoItemList,
  setHomeShoppingList,
} from '@/homeassistant/shopping';
import { createHomeAssistantDashboardSource } from '@/homeassistant/source';
import type { ListItemRecord } from '@/lists/store';
import type { DeskToolEffects } from '@/tools/types';
import { addToListTool, readListTool, removeFromListTool } from '@/tools/list';

// Agenda v2: la lista de COMPRAS vive en todo.shopping_list de Home Assistant;
// PENDIENTES sigue siendo la interna. Home Assistant falso, nada sale a la red.

type RecordedRequest = { readonly method: string; readonly path: string; readonly body?: unknown };

function createFakeTodo(input: { readonly supportedFeatures?: number; readonly fail?: boolean } = {}) {
  const requestList: RecordedRequest[] = [];
  let itemList = [
    { uid: 'u1', summary: 'Leche', status: 'needs_action' },
    { uid: 'u2', summary: 'Pan lactal', status: 'needs_action' },
    { uid: 'u3', summary: 'Leche de almendras', status: 'needs_action' },
    { uid: 'u4', summary: 'Yerba', status: 'completed' },
  ];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const path = url.replace('http://ha.test/api', '');
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    requestList.push({ method: init.method ?? 'GET', path, ...(body === undefined ? {} : { body }) });
    const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });
    if (input.fail === true) {
      return json({}, 502);
    }
    if (path === '/services/todo/get_items?return_response') {
      const statusList = (body?.status as string[] | undefined) ?? ['needs_action', 'completed'];
      return json({
        changed_states: [],
        service_response: {
          'todo.shopping_list': { items: itemList.filter((item) => statusList.includes(item.status)) },
        },
      });
    }
    if (path === '/services/todo/add_item') {
      itemList = [...itemList, { uid: `u${itemList.length + 1}`, summary: String(body?.item), status: 'needs_action' }];
      return json([]);
    }
    if (path === '/services/todo/remove_item') {
      const keyList = body?.item as string[];
      itemList = itemList.filter((item) => !keyList.includes(item.uid));
      return json([]);
    }
    if (path === '/services/todo/update_item') {
      itemList = itemList.map((item) => (item.uid === body?.item ? { ...item, status: String(body?.status) } : item));
      return json([]);
    }
    if (path === '/states/todo.shopping_list') {
      return json({
        entity_id: 'todo.shopping_list',
        state: '3',
        attributes: { supported_features: input.supportedFeatures ?? 15 },
      });
    }
    if (path === '/states') {
      return json([{ entity_id: 'todo.shopping_list', state: '3', attributes: {} }]);
    }
    if (path === '/template') {
      return new Response('[]');
    }
    return json({ message: 'no' }, 404);
  };
  const client = createHomeAssistantClient({
    connection: { apiBaseUrl: 'http://ha.test/api', token: 't', source: 'ha_url' },
    fetchImpl,
  });
  let changeCount = 0;
  const shoppingList = createHomeAssistantShoppingList({
    client,
    onChanged: () => {
      changeCount += 1;
    },
  });
  return { client, shoppingList, requestList, changes: () => changeCount, items: () => itemList };
}

// La lista interna de Jarvis (pendientes), en memoria.
function createInternalEffects() {
  const recordList: ListItemRecord[] = [{ id: 'p1', listName: 'pendientes', content: 'Llamar al plomero', createdAt: 1 }];
  const effects = {
    addListItem: async (item: { listName: string; content: string }) => {
      const record = { id: `p${recordList.length + 1}`, ...item, createdAt: 2 };
      recordList.push(record);
      return record;
    },
    listListItems: async (listName?: string) =>
      recordList.filter((record) => listName === undefined || record.listName === listName),
    removeListItems: async (removal: { listName: string; contentQuery?: string; clearAll: boolean }) => {
      const matched = recordList.filter(
        (record) => record.listName === removal.listName && (removal.clearAll || record.content.includes(removal.contentQuery ?? '\u0000')),
      );
      for (const record of matched) {
        recordList.splice(recordList.indexOf(record), 1);
      }
      return { removedCount: matched.length, removedContentList: matched.map((record) => record.content) };
    },
  } as unknown as DeskToolEffects;
  return { effects, recordList };
}

afterEach(() => {
  setHomeShoppingList(undefined);
});

describe('nombre de la lista', () => {
  it('compras, lista de compras, súper y el default "super" son la de compras; pendientes no', () => {
    for (const name of ['compras', 'Lista de compras', 'la lista de compras', 'súper', 'super', 'el súper', 'Supermercado']) {
      expect(isShoppingListName(name)).toBe(true);
    }
    for (const name of ['pendientes', 'la lista', 'farmacia', undefined]) {
      expect(isShoppingListName(name)).toBe(false);
    }
  });
});

describe('herramientas de listas con Home Assistant', () => {
  it('add_to_list sin nombre va a todo.shopping_list; pendientes, a la interna', async () => {
    const fake = createFakeTodo();
    setHomeShoppingList(fake.shoppingList);
    const internal = createInternalEffects();
    const context = { environment: {} as Env, nowMilliseconds: 0, effects: internal.effects };
    const shopping = await addToListTool.handler({ item: 'Queso' }, context);
    expect(shopping).toEqual({ ok: true, summary: 'Anotado en la lista compras: Queso' });
    expect(fake.requestList.at(-1)).toEqual({
      method: 'POST',
      path: '/services/todo/add_item',
      body: { entity_id: 'todo.shopping_list', item: 'Queso' },
    });
    expect(fake.changes()).toBe(1);
    const pending = await addToListTool.handler({ item: 'Pagar el ABL', listName: 'pendientes' }, context);
    expect(pending.ok).toBe(true);
    expect(internal.recordList.map((record) => record.content)).toEqual(['Llamar al plomero', 'Pagar el ABL']);
    expect(fake.requestList).toHaveLength(1);
  });

  it('read_list de compras lee solo lo que falta comprar; sin nombre, las dos', async () => {
    const fake = createFakeTodo();
    setHomeShoppingList(fake.shoppingList);
    const internal = createInternalEffects();
    const context = { environment: {} as Env, nowMilliseconds: 0, effects: internal.effects };
    const shopping = await readListTool.handler({ listName: 'lista de compras' }, context);
    expect(shopping.summary).toBe('Lista compras: Leche, Pan lactal, Leche de almendras.');
    expect(fake.requestList[0]).toEqual({
      method: 'POST',
      path: '/services/todo/get_items?return_response',
      body: { entity_id: 'todo.shopping_list', status: ['needs_action'] },
    });
    const all = await readListTool.handler({}, context);
    expect(all.summary).toBe('Lista pendientes: Llamar al plomero. Lista compras: Leche, Pan lactal, Leche de almendras.');
  });

  it('remove_from_list saca por uid lo que coincide (sin tildes ni mayúsculas)', async () => {
    const fake = createFakeTodo();
    setHomeShoppingList(fake.shoppingList);
    const context = { environment: {} as Env, nowMilliseconds: 0, effects: createInternalEffects().effects };
    const result = await removeFromListTool.handler({ item: 'LECHE', listName: 'súper' }, context);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Saqué de la lista compras: Leche, Leche de almendras.');
    const removal = fake.requestList.find((request) => request.path === '/services/todo/remove_item');
    expect(removal?.body).toEqual({ entity_id: 'todo.shopping_list', item: ['u1', 'u3'] });
    expect(fake.items().map((item) => item.summary)).toEqual(['Pan lactal', 'Yerba']);
    const missing = await removeFromListTool.handler({ item: 'caviar' }, context);
    expect(missing).toEqual({ ok: false, summary: 'No encontré eso en la lista compras.' });
  });

  it('una lista que no deja borrar pero sí actualizar: se marca completada', async () => {
    const fake = createFakeTodo({ supportedFeatures: 4 });
    const outcome = await fake.shoppingList.removeItems({ query: 'pan', clearAll: false });
    expect(outcome.removedContentList).toEqual(['Pan lactal']);
    const update = fake.requestList.find((request) => request.path === '/services/todo/update_item');
    expect(update?.body).toEqual({ entity_id: 'todo.shopping_list', item: 'u2', status: 'completed' });
  });

  it('Home Assistant caído: el error vuelve como resultado, no tira el turno', async () => {
    const fake = createFakeTodo({ fail: true });
    setHomeShoppingList(fake.shoppingList);
    const context = { environment: {} as Env, nowMilliseconds: 0, effects: createInternalEffects().effects };
    const result = await addToListTool.handler({ item: 'Queso', listName: 'compras' }, context);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('lista de compras de Home Assistant');
    const all = await readListTool.handler({}, context);
    expect(all.ok).toBe(true);
    expect(all.summary).toContain('Lista pendientes: Llamar al plomero.');
    expect(all.summary).toContain('no respondió');
  });

  it('sin Home Assistant, "super" es la lista interna como siempre', async () => {
    const internal = createInternalEffects();
    const context = { environment: {} as Env, nowMilliseconds: 0, effects: internal.effects };
    await addToListTool.handler({ item: 'Queso' }, context);
    expect(internal.recordList.at(-1)).toMatchObject({ listName: 'super', content: 'Queso' });
  });
});

describe('compras en el tablero', () => {
  it('la fuente de HA trae los ítems sin completar, y una edición la invalida', async () => {
    const fake = createFakeTodo();
    const source = createHomeAssistantDashboardSource({ client: fake.client, shoppingList: fake.shoppingList, now: () => 0 });
    const first = await source.readDashboardData({ timezone: 'America/Argentina/Buenos_Aires', locationLabel: 'Casa' });
    expect(first?.shoppingItemList).toEqual(['Leche', 'Pan lactal', 'Leche de almendras']);
    await fake.shoppingList.addItem('Queso');
    // Con caché (30 s) sigue igual hasta que se invalida.
    const cached = await source.readDashboardData({ timezone: 'America/Argentina/Buenos_Aires', locationLabel: 'Casa' });
    expect(cached?.shoppingItemList).toHaveLength(3);
    source.invalidateShoppingCache();
    const fresh = await source.readDashboardData({ timezone: 'America/Argentina/Buenos_Aires', locationLabel: 'Casa' });
    expect(fresh?.shoppingItemList).toEqual(['Leche', 'Pan lactal', 'Leche de almendras', 'Queso']);
  });

  it('sin la entidad en HA no hay tarjeta de compras', async () => {
    const fake = createFakeTodo();
    const source = createHomeAssistantDashboardSource({
      client: { ...fake.client, listStates: async () => [] },
      shoppingList: fake.shoppingList,
      now: () => 0,
    });
    const data = await source.readDashboardData({ timezone: 'America/Argentina/Buenos_Aires', locationLabel: 'Casa' });
    expect(data?.shoppingItemList).toBeUndefined();
  });

  it('parseTodoItemList descarta lo raro y exige la entidad pedida', () => {
    expect(
      parseTodoItemList(
        { 'todo.shopping_list': { items: [{ summary: 'Leche', uid: 'a', status: 'needs_action' }, { nada: 1 }, { summary: '  ' }] } },
        'todo.shopping_list',
      ),
    ).toEqual([{ uid: 'a', summary: 'Leche', status: 'needs_action' }]);
    expect(() => parseTodoItemList({}, 'todo.shopping_list')).toThrow();
  });
});
