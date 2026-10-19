import { isValidEntityId, type HomeAssistantClient, type HomeAssistantState } from '@/homeassistant/client';
import type { HomeAssistantServiceCall } from '@/homeassistant/actions';
import {
  JARVIS_HOME_ASSISTANT_LABEL,
  formatSensorValue,
  isEntityAvailable,
  resolveEntityDomain,
  resolveEntityName,
  resolveHomeEntityKind,
} from '@/homeassistant/entities';

// La casa por voz: lo que leen y ejecutan las herramientas casa_listar,
// casa_estado y casa_controlar (tools/casa.ts).
//
// Misma regla que los toques del tablero (homeassistant/actions.ts): solo las
// entidades que HOY tienen la etiqueta `jarvis`, y solo acciones que tengan
// sentido para su dominio. El modelo no elige entidades fuera de esa lista
// aunque invente un entity_id válido.
//
// El 2026-10-18 "poné la temperatura de losa cuarto chicos en 25" no se pudo
// hacer: el modelo no tenía ninguna herramienta de Home Assistant. Por eso
// casa_controlar acepta el NOMBRE como lo dijo el usuario además del entity_id:
// así el pedido se resuelve en una sola ronda, sin listar antes.

export const HOME_VOICE_LABEL_CACHE_MILLISECONDS = 60_000;
// Si HA todavía no refleja el cambio, una segunda lectura después de esto.
export const HOME_VOICE_READBACK_RETRY_MILLISECONDS = 700;
const DEFAULT_CLIMATE_MIN_TEMPERATURE_C = 7;
const DEFAULT_CLIMATE_MAX_TEMPERATURE_C = 35;
const DEFAULT_CLIMATE_STEP_C = 0.5;
// Un pedido de "+40 grados" es un error del modelo, no un ajuste.
const MAX_RELATIVE_ADJUSTMENT_C = 15;

export const HOME_CONTROL_ACTION_LIST = [
  'turn_on',
  'turn_off',
  'toggle',
  'set_temperature',
  'set_hvac_mode',
] as const;

export type HomeControlAction = (typeof HOME_CONTROL_ACTION_LIST)[number];

export function isHomeControlAction(value: string): value is HomeControlAction {
  return (HOME_CONTROL_ACTION_LIST as readonly string[]).includes(value);
}

export type HomeVoiceResult = {
  readonly ok: boolean;
  readonly summary: string;
};

// Lo que se puede mirar o manejar por voz. Calendarios y clima de afuera
// también llevan la etiqueta, pero son del tablero.
function isVoiceEntity(entityId: string): boolean {
  const kind = resolveHomeEntityKind(entityId);
  return kind === 'toggle' || kind === 'climate' || kind === 'sensor';
}

// ---- Nombres ----
//
// "losa cuarto chicos", "la loza del cuarto de los chicos", "Losa Cuarto
// Chicos" tienen que dar lo mismo. Se comparan palabras normalizadas: sin
// tildes ni mayúsculas, sin artículos, en singular, y "loza" como "losa" (el
// transcriptor escribe las dos).

const STOP_WORD_SET: ReadonlySet<string> = new Set([
  'a', 'al', 'de', 'del', 'el', 'en', 'la', 'las', 'lo', 'los', 'y', 'mi', 'mis', 'su',
]);

const WORD_ALIAS: ReadonlyMap<string, string> = new Map([
  ['loza', 'losa'],
  ['luces', 'luz'],
  ['habitacion', 'cuarto'],
  ['dormitorio', 'cuarto'],
  ['pieza', 'cuarto'],
]);

// Palabras genéricas que el usuario suele decir y el nombre no tiene: "la luz
// del living" para una entidad llamada "Living".
const DOMAIN_WORD_LIST: Readonly<Record<string, readonly string[]>> = {
  light: ['luz', 'lampara', 'velador'],
  switch: ['enchufe', 'llave', 'interruptor'],
  fan: ['ventilador'],
  input_boolean: [],
  climate: ['calefaccion', 'temperatura', 'aire', 'clima', 'termostato'],
  sensor: ['sensor', 'temperatura', 'humedad'],
  binary_sensor: ['sensor'],
};

function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ces')) {
    return `${word.slice(0, -3)}z`;
  }
  if (word.length > 3 && word.endsWith('s')) {
    return word.slice(0, -1);
  }
  return word;
}

export function normalizeEntityWordList(text: string): readonly string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length > 0 && !STOP_WORD_SET.has(word))
    .map((word) => WORD_ALIAS.get(word) ?? word)
    .map(singular)
    .map((word) => WORD_ALIAS.get(word) ?? word);
}

export type HomeEntityResolution =
  | { readonly ok: true; readonly state: HomeAssistantState }
  | { readonly ok: false; readonly error: string };

function isSubset(small: ReadonlySet<string>, big: ReadonlySet<string>): boolean {
  for (const word of small) {
    if (!big.has(word)) {
      return false;
    }
  }
  return true;
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && isSubset(left, right);
}

/**
 * Busca la entidad que nombra el usuario entre las habilitadas. Acepta el
 * entity_id exacto o el nombre; si el nombre encaja con más de una, no adivina.
 */
export function resolveHomeEntity(input: {
  readonly query: string;
  readonly candidateList: readonly HomeAssistantState[];
  // Todas las etiquetadas, para distinguir "no existe" de "no se puede usar".
  readonly labelledEntityIdSet: ReadonlySet<string>;
}): HomeEntityResolution {
  const query = input.query.trim();
  const lowerQuery = query.toLowerCase();
  if (isValidEntityId(lowerQuery)) {
    const state = input.candidateList.find((candidate) => candidate.entity_id === lowerQuery);
    if (state !== undefined) {
      return { ok: true, state };
    }
    if (!input.labelledEntityIdSet.has(lowerQuery)) {
      return {
        ok: false,
        error: `${lowerQuery} no está habilitada para Jarvis: en Home Assistant le falta la etiqueta "${JARVIS_HOME_ASSISTANT_LABEL}".`,
      };
    }
    if (!isVoiceEntity(lowerQuery)) {
      return { ok: false, error: `${lowerQuery} no se puede manejar por voz.` };
    }
    return { ok: false, error: `Home Assistant no informa el estado de ${lowerQuery}.` };
  }

  const queryWordSet = new Set(normalizeEntityWordList(query));
  if (queryWordSet.size === 0) {
    return { ok: false, error: 'Falta decir qué entidad.' };
  }
  const scoredList = input.candidateList.map((state) => {
    const nameWordSet = new Set(normalizeEntityWordList(resolveEntityName(state)));
    const objectWordSet = new Set(
      normalizeEntityWordList(state.entity_id.split('.').slice(1).join(' ')),
    );
    const domainWordList = DOMAIN_WORD_LIST[resolveEntityDomain(state.entity_id)] ?? [];
    const widenedWordSet = new Set([...nameWordSet, ...objectWordSet, ...domainWordList]);
    let score = 0;
    if (setsEqual(queryWordSet, nameWordSet) || setsEqual(queryWordSet, objectWordSet)) {
      score = 3;
    } else if (isSubset(queryWordSet, widenedWordSet)) {
      // "cuarto chicos" para "Losa cuarto chicos".
      score = 2;
    } else if (nameWordSet.size > 0 && isSubset(nameWordSet, queryWordSet)) {
      // "la luz del living de abajo" para "Living": todo el nombre está dicho.
      score = 1;
    }
    return { state, score };
  });
  const bestScore = Math.max(0, ...scoredList.map((entry) => entry.score));
  if (bestScore === 0) {
    return {
      ok: false,
      error: `No encontré "${query}" entre lo habilitado. Usá casa_listar para ver los nombres.`,
    };
  }
  const bestList = scoredList.filter((entry) => entry.score === bestScore);
  if (bestList.length > 1) {
    const nameList = bestList.map((entry) => `${resolveEntityName(entry.state)} (${entry.state.entity_id})`);
    return {
      ok: false,
      error: `"${query}" puede ser más de una: ${nameList.join(', ')}. Preguntale cuál.`,
    };
  }
  return { ok: true, state: bestList[0].state };
}

// ---- Cómo se describe una entidad ----
//
// Una línea por entidad, corta: el modelo la lee en cada ronda.

function readNumber(state: HomeAssistantState, attributeName: string): number | undefined {
  const value = state.attributes[attributeName];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function readStringList(state: HomeAssistantState, attributeName: string): readonly string[] {
  const value = state.attributes[attributeName];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function readString(state: HomeAssistantState, attributeName: string): string | undefined {
  const value = state.attributes[attributeName];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function formatDegrees(value: number): string {
  return `${String(Math.round(value * 10) / 10)}°`;
}

export function describeHomeEntityState(state: HomeAssistantState): string {
  const head = `${resolveEntityName(state)} (${state.entity_id})`;
  if (!isEntityAvailable(state)) {
    return `${head}: no disponible`;
  }
  const kind = resolveHomeEntityKind(state.entity_id);
  if (kind === 'climate') {
    const partList = [state.state];
    const action = readString(state, 'hvac_action');
    if (action !== undefined) {
      partList.push(action);
    }
    const current = readNumber(state, 'current_temperature');
    if (current !== undefined) {
      partList.push(`actual ${formatDegrees(current)}`);
    }
    const target = readNumber(state, 'temperature');
    const low = readNumber(state, 'target_temp_low');
    const high = readNumber(state, 'target_temp_high');
    if (target !== undefined) {
      partList.push(`objetivo ${formatDegrees(target)}`);
    } else if (low !== undefined && high !== undefined) {
      partList.push(`objetivo ${formatDegrees(low)} a ${formatDegrees(high)}`);
    }
    const minimum = readNumber(state, 'min_temp');
    const maximum = readNumber(state, 'max_temp');
    if (minimum !== undefined && maximum !== undefined) {
      partList.push(`límites ${String(minimum)}-${String(maximum)}`);
    }
    const modeList = readStringList(state, 'hvac_modes');
    if (modeList.length > 0) {
      partList.push(`modos ${modeList.join('/')}`);
    }
    return `${head}: ${partList.join(', ')}`;
  }
  if (resolveEntityDomain(state.entity_id) === 'binary_sensor') {
    const deviceClass = readString(state, 'device_class');
    return `${head}: ${state.state}${deviceClass === undefined ? '' : ` (${deviceClass})`}`;
  }
  if (kind === 'sensor') {
    const unit = readString(state, 'unit_of_measurement');
    return `${head}: ${formatSensorValue(state.state)}${unit === undefined ? '' : ` ${unit}`}`;
  }
  return `${head}: ${state.state}`;
}

// ---- Qué servicio llamar ----

type ReadbackExpectation = (state: HomeAssistantState) => boolean;

export type HomeControlPlan =
  | {
      readonly ok: true;
      readonly serviceCall: HomeAssistantServiceCall;
      readonly expectation: ReadbackExpectation;
      // Algo que el usuario tiene que saber además de "listo".
      readonly noteList: readonly string[];
    }
  | { readonly ok: false; readonly error: string };

function roundToStep(value: number, step: number): number {
  const stepped = Math.round(value / step) * step;
  return Math.round(stepped * 100) / 100;
}

function planClimatePower(
  state: HomeAssistantState,
  turnOn: boolean,
): HomeControlPlan {
  const entityId = state.entity_id;
  const modeList = readStringList(state, 'hvac_modes');
  if (!turnOn) {
    if (modeList.length > 0 && !modeList.includes('off')) {
      return { ok: false, error: `${resolveEntityName(state)} no tiene modo apagado.` };
    }
    return {
      ok: true,
      serviceCall: {
        domain: 'climate',
        service: 'set_hvac_mode',
        data: { entity_id: entityId, hvac_mode: 'off' },
      },
      expectation: (next) => next.state === 'off',
      noteList: [],
    };
  }
  // Un solo modo de encendido (off/heat): ese. Las losas radiantes de la casa
  // informan heat/auto/off: sin frío, "prendela" es calentar. Si hay frío y
  // calor (un aire), que HA vuelva al último modo con climate.turn_on.
  const onModeList = modeList.filter((mode) => mode !== 'off');
  const onMode =
    onModeList.length === 1
      ? onModeList[0]
      : onModeList.includes('heat') && !onModeList.includes('cool') && !onModeList.includes('heat_cool')
        ? 'heat'
        : undefined;
  if (onMode !== undefined) {
    return {
      ok: true,
      serviceCall: {
        domain: 'climate',
        service: 'set_hvac_mode',
        data: { entity_id: entityId, hvac_mode: onMode },
      },
      expectation: (next) => next.state === onMode,
      noteList: [],
    };
  }
  return {
    ok: true,
    serviceCall: { domain: 'climate', service: 'turn_on', data: { entity_id: entityId } },
    expectation: (next) => next.state !== 'off',
    noteList: [],
  };
}

export function planHomeControl(input: {
  readonly state: HomeAssistantState;
  readonly action: HomeControlAction;
  readonly temperature?: number;
  readonly adjustment?: number;
  readonly hvacMode?: string;
}): HomeControlPlan {
  const { state, action } = input;
  const entityId = state.entity_id;
  const name = resolveEntityName(state);
  const domain = resolveEntityDomain(entityId);
  const kind = resolveHomeEntityKind(entityId);
  if (!isEntityAvailable(state)) {
    return { ok: false, error: `${name} no está disponible en Home Assistant ahora.` };
  }
  if (kind === 'sensor') {
    return { ok: false, error: `${name} es un sensor: se puede leer pero no controlar.` };
  }

  if (action === 'turn_on' || action === 'turn_off' || action === 'toggle') {
    if (kind === 'climate') {
      const turnOn = action === 'toggle' ? state.state === 'off' : action === 'turn_on';
      return planClimatePower(state, turnOn);
    }
    if (kind !== 'toggle') {
      return { ok: false, error: `${name} no se prende ni se apaga por voz.` };
    }
    const previousState = state.state;
    return {
      ok: true,
      serviceCall: { domain, service: action, data: { entity_id: entityId } },
      expectation:
        action === 'toggle'
          ? (next) => next.state !== previousState
          : (next) => next.state === (action === 'turn_on' ? 'on' : 'off'),
      noteList: [],
    };
  }

  if (kind !== 'climate') {
    return {
      ok: false,
      error: `${action} es solo para climas o losas; ${name} acepta turn_on, turn_off o toggle.`,
    };
  }
  const modeList = readStringList(state, 'hvac_modes');
  const requestedMode = input.hvacMode?.trim().toLowerCase();
  if (requestedMode !== undefined && requestedMode.length > 0 && modeList.length > 0 && !modeList.includes(requestedMode)) {
    return {
      ok: false,
      error: `${name} no tiene el modo "${requestedMode}". Modos: ${modeList.join(', ')}.`,
    };
  }

  if (action === 'set_hvac_mode') {
    if (requestedMode === undefined || requestedMode.length === 0) {
      return { ok: false, error: `Falta el modo. Modos de ${name}: ${modeList.join(', ') || 'desconocidos'}.` };
    }
    return {
      ok: true,
      serviceCall: {
        domain: 'climate',
        service: 'set_hvac_mode',
        data: { entity_id: entityId, hvac_mode: requestedMode },
      },
      expectation: (next) => next.state === requestedMode,
      noteList: [],
    };
  }

  // set_temperature
  const currentTarget = readNumber(state, 'temperature');
  let requested: number;
  if (input.temperature !== undefined) {
    requested = input.temperature;
  } else if (input.adjustment !== undefined) {
    if (Math.abs(input.adjustment) > MAX_RELATIVE_ADJUSTMENT_C) {
      return { ok: false, error: `Un ajuste de ${String(input.adjustment)} grados es demasiado.` };
    }
    if (currentTarget === undefined) {
      return { ok: false, error: `${name} no informa un objetivo para sumarle o restarle grados.` };
    }
    requested = currentTarget + input.adjustment;
  } else {
    return { ok: false, error: 'Falta la temperatura (o el ajuste en grados).' };
  }
  if (!Number.isFinite(requested)) {
    return { ok: false, error: 'La temperatura no es un número.' };
  }
  if (currentTarget === undefined && readNumber(state, 'target_temp_low') !== undefined) {
    return {
      ok: false,
      error: `${name} está en modo rango (dos objetivos): cambialo de modo antes de poner una temperatura.`,
    };
  }
  const minimum = readNumber(state, 'min_temp') ?? DEFAULT_CLIMATE_MIN_TEMPERATURE_C;
  const maximum = readNumber(state, 'max_temp') ?? DEFAULT_CLIMATE_MAX_TEMPERATURE_C;
  const step = readNumber(state, 'target_temp_step') ?? DEFAULT_CLIMATE_STEP_C;
  const clamped = Math.min(maximum, Math.max(minimum, requested));
  const target = roundToStep(clamped, step > 0 ? step : DEFAULT_CLIMATE_STEP_C);
  const noteList: string[] = [];
  if (clamped !== requested) {
    noteList.push(
      `Pediste ${formatDegrees(requested)} pero el ${requested > maximum ? 'máximo' : 'mínimo'} es ${formatDegrees(clamped)}.`,
    );
  }
  const finalMode = requestedMode !== undefined && requestedMode.length > 0 ? requestedMode : undefined;
  // Poner una temperatura NO prende el equipo: prender la losa es gastar
  // energía y el usuario no lo pidió. Se guarda el objetivo, se avisa, y el
  // modelo ofrece prenderla (o la prende si el pedido ya lo decía: modo heat en
  // la misma llamada).
  if (finalMode === undefined && state.state === 'off') {
    noteList.push(
      'Ojo: está apagada (modo off): el objetivo quedó guardado pero no va a calentar hasta que la prendas. Decíselo y ofrecé prenderla (casa_controlar con turn_on).',
    );
  }
  return {
    ok: true,
    serviceCall: {
      domain: 'climate',
      service: 'set_temperature',
      data: {
        entity_id: entityId,
        temperature: target,
        ...(finalMode === undefined ? {} : { hvac_mode: finalMode }),
      },
    },
    expectation: (next) =>
      readNumber(next, 'temperature') === target && (finalMode === undefined || next.state === finalMode),
    noteList,
  };
}

// ---- El controlador ----

export type HomeVoiceControl = {
  listEntities(): Promise<HomeVoiceResult>;
  readEntities(queryList: readonly string[]): Promise<HomeVoiceResult>;
  control(input: {
    readonly entity: string;
    readonly action: HomeControlAction;
    readonly temperature?: number;
    readonly adjustment?: number;
    readonly hvacMode?: string;
  }): Promise<HomeVoiceResult>;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createHomeAssistantVoiceControl(input: {
  readonly client: HomeAssistantClient;
  readonly label?: string;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  // Después de un cambio: el tablero se empuja enseguida para que la placa lo muestre.
  readonly onControlled?: () => void;
}): HomeVoiceControl {
  const { client } = input;
  const label = input.label ?? JARVIS_HOME_ASSISTANT_LABEL;
  const now = input.now ?? (() => Date.now());
  const sleep =
    input.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let labelCache: { readonly entityIdList: readonly string[]; readonly expiresAt: number } | undefined;

  async function readLabelledEntityIdSet(): Promise<ReadonlySet<string>> {
    if (labelCache === undefined || now() >= labelCache.expiresAt) {
      const entityIdList = await client.listLabelEntityIds(label);
      labelCache = { entityIdList, expiresAt: now() + HOME_VOICE_LABEL_CACHE_MILLISECONDS };
    }
    return new Set(labelCache.entityIdList);
  }

  async function readSnapshot(): Promise<
    | {
        readonly ok: true;
        readonly labelledEntityIdSet: ReadonlySet<string>;
        readonly candidateList: readonly HomeAssistantState[];
      }
    | { readonly ok: false; readonly result: HomeVoiceResult }
  > {
    try {
      const [labelledEntityIdSet, stateList] = await Promise.all([
        readLabelledEntityIdSet(),
        client.listStates(),
      ]);
      const candidateList = stateList
        .filter((state) => labelledEntityIdSet.has(state.entity_id) && isVoiceEntity(state.entity_id))
        .toSorted((left, right) => left.entity_id.localeCompare(right.entity_id));
      return { ok: true, labelledEntityIdSet, candidateList };
    } catch (error) {
      return {
        ok: false,
        result: { ok: false, summary: `Home Assistant no responde: ${describeError(error)}` },
      };
    }
  }

  async function readState(entityId: string): Promise<HomeAssistantState | undefined> {
    return (await client.listStates()).find((state) => state.entity_id === entityId);
  }

  return {
    async listEntities() {
      const snapshot = await readSnapshot();
      if (!snapshot.ok) {
        return snapshot.result;
      }
      if (snapshot.candidateList.length === 0) {
        return {
          ok: true,
          summary: `No hay nada habilitado: en Home Assistant hay que ponerle la etiqueta "${label}" a lo que quieras manejar.`,
        };
      }
      return {
        ok: true,
        summary: snapshot.candidateList.map(describeHomeEntityState).join('\n'),
      };
    },

    async readEntities(queryList) {
      if (queryList.length === 0) {
        return { ok: false, summary: 'Falta decir qué entidad.' };
      }
      const snapshot = await readSnapshot();
      if (!snapshot.ok) {
        return snapshot.result;
      }
      const lineList = queryList.map((query) => {
        const resolution = resolveHomeEntity({
          query,
          candidateList: snapshot.candidateList,
          labelledEntityIdSet: snapshot.labelledEntityIdSet,
        });
        return resolution.ok ? describeHomeEntityState(resolution.state) : resolution.error;
      });
      return { ok: true, summary: lineList.join('\n') };
    },

    async control(request) {
      const snapshot = await readSnapshot();
      if (!snapshot.ok) {
        return snapshot.result;
      }
      const resolution = resolveHomeEntity({
        query: request.entity,
        candidateList: snapshot.candidateList,
        labelledEntityIdSet: snapshot.labelledEntityIdSet,
      });
      if (!resolution.ok) {
        return { ok: false, summary: resolution.error };
      }
      const plan = planHomeControl({
        state: resolution.state,
        action: request.action,
        temperature: request.temperature,
        adjustment: request.adjustment,
        hvacMode: request.hvacMode,
      });
      if (!plan.ok) {
        return { ok: false, summary: plan.error };
      }
      const entityId = resolution.state.entity_id;
      try {
        await client.callService(plan.serviceCall);
      } catch (error) {
        return {
          ok: false,
          summary: `Home Assistant rechazó el pedido para ${resolveEntityName(resolution.state)}: ${describeError(error)}`,
        };
      }
      input.onControlled?.();

      // Lectura de vuelta: lo que se le dice al usuario es lo que HA muestra,
      // no lo que se pidió. Algunas integraciones tardan en reflejarlo.
      let nextState: HomeAssistantState | undefined;
      try {
        nextState = await readState(entityId);
        if (nextState === undefined || !plan.expectation(nextState)) {
          await sleep(HOME_VOICE_READBACK_RETRY_MILLISECONDS);
          nextState = await readState(entityId);
        }
      } catch {
        nextState = undefined;
      }
      const noteText = plan.noteList.length === 0 ? '' : ` ${plan.noteList.join(' ')}`;
      if (nextState === undefined) {
        return {
          ok: true,
          summary: `Home Assistant aceptó el pedido, pero no pude leer cómo quedó ${entityId}.${noteText}`,
        };
      }
      if (!plan.expectation(nextState)) {
        return {
          ok: true,
          summary: `Home Assistant aceptó el pedido; por ahora muestra: ${describeHomeEntityState(nextState)}. Puede tardar unos segundos.${noteText}`,
        };
      }
      return { ok: true, summary: `Hecho. Ahora: ${describeHomeEntityState(nextState)}.${noteText}` };
    },
  };
}
