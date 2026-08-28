/** Assemble Addie's stable system prompt in production order. */
export function assembleAddieSystemPrompt(
  rules: string,
  toolReference: string,
  responseStyle: string,
): string {
  return `${rules}\n\n---\n\n${toolReference}\n\n---\n\n${responseStyle}`;
}

/** Assemble the reduced fallback prompt used when rule files cannot load. */
export function assembleAddieFallbackPrompt(
  fallbackPrompt: string,
  toolReference: string,
): string {
  return `${fallbackPrompt}\n\n---\n\n${toolReference}`;
}
