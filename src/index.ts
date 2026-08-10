// lazy-context.ts
//
// Reduz, de forma automática e transparente, o que e enviado ao modelo em
// cada chamada do Pi Coding Agent:
//
//   1. Lazy Tools  — troca o toolset ativo (pi.setActiveTools) conforme a
//      intencao do prompt do usuario, em before_agent_start (uma vez por
//      prompt, nunca no meio de um loop de tool calls).
//   2. Lazy Context — trunca tool_results antigos e grandes em cada chamada
//      ao LLM, via o evento `context`, sem jamais tocar a sessao salva
//      (mesmo padrao do "Dynamic Context Pruning" da discussao oficial #330).
//   3. Lazy Tool Specs (OPT-IN, desligado por padrao) — encurta a description
//      das tools que permanecem ativas no payload ja serializado pro
//      provider, via `before_provider_request`. NUNCA toca no JSON Schema
//      dos parametros (input_schema/parameters), que e estrutural e
//      obrigatorio para a chamada de tool ser valida — so o texto livre da
//      description e candidato a corte. Isso e mais arriscado que os itens
//      1 e 2: descriptions de tools nativas do Pi podem carregar avisos de
//      seguranca ou instrucoes de uso; corta-las pode piorar o comportamento
//      do modelo. Por isso fica desligado ate o usuario ativar explicitamente
//      (config.trimToolDescriptions = true).
//
// APIs usadas, todas publicas e documentadas em docs/extensions.md:
//   pi.getAllTools() / pi.getActiveTools() / pi.setActiveTools()
//   pi.on("before_agent_start" | "context" | "before_provider_request" | ...)
//   pi.registerCommand()
//   ctx.ui.notify / ctx.ui.setStatus
//   ctx.isProjectTrusted()           (gate antes de ler config local)
//   ctx.cwd, CONFIG_DIR_NAME
//
// Zero mudanca de fluxo exigida: com a config default, a extensao so entra
// em acao quando ha algo real para economizar; nunca bloqueia uma ferramenta
// nem remove conteudo que o usuario pediu explicitamente para editar/criar.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type LazyStats = {
  requests: number;
  originalChars: number;
  optimizedChars: number;
  savedChars: number;
  originalTokens: number;
  optimazedTokens: number;
  savedTokens: number;
  updatedAt?: string;
};

type LazyConfig = {
  enabled: boolean;
  lazyTools: boolean;
  lazyContext: boolean;
  // Tools que a extensao sabe classificar. Qualquer tool fora dessas listas
  // (registrada por outra extensao, por exemplo) nunca e desativada.
  fullTools: string[];
  readOnlyTools: string[];
  writeIntentKeywords: string[];
  // Quantas mensagens recentes (aprox. ultimos turnos) nunca sao podadas.
  protectRecentMessages: number;
  // A partir de quantos caracteres um tool_result antigo passa a ser podado.
  toolResultTruncateChars: number;
  // Quantos caracteres do inicio do tool_result sao preservados ao podar.
  toolResultTruncateKeepChars: number;
  // OPT-IN: encurta a description das tools ativas no payload do provider.
  // Nunca toca no schema de parametros. Veja aviso de risco no topo do arquivo.
  trimToolDescriptions: boolean;
  toolDescriptionMaxChars: number;
  // Converte resultados JSON grandes para TOON somente no contexto enviado ao LLM.
  // A sessao persistida e o resultado original permanecem inalterados.
  toonContext: boolean;
  toonMinChars: number;
  toonMinSavingsRatio: number;
};

const DEFAULT_CONFIG: LazyConfig = {
  enabled: true,
  lazyTools: true,
  lazyContext: true,
  fullTools: ["read", "bash", "edit", "write"],
  readOnlyTools: ["read", "bash"],
  writeIntentKeywords: [
    // pt-BR
    "crie", "criar", "edite", "editar", "escreva", "escrever", "delete", "deletar",
    "apague", "apagar", "remova", "remover", "renomeie", "renomear", "mova", "mover",
    "instale", "instalar", "execute", "executar", "rode", "rodar", "commit", "push",
    "refatore", "refatorar", "adicione", "adicionar", "corrija", "corrigir",
    "implemente", "implementar", "atualize", "atualizar", "modifique", "modificar",
    // en
    "create", "write", "edit", "delete", "remove", "rename", "move", "install",
    "run", "execute", "refactor", "add", "fix", "implement", "update", "modify",
    "generate", "build", "deploy",
  ],
  protectRecentMessages: 12,
  toolResultTruncateChars: 4000,
  toolResultTruncateKeepChars: 800,
  trimToolDescriptions: false,
  toolDescriptionMaxChars: 300,
  toonContext: true,
  toonMinChars: 1200,
  toonMinSavingsRatio: 0.10,
};

async function loadStats(cwd: string): Promise<LazyStats> {
  try {
    const raw = await readFile(join(cwd, CONFIG_DIR_NAME, "lazy-context", "stats.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<LazyStats>;
    return {
      requests: Number(parsed.requests) || 0,
      originalChars: Number(parsed.originalChars) || 0,
      optimizedChars: Number(parsed.optimizedChars) || 0,
      savedChars: Number(parsed.savedChars) || 0,
      originalTokens: Number(parsed.originalTokens) || Math.round((Number(parsed.originalChars) || 0) / 4),
      optimazedTokens: Number(parsed.optimazedTokens) || Math.round((Number(parsed.optimizedChars) || 0) / 4),
      savedTokens: Number(parsed.savedTokens) || Math.round((Number(parsed.savedChars) || 0) / 4),
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return { requests: 0, originalChars: 0, optimizedChars: 0, savedChars: 0, originalTokens: 0, optimazedTokens: 0, savedTokens: 0 };
  }
}

async function saveStats(cwd: string, stats: LazyStats): Promise<void> {
  const directory = join(cwd, CONFIG_DIR_NAME, "lazy-context");
  const file = join(directory, "stats.json");
  const temp = `${file}.tmp`;
  await mkdir(directory, { recursive: true });
  await writeFile(temp, `${JSON.stringify({ version: 1, ...stats }, null, 2)}
`, "utf8");
  await rename(temp, file);
}

async function loadConfig(cwd: string, ctx: ExtensionContext): Promise<LazyConfig> {
  if (!ctx.isProjectTrusted()) return { ...DEFAULT_CONFIG };
  const path = join(cwd, CONFIG_DIR_NAME, "lazy-context.json");
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// ---------------------------------------------------------------------------
// Lazy Tools — decide qual subconjunto de tools ativar por prompt
// ---------------------------------------------------------------------------

function detectWriteIntent(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

// So alterna tools que a extensao conhece (config.fullTools). Qualquer tool
// fora dessa lista (de outra extensao, por exemplo) e sempre mantida ativa —
// nunca desativamos algo que nao sabemos para que serve.
function decideToolSet(promptText: string, allToolNames: string[], config: LazyConfig): string[] {
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

function sameToolSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((t) => sa.has(t));
}

// NOTA: a primeira versao tentava reconstruir o ultimo prompt a partir de
// ctx.sessionManager.getEntries(), adivinhando o shape de SessionEntry sem
// confirmacao. Isso falhava silenciosamente (sempre retornava "", entao o
// toolset nunca era reduzido). O jeito correto e documentado de capturar o
// prompt cru e o evento "input" (event.text), guardado aqui em closure e
// consumido por before_agent_start logo em seguida na mesma sequencia.

// ---------------------------------------------------------------------------
// Lazy Context — poda tool_results antigos e grandes, nao-destrutivo
// ---------------------------------------------------------------------------

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

function pruneMessages(messages: any[], config: LazyConfig): { messages: any[]; removedChars: number; toonSavedChars: number } {
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

// ---------------------------------------------------------------------------
// Lazy Tool Specs — corta so a description das tools no payload ja
// serializado pro provider (event.payload em before_provider_request).
// Cobre os 3 formatos dominantes; qualquer shape nao reconhecido passa
// intocado (fail-safe: nunca quebra a chamada por nao reconhecer o formato).
// ---------------------------------------------------------------------------

function trimDescription(desc: unknown, maxChars: number, onTrim: (charsSaved: number) => void): unknown {
  if (typeof desc !== "string" || desc.length <= maxChars) return desc;
  onTrim(desc.length - maxChars);
  return `${desc.slice(0, maxChars)} […]`;
}

function trimToolDescriptionsInPayload(
  payload: any,
  maxChars: number,
): { payload: any; trimmedCount: number; charsSaved: number } {
  if (!payload || !Array.isArray(payload.tools)) {
    return { payload, trimmedCount: 0, charsSaved: 0 };
  }

  let trimmedCount = 0;
  let charsSaved = 0;
  const onTrim = (n: number) => {
    trimmedCount++;
    charsSaved += n;
  };

  const newTools = payload.tools.map((tool: any) => {
    if (!tool || typeof tool !== "object") return tool;

    // Gemini-style: { functionDeclarations: [{ name, description, parameters }] }
    if (Array.isArray(tool.functionDeclarations)) {
      return {
        ...tool,
        functionDeclarations: tool.functionDeclarations.map((fd: any) =>
          fd && typeof fd.description === "string"
            ? { ...fd, description: trimDescription(fd.description, maxChars, onTrim) }
            : fd,
        ),
      };
    }

    // OpenAI-style nested: { type: "function", function: { name, description, parameters } }
    if (tool.function && typeof tool.function.description === "string") {
      return { ...tool, function: { ...tool.function, description: trimDescription(tool.function.description, maxChars, onTrim) } };
    }

    // Anthropic-style / OpenAI Responses flat: { name, description, input_schema|parameters }
    if (typeof tool.description === "string") {
      return { ...tool, description: trimDescription(tool.description, maxChars, onTrim) };
    }

    return tool; // shape nao reconhecido: nao mexe
  });

  return { payload: { ...payload, tools: newTools }, trimmedCount, charsSaved };
}

// ---------------------------------------------------------------------------
// Status de rodape
// ---------------------------------------------------------------------------

function formatStats(stats: LazyStats): string {
  const saved = stats.savedChars;
  const ratio = stats.originalChars > 0 ? (saved / stats.originalChars * 100).toFixed(1) : "0.0";
  return `${stats.requests} req., ${Math.round(saved / 1024)}kb / ~${Math.round(saved / 4)} tokens, ${ratio}%`;
}

function setLazyStatus(ctx: ExtensionContext, activeTools: number, totalTools: number, charsSaved: number): void {
  const kb = charsSaved > 0 ? `${Math.round(charsSaved / 1024)}kb` : "0kb";
  // Estimativa simples: em média, quatro caracteres correspondem a um token.
  const tokens = Math.round(charsSaved / 4);
  ctx.ui.setStatus(
    "lazy-context",
    `LAZY: tools ${activeTools}/${totalTools} · ${kb} economizados · TOK: ${tokens}`,
  );
}

// ---------------------------------------------------------------------------
// Extensao
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let config: LazyConfig = DEFAULT_CONFIG;
  let cwd = "";
  let totalCharsSaved = 0;
  let lastActiveCount = 0;
  let lastTotalCount = 0;
  let pendingPromptText = "";
  let stats: LazyStats = { requests: 0, originalChars: 0, optimizedChars: 0, savedChars: 0, originalTokens: 0, optimazedTokens: 0, savedTokens: 0 };
  let statsWriteQueue = Promise.resolve();

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    config = await loadConfig(cwd, ctx);
    stats = await loadStats(cwd);
    if (!config.enabled) {
      ctx.ui.setStatus("lazy-context", "LAZY: off");
      return;
    }
    const all = pi.getAllTools().map((t) => t.name);
    const active = pi.getActiveTools();
    lastTotalCount = all.length;
    lastActiveCount = active.length;
    setLazyStatus(ctx, lastActiveCount, lastTotalCount, 0);
  });

  // Captura o texto cru do prompt assim que o usuario envia — antes de
  // qualquer expansao de skill/template. So leitura: nunca intercepta,
  // transforma ou bloqueia (retornar nada == "continue", o comportamento
  // default e documentado).
  pi.on("input", async (event) => {
    pendingPromptText = typeof event.text === "string" ? event.text : "";
  });

  // Uma vez por prompt do usuario, antes do loop de agente comecar — nunca
  // no meio de um encadeamento de tool calls (evita trocar o toolset com
  // chamadas pendentes em voo).
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!config.enabled || !config.lazyTools) return;

    const promptText = pendingPromptText;
    const allToolNames = pi.getAllTools().map((t) => t.name);
    const desired = decideToolSet(promptText, allToolNames, config);
    const current = pi.getActiveTools();

    if (!sameToolSet(current, desired)) {
      pi.setActiveTools(desired);
      lastActiveCount = desired.length;
      lastTotalCount = allToolNames.length;
      setLazyStatus(ctx, lastActiveCount, lastTotalCount, totalCharsSaved);
    }
  });

  // A cada chamada ao LLM dentro do loop do agente — poda tool_results
  // antigos e grandes, sem tocar a sessao persistida.
  pi.on("context", async (event, ctx) => {
    if (!config.enabled || !config.lazyContext) return;

    const originalChars = JSON.stringify(event.messages).length;
    const { messages, removedChars, toonSavedChars } = pruneMessages(event.messages, config);
    const optimizedChars = JSON.stringify(messages).length;
    const measuredSaved = Math.max(0, originalChars - optimizedChars);
    stats.requests += 1;
    stats.originalChars += originalChars;
    stats.optimizedChars += optimizedChars;
    stats.savedChars += measuredSaved;
    stats.originalTokens += Math.round(originalChars / 4);
    stats.optimazedTokens += Math.round(optimizedChars / 4);
    stats.savedTokens += Math.round(measuredSaved / 4);
    stats.updatedAt = new Date().toISOString();
    statsWriteQueue = statsWriteQueue.then(() => saveStats(cwd, stats)).catch(() => undefined);

    if (removedChars === 0 && toonSavedChars === 0) return;

    totalCharsSaved += removedChars + toonSavedChars;
    setLazyStatus(ctx, lastActiveCount, lastTotalCount, totalCharsSaved);
    return { messages };
  });

  // Ultima etapa da cadeia: o payload ja esta serializado pro provider ativo.
  // So corta description de tools que sobraram apos o filtro do item 1 — os
  // dois mecanismos se somam (menos tools ativas + descriptions menores nas
  // que restam), mas trimToolDescriptions e opt-in por causa do risco
  // explicado no topo do arquivo.
  pi.on("before_provider_request", async (event, ctx) => {
    if (!config.enabled || !config.trimToolDescriptions) return;

    const { payload, trimmedCount, charsSaved } = trimToolDescriptionsInPayload(
      event.payload,
      config.toolDescriptionMaxChars,
    );
    if (trimmedCount === 0) return;

    totalCharsSaved += charsSaved;
    setLazyStatus(ctx, lastActiveCount, lastTotalCount, totalCharsSaved);
    return payload;
  });

  pi.registerCommand("lazy", {
    description: "Controla a reducao automatica de tools e contexto (lazy-context)",
    getArgumentCompletions: (prefix: string) => {
      const subcommands = ["status", "on", "off", "stats", "trim-specs on", "trim-specs off"];
      const filtered = subcommands.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const sub = args.trim();

      switch (sub) {
        case "on": {
          config.enabled = true;
          ctx.ui.notify("lazy-context: ativado", "info");
          setLazyStatus(ctx, lastActiveCount, lastTotalCount, totalCharsSaved);
          break;
        }
        case "off": {
          config.enabled = false;
          const all = pi.getAllTools().map((t) => t.name);
          pi.setActiveTools(all); // restaura toolset completo
          ctx.ui.setStatus("lazy-context", "LAZY: off");
          ctx.ui.notify("lazy-context: desativado, toolset completo restaurado", "info");
          break;
        }
        case "stats": {
          const kb = (totalCharsSaved / 1024).toFixed(1);
          ctx.ui.notify(
            `lazy-context stats — tools ativas: ${lastActiveCount}/${lastTotalCount}, ` +
              `sessao: ~${kb}kb (~${Math.round(totalCharsSaved / 4)} tokens), ` +
              `acumulado: ${formatStats(stats)}`,
            "info",
          );
          break;
        }
        case "trim-specs on": {
          config.trimToolDescriptions = true;
          ctx.ui.notify(
            "lazy-context: corte de description de tools ATIVADO (opt-in, risco: pode encurtar avisos de uso das tools)",
            "warning",
          );
          break;
        }
        case "trim-specs off": {
          config.trimToolDescriptions = false;
          ctx.ui.notify("lazy-context: corte de description de tools desativado", "info");
          break;
        }

        case "status":
        default: {
          const state = config.enabled ? "ativado" : "desativado";
          ctx.ui.notify(
            `lazy-context: ${state} — lazyTools=${config.lazyTools}, lazyContext=${config.lazyContext}, ` +
              `trimToolDescriptions=${config.trimToolDescriptions}. ` +
              `Uso: /lazy status | on | off | stats | trim-specs on | trim-specs off`,
            "info",
          );
        }
      }
    },
  });
}