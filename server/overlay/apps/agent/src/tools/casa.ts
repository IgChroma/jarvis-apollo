import { z } from 'zod';

import {
  HOME_CONTROL_ACTION_LIST,
  type HomeVoiceControl,
} from '@/homeassistant/voice';
import type { ToolDefinition, ToolExecutionResult } from '@/tools/types';

// Home Assistant por voz (homeassistant/voice.ts). Las tres herramientas solo
// existen si el host tiene conexión con HA (host/main.ts registra el
// controlador): sin HA no se manda ningún esquema de más al modelo.
//
// Esquemas cortos a propósito: viajan en cada llamada al modelo (ver
// turn/run.ts, toolSchemaChars). Ninguna pide confirmación: prender una luz o
// cambiar la losa se deshace con otra frase.

let registeredHomeControl: HomeVoiceControl | undefined;

export function setHomeVoiceControl(control: HomeVoiceControl | undefined): void {
  registeredHomeControl = control;
}

export const HOME_TOOL_NAME_LIST = ['casa_listar', 'casa_estado', 'casa_controlar'] as const;

const NOT_CONFIGURED_RESULT: ToolExecutionResult = {
  ok: false,
  summary: 'Home Assistant no está conectado a Jarvis.',
};

function describeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'argumentos'}: ${issue.message}`)
    .join('; ');
}

export const homeListTool: ToolDefinition = {
  name: 'casa_listar',
  safety: 'safe',
  description:
    'Lista lo que podés mirar o manejar de la casa (Home Assistant): nombre, entity_id, estado y, en losas y climas, temperatura actual, objetivo, límites y modos.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async handler() {
    if (registeredHomeControl === undefined) {
      return NOT_CONFIGURED_RESULT;
    }
    return registeredHomeControl.listEntities();
  },
};

const homeStateArgsSchema = z.object({
  entidades: z.array(z.string().min(1)).min(1).max(12),
});

export const homeStateTool: ToolDefinition = {
  name: 'casa_estado',
  safety: 'safe',
  description:
    'Estado actual de luces, enchufes, losas, aires o sensores de la casa. entidades: entity_id o el nombre como lo dijo el usuario.',
  parameters: {
    type: 'object',
    properties: {
      entidades: { type: 'array', items: { type: 'string' } },
    },
    required: ['entidades'],
    additionalProperties: false,
  },
  async handler(args) {
    if (registeredHomeControl === undefined) {
      return NOT_CONFIGURED_RESULT;
    }
    const parsed = homeStateArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, summary: `Argumentos inválidos: ${describeZodError(parsed.error)}` };
    }
    return registeredHomeControl.readEntities(parsed.data.entidades);
  },
};

const homeControlArgsSchema = z.object({
  entidad: z.string().min(1),
  accion: z.enum(HOME_CONTROL_ACTION_LIST),
  temperatura: z.number().finite().optional(),
  ajuste: z.number().finite().optional(),
  modo: z.string().optional(),
});

export const homeControlTool: ToolDefinition = {
  name: 'casa_controlar',
  safety: 'safe',
  description:
    'Prende, apaga o ajusta algo de la casa (luces, enchufes, ventiladores, losas radiantes, aires). Devuelve cómo quedó según Home Assistant.',
  parameters: {
    type: 'object',
    properties: {
      entidad: {
        type: 'string',
        description: 'entity_id (climate.losa_cuarto_chicos) o el nombre como lo dijo el usuario',
      },
      accion: { type: 'string', enum: [...HOME_CONTROL_ACTION_LIST] },
      temperatura: { type: 'number', description: 'set_temperature: °C absolutos' },
      ajuste: { type: 'number', description: 'set_temperature: grados a sumar o restar al objetivo actual' },
      modo: {
        type: 'string',
        description: 'set_hvac_mode: heat, auto, off… Con set_temperature, solo si pidió prenderla',
      },
    },
    required: ['entidad', 'accion'],
    additionalProperties: false,
  },
  async handler(args) {
    if (registeredHomeControl === undefined) {
      return NOT_CONFIGURED_RESULT;
    }
    const parsed = homeControlArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, summary: `Argumentos inválidos: ${describeZodError(parsed.error)}` };
    }
    return registeredHomeControl.control({
      entity: parsed.data.entidad,
      action: parsed.data.accion,
      temperature: parsed.data.temperatura,
      adjustment: parsed.data.ajuste,
      hvacMode: parsed.data.modo,
    });
  },
};

export function listHomeToolDefinitionList(): readonly ToolDefinition[] {
  return registeredHomeControl === undefined ? [] : [homeListTool, homeStateTool, homeControlTool];
}
