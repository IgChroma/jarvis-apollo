import Anthropic from '@anthropic-ai/sdk';
import type { BetaContentBlockParam } from '@anthropic-ai/sdk/resources/beta/messages';

import { createClaudeSpendGuard, type ClaudeBudgetStatus, type ClaudeSpendGuard } from '@/claude/budget';
import {
  buildClaudeRequestParts,
  buildClaudeToolList,
  streamClaudeRound,
  type ClaudeStreamFunction,
} from '@/claude/chat';
import {
  resolveClaudeConfiguration,
  type ClaudeConfiguration,
  type ClaudeEffort,
  type ClaudeTier,
} from '@/claude/config';
import { selectClaudeTier, type ClaudeTierReason } from '@/claude/tier';
import { reportApiCost } from '@/costs/ledger';
import type { MemorySqlExecutor } from '@/memory/store';
import type { VoiceAdapters } from '@/turn/run';

// Claude como proveedor del LLM de conversación, con OpenRouter de red.
//
// Por turno (una instancia de `createTurnLlm` por turno):
// 1. En la primera ronda se decide UNA vez: nivel (claude/tier.ts) y si el
//    presupuesto deja usar Claude (claude/budget.ts). No se cambia de modelo a
//    mitad de turno: el razonamiento de una ronda solo lo lee el mismo modelo.
// 2. Cada ronda va por streaming a Anthropic. Si algo sale mal (red, 5xx, 429,
//    rechazo sin fallback, corte por max_tokens sin texto), esa ronda y las que
//    quedan del turno van por OpenRouter, igual que antes de Claude.
// 3. El costo de cada llamada se calcula con `usage` y se anota en api_costs
//    (componente llm_claude), que es lo que suma el guardián.

type LlmAdapter = VoiceAdapters['llm'];
type LlmAdapterInput = Parameters<LlmAdapter>[0];

// Techo de tokens por nivel. El razonamiento cuenta dentro de max_tokens aunque
// no se devuelva: el techo tiene que dejarle lugar además de a la respuesta, que
// en voz son una o dos oraciones.
const MAX_TOKENS_BY_TIER: Readonly<Record<ClaudeTier, number>> = {
  fast: 4096,
  reasoning: 8192,
  hard: 16000,
};

// Sin reintentos del SDK: en voz, reintentar un 429 o un 5xx con espera es
// peor que contestar por OpenRouter, que es el reintento de verdad.
const CLAUDE_CLIENT_MAX_RETRIES = 0;
const CLAUDE_CLIENT_TIMEOUT_MILLISECONDS = 60_000;
export const CLAUDE_SPEND_LOG_INTERVAL_MILLISECONDS = 60 * 60 * 1000;

type ProviderLabel = ClaudeTier | 'openrouter';

type TurnDecision =
  | {
      readonly provider: 'claude';
      readonly tier: ClaudeTier;
      readonly model: string;
      readonly effort: ClaudeEffort;
      readonly reason: ClaudeTierReason;
    }
  | { readonly provider: 'openrouter'; readonly reason: string };

export type ClaudeProvider = {
  readonly configuration: ClaudeConfiguration;
  readonly guard: ClaudeSpendGuard;
  readonly createTurnLlm: (openRouterLlm: LlmAdapter) => LlmAdapter;
  readonly logSpend: (usingLabel: string) => void;
};

type LogFunction = (payload: Record<string, unknown>) => void;

const defaultLog: LogFunction = (payload) => {
  console.log(JSON.stringify(payload));
};

// Los 400 de Anthropic dicen qué campo del pedido rechazaron ("messages.3.content:
// …", "tools.12.input_schema: …"): sin eso un 400 no se puede arreglar. Se guarda
// solo ese texto, recortado, y sin lo que venga entre comillas (puede citar un
// pedazo del pedido, es decir, de la conversación).
const MAX_API_ERROR_DETAIL_LENGTH = 300;

function describeApiErrorDetail(error: InstanceType<typeof Anthropic.APIError>): string | undefined {
  const body = error.error as { error?: { message?: unknown; type?: unknown } } | undefined;
  const message = typeof body?.error?.message === 'string' ? body.error.message : undefined;
  if (message === undefined) {
    return undefined;
  }
  return message
    .replace(/"[^"]*"/g, '"…"')
    .replace(/'[^']*'/g, "'…'")
    .slice(0, MAX_API_ERROR_DETAIL_LENGTH);
}

function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Anthropic.APIError) {
    const detail = describeApiErrorDetail(error);
    return {
      error: error.constructor.name,
      status: error.status ?? null,
      ...(detail !== undefined ? { detalle: detail } : {}),
    };
  }
  return { error: error instanceof Error ? error.name : 'desconocido' };
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function describeBudget(status: ClaudeBudgetStatus): Record<string, unknown> {
  return {
    gastadoUsd: Math.round(status.spentUsd * 10_000) / 10_000,
    presupuestoUsd: status.budgetUsd,
    limiteUsd: status.limitUsd,
    periodoDesde: new Date(status.cycle.startMilliseconds).toISOString(),
    periodoHasta: new Date(status.cycle.endMilliseconds).toISOString(),
  };
}

function findLastUserText(messageList: LlmAdapterInput['messageList']): string {
  for (let index = messageList.length - 1; index >= 0; index -= 1) {
    const message = messageList[index];
    if (message.role === 'user') {
      return message.content;
    }
  }
  return '';
}

export function createClaudeProvider(dependencies: {
  readonly configuration: ClaudeConfiguration;
  readonly sqlExecutor: MemorySqlExecutor;
  readonly stream: ClaudeStreamFunction;
  readonly now?: () => number;
  readonly log?: LogFunction;
}): ClaudeProvider {
  const { configuration } = dependencies;
  const now = dependencies.now ?? Date.now;
  const log = dependencies.log ?? defaultLog;
  const guard = createClaudeSpendGuard({
    sqlExecutor: dependencies.sqlExecutor,
    budgetUsd: configuration.budgetUsd,
    cycleDay: configuration.budgetCycleDay,
    minRemainingPercent: configuration.minRemainingPercent,
    timeZone: configuration.budgetTimeZone,
  });
  let lastSpendLogAt: number | undefined;
  let lastLabel: ProviderLabel | undefined;

  function logSpend(usingLabel: string, status: ClaudeBudgetStatus = guard.status(now())): void {
    lastSpendLogAt = now();
    log({
      level: 'info',
      message: 'apollo_claude_gasto',
      usando: usingLabel,
      ...describeBudget(status),
    });
  }

  function decide(input: LlmAdapterInput): TurnDecision {
    const status = guard.status(now());
    const choice = selectClaudeTier({
      userText: input.userText ?? findLastUserText(input.messageList),
      reasoning: input.routeReasoning,
      hardReasoningThreshold: configuration.hardReasoningThreshold,
      hardPhraseList: configuration.hardPhraseList,
    });
    const decision: TurnDecision = status.allowed
      ? {
          provider: 'claude',
          tier: choice.tier,
          model: configuration.modelByTier[choice.tier],
          effort: configuration.effortByTier[choice.tier],
          reason: choice.reason,
        }
      : { provider: 'openrouter', reason: 'presupuesto_agotado' };
    const label: ProviderLabel = decision.provider === 'claude' ? decision.tier : 'openrouter';
    if (
      label !== lastLabel ||
      lastSpendLogAt === undefined ||
      now() - lastSpendLogAt >= CLAUDE_SPEND_LOG_INTERVAL_MILLISECONDS
    ) {
      logSpend(label, status);
    }
    lastLabel = label;
    log({
      level: 'info',
      message: 'apollo_claude_nivel',
      proveedor: decision.provider,
      ...(decision.provider === 'claude'
        ? { nivel: decision.tier, modelo: decision.model, esfuerzo: decision.effort }
        : {}),
      motivo: decision.reason,
      // El nivel que habría tocado, aunque el presupuesto lo mande a OpenRouter.
      nivelElegido: choice.tier,
      motivoNivel: choice.reason,
    });
    return decision;
  }

  function createTurnLlm(openRouterLlm: LlmAdapter): LlmAdapter {
    let decision: TurnDecision | undefined;
    const assistantContentByToolCallId = new Map<string, readonly BetaContentBlockParam[]>();

    return async (input) => {
      decision ??= decide(input);
      if (decision.provider === 'openrouter') {
        return openRouterLlm(input);
      }
      const current = decision;
      const startedAt = now();
      try {
        const round = await streamClaudeRound({
          stream: dependencies.stream,
          model: current.model,
          effort: current.effort,
          maxTokens: MAX_TOKENS_BY_TIER[current.tier],
          requestParts: buildClaudeRequestParts({
            messageList: input.messageList,
            cacheableSystemPrefix: input.systemPromptCacheablePrefix,
            assistantContentByToolCallId,
          }),
          toolList: buildClaudeToolList(input.toolDefinitionList),
          // forced tool_choice es un 400 en Opus 5.5 y Sonnet 5.5: cuando el
          // turno pide 'required' (turn/claims.ts) la nota de sistema que va
          // en la conversación ya le dice qué herramienta llamar.
          onTextDelta: input.onTextDelta,
        });
        const usage = round.message.usage;
        // Se anota siempre, sirva o no la ronda: se cobra igual.
        reportApiCost({
          component: 'llm_claude',
          model: round.message.model,
          costUsd: round.costUsd,
          inputTokens:
            usage.input_tokens +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0),
          outputTokens: usage.output_tokens,
        });
        guard.record(round.costUsd, now());
        log({
          level: round.failure === undefined ? 'info' : 'warn',
          message: 'apollo_claude_ronda',
          nivel: current.tier,
          modelo: round.message.model,
          stopReason: round.message.stop_reason,
          ...(round.message.stop_details?.category
            ? { categoriaRechazo: round.message.stop_details.category }
            : {}),
          fallbackServidor: round.servedByFallback,
          costoUsd: roundUsd(round.costUsd),
          tokensEntrada: usage.input_tokens,
          tokensCacheEscritos: usage.cache_creation_input_tokens ?? 0,
          tokensCacheLeidos: usage.cache_read_input_tokens ?? 0,
          tokensSalida: usage.output_tokens,
          ms: now() - startedAt,
        });
        if (round.failure !== undefined) {
          throw new ClaudeUnusableRoundError(round.failure);
        }
        // Las respuestas que pasaron por el fallback del servidor se rearman
        // desde texto + tool_use en la ronda siguiente (sin su razonamiento):
        // reenviar ese contenido tiene reglas propias que no hacen falta acá.
        if (!round.servedByFallback) {
          for (const toolCall of round.toolCallList) {
            assistantContentByToolCallId.set(toolCall.id, round.message.content);
          }
        }
        return { text: round.text, toolCallList: round.toolCallList };
      } catch (error) {
        log({
          level: 'warn',
          message: 'apollo_claude_fallback_openrouter',
          nivel: current.tier,
          modelo: current.model,
          ms: now() - startedAt,
          ...(error instanceof ClaudeUnusableRoundError
            ? { motivo: error.failure }
            : { motivo: 'error_api', ...describeError(error) }),
        });
        // El resto del turno, por OpenRouter: no se vuelve a Claude a mitad.
        decision = { provider: 'openrouter', reason: 'fallo_claude' };
        // Lo que Claude ya había escrito en vivo se descarta antes de que
        // OpenRouter empiece a escribir lo suyo.
        input.onStreamReset?.();
        return openRouterLlm(input);
      }
    };
  }

  return {
    configuration,
    guard,
    createTurnLlm,
    logSpend: (usingLabel) => logSpend(usingLabel),
  };
}

export class ClaudeUnusableRoundError extends Error {
  readonly failure: string;

  constructor(failure: string) {
    super(`ronda de Claude inservible: ${failure}`);
    this.name = 'ClaudeUnusableRoundError';
    this.failure = failure;
  }
}

export function createAnthropicStreamFunction(apiKey: string): ClaudeStreamFunction {
  const client = new Anthropic({
    apiKey,
    maxRetries: CLAUDE_CLIENT_MAX_RETRIES,
    timeout: CLAUDE_CLIENT_TIMEOUT_MILLISECONDS,
  });
  return (params) => {
    const stream = client.beta.messages.stream(params);
    return {
      onText: (listener) => {
        stream.on('text', (deltaText) => listener(deltaText));
      },
      finalMessage: () => stream.finalMessage(),
    };
  };
}

// Un proveedor por base (como el router): el guardián guarda en memoria la suma
// del período. null = Claude apagado (sin key o CLAUDE_ENABLED=off).
const claudeProviderBySqlExecutor = new WeakMap<MemorySqlExecutor, ClaudeProvider | null>();

export function resolveClaudeProvider(
  sqlExecutor: MemorySqlExecutor,
  environment: Record<string, string | undefined> = readProcessEnvironment(),
): ClaudeProvider | undefined {
  const existing = claudeProviderBySqlExecutor.get(sqlExecutor);
  if (existing !== undefined) {
    return existing ?? undefined;
  }
  const configuration = resolveClaudeConfiguration(environment);
  if (!configuration.enabled || configuration.apiKey === undefined) {
    claudeProviderBySqlExecutor.set(sqlExecutor, null);
    console.log(
      JSON.stringify({
        level: 'info',
        message: 'apollo_claude_configuracion',
        habilitado: false,
        motivo: configuration.disabledReason,
      }),
    );
    return undefined;
  }
  try {
    const provider = createClaudeProvider({
      configuration,
      sqlExecutor,
      stream: createAnthropicStreamFunction(configuration.apiKey),
    });
    claudeProviderBySqlExecutor.set(sqlExecutor, provider);
    console.log(
      JSON.stringify({
        level: 'info',
        message: 'apollo_claude_configuracion',
        habilitado: true,
        modelos: configuration.modelByTier,
        esfuerzos: configuration.effortByTier,
        presupuestoUsd: configuration.budgetUsd,
        diaDeCorte: configuration.budgetCycleDay,
        margenPorcentaje: configuration.minRemainingPercent,
        zonaHoraria: configuration.budgetTimeZone,
        umbralOpus: configuration.hardReasoningThreshold,
      }),
    );
    return provider;
  } catch (error) {
    claudeProviderBySqlExecutor.set(sqlExecutor, null);
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'apollo_claude_no_arranco',
        ...describeError(error),
      }),
    );
    return undefined;
  }
}

function readProcessEnvironment(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}
