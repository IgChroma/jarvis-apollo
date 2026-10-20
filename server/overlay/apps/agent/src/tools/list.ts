import { z } from 'zod';

import {
  getHomeShoppingList,
  isShoppingListName,
  SHOPPING_LIST_DISPLAY_NAME,
  type HomeShoppingList,
} from '@/homeassistant/shopping';
import type { ListItemRecord } from '@/lists/store';
import type { ToolDefinition, ToolExecutionResult } from '@/tools/types';

// Overlay de Jarvis sobre tools/list.ts de upstream.
//
// Agenda v2 (docs/vistas-tablero.md): hay DOS listas para el usuario.
//   - Compras ("compras", "lista de compras", "súper", y la de por defecto,
//     "super"): con Home Assistant vive en `todo.shopping_list`
//     (homeassistant/shopping.ts), la misma que ve en la app de HA.
//   - Pendientes y cualquier otra: la lista interna de Jarvis (SQLite + espejo
//     de Notion), como antes.
// Sin Home Assistant todo es interno, exactamente como upstream.
//
// Un Home Assistant caído no puede tirar el turno: el error vuelve como
// resultado de la herramienta y el modelo lo cuenta.

const DEFAULT_LIST_NAME = 'super';

const addToListArgsSchema = z.object({
  item: z.string().min(1).max(300),
  listName: z.string().min(1).max(100).optional(),
});

const readListArgsSchema = z.object({
  listName: z.string().min(1).max(100).optional(),
});

const removeFromListArgsSchema = z
  .object({
    item: z.string().min(1).max(300).optional(),
    listName: z.string().min(1).max(100).optional(),
    clearAll: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if (
      value.clearAll !== true &&
      (value.item === undefined || value.item.trim() === '')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'item or clearAll required',
      });
    }
  });

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function homeAssistantFailure(error: unknown): ToolExecutionResult {
  return {
    ok: false,
    summary: `No pude usar la lista de compras de Home Assistant: ${describeError(error)}`,
  };
}

/** La lista de compras de HA si el nombre la pide y hay Home Assistant. */
function resolveShoppingList(listName: string | undefined): HomeShoppingList | undefined {
  const shoppingList = getHomeShoppingList();
  return shoppingList !== undefined && isShoppingListName(listName) ? shoppingList : undefined;
}

const SHOPPING_LIST_SPOKEN_NAME = SHOPPING_LIST_DISPLAY_NAME.toLowerCase();

async function readShoppingItemRecordList(shoppingList: HomeShoppingList): Promise<ListItemRecord[]> {
  const itemList = await shoppingList.listItems();
  return itemList.map((item, index) => ({
    id: item.uid ?? `${shoppingList.entityId}:${String(index)}`,
    listName: SHOPPING_LIST_SPOKEN_NAME,
    content: item.summary,
    createdAt: 0,
  }));
}

function formatListForSpeech(itemList: readonly ListItemRecord[]): string {
  const listNameSet = [...new Set(itemList.map((item) => item.listName))];
  if (listNameSet.length === 1) {
    const contentList = itemList.map((item) => item.content);
    return `Lista ${listNameSet[0]}: ${contentList.join(', ')}.`;
  }
  return listNameSet
    .map((listName) => {
      const contentList = itemList
        .filter((item) => item.listName === listName)
        .map((item) => item.content);
      return `Lista ${listName}: ${contentList.join(', ')}.`;
    })
    .join(' ');
}

export const addToListTool: ToolDefinition = {
  name: 'add_to_list',
  safety: 'safe',
  description:
    'Agrega un ítem a una lista. Por defecto la de compras (súper); listName "pendientes" u otra para las demás',
  parameters: {
    type: 'object',
    properties: {
      item: { type: 'string' },
      listName: { type: 'string' },
    },
    required: ['item'],
    additionalProperties: false,
  },
  async handler(args, context) {
    const parsedArgs = addToListArgsSchema.parse(args);
    const listName = parsedArgs.listName ?? DEFAULT_LIST_NAME;
    const shoppingList = resolveShoppingList(listName);
    if (shoppingList !== undefined) {
      try {
        await shoppingList.addItem(parsedArgs.item);
      } catch (error) {
        return homeAssistantFailure(error);
      }
      return {
        ok: true,
        summary: `Anotado en la lista ${SHOPPING_LIST_SPOKEN_NAME}: ${parsedArgs.item}`,
      };
    }
    if (!context.effects) {
      return { ok: false, summary: 'Effects no disponibles' };
    }
    await context.effects.addListItem({ listName, content: parsedArgs.item });
    return {
      ok: true,
      summary: `Anotado en la lista ${listName}: ${parsedArgs.item}`,
    };
  },
};

export const readListTool: ToolDefinition = {
  name: 'read_list',
  safety: 'safe',
  description: 'Lee una lista por nombre (compras, pendientes…), o todas las listas si no se indica',
  parameters: {
    type: 'object',
    properties: { listName: { type: 'string' } },
    additionalProperties: false,
  },
  async handler(args, context) {
    const parsedArgs = readListArgsSchema.parse(args);
    const shoppingList = resolveShoppingList(parsedArgs.listName);
    let itemList: ListItemRecord[];
    if (shoppingList !== undefined) {
      try {
        itemList = await readShoppingItemRecordList(shoppingList);
      } catch (error) {
        return homeAssistantFailure(error);
      }
    } else {
      if (!context.effects) {
        return { ok: false, summary: 'Effects no disponibles' };
      }
      itemList = [...(await context.effects.listListItems(parsedArgs.listName))];
      // "Leeme las listas": también la de compras de HA. Si HA no contesta,
      // se leen las internas igual y se avisa.
      const homeShoppingList = getHomeShoppingList();
      if (parsedArgs.listName === undefined && homeShoppingList !== undefined) {
        try {
          itemList = [...itemList, ...(await readShoppingItemRecordList(homeShoppingList))];
        } catch (error) {
          const internal = itemList.length === 0 ? 'No hay listas internas con ítems.' : formatListForSpeech(itemList);
          return {
            ok: true,
            summary: `${internal} (La de compras de Home Assistant no respondió: ${describeError(error)})`,
            data: itemList,
          };
        }
      }
    }
    if (itemList.length === 0) {
      const spokenListName = shoppingList !== undefined ? SHOPPING_LIST_SPOKEN_NAME : parsedArgs.listName;
      return {
        ok: true,
        summary:
          spokenListName === undefined
            ? 'No hay listas con ítems.'
            : `La lista ${spokenListName} está vacía.`,
      };
    }
    return {
      ok: true,
      summary: formatListForSpeech(itemList),
      data: itemList,
    };
  },
};

export const removeFromListTool: ToolDefinition = {
  name: 'remove_from_list',
  safety: 'safe',
  description: 'Saca un ítem de una lista (match parcial; por defecto la de compras) o la vacía entera con clearAll',
  parameters: {
    type: 'object',
    properties: {
      item: { type: 'string' },
      listName: { type: 'string' },
      clearAll: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  async handler(args, context) {
    const parsedArgsResult = removeFromListArgsSchema.safeParse(args);
    if (!parsedArgsResult.success) {
      return { ok: false, summary: 'Indicá un ítem o clearAll' };
    }
    const parsedArgs = parsedArgsResult.data;
    const listName = parsedArgs.listName ?? DEFAULT_LIST_NAME;
    const shoppingList = resolveShoppingList(listName);
    let removal: { readonly removedCount: number; readonly removedContentList: readonly string[] };
    let spokenListName = listName;
    if (shoppingList !== undefined) {
      spokenListName = SHOPPING_LIST_SPOKEN_NAME;
      try {
        const outcome = await shoppingList.removeItems({
          query: parsedArgs.item,
          clearAll: parsedArgs.clearAll === true,
        });
        removal = { removedCount: outcome.removedContentList.length, removedContentList: outcome.removedContentList };
      } catch (error) {
        return homeAssistantFailure(error);
      }
    } else {
      if (!context.effects) {
        return { ok: false, summary: 'Effects no disponibles' };
      }
      removal = await context.effects.removeListItems(
        parsedArgs.item === undefined
          ? { listName, clearAll: parsedArgs.clearAll === true }
          : {
              listName,
              contentQuery: parsedArgs.item,
              clearAll: parsedArgs.clearAll === true,
            },
      );
    }
    if (removal.removedCount === 0) {
      return {
        ok: false,
        summary: `No encontré eso en la lista ${spokenListName}.`,
      };
    }
    return {
      ok: true,
      summary:
        parsedArgs.clearAll === true
          ? `Lista ${spokenListName} vaciada (${removal.removedCount} ítems).`
          : `Saqué de la lista ${spokenListName}: ${removal.removedContentList.join(', ')}.`,
      data: removal,
    };
  },
};
