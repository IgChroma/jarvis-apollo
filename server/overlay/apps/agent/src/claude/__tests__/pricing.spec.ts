import { describe, expect, it } from 'bun:test';

import { computeClaudeMessageCostUsd, computeClaudeUsageCostUsd } from '@/claude/pricing';

const usage = (overrides: Record<string, unknown> = {}) => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  ...overrides,
});

describe('Claude cost from usage', () => {
  it('prices Haiku 5.5 input, output and both cache directions', () => {
    // USD/MTok: 0,10 entrada, 0,50 salida, 0,125 escritura 5 min, 0,01 lectura.
    const cost = computeClaudeUsageCostUsd(
      'claude-haiku-5-5',
      usage({
        input_tokens: 25_000,
        output_tokens: 1_000_000,
        cache_creation_input_tokens: 25_000,
        cache_read_input_tokens: 25_000,
      }),
    );
    expect(cost).toBeCloseTo(25_000 * 0.1e-6 + 0.5 + 25_000 * 0.125e-6 + 25_000 * 0.01e-6, 10);
  });

  it('switches Haiku to the long-prompt rate above 100K prompt tokens', () => {
    const short = computeClaudeUsageCostUsd('claude-haiku-5-5', usage({ input_tokens: 100_000 }));
    expect(short).toBeCloseTo(0.01, 10);
    // 90K sin caché + 20K leídos de caché = 110K de prompt: tarifa larga.
    const long = computeClaudeUsageCostUsd(
      'claude-haiku-5-5',
      usage({ input_tokens: 90_000, cache_read_input_tokens: 20_000, output_tokens: 1_000 }),
    );
    expect(long).toBeCloseTo(90_000 * 0.5e-6 + 20_000 * 0.05e-6 + 1_000 * 2.5e-6, 10);
  });

  it('prices Sonnet 5.5 and Opus 5.5 at list price', () => {
    const turn = usage({
      input_tokens: 1_000,
      output_tokens: 200,
      cache_creation_input_tokens: 2_000,
      cache_read_input_tokens: 10_000,
    });
    expect(computeClaudeUsageCostUsd('claude-sonnet-5-5', turn)).toBeCloseTo(
      (1_000 * 2 + 200 * 10 + 2_000 * 2.5 + 10_000 * 0.2) / 1e6,
      10,
    );
    expect(computeClaudeUsageCostUsd('claude-opus-5-5', turn)).toBeCloseTo(
      (1_000 * 4 + 200 * 20 + 2_000 * 5 + 10_000 * 0.2) / 1e6,
      10,
    );
  });

  it('uses the 1-hour write price when the API reports it', () => {
    const cost = computeClaudeUsageCostUsd(
      'claude-opus-5-5',
      usage({
        cache_creation_input_tokens: 3_000,
        cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 2_000 },
      }),
    );
    expect(cost).toBeCloseTo((1_000 * 5 + 2_000 * 8) / 1e6, 10);
  });

  it('prices an unknown model as the most expensive one', () => {
    expect(computeClaudeUsageCostUsd('claude-futuro-9', usage({ output_tokens: 1_000_000 }))).toBeCloseTo(25, 6);
  });

  it('adds every attempt of a server-side fallback at its own model price', () => {
    const cost = computeClaudeMessageCostUsd({
      requestedModel: 'claude-sonnet-5-5',
      responseModel: 'claude-sonnet-5',
      usage: {
        ...usage({ input_tokens: 1_000, output_tokens: 100 }),
        iterations: [
          { type: 'message', model: null, ...usage({ input_tokens: 1_000, output_tokens: 50 }) },
          { type: 'fallback_message', model: 'claude-opus-5', ...usage({ input_tokens: 1_000, output_tokens: 100 }) },
        ],
      },
    });
    expect(cost).toBeCloseTo((1_000 * 2 + 50 * 10) / 1e6 + (1_000 * 5 + 100 * 25) / 1e6, 10);
  });

  it('uses the top-level usage when there are no iterations', () => {
    expect(
      computeClaudeMessageCostUsd({
        requestedModel: 'claude-haiku-5-5',
        responseModel: 'claude-haiku-5-5',
        usage: { ...usage({ input_tokens: 2_000, output_tokens: 40 }), iterations: null },
      }),
    ).toBeCloseTo((2_000 * 0.1 + 40 * 0.5) / 1e6, 12);
  });
});
