import { z } from 'zod';

import type { HomeAssistantClient } from '@/homeassistant/client';

// Agenda v2: la lista de COMPRAS vive en Home Assistant (`todo.shopping_list`,
// la de la integración Lista de compras). La de PENDIENTES sigue siendo la
// interna de Jarvis (SQLite + espejo de Notion). Ver docs/vistas-tablero.md.
//
// Las herramientas de voz (read_list, add_to_list, remove_from_list) deciden
// por el nombre de la lista: "compras", "lista de compras", "súper" (y la de por
// defecto, "super") van acá cuando hay Home Assistant; el resto, a la interna.
//
// Servicios (todo.*, la lista informa supported_features 15 = crear, borrar,
// actualizar y mover):
//   - leer: todo.get_items con status needs_action (servicio con respuesta);
//   - agregar: todo.add_item;
//   - sacar: todo.remove_item por uid. Si una lista no deja borrar (bit 2)
//     pero sí actualizar (bit 4), se marca completada con todo.update_item.

export const HOME_ASSISTANT_SHOPPING_LIST_ENTITY_ID = 'todo.shopping_list';
export const SHOPPING_LIST_DISPLAY_NAME = 'Compras';

// TodoListEntityFeature de Home Assistant.
const TODO_FEATURE_DELETE = 2;
const TODO_FEATURE_UPDATE = 4;

const todoItemSchema = z.object({
  uid: z.string().nullish(),
  summary: z.string().default(''),
  status: z.string().default('needs_action'),
});

export type HomeAssistantTodoItem = {
  readonly uid?: string;
  readonly summary: string;
  readonly status: string;
};

/** Respuesta de todo.get_items → ítems; una entrada rara se descarta sola. */
export function parseTodoItemList(serviceResponse: unknown, entityId: string): readonly HomeAssistantTodoItem[] {
  if (typeof serviceResponse !== 'object' || serviceResponse === null) {
    throw new Error('todo.get_items no devolvió respuesta');
  }
  const entityResponse = (serviceResponse as Record<string, unknown>)[entityId];
  const rawItemList =
    typeof entityResponse === 'object' && entityResponse !== null
      ? (entityResponse as { items?: unknown }).items
      : undefined;
  if (!Array.isArray(rawItemList)) {
    throw new Error(`todo.get_items no trajo ítems de ${entityId}`);
  }
  const itemList: HomeAssistantTodoItem[] = [];
  for (const rawItem of rawItemList) {
    const parsed = todoItemSchema.safeParse(rawItem);
    if (!parsed.success || parsed.data.summary.trim().length === 0) {
      continue;
    }
    itemList.push({
      ...(parsed.data.uid === undefined || parsed.data.uid === null ? {} : { uid: parsed.data.uid }),
      summary: parsed.data.summary.trim(),
      status: parsed.data.status,
    });
  }
  return itemList;
}

function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const SHOPPING_LIST_NAME_SET: ReadonlySet<string> = new Set([
  'compras',
  'compra',
  'super',
  'supermercado',
  'mercado',
  'shopping',
  'shopping list',
]);

/** ¿El nombre que dijo el usuario (o el default "super") es la lista de compras? */
export function isShoppingListName(listName: string | undefined): boolean {
  if (listName === undefined) {
    return false;
  }
  const normalized = normalizeText(listName)
    .replace(/^(la |mi )/, '')
    .replace(/^lista (de |del |de la )?/, '')
    .replace(/^(el |la )/, '')
    .trim();
  return SHOPPING_LIST_NAME_SET.has(normalized);
}

export type HomeShoppingList = {
  readonly entityId: string;
  /** Ítems sin completar, en el orden de la lista. */
  listItems(): Promise<readonly HomeAssistantTodoItem[]>;
  addItem(text: string): Promise<void>;
  removeItems(input: {
    readonly query?: string;
    readonly clearAll: boolean;
  }): Promise<{ readonly removedContentList: readonly string[] }>;
};

export function createHomeAssistantShoppingList(input: {
  readonly client: HomeAssistantClient;
  readonly entityId?: string;
  // Después de un cambio: el tablero se refresca para que la tarjeta lo muestre.
  readonly onChanged?: () => void;
}): HomeShoppingList {
  const { client } = input;
  const entityId = input.entityId ?? HOME_ASSISTANT_SHOPPING_LIST_ENTITY_ID;

  async function listItems(): Promise<readonly HomeAssistantTodoItem[]> {
    const response = await client.callServiceWithResponse({
      domain: 'todo',
      service: 'get_items',
      data: { entity_id: entityId, status: ['needs_action'] },
    });
    return parseTodoItemList(response, entityId).filter((item) => item.status === 'needs_action');
  }

  return {
    entityId,
    listItems,
    async addItem(text) {
      await client.callService({
        domain: 'todo',
        service: 'add_item',
        data: { entity_id: entityId, item: text.trim() },
      });
      input.onChanged?.();
    },
    async removeItems({ query, clearAll }) {
      const normalizedQuery = normalizeText(query ?? '');
      // Igual que la lista interna: sin texto solo se vacía con clearAll.
      if (!clearAll && normalizedQuery.length === 0) {
        return { removedContentList: [] };
      }
      const itemList = await listItems();
      const matchedList = clearAll
        ? itemList
        : itemList.filter((item) => normalizeText(item.summary).includes(normalizedQuery));
      if (matchedList.length === 0) {
        return { removedContentList: [] };
      }
      const state = await client.getState(entityId);
      const features = Number(state?.attributes.supported_features ?? 0);
      const canDelete = (features & TODO_FEATURE_DELETE) !== 0;
      const canUpdate = (features & TODO_FEATURE_UPDATE) !== 0;
      // Por uid: dos ítems con el mismo texto no se confunden. Sin uid, el texto.
      const keyList = matchedList.map((item) => item.uid ?? item.summary);
      if (canDelete || !canUpdate) {
        await client.callService({
          domain: 'todo',
          service: 'remove_item',
          data: { entity_id: entityId, item: keyList },
        });
      } else {
        for (const key of keyList) {
          await client.callService({
            domain: 'todo',
            service: 'update_item',
            data: { entity_id: entityId, item: key, status: 'completed' },
          });
        }
      }
      input.onChanged?.();
      return { removedContentList: matchedList.map((item) => item.summary) };
    },
  };
}

// Registro del host (host/main.ts), como setHomeVoiceControl: sin Home
// Assistant queda undefined y todas las listas son internas.
let registeredShoppingList: HomeShoppingList | undefined;

export function setHomeShoppingList(shoppingList: HomeShoppingList | undefined): void {
  registeredShoppingList = shoppingList;
}

export function getHomeShoppingList(): HomeShoppingList | undefined {
  return registeredShoppingList;
}
