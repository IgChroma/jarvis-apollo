import { afterEach, describe, expect, it } from 'bun:test';

import type { HomeAssistantClient, HomeAssistantState } from '@/homeassistant/client';
import {
  createHomeAssistantVoiceControl,
  describeHomeEntityState,
  normalizeEntityWordList,
  planHomeControl,
  resolveHomeEntity,
} from '@/homeassistant/voice';
import { buildHomeControlPromptNote } from '@/persona/soul';
import { createBuiltinToolDefinitionMap } from '@/tools/catalog';
import { homeControlTool, homeStateTool, listHomeToolDefinitionList, setHomeVoiceControl } from '@/tools/casa';

// Datos reales de la casa (leídos el 2026-10-19 con el token del dueño): las
// dos losas radiantes, apagadas, con paso de 0,1 °C y límites 5-35.
const LABELLED_ENTITY_ID_LIST = [
  'climate.losa_cuarto_chicos',
  'climate.losa_cuarto_lago',
  'sensor.ing_maschwitz_temperature',
  'sensor.ing_maschwitz_precipitation_last_24_hours',
  'sensor.circuit_breaker_voltage',
];

function losa(entityId: string, friendlyName: string, target: number, state = 'off'): HomeAssistantState {
  return {
    entity_id: entityId,
    state,
    attributes: {
      friendly_name: friendlyName,
      current_temperature: 22.5,
      temperature: target,
      min_temp: 5,
      max_temp: 35,
      target_temp_step: 0.1,
      hvac_modes: ['heat', 'auto', 'off'],
    },
  };
}

function buildRealStateList(): HomeAssistantState[] {
  return [
    losa('climate.losa_cuarto_chicos', 'Losa cuarto chicos', 23.5),
    losa('climate.losa_cuarto_lago', 'Losa cuarto lago', 24),
    {
      entity_id: 'sensor.ing_maschwitz_temperature',
      state: '18.234',
      attributes: { friendly_name: 'Ing Maschwitz Temperature', unit_of_measurement: '°C' },
    },
    {
      entity_id: 'sensor.ing_maschwitz_precipitation_last_24_hours',
      state: '0',
      attributes: { friendly_name: 'Ing Maschwitz Precipitation last 24 hours', unit_of_measurement: 'mm' },
    },
    {
      entity_id: 'sensor.circuit_breaker_voltage',
      state: '221.4',
      attributes: { friendly_name: 'Circuit breaker Voltage', unit_of_measurement: 'V' },
    },
    // Sin etiqueta: nunca se puede tocar por voz.
    {
      entity_id: 'switch.porton',
      state: 'off',
      attributes: { friendly_name: 'Portón' },
    },
    {
      entity_id: 'light.living',
      state: 'off',
      attributes: { friendly_name: 'Living' },
    },
  ];
}

type ServiceCall = Parameters<HomeAssistantClient['callService']>[0];

// HA simulado: aplica set_temperature / set_hvac_mode / turn_on|off sobre la
// lista de estados, así la lectura de vuelta ve el cambio.
function createFakeClient(input: {
  readonly labelledEntityIdList?: readonly string[];
  readonly stateList?: HomeAssistantState[];
  readonly applyChanges?: boolean;
  readonly failService?: boolean;
} = {}) {
  const stateList = input.stateList ?? buildRealStateList();
  const serviceCallList: ServiceCall[] = [];
  let labelReadCount = 0;
  const client: HomeAssistantClient = {
    connection: { apiBaseUrl: 'http://ha/api', token: 't', source: 'ha_url' },
    async listLabelEntityIds() {
      labelReadCount += 1;
      return input.labelledEntityIdList ?? LABELLED_ENTITY_ID_LIST;
    },
    async listStates() {
      return stateList.map((state) => structuredClone(state));
    },
    async listCalendarEvents() {
      return [];
    },
    async getDailyForecast() {
      return [];
    },
    async callService(call) {
      serviceCallList.push(call);
      if (input.failService === true) {
        throw new Error('Home Assistant POST /services/climate/set_temperature respondió 400');
      }
      if (input.applyChanges === false) {
        return;
      }
      const entityId = call.data.entity_id as string;
      const index = stateList.findIndex((state) => state.entity_id === entityId);
      const state = stateList[index];
      if (call.service === 'set_temperature') {
        state.attributes = { ...state.attributes, temperature: call.data.temperature };
        if (typeof call.data.hvac_mode === 'string') {
          state.state = call.data.hvac_mode;
        }
      } else if (call.service === 'set_hvac_mode') {
        state.state = call.data.hvac_mode as string;
      } else if (call.service === 'turn_on' || call.service === 'turn_off') {
        state.state = call.service === 'turn_on' ? 'on' : 'off';
      }
    },
  };
  return { client, serviceCallList, stateList, labelReads: () => labelReadCount };
}

function createControl(fake: ReturnType<typeof createFakeClient>) {
  let controlledCount = 0;
  const sleepList: number[] = [];
  const control = createHomeAssistantVoiceControl({
    client: fake.client,
    now: () => 1_000,
    sleep: async (milliseconds) => {
      sleepList.push(milliseconds);
    },
    onControlled: () => {
      controlledCount += 1;
    },
  });
  return { control, controlledCount: () => controlledCount, sleepList };
}

afterEach(() => setHomeVoiceControl(undefined));

describe('normalizeEntityWordList', () => {
  it('ignora tildes, mayúsculas, artículos y plurales, y lee "loza" como "losa"', () => {
    expect(normalizeEntityWordList('la Loza del Cuarto de los Chicos')).toEqual(['losa', 'cuarto', 'chico']);
    expect(normalizeEntityWordList('Losa cuarto chicos')).toEqual(['losa', 'cuarto', 'chico']);
    expect(normalizeEntityWordList('las luces')).toEqual(['luz']);
    expect(normalizeEntityWordList('Habitación')).toEqual(['cuarto']);
  });
});

describe('resolveHomeEntity', () => {
  const stateList = buildRealStateList().filter((state) =>
    LABELLED_ENTITY_ID_LIST.includes(state.entity_id),
  );
  const labelledEntityIdSet = new Set(LABELLED_ENTITY_ID_LIST);
  const resolve = (query: string) =>
    resolveHomeEntity({ query, candidateList: stateList, labelledEntityIdSet });

  it('encuentra la losa por como lo dijo el usuario', () => {
    for (const query of [
      'losa cuarto chicos',
      'la loza del cuarto de los chicos',
      'cuarto de los chicos',
      'Losa Cuarto Chicos',
      'climate.losa_cuarto_chicos',
    ]) {
      const resolution = resolve(query);
      expect(resolution.ok ? resolution.state.entity_id : resolution.error).toBe(
        'climate.losa_cuarto_chicos',
      );
    }
    const lago = resolve('cuarto lago');
    expect(lago.ok && lago.state.entity_id).toBe('climate.losa_cuarto_lago');
  });

  it('no adivina cuando el nombre encaja con dos', () => {
    const resolution = resolve('la losa');
    expect(resolution.ok).toBe(false);
    expect(!resolution.ok && resolution.error).toContain('Losa cuarto chicos');
    expect(!resolution.ok && resolution.error).toContain('Losa cuarto lago');
  });

  it('rechaza un entity_id válido sin la etiqueta jarvis', () => {
    const resolution = resolve('switch.porton');
    expect(resolution.ok).toBe(false);
    expect(!resolution.ok && resolution.error).toContain('etiqueta "jarvis"');
  });

  it('dice que no lo encontró en vez de elegir cualquiera', () => {
    const resolution = resolve('heladera');
    expect(resolution.ok).toBe(false);
    expect(!resolution.ok && resolution.error).toContain('casa_listar');
  });
});

describe('describeHomeEntityState', () => {
  it('una línea corta con lo que hace falta para decidir', () => {
    const [chicos, , temperature] = buildRealStateList();
    expect(describeHomeEntityState(chicos)).toBe(
      'Losa cuarto chicos (climate.losa_cuarto_chicos): off, actual 22.5°, objetivo 23.5°, límites 5-35, modos heat/auto/off',
    );
    expect(describeHomeEntityState(temperature)).toBe(
      'Ing Maschwitz Temperature (sensor.ing_maschwitz_temperature): 18.2 °C',
    );
  });
});

describe('planHomeControl', () => {
  const chicos = losa('climate.losa_cuarto_chicos', 'Losa cuarto chicos', 23.5);

  it('pone el objetivo pero NO prende la losa apagada: avisa', () => {
    const plan = planHomeControl({ state: chicos, action: 'set_temperature', temperature: 25 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.serviceCall).toEqual({
      domain: 'climate',
      service: 'set_temperature',
      data: { entity_id: 'climate.losa_cuarto_chicos', temperature: 25 },
    });
    expect(plan.noteList.join(' ')).toContain('está apagada');
  });

  it('con modo heat la prende en el mismo pedido', () => {
    const plan = planHomeControl({
      state: chicos,
      action: 'set_temperature',
      temperature: 25,
      hvacMode: 'heat',
    });
    expect(plan.ok && plan.serviceCall.data).toEqual({
      entity_id: 'climate.losa_cuarto_chicos',
      temperature: 25,
      hvac_mode: 'heat',
    });
    expect(plan.ok && plan.noteList).toEqual([]);
  });

  it('limita a min/max y redondea al paso de la entidad', () => {
    const tooHot = planHomeControl({ state: chicos, action: 'set_temperature', temperature: 40 });
    expect(tooHot.ok && tooHot.serviceCall.data.temperature).toBe(35);
    expect(tooHot.ok && tooHot.noteList[0]).toContain('máximo es 35°');
    const fine = planHomeControl({ state: chicos, action: 'set_temperature', temperature: 24.26 });
    expect(fine.ok && fine.serviceCall.data.temperature).toBe(24.3);
    const coarse = planHomeControl({
      state: { ...chicos, attributes: { ...chicos.attributes, target_temp_step: 0.5 } },
      action: 'set_temperature',
      temperature: 24.3,
    });
    expect(coarse.ok && coarse.serviceCall.data.temperature).toBe(24.5);
  });

  it('"subí dos grados" se calcula sobre el objetivo actual', () => {
    const plan = planHomeControl({ state: chicos, action: 'set_temperature', adjustment: 2 });
    expect(plan.ok && plan.serviceCall.data.temperature).toBe(25.5);
    const tooMuch = planHomeControl({ state: chicos, action: 'set_temperature', adjustment: 40 });
    expect(tooMuch.ok).toBe(false);
  });

  it('prender una losa heat/auto/off es modo heat; apagarla, off', () => {
    const on = planHomeControl({ state: chicos, action: 'turn_on' });
    expect(on.ok && on.serviceCall).toEqual({
      domain: 'climate',
      service: 'set_hvac_mode',
      data: { entity_id: 'climate.losa_cuarto_chicos', hvac_mode: 'heat' },
    });
    const off = planHomeControl({ state: { ...chicos, state: 'heat' }, action: 'turn_off' });
    expect(off.ok && off.serviceCall.data.hvac_mode).toBe('off');
  });

  it('un aire con frío y calor se prende con climate.turn_on (vuelve al último modo)', () => {
    const aire: HomeAssistantState = {
      ...chicos,
      entity_id: 'climate.aire',
      attributes: { ...chicos.attributes, hvac_modes: ['off', 'cool', 'heat', 'auto'] },
    };
    const plan = planHomeControl({ state: aire, action: 'turn_on' });
    expect(plan.ok && plan.serviceCall.service).toBe('turn_on');
  });

  it('rechaza lo que no corresponde al dominio', () => {
    const sensor = buildRealStateList()[2];
    expect(planHomeControl({ state: sensor, action: 'turn_on' }).ok).toBe(false);
    const light: HomeAssistantState = { entity_id: 'light.living', state: 'off', attributes: {} };
    expect(planHomeControl({ state: light, action: 'set_temperature', temperature: 20 }).ok).toBe(false);
    expect(planHomeControl({ state: light, action: 'turn_on' })).toMatchObject({
      ok: true,
      serviceCall: { domain: 'light', service: 'turn_on', data: { entity_id: 'light.living' } },
    });
    expect(planHomeControl({ state: chicos, action: 'set_hvac_mode', hvacMode: 'cool' }).ok).toBe(false);
    expect(
      planHomeControl({ state: { ...chicos, state: 'unavailable' }, action: 'set_temperature', temperature: 20 }).ok,
    ).toBe(false);
  });
});

describe('createHomeAssistantVoiceControl', () => {
  it('"poné la losa del cuarto de los chicos en 25": llama a HA y lee cómo quedó', async () => {
    const fake = createFakeClient();
    const { control, controlledCount } = createControl(fake);
    const result = await control.control({
      entity: 'losa cuarto chicos',
      action: 'set_temperature',
      temperature: 25,
    });
    expect(fake.serviceCallList).toEqual([
      {
        domain: 'climate',
        service: 'set_temperature',
        data: { entity_id: 'climate.losa_cuarto_chicos', temperature: 25 },
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('Hecho. Ahora: Losa cuarto chicos');
    expect(result.summary).toContain('objetivo 25°');
    expect(result.summary).toContain('está apagada');
    expect(controlledCount()).toBe(1);
  });

  it('si HA tarda en reflejarlo, relee una vez y lo dice sin mentir', async () => {
    const fake = createFakeClient({ applyChanges: false });
    const { control, sleepList } = createControl(fake);
    const result = await control.control({
      entity: 'climate.losa_cuarto_lago',
      action: 'set_temperature',
      temperature: 21,
    });
    expect(result.ok).toBe(true);
    expect(sleepList).toHaveLength(1);
    expect(result.summary).toContain('por ahora muestra');
    expect(result.summary).toContain('objetivo 24°');
  });

  it('nunca toca algo sin la etiqueta, aunque el id exista', async () => {
    const fake = createFakeClient();
    const { control } = createControl(fake);
    const result = await control.control({ entity: 'switch.porton', action: 'turn_on' });
    expect(result.ok).toBe(false);
    expect(fake.serviceCallList).toEqual([]);
  });

  it('un error de HA vuelve como texto que el modelo puede decir', async () => {
    const fake = createFakeClient({ failService: true });
    const { control } = createControl(fake);
    const result = await control.control({
      entity: 'losa cuarto lago',
      action: 'set_temperature',
      temperature: 22,
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Home Assistant rechazó el pedido para Losa cuarto lago');
  });

  it('lista solo lo etiquetado y lee varias entidades; la etiqueta se cachea', async () => {
    const fake = createFakeClient();
    const { control } = createControl(fake);
    const list = await control.listEntities();
    expect(list.summary.split('\n')).toHaveLength(5);
    expect(list.summary).not.toContain('switch.porton');
    const read = await control.readEntities(['cuarto lago', 'heladera']);
    expect(read.summary).toContain('Losa cuarto lago (climate.losa_cuarto_lago): off');
    expect(read.summary).toContain('No encontré "heladera"');
    expect(fake.labelReads()).toBe(1);
  });
});

describe('herramientas casa_*', () => {
  it('sin Home Assistant no se registran (no suman esquemas al modelo)', () => {
    expect(listHomeToolDefinitionList()).toEqual([]);
    expect(createBuiltinToolDefinitionMap().has('casa_controlar')).toBe(false);
  });

  it('con Home Assistant están en el catálogo, sin confirmación y con esquemas chicos', () => {
    setHomeVoiceControl(createControl(createFakeClient()).control);
    const toolMap = createBuiltinToolDefinitionMap();
    for (const name of ['casa_listar', 'casa_estado', 'casa_controlar']) {
      const tool = toolMap.get(name);
      expect(tool?.safety).toBe('safe');
      // Entra entera en el recorte de turn/run.ts (180).
      expect(tool!.description.length).toBeLessThanOrEqual(180);
    }
    const schemaChars = listHomeToolDefinitionList().reduce(
      (total, tool) => total + JSON.stringify(tool.parameters).length + tool.description.length,
      0,
    );
    expect(schemaChars).toBeLessThan(1400);
  });

  it('casa_controlar valida los argumentos y devuelve el error, sin tirar', async () => {
    setHomeVoiceControl(createControl(createFakeClient()).control);
    const context = { environment: {} as Env, nowMilliseconds: 0 };
    const invalid = await homeControlTool.handler({ entidad: 'losa', accion: 'explotar' }, context);
    expect(invalid.ok).toBe(false);
    expect(invalid.summary).toContain('Argumentos inválidos');
    const done = await homeControlTool.handler(
      { entidad: 'loza cuarto chicos', accion: 'set_temperature', temperatura: 25, modo: 'heat' },
      context,
    );
    expect(done.ok).toBe(true);
    expect(done.summary).toContain('Losa cuarto chicos (climate.losa_cuarto_chicos): heat');
    const state = await homeStateTool.handler({ entidades: ['cuarto chicos'] }, context);
    expect(state.summary).toContain('objetivo 25°');
  });
});

describe('buildHomeControlPromptNote', () => {
  it('solo aparece si la casa está conectada', () => {
    expect(buildHomeControlPromptNote(['set_volume'])).toBe('');
    const note = buildHomeControlPromptNote(['casa_listar', 'casa_estado', 'casa_controlar']);
    expect(note).toContain('casa_controlar');
    expect(note.length).toBeLessThan(600);
  });
});
