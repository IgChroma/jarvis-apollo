import { describe, expect, it } from 'bun:test';

import {
  ROUTER_INTENT_BY_ID,
  matchIntentToolNameList,
  resolveIntentForUsedToolList,
} from '@/router/intents';

// Agenda v2: con Home Assistant, agendar usa agenda_* y ya no ofrece la hora
// de salida (decisión del dueño, 2026-10-19).

const AVAILABLE_TOOL_NAME_LIST = [
  'agenda_agregar',
  'agenda_listar',
  'agenda_borrar',
  'avisar_para_salir',
  'set_reminder',
  'list_reminders',
  'web_search',
  'mcp_9386143d_create_event_cd2e3216',
  'mcp_77aa_maps_directions_0badf00d',
];

function toolsFor(intentId: Parameters<typeof ROUTER_INTENT_BY_ID.get>[0]): readonly string[] | undefined {
  return matchIntentToolNameList(ROUTER_INTENT_BY_ID.get(intentId)!, AVAILABLE_TOOL_NAME_LIST);
}

describe('intenciones de agenda', () => {
  it('agenda_crear: agenda_* y Google Calendar si está, sin avisar_para_salir', () => {
    expect(toolsFor('agenda_crear')).toEqual([
      'agenda_agregar',
      'agenda_listar',
      'agenda_borrar',
      'set_reminder',
      'mcp_9386143d_create_event_cd2e3216',
    ]);
  });

  it('avisar_para_salir queda en viaje (y en recordatorio), donde se pide explícitamente', () => {
    expect(toolsFor('viaje')).toContain('avisar_para_salir');
    expect(toolsFor('recordatorio')).toContain('avisar_para_salir');
    expect(toolsFor('agenda_crear')).not.toContain('avisar_para_salir');
  });

  it('agenda_leer usa agenda_listar y los recordatorios', () => {
    expect(toolsFor('agenda_leer')).toEqual(['agenda_listar', 'list_reminders']);
  });

  it('sin Home Assistant agenda_crear queda con lo de antes (menos la salida)', () => {
    const withoutHome = matchIntentToolNameList(ROUTER_INTENT_BY_ID.get('agenda_crear')!, [
      'avisar_para_salir',
      'set_reminder',
      'mcp_9386143d_create_event_cd2e3216',
    ]);
    expect(withoutHome).toEqual(['set_reminder', 'mcp_9386143d_create_event_cd2e3216']);
  });

  it('usar agenda_agregar etiqueta el turno como agenda_crear', () => {
    expect(resolveIntentForUsedToolList(['agenda_agregar'], 'otro')).toBe('agenda_crear');
    expect(resolveIntentForUsedToolList(['agenda_listar'], 'agenda_leer')).toBe('agenda_leer');
  });
});
