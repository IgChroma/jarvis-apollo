import { APOLLO_TIME_ZONE } from '@/configuration/identity';

// Claude (API de Anthropic) como proveedor opcional del LLM de conversación.
//
// Prendido por defecto cuando hay ANTHROPIC_API_KEY; sin key, o con
// CLAUDE_ENABLED=off, todo sigue por OpenRouter como siempre. STT, embeddings y
// el router Jev siguen en OpenRouter pase lo que pase.
//
// Tres niveles por turno (ver claude/tier.ts):
// - fast       Haiku: el default de la charla.
// - reasoning  Sonnet: cuando Jev dice que hay que razonar.
// - hard       Opus: cuando Jev está muy seguro de que es difícil, o le pedís
//              que lo piense bien.

export type ClaudeTier = 'fast' | 'reasoning' | 'hard';

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ClaudeConfiguration = {
  readonly enabled: boolean;
  // Por qué quedó apagado (para el log de arranque); undefined si está prendido.
  readonly disabledReason: 'sin_key' | 'apagado' | undefined;
  readonly apiKey: string | undefined;
  readonly modelByTier: Readonly<Record<ClaudeTier, string>>;
  readonly effortByTier: Readonly<Record<ClaudeTier, ClaudeEffort>>;
  readonly budgetUsd: number;
  readonly budgetCycleDay: number;
  readonly minRemainingPercent: number;
  readonly budgetTimeZone: string;
  // Probabilidad de "requiere razonar" de Jev a partir de la cual el turno va a
  // Opus en vez de Sonnet.
  readonly hardReasoningThreshold: number;
  readonly hardPhraseList: readonly string[];
};

export const DEFAULT_CLAUDE_MODEL_BY_TIER: Readonly<Record<ClaudeTier, string>> = {
  fast: 'claude-haiku-5-5',
  reasoning: 'claude-sonnet-5-5',
  hard: 'claude-opus-5-5',
};

// Esfuerzo (output_config.effort) por nivel. Es la única perilla de cuánto
// piensa el modelo, y por lo tanto de latencia y costo:
// - fast/reasoning en `low`: es voz, la primera palabra tiene que salir rápido.
//   En `low` Haiku y Sonnet se saltean el razonamiento en lo simple y lo
//   acortan en lo demás (en `medium` Sonnet piensa antes de casi toda respuesta).
// - hard en `medium`: en Opus 5.5 el razonamiento no se puede apagar y `medium`
//   es su default. Llegar a este nivel ya significa "esto es difícil", así que
//   `low` le sacaría justo lo que se le pide; `high` alarga el turno y duplica
//   los tokens de salida para una respuesta que se dice en voz alta en dos
//   oraciones. Se puede subir con CLAUDE_EFFORT_HARD si hace falta.
export const DEFAULT_CLAUDE_EFFORT_BY_TIER: Readonly<Record<ClaudeTier, ClaudeEffort>> = {
  fast: 'low',
  reasoning: 'low',
  hard: 'medium',
};

export const DEFAULT_CLAUDE_BUDGET_USD = 50;
export const DEFAULT_CLAUDE_BUDGET_CYCLE_DAY = 12;
// 0 = se usa Claude hasta gastar el presupuesto entero del período. Subilo (por
// ejemplo a 10) si querés dejar un margen sin tocar.
export const DEFAULT_CLAUDE_MIN_REMAINING_PERCENT = 0;
export const DEFAULT_CLAUDE_HARD_REASONING_THRESHOLD = 0.9;

// Frases con las que el usuario pide explícitamente que lo piense a fondo. Lista
// corta a propósito: cada frase manda el turno a Opus. Se compara sin tildes ni
// mayúsculas (ver normalizeForPhraseMatch).
export const DEFAULT_CLAUDE_HARD_PHRASE_LIST: readonly string[] = [
  'pensalo bien',
  'pensá bien',
  'pensalo a fondo',
  'pensá a fondo',
  'razonalo bien',
  'pregunta difícil',
];

const EFFORT_LIST: readonly ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function readText(environment: Record<string, string | undefined>, name: string): string | undefined {
  const value = environment[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function readNumber(
  environment: Record<string, string | undefined>,
  name: string,
  fallback: number,
  isValid: (value: number) => boolean,
): number {
  const text = readText(environment, name);
  if (text === undefined) {
    return fallback;
  }
  const value = Number(text);
  return Number.isFinite(value) && isValid(value) ? value : fallback;
}

function readEffort(
  environment: Record<string, string | undefined>,
  name: string,
  fallback: ClaudeEffort,
): ClaudeEffort {
  const text = readText(environment, name)?.toLowerCase();
  return EFFORT_LIST.find((effort) => effort === text) ?? fallback;
}

function isSwitchOff(value: string | undefined): boolean {
  return value !== undefined && ['off', 'false', '0', 'no'].includes(value.toLowerCase());
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function resolveClaudeConfiguration(
  environment: Record<string, string | undefined>,
): ClaudeConfiguration {
  const apiKey = readText(environment, 'ANTHROPIC_API_KEY');
  const switchOff = isSwitchOff(readText(environment, 'CLAUDE_ENABLED'));
  const disabledReason = apiKey === undefined ? 'sin_key' : switchOff ? 'apagado' : undefined;
  const phraseText = readText(environment, 'CLAUDE_HARD_PHRASES');
  const phraseList =
    phraseText === undefined
      ? DEFAULT_CLAUDE_HARD_PHRASE_LIST
      : phraseText
          .split(',')
          .map((phrase) => phrase.trim())
          .filter((phrase) => phrase.length > 0);
  const timeZoneText = readText(environment, 'CLAUDE_BUDGET_TIMEZONE');
  return {
    enabled: disabledReason === undefined,
    disabledReason,
    apiKey,
    modelByTier: {
      fast: readText(environment, 'CLAUDE_MODEL_FAST') ?? DEFAULT_CLAUDE_MODEL_BY_TIER.fast,
      reasoning:
        readText(environment, 'CLAUDE_MODEL_REASONING') ?? DEFAULT_CLAUDE_MODEL_BY_TIER.reasoning,
      hard: readText(environment, 'CLAUDE_MODEL_HARD') ?? DEFAULT_CLAUDE_MODEL_BY_TIER.hard,
    },
    effortByTier: {
      fast: readEffort(environment, 'CLAUDE_EFFORT_FAST', DEFAULT_CLAUDE_EFFORT_BY_TIER.fast),
      reasoning: readEffort(
        environment,
        'CLAUDE_EFFORT_REASONING',
        DEFAULT_CLAUDE_EFFORT_BY_TIER.reasoning,
      ),
      hard: readEffort(environment, 'CLAUDE_EFFORT_HARD', DEFAULT_CLAUDE_EFFORT_BY_TIER.hard),
    },
    budgetUsd: readNumber(environment, 'CLAUDE_BUDGET_USD', DEFAULT_CLAUDE_BUDGET_USD, (value) => value >= 0),
    budgetCycleDay: Math.trunc(
      readNumber(
        environment,
        'CLAUDE_BUDGET_CYCLE_DAY',
        DEFAULT_CLAUDE_BUDGET_CYCLE_DAY,
        (value) => value >= 1 && value <= 31,
      ),
    ),
    minRemainingPercent: readNumber(
      environment,
      'CLAUDE_MIN_REMAINING_PERCENT',
      DEFAULT_CLAUDE_MIN_REMAINING_PERCENT,
      (value) => value >= 0 && value <= 100,
    ),
    budgetTimeZone:
      timeZoneText !== undefined && isValidTimeZone(timeZoneText) ? timeZoneText : APOLLO_TIME_ZONE,
    hardReasoningThreshold: readNumber(
      environment,
      'CLAUDE_HARD_REASONING_THRESHOLD',
      DEFAULT_CLAUDE_HARD_REASONING_THRESHOLD,
      (value) => value >= 0 && value <= 1,
    ),
    hardPhraseList: phraseList,
  };
}
