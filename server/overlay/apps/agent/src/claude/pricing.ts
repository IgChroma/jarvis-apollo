// Costo de cada llamada a Claude, calculado a partir de `usage`.
//
// La cuenta no es una organización, así que no hay Admin API para preguntarle a
// Anthropic cuánto se gastó: el costo se calcula acá con la tabla de precios de
// lista y se anota en api_costs (ver costs/ledger.ts). Es una estimación fiel
// mientras los precios de esta tabla sigan vigentes: revisalos si Anthropic los
// cambia.
//
// Fuente: precios de lista de la API de Anthropic (platform.claude.com, página
// Pricing), relevados en la referencia del SDK al 2026-10-06. USD por millón de
// tokens (MTok):
//
// | modelo            | entrada | salida | escribir caché 5 min | 1 h  | leer caché |
// |-------------------|---------|--------|----------------------|------|------------|
// | claude-haiku-5-5  | 0,10    | 0,50   | 0,125                | 0,20 | 0,01       |  (prompt ≤ 100K tokens)
// | claude-haiku-5-5  | 0,50    | 2,50   | 0,625                | 1,00 | 0,05       |  (prompt > 100K tokens)
// | claude-sonnet-5-5 | 2       | 10     | 2,50                 | 4    | 0,20       |
// | claude-opus-5-5   | 4       | 20     | 5                    | 8    | 0,20       |
//
// Haiku 5.5: lectura de caché 0,1x la entrada, escritura 1,25x (5 min) y 2x
// (1 h), con dos tarifas según el largo del prompt (entrada + caché escrita +
// caché leída). Las filas de abajo son los modelos a los que el fallback del
// lado del servidor puede pasar un turno rechazado (Sonnet 5, Opus 5, Opus 4.8),
// con los multiplicadores estándar de caché.

export type ClaudeModelPrice = {
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  readonly cacheWrite5mUsdPerMTok: number;
  readonly cacheWrite1hUsdPerMTok: number;
  readonly cacheReadUsdPerMTok: number;
};

export type ClaudeModelPricing = {
  readonly standard: ClaudeModelPrice;
  // Tarifa para prompts largos, si el modelo tiene una; y desde cuántos tokens.
  readonly longPrompt?: { readonly aboveTokens: number; readonly price: ClaudeModelPrice };
};

function standardPrice(inputUsdPerMTok: number, outputUsdPerMTok: number): ClaudeModelPrice {
  return {
    inputUsdPerMTok,
    outputUsdPerMTok,
    cacheWrite5mUsdPerMTok: inputUsdPerMTok * 1.25,
    cacheWrite1hUsdPerMTok: inputUsdPerMTok * 2,
    cacheReadUsdPerMTok: inputUsdPerMTok * 0.1,
  };
}

export const CLAUDE_PRICE_TABLE: Readonly<Record<string, ClaudeModelPricing>> = {
  'claude-haiku-5-5': {
    standard: standardPrice(0.1, 0.5),
    longPrompt: { aboveTokens: 100_000, price: standardPrice(0.5, 2.5) },
  },
  'claude-sonnet-5-5': {
    standard: {
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 10,
      cacheWrite5mUsdPerMTok: 2.5,
      cacheWrite1hUsdPerMTok: 4,
      cacheReadUsdPerMTok: 0.2,
    },
  },
  'claude-opus-5-5': {
    standard: {
      inputUsdPerMTok: 4,
      outputUsdPerMTok: 20,
      cacheWrite5mUsdPerMTok: 5,
      cacheWrite1hUsdPerMTok: 8,
      cacheReadUsdPerMTok: 0.2,
    },
  },
  // Destinos posibles del fallback del lado del servidor.
  'claude-sonnet-5': { standard: standardPrice(2, 10) },
  'claude-opus-5': { standard: standardPrice(5, 25) },
  'claude-opus-4-8': { standard: standardPrice(5, 25) },
};

// Un modelo que no está en la tabla se cobra como el más caro de la tabla: el
// guardián de gasto tiene que pecar de prudente, nunca de optimista.
export const UNKNOWN_CLAUDE_MODEL_PRICING: ClaudeModelPricing = { standard: standardPrice(5, 25) };

export function isKnownClaudeModel(model: string): boolean {
  return Object.hasOwn(CLAUDE_PRICE_TABLE, model);
}

// Lo que importa de `usage` (top-level o de cada entrada de usage.iterations).
export type ClaudeUsageLike = {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  readonly cache_creation?: {
    readonly ephemeral_5m_input_tokens?: number | null;
    readonly ephemeral_1h_input_tokens?: number | null;
  } | null;
};

export function computeClaudeUsageCostUsd(model: string, usage: ClaudeUsageLike): number {
  const pricing = CLAUDE_PRICE_TABLE[model] ?? UNKNOWN_CLAUDE_MODEL_PRICING;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const promptTokens = usage.input_tokens + cacheWriteTokens + cacheReadTokens;
  const price =
    pricing.longPrompt !== undefined && promptTokens > pricing.longPrompt.aboveTokens
      ? pricing.longPrompt.price
      : pricing.standard;
  // Si la API desglosa la escritura por TTL se usa eso; si no, todo es 5 min
  // (el único TTL que pide este código).
  const write1hTokens = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5mTokens = Math.max(0, cacheWriteTokens - write1hTokens);
  const microDollars =
    usage.input_tokens * price.inputUsdPerMTok +
    usage.output_tokens * price.outputUsdPerMTok +
    write5mTokens * price.cacheWrite5mUsdPerMTok +
    write1hTokens * price.cacheWrite1hUsdPerMTok +
    cacheReadTokens * price.cacheReadUsdPerMTok;
  return microDollars / 1_000_000;
}

type IterationLike = ClaudeUsageLike & {
  readonly type: string;
  readonly model?: string | null;
};

// Costo de un mensaje completo. Con el fallback del lado del servidor,
// `usage.iterations` es la fuente de verdad por intento (cada uno a la tarifa
// del modelo que lo corrió) y el `usage` de arriba cubre solo el intento que
// produjo el mensaje.
export function computeClaudeMessageCostUsd(input: {
  readonly requestedModel: string;
  readonly responseModel: string;
  readonly usage: ClaudeUsageLike & { readonly iterations?: readonly IterationLike[] | null };
}): number {
  const iterationList = (input.usage.iterations ?? []).filter(
    (iteration) => iteration.type === 'message' || iteration.type === 'fallback_message',
  );
  if (iterationList.length === 0) {
    return computeClaudeUsageCostUsd(input.responseModel, input.usage);
  }
  return iterationList.reduce(
    (total, iteration) =>
      total + computeClaudeUsageCostUsd(iteration.model ?? input.requestedModel, iteration),
    0,
  );
}
