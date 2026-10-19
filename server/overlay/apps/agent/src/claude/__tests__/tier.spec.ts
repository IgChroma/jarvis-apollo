import { describe, expect, it } from 'bun:test';

import { DEFAULT_CLAUDE_HARD_PHRASE_LIST, resolveClaudeConfiguration } from '@/claude/config';
import { asksToThinkHard, selectClaudeTier } from '@/claude/tier';
import type { RouterReasoningDecision } from '@/router/log';

const base = {
  hardReasoningThreshold: 0.9,
  hardPhraseList: DEFAULT_CLAUDE_HARD_PHRASE_LIST,
};

const reasoning = (overrides: Partial<RouterReasoningDecision>): RouterReasoningDecision => ({
  probability: 0.6,
  policy: true,
  enabled: true,
  explored: false,
  ...overrides,
});

describe('Claude tier selection', () => {
  it('defaults to the fast tier without a router decision', () => {
    expect(selectClaudeTier({ ...base, userText: '¿qué hora es?', reasoning: undefined })).toEqual({
      tier: 'fast',
      reason: 'default',
    });
  });

  it('stays fast when the router decided not to reason', () => {
    const choice = selectClaudeTier({
      ...base,
      userText: 'contame un chiste',
      reasoning: reasoning({ probability: 0.2, policy: false, enabled: false }),
    });
    expect(choice.tier).toBe('fast');
  });

  it('uses the reasoning tier when the router turns reasoning on', () => {
    expect(
      selectClaudeTier({ ...base, userText: '¿cuántos días faltan para el 5?', reasoning: reasoning({}) }),
    ).toEqual({ tier: 'reasoning', reason: 'jev_razonar' });
  });

  it('marks the A/B exploration arm', () => {
    const choice = selectClaudeTier({
      ...base,
      userText: 'hola',
      reasoning: reasoning({ probability: 0.1, policy: false, enabled: true, explored: true }),
    });
    expect(choice).toEqual({ tier: 'reasoning', reason: 'jev_razonar_exploracion' });
  });

  it('goes to the hard tier when Jev is very sure the turn needs reasoning', () => {
    expect(selectClaudeTier({ ...base, userText: 'x', reasoning: reasoning({ probability: 0.95 }) })).toEqual({
      tier: 'hard',
      reason: 'jev_muy_dificil',
    });
    // Exactamente en el umbral también cuenta.
    expect(selectClaudeTier({ ...base, userText: 'x', reasoning: reasoning({ probability: 0.9 }) }).tier).toBe(
      'hard',
    );
  });

  it('respects the A/B when it switched reasoning off, even with a high probability', () => {
    const choice = selectClaudeTier({
      ...base,
      userText: 'x',
      reasoning: reasoning({ probability: 0.97, policy: true, enabled: false, explored: true }),
    });
    expect(choice.tier).toBe('fast');
  });

  it('goes to the hard tier when the user asks to think hard, without the router', () => {
    for (const userText of [
      'Pensalo bien: ¿me conviene el plazo fijo o el dólar?',
      'PENSÁ A FONDO esto',
      'es una pregunta difícil, ¿cuánto pesa la Luna?',
      'razonalo bien por favor',
    ]) {
      expect(selectClaudeTier({ ...base, userText, reasoning: undefined })).toEqual({
        tier: 'hard',
        reason: 'pedido_explicito',
      });
    }
  });

  it('matches whole phrases only, ignoring accents and punctuation', () => {
    expect(asksToThinkHard('Pensa bien, ¿sí?', ['pensá bien'])).toBe(true);
    expect(asksToThinkHard('el que piensa bien gana', ['pensá bien'])).toBe(false);
    expect(asksToThinkHard('repensalo bien', ['pensalo bien'])).toBe(false);
  });

  it('reads the phrase list and threshold from the environment', () => {
    const configuration = resolveClaudeConfiguration({
      ANTHROPIC_API_KEY: 'k',
      CLAUDE_HARD_PHRASES: 'modo genio, a fondo',
      CLAUDE_HARD_REASONING_THRESHOLD: '0.8',
    });
    expect(configuration.hardPhraseList).toEqual(['modo genio', 'a fondo']);
    expect(
      selectClaudeTier({
        userText: 'activá el modo genio',
        reasoning: undefined,
        hardReasoningThreshold: configuration.hardReasoningThreshold,
        hardPhraseList: configuration.hardPhraseList,
      }).tier,
    ).toBe('hard');
    expect(
      selectClaudeTier({
        userText: 'x',
        reasoning: reasoning({ probability: 0.85 }),
        hardReasoningThreshold: configuration.hardReasoningThreshold,
        hardPhraseList: configuration.hardPhraseList,
      }).tier,
    ).toBe('hard');
  });
});

describe('Claude configuration', () => {
  it('is on by default when there is a key, with the documented defaults', () => {
    const configuration = resolveClaudeConfiguration({ ANTHROPIC_API_KEY: 'k' });
    expect(configuration.enabled).toBe(true);
    expect(configuration.modelByTier).toEqual({
      fast: 'claude-haiku-5-5',
      reasoning: 'claude-sonnet-5-5',
      hard: 'claude-opus-5-5',
    });
    expect(configuration.effortByTier).toEqual({ fast: 'low', reasoning: 'low', hard: 'medium' });
    expect(configuration.budgetUsd).toBe(50);
    expect(configuration.budgetCycleDay).toBe(12);
    expect(configuration.minRemainingPercent).toBe(0);
    expect(configuration.budgetTimeZone).toBe('America/Argentina/Buenos_Aires');
  });

  it('is off without a key or when switched off', () => {
    expect(resolveClaudeConfiguration({}).disabledReason).toBe('sin_key');
    expect(resolveClaudeConfiguration({ CLAUDE_ENABLED: 'on' }).enabled).toBe(false);
    const switchedOff = resolveClaudeConfiguration({ ANTHROPIC_API_KEY: 'k', CLAUDE_ENABLED: 'off' });
    expect(switchedOff.enabled).toBe(false);
    expect(switchedOff.disabledReason).toBe('apagado');
    expect(resolveClaudeConfiguration({ ANTHROPIC_API_KEY: 'k', CLAUDE_ENABLED: 'false' }).enabled).toBe(false);
  });

  it('reads overrides and ignores invalid values', () => {
    const configuration = resolveClaudeConfiguration({
      ANTHROPIC_API_KEY: 'k',
      CLAUDE_BUDGET_USD: '150',
      CLAUDE_BUDGET_CYCLE_DAY: '40',
      CLAUDE_MIN_REMAINING_PERCENT: '10',
      CLAUDE_MODEL_HARD: 'claude-opus-5',
      CLAUDE_EFFORT_HARD: 'high',
      CLAUDE_EFFORT_FAST: 'turbo',
      CLAUDE_BUDGET_TIMEZONE: 'No/Existe',
    });
    expect(configuration.budgetUsd).toBe(150);
    expect(configuration.budgetCycleDay).toBe(12);
    expect(configuration.minRemainingPercent).toBe(10);
    expect(configuration.modelByTier.hard).toBe('claude-opus-5');
    expect(configuration.effortByTier.hard).toBe('high');
    expect(configuration.effortByTier.fast).toBe('low');
    expect(configuration.budgetTimeZone).toBe('America/Argentina/Buenos_Aires');
  });
});
