import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaMessage,
  BetaMessageStreamParams,
} from '@anthropic-ai/sdk/resources/beta/messages';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';

import { buildClaudeRequestParts, type ClaudeStreamFunction } from '@/claude/chat';
import { resolveClaudeConfiguration } from '@/claude/config';
import { createClaudeProvider } from '@/claude/provider';
import {
  createSqliteApiCostSink,
  setApiCostSink,
  type ApiCostEntry,
} from '@/costs/ledger';
import { createBunSqliteExecutor } from '@/platform/bun/sql';
import type { RouterReasoningDecision } from '@/router/log';
import type { VoiceAdapters } from '@/turn/run';
import type { OpenRouterChatMessage } from '@/voice/llm';

afterEach(() => setApiCostSink(undefined));

type LlmInput = Parameters<VoiceAdapters['llm']>[0];

const NOW = Date.parse('2026-10-18T15:00:00Z');
const STABLE_PREFIX = 'Sos Jarvis. Herramientas instaladas: ninguna.';

function makeMessage(
  overrides: Omit<Partial<BetaMessage>, 'usage'> & { usage?: Partial<BetaMessage['usage']> },
): BetaMessage {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: [{ type: 'text', text: 'Hola.', citations: null }],
    stop_reason: 'end_turn',
    stop_details: null,
    stop_sequence: null,
    container: null,
    context_management: null,
    diagnostics: null,
    ...overrides,
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      iterations: null,
      ...overrides.usage,
    },
  } as unknown as BetaMessage;
}

type ScriptStep = { readonly deltas?: readonly string[]; readonly message?: BetaMessage; readonly error?: Error };

function createMockStream(script: ScriptStep[]) {
  const paramsList: BetaMessageStreamParams[] = [];
  const stream: ClaudeStreamFunction = (params) => {
    paramsList.push(structuredClone(params));
    const step = script.shift() ?? { message: makeMessage({}) };
    const listenerList: ((delta: string) => void)[] = [];
    return {
      onText: (listener) => {
        listenerList.push(listener);
      },
      finalMessage: async () => {
        for (const delta of step.deltas ?? []) {
          for (const listener of listenerList) listener(delta);
        }
        if (step.error !== undefined) throw step.error;
        return step.message ?? makeMessage({});
      },
    };
  };
  return { stream, paramsList };
}

function createHarness(input: {
  readonly script: ScriptStep[];
  readonly environment?: Record<string, string>;
  readonly spentUsd?: number;
}) {
  const executor = createBunSqliteExecutor(new Database(':memory:'));
  let clock = NOW;
  const costEntryList: ApiCostEntry[] = [];
  const sqliteSink = createSqliteApiCostSink(executor, () => clock);
  setApiCostSink((entry) => {
    costEntryList.push(entry);
    sqliteSink(entry);
  });
  if (input.spentUsd !== undefined) {
    sqliteSink({ component: 'llm_claude', model: 'claude-haiku-5-5', costUsd: input.spentUsd });
  }
  const { stream, paramsList } = createMockStream(input.script);
  const logList: Record<string, unknown>[] = [];
  const provider = createClaudeProvider({
    configuration: resolveClaudeConfiguration({ ANTHROPIC_API_KEY: 'k', ...input.environment }),
    sqlExecutor: executor,
    stream,
    now: () => clock,
    log: (payload) => logList.push(payload),
  });
  const openRouterCallList: LlmInput[] = [];
  const openRouterLlm: VoiceAdapters['llm'] = async (llmInput) => {
    openRouterCallList.push(llmInput);
    llmInput.onTextDelta?.('Por OpenRouter.');
    return { text: 'Por OpenRouter.', toolCallList: [] };
  };
  return {
    provider,
    paramsList,
    costEntryList,
    logList,
    openRouterCallList,
    openRouterLlm,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
  };
}

const baseMessageList: OpenRouterChatMessage[] = [
  { role: 'system', content: `${STABLE_PREFIX}\n\nHora actual: 12:00.` },
  { role: 'user', content: '¿Qué tal?' },
];

function llmInput(overrides: Partial<LlmInput> = {}): LlmInput {
  return {
    messageList: baseMessageList,
    toolDefinitionList: [
      {
        name: 'set_reminder',
        description: 'Programa un recordatorio.',
        parameters: { type: 'object', properties: { message: { type: 'string' } } },
      },
    ],
    systemPromptCacheablePrefix: STABLE_PREFIX,
    userText: '¿Qué tal?',
    ...overrides,
  };
}

const reasoningOn: RouterReasoningDecision = { probability: 0.6, policy: true, enabled: true, explored: false };

describe('Claude provider', () => {
  it('answers a fast turn with Haiku, streaming and recording its cost', async () => {
    const harness = createHarness({
      script: [{ deltas: ['Ho', 'la.'], message: makeMessage({ usage: { input_tokens: 1_000, output_tokens: 20 } }) }],
    });
    const deltaList: string[] = [];
    const result = await harness.provider.createTurnLlm(harness.openRouterLlm)(
      llmInput({ onTextDelta: (delta) => deltaList.push(delta), toolChoice: 'required' }),
    );

    expect(result).toEqual({ text: 'Hola.', toolCallList: [] });
    expect(deltaList).toEqual(['Ho', 'la.']);
    expect(harness.openRouterCallList).toHaveLength(0);

    const params = harness.paramsList[0];
    expect(params.model).toBe('claude-haiku-5-5');
    expect(params.output_config).toEqual({ effort: 'low' });
    expect(params.thinking).toEqual({ type: 'adaptive' });
    expect(params.cache_control).toEqual({ type: 'ephemeral' });
    // Haiku 5.5 no tiene fallback del servidor; el tool_choice forzado no se manda.
    expect(params.fallbacks).toBeUndefined();
    expect(params.betas).toBeUndefined();
    expect(params.tool_choice).toBeUndefined();
    // Lo estable con punto de caché, lo volátil después y sin él.
    expect(params.system).toEqual([
      { type: 'text', text: STABLE_PREFIX, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '\n\nHora actual: 12:00.' },
    ]);
    expect(params.tools?.[0]).toMatchObject({ name: 'set_reminder', eager_input_streaming: true });

    expect(harness.costEntryList).toHaveLength(1);
    expect(harness.costEntryList[0]).toMatchObject({
      component: 'llm_claude',
      model: 'claude-haiku-5-5',
      inputTokens: 1_000,
      outputTokens: 20,
    });
    expect(harness.costEntryList[0].costUsd).toBeCloseTo((1_000 * 0.1 + 20 * 0.5) / 1e6, 12);
    expect(harness.logList.find((entry) => entry.message === 'apollo_claude_nivel')).toMatchObject({
      proveedor: 'claude',
      nivel: 'fast',
      modelo: 'claude-haiku-5-5',
      motivo: 'default',
    });
  });

  it('uses Sonnet with server-side fallback when the router asks to reason', async () => {
    const harness = createHarness({ script: [{ message: makeMessage({ model: 'claude-sonnet-5-5' }) }] });
    await harness.provider.createTurnLlm(harness.openRouterLlm)(llmInput({ routeReasoning: reasoningOn }));
    const params = harness.paramsList[0];
    expect(params.model).toBe('claude-sonnet-5-5');
    expect(params.output_config).toEqual({ effort: 'low' });
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(params.fallbacks).toBe('default');
  });

  it('uses Opus at medium effort when the user asks to think hard', async () => {
    const harness = createHarness({ script: [{ message: makeMessage({ model: 'claude-opus-5-5' }) }] });
    await harness.provider.createTurnLlm(harness.openRouterLlm)(
      llmInput({ userText: 'Pensalo bien: ¿me conviene alquilar o comprar?' }),
    );
    expect(harness.paramsList[0].model).toBe('claude-opus-5-5');
    expect(harness.paramsList[0].output_config).toEqual({ effort: 'medium' });
    expect(harness.paramsList[0].fallbacks).toBe('default');
  });

  it('falls back to OpenRouter for the rest of the turn when Haiku refuses', async () => {
    const harness = createHarness({
      script: [
        {
          deltas: ['Mirá, '],
          message: makeMessage({
            stop_reason: 'refusal',
            stop_details: { type: 'refusal', category: 'cyber', explanation: null } as BetaMessage['stop_details'],
          }),
        },
      ],
    });
    let resetCount = 0;
    const llm = harness.provider.createTurnLlm(harness.openRouterLlm);
    const result = await llm(llmInput({ onStreamReset: () => (resetCount += 1) }));

    expect(result.text).toBe('Por OpenRouter.');
    expect(resetCount).toBe(1);
    expect(harness.openRouterCallList).toHaveLength(1);
    // Se cobró igual: queda anotado.
    expect(harness.costEntryList).toHaveLength(1);
    expect(harness.logList.find((entry) => entry.message === 'apollo_claude_fallback_openrouter')).toMatchObject({
      motivo: 'refusal',
    });

    // La ronda siguiente del mismo turno ya no prueba Claude.
    await llm(llmInput());
    expect(harness.paramsList).toHaveLength(1);
    expect(harness.openRouterCallList).toHaveLength(2);
  });

  it('falls back to OpenRouter on an API or network error', async () => {
    for (const error of [
      new Anthropic.APIConnectionError({ message: 'sin red' }),
      new Anthropic.InternalServerError(529, undefined, 'overloaded', new Headers()),
      new Anthropic.RateLimitError(429, undefined, 'rate limited', new Headers()),
    ]) {
      const harness = createHarness({ script: [{ error }] });
      const result = await harness.provider.createTurnLlm(harness.openRouterLlm)(llmInput());
      expect(result.text).toBe('Por OpenRouter.');
      expect(harness.costEntryList).toHaveLength(0);
      const log = harness.logList.find((entry) => entry.message === 'apollo_claude_fallback_openrouter');
      expect(log).toMatchObject({ motivo: 'error_api', error: error.constructor.name });
    }
  });

  it('falls back when the reply is cut by max_tokens with no text or inside a tool call', async () => {
    const harness = createHarness({
      script: [
        {
          message: makeMessage({
            stop_reason: 'max_tokens',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'set_reminder', input: { message: 'pa' } }] as BetaMessage['content'],
          }),
        },
      ],
    });
    const result = await harness.provider.createTurnLlm(harness.openRouterLlm)(llmInput());
    expect(result.text).toBe('Por OpenRouter.');
    expect(result.toolCallList).toEqual([]);
  });

  it('uses OpenRouter without calling Claude once the cycle budget is spent', async () => {
    const harness = createHarness({ script: [], spentUsd: 50 });
    const result = await harness.provider.createTurnLlm(harness.openRouterLlm)(llmInput());
    expect(result.text).toBe('Por OpenRouter.');
    expect(harness.paramsList).toHaveLength(0);
    expect(harness.logList.find((entry) => entry.message === 'apollo_claude_nivel')).toMatchObject({
      proveedor: 'openrouter',
      motivo: 'presupuesto_agotado',
    });
    expect(harness.logList.find((entry) => entry.message === 'apollo_claude_gasto')).toMatchObject({
      usando: 'openrouter',
      gastadoUsd: 50,
      presupuestoUsd: 50,
    });
  });

  it('lets a turn that starts under the limit finish on Claude and switches on the next turn', async () => {
    const expensive = makeMessage({
      model: 'claude-opus-5-5',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'set_reminder', input: { message: 'x' } }] as BetaMessage['content'],
      stop_reason: 'tool_use',
      usage: { input_tokens: 0, output_tokens: 1_000_000 }, // USD 20
    });
    const harness = createHarness({
      script: [{ message: expensive }, { message: makeMessage({ model: 'claude-opus-5-5' }) }],
      spentUsd: 49.99,
    });
    const llm = harness.provider.createTurnLlm(harness.openRouterLlm);
    const firstRound = await llm(llmInput({ userText: 'pensalo bien' }));
    expect(firstRound.toolCallList).toHaveLength(1);
    // Ya se pasó del presupuesto, pero el turno sigue en Claude.
    expect(harness.provider.guard.status(NOW).allowed).toBe(false);
    await llm(llmInput({ userText: 'pensalo bien' }));
    expect(harness.paramsList.map((params) => params.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5']);
    expect(harness.openRouterCallList).toHaveLength(0);

    // El turno siguiente va por OpenRouter.
    await harness.provider.createTurnLlm(harness.openRouterLlm)(llmInput());
    expect(harness.paramsList).toHaveLength(2);
    expect(harness.openRouterCallList).toHaveLength(1);
  });

  it('sends Claude its own previous content (thinking included) in the next tool round', async () => {
    const toolRound = makeMessage({
      stop_reason: 'tool_use',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'tool_use', id: 'toolu_9', name: 'set_reminder', input: { message: 'pan' } },
      ] as BetaMessage['content'],
    });
    const harness = createHarness({ script: [{ message: toolRound }, { message: makeMessage({}) }] });
    const llm = harness.provider.createTurnLlm(harness.openRouterLlm);
    const first = await llm(llmInput());
    expect(first.toolCallList).toEqual([{ id: 'toolu_9', name: 'set_reminder', args: { message: 'pan' } }]);

    const secondMessageList: OpenRouterChatMessage[] = [
      ...baseMessageList,
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'toolu_9', type: 'function', function: { name: 'set_reminder', arguments: '{"message":"pan"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_9', content: '{"ok":true,"summary":"Listo"}' },
    ];
    await llm(llmInput({ messageList: secondMessageList }));
    const messages = harness.paramsList[1].messages;
    expect(messages[1]).toEqual({ role: 'assistant', content: toolRound.content });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: '{"ok":true,"summary":"Listo"}' }],
    });
  });

  it('logs the cycle spend on tier changes and at most hourly otherwise', async () => {
    const harness = createHarness({ script: [] });
    const spendLogCount = () => harness.logList.filter((entry) => entry.message === 'apollo_claude_gasto').length;
    await harness.provider.createTurnLlm(harness.openRouterLlm)(llmInput());
    await harness.provider.createTurnLlm(harness.openRouterLlm)(llmInput());
    expect(spendLogCount()).toBe(1);
    await harness.provider.createTurnLlm(harness.openRouterLlm)(llmInput({ routeReasoning: reasoningOn }));
    expect(spendLogCount()).toBe(2);
    await harness.provider.createTurnLlm(harness.openRouterLlm)(llmInput({ routeReasoning: reasoningOn }));
    expect(spendLogCount()).toBe(2);
    harness.advance(60 * 60 * 1000);
    await harness.provider.createTurnLlm(harness.openRouterLlm)(llmInput({ routeReasoning: reasoningOn }));
    expect(spendLogCount()).toBe(3);
  });

  it('never logs the prompt or the key', async () => {
    const harness = createHarness({ script: [{ message: makeMessage({}) }] });
    await harness.provider.createTurnLlm(harness.openRouterLlm)(llmInput());
    const serialized = JSON.stringify(harness.logList);
    expect(serialized).not.toContain('Qué tal');
    expect(serialized).not.toContain(STABLE_PREFIX);
  });
});

describe('Claude request conversion', () => {
  it('turns a mid-turn system note after an assistant reply into a user turn', () => {
    const parts = buildClaudeRequestParts({
      messageList: [
        { role: 'system', content: 'Sos Jarvis.' },
        { role: 'assistant', content: 'turno viejo sin pregunta' },
        { role: 'user', content: 'recordame comprar pan' },
        { role: 'assistant', content: 'Listo, te aviso.' },
        { role: 'system', content: 'Atención: llamá a set_reminder.' },
      ],
    });
    // Sin prefijo estable conocido, el system va sin punto de caché.
    expect(parts.system).toEqual([{ type: 'text', text: 'Sos Jarvis.' }]);
    expect(parts.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'recordame comprar pan' }] },
      { role: 'assistant', content: 'Listo, te aviso.' },
      { role: 'user', content: [{ type: 'text', text: 'Atención: llamá a set_reminder.' }] },
    ]);
  });

  it('groups parallel tool results in one user message and rebuilds tool calls it did not produce', () => {
    const parts = buildClaudeRequestParts({
      messageList: [
        { role: 'system', content: 'S' },
        { role: 'user', content: '¿clima y dólar?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'router-clima', type: 'function', function: { name: 'clima', arguments: '{}' } },
            { id: 'router-dolar', type: 'function', function: { name: 'dolar', arguments: '' } },
          ],
        },
        { role: 'tool', tool_call_id: 'router-clima', content: '{"ok":true}' },
        { role: 'tool', tool_call_id: 'router-dolar', content: '{"ok":true}' },
      ],
    });
    expect(parts.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'router-clima', name: 'clima', input: {} },
        { type: 'tool_use', id: 'router-dolar', name: 'dolar', input: {} },
      ],
    });
    expect(parts.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'router-clima', content: '{"ok":true}' },
        { type: 'tool_result', tool_use_id: 'router-dolar', content: '{"ok":true}' },
      ],
    });
  });
});
