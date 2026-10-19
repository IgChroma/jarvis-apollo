import { describe, expect, it } from 'bun:test';

import { planHomeAssistantAction } from '@/homeassistant/actions';
import type { HomeAssistantState } from '@/homeassistant/client';

const labelledEntityIdSet = new Set(['light.living', 'climate.dormitorio', 'sensor.temp']);

function climateState(attributes: Record<string, unknown>, value = 'cool'): HomeAssistantState {
  return { entity_id: 'climate.dormitorio', state: value, attributes };
}

describe('planHomeAssistantAction', () => {
  it('toggle de una luz etiquetada → homeassistant.toggle', () => {
    expect(
      planHomeAssistantAction({
        entityId: 'light.living',
        action: 'toggle',
        labelledEntityIdSet,
        state: undefined,
      }),
    ).toEqual({
      ok: true,
      serviceCall: { domain: 'homeassistant', service: 'toggle', data: { entity_id: 'light.living' } },
    });
  });

  it('rechaza ids con formato inválido antes de mirar nada más', () => {
    for (const entityId of ['light', 'light.living/../x', 'LIGHT.LIVING', '.living', 'light.']) {
      expect(
        planHomeAssistantAction({ entityId, action: 'toggle', labelledEntityIdSet, state: undefined }),
      ).toEqual({ ok: false, reason: 'entity_id_invalido' });
    }
  });

  it('rechaza entidades que no tienen la etiqueta', () => {
    expect(
      planHomeAssistantAction({
        entityId: 'switch.porton',
        action: 'toggle',
        labelledEntityIdSet,
        state: undefined,
      }),
    ).toEqual({ ok: false, reason: 'entidad_no_habilitada' });
  });

  it('rechaza acciones que no corresponden al tipo', () => {
    expect(
      planHomeAssistantAction({ entityId: 'sensor.temp', action: 'toggle', labelledEntityIdSet, state: undefined }),
    ).toEqual({ ok: false, reason: 'accion_no_corresponde' });
    expect(
      planHomeAssistantAction({ entityId: 'light.living', action: 'climate_up', labelledEntityIdSet, state: undefined }),
    ).toEqual({ ok: false, reason: 'accion_no_corresponde' });
    expect(
      planHomeAssistantAction({
        entityId: 'climate.dormitorio',
        action: 'toggle',
        labelledEntityIdSet,
        state: climateState({ temperature: 22 }),
      }),
    ).toEqual({ ok: false, reason: 'accion_no_corresponde' });
  });

  it('climate_up/down mueve el objetivo 0,5 °C', () => {
    expect(
      planHomeAssistantAction({
        entityId: 'climate.dormitorio',
        action: 'climate_up',
        labelledEntityIdSet,
        state: climateState({ temperature: 22.1, min_temp: 16, max_temp: 30 }),
      }),
    ).toEqual({
      ok: true,
      serviceCall: {
        domain: 'climate',
        service: 'set_temperature',
        data: { entity_id: 'climate.dormitorio', temperature: 22.6 },
      },
    });
    const down = planHomeAssistantAction({
      entityId: 'climate.dormitorio',
      action: 'climate_down',
      labelledEntityIdSet,
      state: climateState({ temperature: 22.5 }),
    });
    expect(down.ok && down.serviceCall.data.temperature).toBe(22);
  });

  it('respeta los límites de la entidad', () => {
    const nearMaximum = planHomeAssistantAction({
      entityId: 'climate.dormitorio',
      action: 'climate_up',
      labelledEntityIdSet,
      state: climateState({ temperature: 29.8, min_temp: 16, max_temp: 30 }),
    });
    expect(nearMaximum.ok && nearMaximum.serviceCall.data.temperature).toBe(30);
    expect(
      planHomeAssistantAction({
        entityId: 'climate.dormitorio',
        action: 'climate_down',
        labelledEntityIdSet,
        state: climateState({ temperature: 16, min_temp: 16, max_temp: 30 }),
      }),
    ).toEqual({ ok: false, reason: 'en_el_limite' });
  });

  it('sin estado, no disponible o sin objetivo único, no llama a HA', () => {
    const base = { entityId: 'climate.dormitorio', action: 'climate_up', labelledEntityIdSet } as const;
    expect(planHomeAssistantAction({ ...base, state: undefined })).toEqual({ ok: false, reason: 'sin_estado' });
    expect(planHomeAssistantAction({ ...base, state: climateState({ temperature: 22 }, 'unavailable') }))
      .toEqual({ ok: false, reason: 'no_disponible' });
    expect(
      planHomeAssistantAction({
        ...base,
        state: climateState({ target_temp_low: 20, target_temp_high: 24 }, 'heat_cool'),
      }),
    ).toEqual({ ok: false, reason: 'sin_objetivo' });
  });
});
