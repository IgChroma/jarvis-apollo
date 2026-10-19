import type { HomeAssistantTileAction } from '@/protocol/schema';

import { isValidEntityId, type HomeAssistantState } from '@/homeassistant/client';
import { isEntityAvailable, resolveHomeEntityKind } from '@/homeassistant/entities';

// Qué servicio de Home Assistant corresponde a un toque en un mosaico.
//
// La placa manda un id de entidad y una acción; el servidor NO le cree: solo
// acepta entidades que hoy tienen la etiqueta `jarvis` y acciones que tengan
// sentido para su tipo. Si no, cualquiera con el secreto del WebSocket podría
// apagar la heladera o abrir el portón mandando un id a mano.

export const CLIMATE_TARGET_STEP_C = 0.5;
// Los defaults de HA cuando la entidad no informa límites.
const DEFAULT_CLIMATE_MIN_TEMPERATURE_C = 7;
const DEFAULT_CLIMATE_MAX_TEMPERATURE_C = 35;

export type HomeAssistantServiceCall = {
  readonly domain: string;
  readonly service: string;
  readonly data: Readonly<Record<string, unknown>>;
};

export type HomeAssistantActionRejection =
  | 'entity_id_invalido'
  | 'entidad_no_habilitada'
  | 'accion_no_corresponde'
  | 'sin_estado'
  | 'no_disponible'
  | 'sin_objetivo'
  | 'en_el_limite';

export type HomeAssistantActionPlan =
  | { readonly ok: true; readonly serviceCall: HomeAssistantServiceCall }
  | { readonly ok: false; readonly reason: HomeAssistantActionRejection };

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Nuevo objetivo de un aire/estufa: ± 0,5 °C, dentro de los límites que
 * informa la entidad. Se redondea a un decimal para que 22,1 + 0,5 no viaje
 * como 22,600000000000001.
 */
export function planClimateTarget(input: {
  readonly state: HomeAssistantState;
  readonly direction: 1 | -1;
}): { readonly ok: true; readonly targetC: number } | { readonly ok: false; readonly reason: HomeAssistantActionRejection } {
  const currentTarget = readFiniteNumber(input.state.attributes.temperature);
  if (currentTarget === undefined) {
    // Modo heat_cool (rango con dos objetivos) o un equipo sin objetivo: no hay
    // un número único que mover.
    return { ok: false, reason: 'sin_objetivo' };
  }
  const minimum =
    readFiniteNumber(input.state.attributes.min_temp) ?? DEFAULT_CLIMATE_MIN_TEMPERATURE_C;
  const maximum =
    readFiniteNumber(input.state.attributes.max_temp) ?? DEFAULT_CLIMATE_MAX_TEMPERATURE_C;
  const requested = currentTarget + input.direction * CLIMATE_TARGET_STEP_C;
  const clamped = Math.min(maximum, Math.max(minimum, requested));
  const targetC = Math.round(clamped * 10) / 10;
  if (targetC === currentTarget) {
    return { ok: false, reason: 'en_el_limite' };
  }
  return { ok: true, targetC };
}

export function planHomeAssistantAction(input: {
  readonly entityId: string;
  readonly action: HomeAssistantTileAction;
  readonly labelledEntityIdSet: ReadonlySet<string>;
  readonly state: HomeAssistantState | undefined;
}): HomeAssistantActionPlan {
  const { entityId, action } = input;
  if (!isValidEntityId(entityId)) {
    return { ok: false, reason: 'entity_id_invalido' };
  }
  if (!input.labelledEntityIdSet.has(entityId)) {
    return { ok: false, reason: 'entidad_no_habilitada' };
  }
  const kind = resolveHomeEntityKind(entityId);
  if (action === 'toggle') {
    if (kind !== 'toggle') {
      return { ok: false, reason: 'accion_no_corresponde' };
    }
    return {
      ok: true,
      serviceCall: {
        domain: 'homeassistant',
        service: 'toggle',
        data: { entity_id: entityId },
      },
    };
  }
  if (kind !== 'climate') {
    return { ok: false, reason: 'accion_no_corresponde' };
  }
  if (input.state === undefined) {
    return { ok: false, reason: 'sin_estado' };
  }
  if (!isEntityAvailable(input.state)) {
    return { ok: false, reason: 'no_disponible' };
  }
  const target = planClimateTarget({
    state: input.state,
    direction: action === 'climate_up' ? 1 : -1,
  });
  if (!target.ok) {
    return target;
  }
  return {
    ok: true,
    serviceCall: {
      domain: 'climate',
      service: 'set_temperature',
      data: { entity_id: entityId, temperature: target.targetC },
    },
  };
}
