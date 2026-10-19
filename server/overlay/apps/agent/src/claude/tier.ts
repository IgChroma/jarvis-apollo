import type { ClaudeTier } from '@/claude/config';
import type { RouterReasoningDecision } from '@/router/log';

// Qué modelo de Claude contesta el turno. Reusa la señal que ya tiene el router
// (Jev: "¿hace falta razonar?" con su umbral aprendido y el A/B):
// - hard       si el usuario lo pide explícitamente ("pensalo bien"…), o si el
//              router decidió razonar y Jev está muy seguro (probabilidad ≥
//              CLAUDE_HARD_REASONING_THRESHOLD, 0,9 por defecto);
// - reasoning  si el router decidió razonar;
// - fast       en cualquier otro caso (incluye sin router, modo shadow o Jev
//              caído: lo barato y rápido es el default).
//
// Se usa `enabled` (lo que se aplicó) y no `policy`: así el A/B del router sigue
// midiendo lo mismo, ahora como "Sonnet contra Haiku".

export type ClaudeTierReason =
  | 'pedido_explicito'
  | 'jev_muy_dificil'
  | 'jev_razonar'
  | 'jev_razonar_exploracion'
  | 'default';

export type ClaudeTierChoice = {
  readonly tier: ClaudeTier;
  readonly reason: ClaudeTierReason;
};

export function normalizeForPhraseMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function asksToThinkHard(userText: string, phraseList: readonly string[]): boolean {
  const normalizedText = ` ${normalizeForPhraseMatch(userText)} `;
  return phraseList.some((phrase) => {
    const normalizedPhrase = normalizeForPhraseMatch(phrase);
    return normalizedPhrase.length > 0 && normalizedText.includes(` ${normalizedPhrase} `);
  });
}

export function selectClaudeTier(input: {
  readonly userText: string;
  readonly reasoning: RouterReasoningDecision | undefined;
  readonly hardReasoningThreshold: number;
  readonly hardPhraseList: readonly string[];
}): ClaudeTierChoice {
  if (asksToThinkHard(input.userText, input.hardPhraseList)) {
    return { tier: 'hard', reason: 'pedido_explicito' };
  }
  if (input.reasoning?.enabled === true) {
    const probability = input.reasoning.probability;
    if (probability !== undefined && probability >= input.hardReasoningThreshold) {
      return { tier: 'hard', reason: 'jev_muy_dificil' };
    }
    return {
      tier: 'reasoning',
      reason: input.reasoning.explored ? 'jev_razonar_exploracion' : 'jev_razonar',
    };
  }
  return { tier: 'fast', reason: 'default' };
}
