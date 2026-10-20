// Recortes de texto del tablero. Viven aparte de payload.ts para que la agenda
// (dashboard/agenda.ts) los use sin una importación circular.

export function clipDashboardText(text: string, maximumCharacterCount: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maximumCharacterCount) {
    return collapsed;
  }
  const clipped = collapsed.slice(0, maximumCharacterCount);
  const lastSpaceIndex = clipped.lastIndexOf(' ');
  // Un corte muy al principio deja una palabra sola y se entiende menos que
  // cortar al medio de la última.
  const trimmed = lastSpaceIndex > maximumCharacterCount / 2
    ? clipped.slice(0, lastSpaceIndex)
    : clipped;
  return `${trimmed}…`;
}

/** Como `clipDashboardText`, pero el resultado (con "…") nunca pasa del máximo. */
export function clipDashboardTextWithin(text: string, maximumCharacterCount: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maximumCharacterCount) {
    return collapsed;
  }
  return clipDashboardText(collapsed, Math.max(1, maximumCharacterCount - 1));
}
