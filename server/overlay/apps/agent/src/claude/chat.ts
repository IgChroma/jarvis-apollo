import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaTextBlockParam,
  BetaTool,
} from '@anthropic-ai/sdk/resources/beta/messages';

import type { ClaudeEffort } from '@/claude/config';
import { computeClaudeMessageCostUsd } from '@/claude/pricing';
import { jsonSerializableValueSchema } from '@/tools/types';
import type { OpenRouterChatMessage, OpenRouterToolCall } from '@/voice/llm';
import type { LanguageModelToolDescriptor } from '@/turn/run';

// Una ronda del turno contra la API de Anthropic, con el SDK oficial.
//
// El turno (turn/run.ts) arma la conversación en el formato de OpenRouter; acá
// se traduce al de la Messages API:
// - el primer `system` va al `system` de arriba, partido en dos bloques: lo
//   estable (alma + sesión + herramientas instaladas) con un punto de caché, y
//   lo volátil (hora, memorias, foco, telemetría, personaje) después, sin caché;
// - las rondas de herramientas van como `tool_use` / `tool_result`, y si la ronda
//   anterior la contestó Claude se le devuelve su contenido TAL CUAL (con los
//   bloques de `thinking`), como pide la API;
// - un `system` en el medio (la nota de turn/claims.ts) va como texto del
//   usuario: la API solo acepta mensajes `system` intermedios después de un
//   mensaje del usuario, y esa nota sigue a una respuesta del asistente.

// Lo mínimo del stream del SDK que se usa: así los tests no necesitan red.
export type ClaudeMessageStream = {
  readonly onText: (listener: (deltaText: string) => void) => void;
  readonly finalMessage: () => Promise<BetaMessage>;
};

export type ClaudeStreamFunction = (params: BetaMessageStreamParams) => ClaudeMessageStream;

// Modelos que aceptan `fallbacks: "default"` (beta server-side-fallback-2026-07-01):
// si sus clasificadores rechazan el pedido, la API lo reintenta del lado del
// servidor en el modelo que recomienda para esa categoría. Haiku 5.5 no tiene
// fallback del servidor: su rechazo cae en OpenRouter (ver claude/provider.ts).
const SERVER_FALLBACK_MODEL_SET: ReadonlySet<string> = new Set([
  'claude-opus-5-5',
  'claude-sonnet-5-5',
]);
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export function supportsServerFallback(model: string): boolean {
  return SERVER_FALLBACK_MODEL_SET.has(model);
}

export type ClaudeRequestParts = {
  readonly system: BetaTextBlockParam[];
  readonly messages: BetaMessageParam[];
};

function parseToolArguments(argumentsText: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argumentsText === '' ? '{}' : argumentsText);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function buildSystemBlockList(
  systemText: string | undefined,
  cacheableSystemPrefix: string | undefined,
): BetaTextBlockParam[] {
  if (systemText === undefined || systemText.trim().length === 0) {
    return [];
  }
  if (
    cacheableSystemPrefix !== undefined &&
    cacheableSystemPrefix.trim().length > 0 &&
    systemText.startsWith(cacheableSystemPrefix)
  ) {
    const volatileText = systemText.slice(cacheableSystemPrefix.length);
    const blockList: BetaTextBlockParam[] = [
      { type: 'text', text: cacheableSystemPrefix, cache_control: { type: 'ephemeral' } },
    ];
    if (volatileText.trim().length > 0) {
      blockList.push({ type: 'text', text: volatileText });
    }
    return blockList;
  }
  // Sin prefijo estable conocido no se marca nada: escribir en caché un system
  // que cambia en cada turno (lleva la hora) solo pagaría el recargo.
  return [{ type: 'text', text: systemText }];
}

export function buildClaudeRequestParts(input: {
  readonly messageList: readonly OpenRouterChatMessage[];
  readonly cacheableSystemPrefix?: string;
  // Contenido original de las respuestas de Claude de este turno, por id de
  // llamada a herramienta.
  readonly assistantContentByToolCallId?: ReadonlyMap<string, readonly BetaContentBlockParam[]>;
}): ClaudeRequestParts {
  const [firstMessage, ...restMessageList] = input.messageList;
  const systemText = firstMessage?.role === 'system' ? firstMessage.content : undefined;
  const conversationList =
    firstMessage === undefined || firstMessage.role === 'system'
      ? restMessageList
      : input.messageList;
  const messages: BetaMessageParam[] = [];

  const pushUserBlockList = (blockList: BetaContentBlockParam[]): void => {
    const lastMessage = messages.at(-1);
    if (lastMessage?.role === 'user' && Array.isArray(lastMessage.content)) {
      lastMessage.content.push(...blockList);
      return;
    }
    messages.push({ role: 'user', content: blockList });
  };

  for (const message of conversationList) {
    switch (message.role) {
      case 'user':
      case 'system': {
        if (message.content.trim().length > 0) {
          pushUserBlockList([{ type: 'text', text: message.content }]);
        }
        break;
      }
      case 'tool': {
        pushUserBlockList([
          { type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content },
        ]);
        break;
      }
      case 'assistant': {
        // La conversación tiene que empezar por el usuario: una historia
        // recortada que arranca con el asistente pierde esa primera respuesta.
        if (messages.length === 0) {
          break;
        }
        const text = message.content?.trim() ?? '';
        const toolCallList = message.tool_calls ?? [];
        if (toolCallList.length > 0) {
          const originalContent = input.assistantContentByToolCallId?.get(toolCallList[0].id);
          const content: BetaContentBlockParam[] =
            originalContent !== undefined
              ? [...originalContent]
              : [
                  ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
                  ...toolCallList.map((toolCall) => ({
                    type: 'tool_use' as const,
                    id: toolCall.id,
                    name: toolCall.function.name,
                    input: parseToolArguments(toolCall.function.arguments),
                  })),
                ];
          messages.push({ role: 'assistant', content });
        } else if (text.length > 0) {
          messages.push({ role: 'assistant', content: text });
        }
        break;
      }
    }
  }

  return {
    system: buildSystemBlockList(systemText, input.cacheableSystemPrefix),
    messages,
  };
}

export function buildClaudeToolList(
  toolDefinitionList: readonly LanguageModelToolDescriptor[],
): BetaTool[] {
  return toolDefinitionList.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: { ...(tool.parameters ?? {}), type: 'object' } as BetaTool.InputSchema,
    // Por defecto en pedidos con streaming. Sin validación del servidor, el
    // único control es el de cada herramienta: todas parsean sus argumentos con
    // su propio esquema antes de hacer nada (tools/router.ts).
    eager_input_streaming: true,
  }));
}

export type ClaudeRoundFailure =
  | 'refusal'
  | 'max_tokens_sin_texto'
  | 'max_tokens_en_herramienta'
  | 'stop_reason_inesperado';

export type ClaudeRoundResult = {
  readonly message: BetaMessage;
  readonly costUsd: number;
  readonly text: string;
  readonly toolCallList: readonly OpenRouterToolCall[];
  // undefined = la ronda sirve. Si no, el turno sigue por OpenRouter.
  readonly failure: ClaudeRoundFailure | undefined;
  // true si la API pasó el pedido a otro modelo (fallback del servidor).
  readonly servedByFallback: boolean;
};

export function classifyClaudeStop(message: BetaMessage): ClaudeRoundFailure | undefined {
  const hasText = message.content.some(
    (block) => block.type === 'text' && block.text.trim().length > 0,
  );
  const hasToolUse = message.content.some((block) => block.type === 'tool_use');
  switch (message.stop_reason) {
    case 'end_turn':
    case 'stop_sequence':
      return undefined;
    case 'tool_use':
      return hasToolUse ? undefined : 'stop_reason_inesperado';
    case 'max_tokens':
      // Una herramienta cortada a mitad de los argumentos puede parsear como un
      // objeto válido: nunca se ejecuta. Un texto cortado se dice igual.
      if (hasToolUse) {
        return 'max_tokens_en_herramienta';
      }
      return hasText ? undefined : 'max_tokens_sin_texto';
    case 'refusal':
      return 'refusal';
    default:
      return 'stop_reason_inesperado';
  }
}

export async function streamClaudeRound(input: {
  readonly stream: ClaudeStreamFunction;
  readonly model: string;
  readonly effort: ClaudeEffort;
  readonly maxTokens: number;
  readonly requestParts: ClaudeRequestParts;
  readonly toolList: readonly BetaTool[];
  readonly onTextDelta?: (deltaText: string) => void;
}): Promise<ClaudeRoundResult> {
  const useServerFallback = supportsServerFallback(input.model);
  const params: BetaMessageStreamParams = {
    model: input.model,
    max_tokens: input.maxTokens,
    system: input.requestParts.system,
    messages: input.requestParts.messages,
    // Adaptativo en los tres modelos: en Opus 5.5 no se puede apagar y en
    // Sonnet 5.5 `disabled` es un 400. Cuánto piensa lo decide el esfuerzo.
    thinking: { type: 'adaptive' },
    output_config: { effort: input.effort },
    // Caché automática de la cola de la conversación: en un turno con
    // herramientas, la segunda ronda lee de caché todo lo que ya mandó la
    // primera. Se suma al punto de caché explícito del system estable.
    cache_control: { type: 'ephemeral' },
    ...(input.toolList.length > 0 ? { tools: [...input.toolList] } : {}),
    ...(useServerFallback ? { betas: [SERVER_FALLBACK_BETA], fallbacks: 'default' as const } : {}),
  };
  const stream = input.stream(params);
  const onTextDelta = input.onTextDelta;
  if (onTextDelta !== undefined) {
    stream.onText((deltaText) => onTextDelta(deltaText));
  }
  const message = await stream.finalMessage();
  const costUsd = computeClaudeMessageCostUsd({
    requestedModel: input.model,
    responseModel: message.model,
    usage: message.usage,
  });
  const failure = classifyClaudeStop(message);
  const text = message.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim();
  const toolCallList =
    failure === undefined
      ? message.content.flatMap((block) =>
          block.type === 'tool_use'
            ? [
                {
                  id: block.id,
                  name: block.name,
                  args: jsonSerializableValueSchema.parse(block.input ?? {}),
                },
              ]
            : [],
        )
      : [];
  const servedByFallback =
    message.content.some((block) => block.type === 'fallback') ||
    (message.usage.iterations ?? []).some((iteration) => iteration.type === 'fallback_message');
  return { message, costUsd, text, toolCallList, failure, servedByFallback };
}
