import { z } from 'zod';

import type { HomeAgendaControl } from '@/homeassistant/agenda';
import { AGENDA_ICON_LIST } from '@/protocol/schema';
import type { ToolDefinition, ToolExecutionResult } from '@/tools/types';

// Agenda v2 por voz (homeassistant/agenda.ts): agendar, listar y borrar
// eventos de los calendarios de Home Assistant. Como las casa_*, solo existen
// si el host tiene Home Assistant (host/main.ts registra el controlador).
//
// Esquemas cortos: viajan en cada llamada al modelo. Ninguna pide
// confirmación: agendar se deshace borrando, y borrar exige el id que da
// agenda_listar (dos pasos, nunca a ciegas).

let registeredAgendaControl: HomeAgendaControl | undefined;

export function setHomeAgendaControl(control: HomeAgendaControl | undefined): void {
  registeredAgendaControl = control;
}

export const AGENDA_TOOL_NAME_LIST = ['agenda_agregar', 'agenda_listar', 'agenda_borrar'] as const;

const NOT_CONFIGURED_RESULT: ToolExecutionResult = {
  ok: false,
  summary: 'La agenda de Home Assistant no está conectada a Jarvis.',
};

function describeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'argumentos'}: ${issue.message}`)
    .join('; ');
}

const agendaAddArgsSchema = z.object({
  fecha: z.string().min(1).max(20),
  hora: z.string().max(10).optional(),
  todo_el_dia: z.boolean().optional(),
  titulo_corto: z.string().min(1).max(80),
  emoji: z.string().max(20).optional(),
  icono: z.enum(AGENDA_ICON_LIST),
  titulo_largo: z.string().max(200).optional(),
  lugar: z.string().max(200).optional(),
  duracion_minutos: z.number().int().min(1).max(1440).optional(),
  descripcion: z.string().max(1000).optional(),
});

export const agendaAddTool: ToolDefinition = {
  name: 'agenda_agregar',
  safety: 'safe',
  description:
    'Agenda un evento en el calendario de la casa. Alcanza con fecha y hora (o todo el día); lugar opcional. No preguntes cómo va a ir ni crees recordatorios aparte.',
  parameters: {
    type: 'object',
    properties: {
      fecha: { type: 'string', description: 'AAAA-MM-DD' },
      hora: { type: 'string', description: 'HH:MM, hora argentina' },
      todo_el_dia: { type: 'boolean' },
      titulo_corto: { type: 'string', description: 'máx. 18 caracteres, sin emoji' },
      emoji: { type: 'string', description: 'un emoji' },
      icono: { type: 'string', enum: [...AGENDA_ICON_LIST] },
      titulo_largo: { type: 'string' },
      lugar: { type: 'string' },
      duracion_minutos: { type: 'integer', description: 'default 60' },
      descripcion: { type: 'string' },
    },
    required: ['fecha', 'titulo_corto', 'emoji', 'icono'],
    additionalProperties: false,
  },
  async handler(args) {
    if (registeredAgendaControl === undefined) {
      return NOT_CONFIGURED_RESULT;
    }
    const parsed = agendaAddArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, summary: `Argumentos inválidos: ${describeZodError(parsed.error)}` };
    }
    const data = parsed.data;
    return registeredAgendaControl.addEvent({
      date: data.fecha,
      time: data.hora,
      allDay: data.todo_el_dia,
      shortTitle: data.titulo_corto,
      emoji: data.emoji,
      icon: data.icono,
      longTitle: data.titulo_largo,
      location: data.lugar,
      durationMinutes: data.duracion_minutos,
      description: data.descripcion,
    });
  },
};

const agendaListArgsSchema = z.object({
  desde: z.string().min(1).max(20),
  hasta: z.string().min(1).max(20).optional(),
});

export const agendaListTool: ToolDefinition = {
  name: 'agenda_listar',
  safety: 'safe',
  description:
    'Eventos de los calendarios de la casa entre dos fechas (hasta 31 días). Devuelve id, día, hora y título.',
  parameters: {
    type: 'object',
    properties: {
      desde: { type: 'string', description: 'AAAA-MM-DD' },
      hasta: { type: 'string', description: 'AAAA-MM-DD, inclusive; default = desde' },
    },
    required: ['desde'],
    additionalProperties: false,
  },
  async handler(args) {
    if (registeredAgendaControl === undefined) {
      return NOT_CONFIGURED_RESULT;
    }
    const parsed = agendaListArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, summary: `Argumentos inválidos: ${describeZodError(parsed.error)}` };
    }
    return registeredAgendaControl.listEvents({ from: parsed.data.desde, to: parsed.data.hasta });
  },
};

const agendaDeleteArgsSchema = z.object({
  id: z.string().min(1).max(300),
});

export const agendaDeleteTool: ToolDefinition = {
  name: 'agenda_borrar',
  safety: 'safe',
  description: 'Borra un evento del calendario por su id (sacalo antes de agenda_listar).',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(args) {
    if (registeredAgendaControl === undefined) {
      return NOT_CONFIGURED_RESULT;
    }
    const parsed = agendaDeleteArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, summary: `Argumentos inválidos: ${describeZodError(parsed.error)}` };
    }
    return registeredAgendaControl.deleteEvent(parsed.data.id);
  },
};

export function listAgendaToolDefinitionList(): readonly ToolDefinition[] {
  return registeredAgendaControl === undefined ? [] : [agendaAddTool, agendaListTool, agendaDeleteTool];
}
