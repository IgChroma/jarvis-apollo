import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
} from '@anthropic-ai/sdk/resources/beta/messages';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  CLAUDE_TOOL_NAME_PATTERN,
  buildClaudeRequestParts,
  buildClaudeToolList,
  sanitizeClaudeInputSchema,
  streamClaudeRound,
  type ClaudeStreamFunction,
} from '@/claude/chat';
import { resolveClaudeConfiguration } from '@/claude/config';
import { createClaudeProvider } from '@/claude/provider';
import { setApiCostSink } from '@/costs/ledger';
import { createHomeAssistantVoiceControl } from '@/homeassistant/voice';
import { createBunSqliteExecutor } from '@/platform/bun/sql';
import { ROUTER_ESCAPE_TOOL_NAME } from '@/router/intents';
import { setHomeVoiceControl } from '@/tools/casa';
import { listBuiltinToolDefinitionList } from '@/tools/catalog';
import { condenseToolDescription, type LanguageModelToolDescriptor } from '@/turn/run';
import { UNBACKED_CLAIM_NUDGE } from '@/turn/claims';
import type { OpenRouterChatMessage } from '@/voice/llm';

// La forma del pedido a Anthropic para un turno realista, contra las reglas que
// la API hace cumplir con un 400 (skill claude-api, 2026-10). El 2026-10-18 el
// primer pedido a claude-haiku-5-5 volvió 400 y el turno cayó a OpenRouter:
// estas invariantes son lo que se puede asegurar sin red.

afterEach(() => {
  setHomeVoiceControl(undefined);
  setApiCostSink(undefined);
});

const STABLE_PREFIX =
  'Sos Jarvis, un asistente personal. Hablás español rioplatense.\nCasa: luces y losas con casa_controlar.';
const VOLATILE_NOTE = '\n\nFocus inactivo.\nAhora: domingo 19 de octubre, 10:42.';

const EFFORT_SET = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function registerFakeHome(): void {
  setHomeVoiceControl(
    createHomeAssistantVoiceControl({
      client: {
        connection: { apiBaseUrl: 'http://ha/api', token: 't', source: 'ha_url' },
        listLabelEntityIds: async () => [],
        listStates: async () => [],
        listCalendarEvents: async () => [],
        getDailyForecast: async () => [],
        callServiceWithResponse: async () => undefined,
        getState: async () => undefined,
        sendWebSocketCommand: async () => undefined,
        callService: async () => undefined,
      },
    }),
  );
}

// Igual que turn/run.ts arma la lista que ve el modelo.
function buildTurnToolDescriptorList(): LanguageModelToolDescriptor[] {
  registerFakeHome();
  const builtinList = listBuiltinToolDefinitionList().map((tool) => ({
    name: tool.name,
    description: condenseToolDescription(tool.description),
    parameters: tool.parameters,
  }));
  // Un esquema MCP como los publica un servidor de verdad: con $schema y una
  // combinación en la raíz, que la API rechaza.
  const mcpTool: LanguageModelToolDescriptor = {
    name: 'mcp_9386143d_create_event_cd2e3216',
    description: '[Google Calendar] Crea un evento.',
    parameters: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        summary: { type: 'string' },
        start: { anyOf: [{ type: 'string' }, { type: 'object', properties: {} }] },
      },
      anyOf: [{ required: ['summary'] }, { required: ['start'] }],
      required: ['summary'],
      additionalProperties: false,
    },
  };
  return [...builtinList, mcpTool];
}

// Un turno con historia y una ronda de herramientas ya hecha: "poné la losa en
// 25" → casa_controlar → "Listo" sin confirmar → nota del sistema.
function buildTurnMessageList(): OpenRouterChatMessage[] {
  return [
    { role: 'system', content: STABLE_PREFIX + VOLATILE_NOTE },
    { role: 'assistant', content: 'Buen día. ¿Arrancamos?' },
    { role: 'user', content: '¿Qué temperatura hace afuera?' },
    { role: 'assistant', content: 'Hacen 18 grados en Maschwitz.' },
    { role: 'user', content: '   ' },
    { role: 'user', content: 'Poné la temperatura de losa cuarto chicos en 25.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'toolu_01',
          type: 'function',
          function: {
            name: 'casa_controlar',
            arguments: JSON.stringify({ entidad: 'losa cuarto chicos', accion: 'set_temperature', temperatura: 25 }),
          },
        },
        {
          id: 'toolu_02',
          type: 'function',
          function: { name: 'casa_estado', arguments: '' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'toolu_01', content: JSON.stringify({ ok: true, summary: 'Hecho.' }) },
    { role: 'tool', tool_call_id: 'toolu_02', content: JSON.stringify({ ok: false, summary: 'Falta la entidad.' }) },
    { role: 'assistant', content: 'Listo, quedó en 25.' },
    { role: 'system', content: UNBACKED_CLAIM_NUDGE },
  ];
}

function countCacheBreakpoints(params: BetaMessageStreamParams): number {
  let count = params.cache_control === undefined ? 0 : 1;
  const countIn = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(countIn);
      return;
    }
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (record.cache_control !== undefined && record.cache_control !== null) {
        count += 1;
      }
      Object.entries(record)
        .filter(([key]) => key !== 'cache_control')
        .forEach(([, nested]) => countIn(nested));
    }
  };
  countIn(params.system);
  countIn(params.tools);
  countIn(params.messages);
  return count;
}

function blockList(message: BetaMessageParam): BetaContentBlockParam[] {
  return typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : [...message.content];
}

// Las invariantes. Cada una es un 400 conocido si se rompe.
function assertValidClaudeRequest(params: BetaMessageStreamParams): void {
  expect(Number.isInteger(params.max_tokens)).toBe(true);
  expect(params.max_tokens).toBeGreaterThan(0);
  expect(params.max_tokens).toBeLessThanOrEqual(128_000);
  // Haiku 5.5 / Sonnet 5.5 / Opus 5.5: budget_tokens y disabled son 400.
  expect(params.thinking).toEqual({ type: 'adaptive' });
  expect(EFFORT_SET.has(String(params.output_config?.effort))).toBe(true);
  // Muestreo distinto del default: 400 en Haiku 5.5.
  expect('temperature' in params).toBe(false);
  expect('top_p' in params).toBe(false);
  expect('top_k' in params).toBe(false);
  // tool_choice forzado: 400 en Opus/Sonnet 5.5.
  const toolChoiceType = (params.tool_choice as { type?: string } | undefined)?.type;
  expect(toolChoiceType === 'any' || toolChoiceType === 'tool').toBe(false);
  if (params.model === 'claude-haiku-5-5') {
    // Haiku 5.5 no tiene fallback del servidor: una lista de modelos es 400.
    expect('fallbacks' in params).toBe(false);
    expect(params.betas ?? []).toEqual([]);
  }
  expect(countCacheBreakpoints(params)).toBeLessThanOrEqual(4);

  // system: bloques de texto no vacíos.
  for (const block of params.system as { type: string; text: string }[]) {
    expect(block.type).toBe('text');
    expect(block.text.trim().length).toBeGreaterThan(0);
  }

  // tools
  const toolNameSet = new Set<string>();
  for (const tool of params.tools ?? []) {
    const customTool = tool as { name: string; description?: string; input_schema: Record<string, unknown> };
    expect(customTool.name).toMatch(CLAUDE_TOOL_NAME_PATTERN);
    expect(toolNameSet.has(customTool.name)).toBe(false);
    toolNameSet.add(customTool.name);
    if (customTool.description !== undefined) {
      expect(customTool.description.trim().length).toBeGreaterThan(0);
    }
    const schema = customTool.input_schema;
    expect(schema.type).toBe('object');
    for (const key of ['oneOf', 'anyOf', 'allOf', '$schema']) {
      expect(key in schema).toBe(false);
    }
    if (schema.properties !== undefined) {
      expect(typeof schema.properties).toBe('object');
      expect(Array.isArray(schema.properties)).toBe(false);
    }
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  }

  // messages
  const messageList = params.messages;
  expect(messageList.length).toBeGreaterThan(0);
  expect(messageList[0].role).toBe('user');
  // Termina en el usuario: un assistant al final es prefill, 400 en los 5.5.
  expect(messageList.at(-1)?.role).toBe('user');
  const seenToolUseIdSet = new Set<string>();
  messageList.forEach((message, index) => {
    expect(['user', 'assistant']).toContain(message.role);
    if (index > 0) {
      expect(message.role).not.toBe(messageList[index - 1].role);
    }
    const blocks = blockList(message);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      if (block.type === 'text') {
        expect(block.text.trim().length).toBeGreaterThan(0);
      }
    }
    if (message.role !== 'assistant') {
      return;
    }
    const toolUseIdList = blocks.flatMap((block) => (block.type === 'tool_use' ? [block.id] : []));
    for (const toolUseId of toolUseIdList) {
      expect(seenToolUseIdSet.has(toolUseId)).toBe(false);
      seenToolUseIdSet.add(toolUseId);
    }
    if (toolUseIdList.length === 0) {
      return;
    }
    // Cada tool_use tiene su tool_result en el mensaje que sigue, y los
    // resultados van ANTES que cualquier texto.
    const next = messageList[index + 1];
    expect(next?.role).toBe('user');
    const nextBlocks = blockList(next);
    const leadingResultIdList: string[] = [];
    for (const block of nextBlocks) {
      if (block.type !== 'tool_result') {
        break;
      }
      leadingResultIdList.push(block.tool_use_id);
    }
    expect(leadingResultIdList.toSorted()).toEqual(toolUseIdList.toSorted());
    expect(nextBlocks.filter((block) => block.type === 'tool_result')).toHaveLength(toolUseIdList.length);
  });
  // Ningún tool_result sin su tool_use.
  for (const message of messageList) {
    for (const block of blockList(message)) {
      if (block.type === 'tool_result') {
        expect(seenToolUseIdSet.has(block.tool_use_id)).toBe(true);
        expect(String(block.content).length).toBeGreaterThan(0);
      }
    }
  }
}

function makeMessage(content: BetaMessage['content'], stopReason: BetaMessage['stop_reason'] = 'end_turn'): BetaMessage {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content,
    stop_reason: stopReason,
    stop_details: null,
    stop_sequence: null,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      iterations: null,
    },
  } as unknown as BetaMessage;
}

function createCapturingStream(responseList: BetaMessage[] = []) {
  const paramsList: BetaMessageStreamParams[] = [];
  const stream: ClaudeStreamFunction = (params) => {
    paramsList.push(structuredClone(params));
    const message = responseList.shift() ?? makeMessage([{ type: 'text', text: 'Listo.', citations: null }] as BetaMessage['content']);
    return { onText: () => undefined, finalMessage: async () => message };
  };
  return { stream, paramsList };
}

describe('pedido a Claude de un turno realista', () => {
  it('cumple las reglas de la API con 37 herramientas, historia y una ronda de herramientas', async () => {
    const toolDescriptorList = buildTurnToolDescriptorList();
    expect(toolDescriptorList.length).toBeGreaterThanOrEqual(38);
    const { stream, paramsList } = createCapturingStream();
    await streamClaudeRound({
      stream,
      model: 'claude-haiku-5-5',
      effort: 'low',
      maxTokens: 4096,
      requestParts: buildClaudeRequestParts({
        messageList: buildTurnMessageList(),
        cacheableSystemPrefix: STABLE_PREFIX,
      }),
      toolList: buildClaudeToolList(toolDescriptorList),
    });
    const [params] = paramsList;
    assertValidClaudeRequest(params);
    // Dos puntos de caché: el system estable y el automático de arriba.
    expect(countCacheBreakpoints(params)).toBe(2);
    // La historia recortada que arranca con el asistente pierde esa respuesta,
    // el "   " del usuario no viaja, y la nota del sistema va como texto del
    // usuario (sigue a una respuesta del asistente).
    expect(params.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '¿Qué temperatura hace afuera?' }],
    });
    expect(params.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: UNBACKED_CLAIM_NUDGE }],
    });
    const mcpTool = params.tools?.find((tool) => (tool as { name: string }).name === 'mcp_9386143d_create_event_cd2e3216') as
      | { input_schema: Record<string, unknown> }
      | undefined;
    // Lo de adentro de las propiedades se respeta.
    expect((mcpTool?.input_schema.properties as Record<string, unknown>).start).toEqual({
      anyOf: [{ type: 'string' }, { type: 'object', properties: {} }],
    });
  });

  it('el primer pedido del turno (sin rondas previas) también', async () => {
    const { stream, paramsList } = createCapturingStream();
    await streamClaudeRound({
      stream,
      model: 'claude-haiku-5-5',
      effort: 'low',
      maxTokens: 4096,
      requestParts: buildClaudeRequestParts({
        messageList: buildTurnMessageList().slice(0, 6),
        cacheableSystemPrefix: STABLE_PREFIX,
      }),
      toolList: buildClaudeToolList(buildTurnToolDescriptorList()),
    });
    assertValidClaudeRequest(paramsList[0]);
  });

  it('Opus 5.5 lleva el fallback del servidor; Haiku no', async () => {
    const { stream, paramsList } = createCapturingStream();
    await streamClaudeRound({
      stream,
      model: 'claude-opus-5-5',
      effort: 'medium',
      maxTokens: 16000,
      requestParts: buildClaudeRequestParts({ messageList: buildTurnMessageList().slice(0, 6) }),
      toolList: [],
    });
    assertValidClaudeRequest(paramsList[0]);
    expect(paramsList[0].fallbacks).toBe('default');
    expect('tools' in paramsList[0]).toBe(false);
  });
});

describe('sanitizeClaudeInputSchema / buildClaudeToolList', () => {
  it('fuerza type object y saca lo que la API rechaza en la raíz', () => {
    expect(sanitizeClaudeInputSchema(undefined)).toEqual({ type: 'object' });
    expect(
      sanitizeClaudeInputSchema({ type: 'string', properties: [], required: 'x', oneOf: [] }),
    ).toEqual({ type: 'object' });
  });

  it('descarta una herramienta con nombre inválido en vez de tirar abajo el pedido', () => {
    const toolList = buildClaudeToolList([
      { name: 'self.audio_speaker.set_volume', description: 'x', parameters: { type: 'object' } },
      { name: 'ok_tool', description: '', parameters: { type: 'object' } },
    ]);
    expect(toolList.map((tool) => tool.name)).toEqual(['ok_tool']);
    expect('description' in toolList[0]).toBe(false);
  });
});

describe('pensamiento preservado dentro del turno', () => {
  function createProvider(responseList: BetaMessage[]) {
    setApiCostSink(() => undefined);
    const { stream, paramsList } = createCapturingStream(responseList);
    const provider = createClaudeProvider({
      configuration: resolveClaudeConfiguration({ ANTHROPIC_API_KEY: 'k' }),
      sqlExecutor: createBunSqliteExecutor(new Database(':memory:')),
      stream,
      now: () => Date.parse('2026-10-19T13:00:00Z'),
      log: () => undefined,
    });
    return { provider, paramsList };
  }

  const thinkingBlock = { type: 'thinking', thinking: '', signature: 'sig' };

  it('si el router amplía las herramientas, la ronda anterior se reenvía sin su razonamiento', async () => {
    const { provider, paramsList } = createProvider([
      makeMessage(
        [
          thinkingBlock,
          { type: 'tool_use', id: 'toolu_escape', name: ROUTER_ESCAPE_TOOL_NAME, input: {} },
        ] as unknown as BetaMessage['content'],
        'tool_use',
      ),
      makeMessage(
        [
          thinkingBlock,
          {
            type: 'tool_use',
            id: 'toolu_casa',
            name: 'casa_controlar',
            input: { entidad: 'losa cuarto chicos', accion: 'set_temperature', temperatura: 25 },
          },
        ] as unknown as BetaMessage['content'],
        'tool_use',
      ),
    ]);
    const llm = provider.createTurnLlm(async () => ({ text: 'openrouter', toolCallList: [] }));
    const fullToolList = buildTurnToolDescriptorList();
    const narrowToolList = fullToolList.filter((tool) => tool.name === 'set_volume').concat({
      name: ROUTER_ESCAPE_TOOL_NAME,
      description: 'Pedí todas.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    });
    const messageList: OpenRouterChatMessage[] = [
      { role: 'system', content: STABLE_PREFIX + VOLATILE_NOTE },
      { role: 'user', content: 'Poné la losa del cuarto de los chicos en 25.' },
    ];
    const baseInput = { systemPromptCacheablePrefix: STABLE_PREFIX, userText: 'Poné la losa…' };

    const first = await llm({ ...baseInput, messageList, toolDefinitionList: narrowToolList });
    messageList.push(
      {
        role: 'assistant',
        content: null,
        tool_calls: first.toolCallList.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      },
      { role: 'tool', tool_call_id: 'toolu_escape', content: '{"ok":true,"summary":"Listo"}' },
    );
    const second = await llm({ ...baseInput, messageList, toolDefinitionList: fullToolList });
    messageList.push(
      {
        role: 'assistant',
        content: null,
        tool_calls: second.toolCallList.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      },
      { role: 'tool', tool_call_id: 'toolu_casa', content: '{"ok":true,"summary":"Hecho."}' },
    );
    await llm({ ...baseInput, messageList, toolDefinitionList: fullToolList });

    expect(paramsList).toHaveLength(3);
    paramsList.forEach(assertValidClaudeRequest);
    const thirdMessageList = paramsList[2].messages;
    const escapeRound = blockList(thirdMessageList[1]);
    const casaRound = blockList(thirdMessageList[3]);
    // Producida con la lista corta: sin razonamiento. Producida con la lista
    // actual: con el suyo, tal cual.
    expect(escapeRound.map((block) => block.type)).toEqual(['tool_use']);
    expect(casaRound.map((block) => block.type)).toEqual(['thinking', 'tool_use']);
  });

  it('con la misma lista de herramientas, el razonamiento se reenvía tal cual', async () => {
    const { provider, paramsList } = createProvider([
      makeMessage(
        [
          thinkingBlock,
          { type: 'tool_use', id: 'toolu_1', name: 'casa_estado', input: { entidades: ['cuarto lago'] } },
        ] as unknown as BetaMessage['content'],
        'tool_use',
      ),
    ]);
    const llm = provider.createTurnLlm(async () => ({ text: 'openrouter', toolCallList: [] }));
    const toolDefinitionList = buildTurnToolDescriptorList();
    const messageList: OpenRouterChatMessage[] = [
      { role: 'system', content: STABLE_PREFIX },
      { role: 'user', content: '¿Cómo está la losa del cuarto lago?' },
    ];
    await llm({ messageList, toolDefinitionList, systemPromptCacheablePrefix: STABLE_PREFIX });
    messageList.push(
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'toolu_1',
            type: 'function',
            function: { name: 'casa_estado', arguments: '{"entidades":["cuarto lago"]}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: '{"ok":true,"summary":"off"}' },
    );
    await llm({ messageList, toolDefinitionList, systemPromptCacheablePrefix: STABLE_PREFIX });
    paramsList.forEach(assertValidClaudeRequest);
    expect(blockList(paramsList[1].messages[1]).map((block) => block.type)).toEqual([
      'thinking',
      'tool_use',
    ]);
  });
});
