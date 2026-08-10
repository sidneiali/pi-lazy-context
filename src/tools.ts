import type { LazyConfig } from "./config.js";

function detectWriteIntent(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

// So alterna tools que a extensao conhece (config.fullTools). Qualquer tool
// fora dessa lista (de outra extensao, por exemplo) e sempre mantida ativa —
// nunca desativamos algo que nao sabemos para que serve.
export function decideToolSet(promptText: string, allToolNames: string[], config: LazyConfig): string[] {
  const unknownTools = allToolNames.filter((name) => !config.fullTools.includes(name));

  if (!promptText.trim()) {
    return allToolNames; // sem sinal suficiente: nao restringe
  }
  if (detectWriteIntent(promptText, config.writeIntentKeywords)) {
    return allToolNames; // intencao de escrita/execucao: toolset completo
  }

  const knownReadOnly = config.readOnlyTools.filter((name) => allToolNames.includes(name));
  return [...new Set([...knownReadOnly, ...unknownTools])];
}

export function sameToolSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((t) => sa.has(t));
}

