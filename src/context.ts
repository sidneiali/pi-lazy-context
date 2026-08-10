import { execFileSync } from "node:child_process";
import type { LazyConfig } from "./config.js";

type PruneResult = { content: unknown; removedChars: number };

type ToonResult = { content: unknown; savedChars: number };

function pruneToolResultContent(content: unknown, config: LazyConfig): PruneResult {
  if (!Array.isArray(content)) return { content, removedChars: 0 };

  let removedChars = 0;
  const newContent = content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const b = block as { type?: string; text?: string };
    if (b.type !== "text" || typeof b.text !== "string") return block;
    if (b.text.length <= config.toolResultTruncateChars) return block;

    const removed = b.text.length - config.toolResultTruncateKeepChars;
    removedChars += removed;
    return {
      ...b,
      text:
        `${b.text.slice(0, config.toolResultTruncateKeepChars)}\n\n` +
        `[...lazy-context: ${removed} caracteres omitidos deste resultado antigo; ` +
        `o conteudo original permanece intacto na sessao, use /lazy off se precisar dele agora]`,
    };
  });

  return { content: newContent, removedChars };
}

function encodeToon(value: unknown): string | undefined {
  try {
    const command = process.platform === "win32" ? "cmd.exe" : "toon";
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", "toon --encode"]
      : ["--encode"];
    return execFileSync(command, args, {
      input: `${JSON.stringify(value)}\n`,
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
    });
  } catch {
    return undefined;
  }
}

function isPrimitive(value: unknown): boolean {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isUniformObjectArray(value: unknown[]): boolean {
  if (value.length === 0 || !value.every((entry) => isPlainObject(entry))) return false;
  const keys = Object.keys(value[0] as Record<string, unknown>).sort();
  if (keys.length === 0) return false;
  return value.every((entry) => {
    const object = entry as Record<string, unknown>;
    const entryKeys = Object.keys(object).sort();
    return entryKeys.length === keys.length
      && entryKeys.every((key, index) => key === keys[index])
      && keys.every((key) => isPrimitive(object[key]));
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Regra da skill TOON: favorece dados planos/rasos e arrays uniformes;
// rejeita arrays de arrays e estruturas irregulares/profundas.
function isSafeToonShape(value: unknown, depth = 0): boolean {
  if (isPrimitive(value)) return true;
  if (depth > 2 || Array.isArray(value) && value.some(Array.isArray)) return false;

  if (Array.isArray(value)) {
    return value.every((entry) => isPrimitive(entry)) || isUniformObjectArray(value);
  }

  if (!isPlainObject(value)) return false;
  return Object.values(value).every((entry) => isSafeToonShape(entry, depth + 1));
}

// TOON só é aplicado a JSON puro, com shape seguro, e quando há economia real.
function convertJsonToolResultContent(content: unknown, config: LazyConfig): ToonResult {
  if (!config.toonContext || !Array.isArray(content)) return { content, savedChars: 0 };

  let savedChars = 0;
  const converted = content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const b = block as { type?: string; text?: string };
    if (b.type !== "text" || typeof b.text !== "string" || b.text.length < config.toonMinChars) {
      return block;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(b.text);
    } catch {
      return block;
    }
    if (!parsed || typeof parsed !== "object" || !isSafeToonShape(parsed)) return block;

    const toon = encodeToon(parsed);
    if (!toon) return block;
    const replacement = `[TOON: JSON convertido apenas para o contexto; use toon -d se precisar do JSON]\n${toon}`;
    const saved = b.text.length - replacement.length;
    if (saved <= 0 || saved / b.text.length < config.toonMinSavingsRatio) return block;

    savedChars += saved;
    return { ...b, text: replacement };
  });

  return { content: converted, savedChars };
}

function isToolResultMessage(message: any): boolean {
  return message?.role === "tool_result" || message?.role === "toolResult";
}

export function pruneMessages(messages: any[], config: LazyConfig): { messages: any[]; removedChars: number; toonSavedChars: number } {
  const protectFrom = Math.max(0, messages.length - config.protectRecentMessages);
  let removedChars = 0;
  let toonSavedChars = 0;

  const pruned = messages.map((msg, i) => {
    if (!isToolResultMessage(msg)) return msg;

    // Primeiro poda resultados antigos; em seguida tenta TOON no conteúdo que
    // ainda será enviado. A cópia do evento é não-destrutiva.
    const prunedResult = i < protectFrom
      ? pruneToolResultContent(msg.content, config)
      : { content: msg.content, removedChars: 0 };
    removedChars += prunedResult.removedChars;

    const toonResult = convertJsonToolResultContent(prunedResult.content, config);
    toonSavedChars += toonResult.savedChars;
    if (prunedResult.removedChars === 0 && toonResult.savedChars === 0) return msg;
    return { ...msg, content: toonResult.content };
  });

  return { messages: pruned, removedChars, toonSavedChars };
}

