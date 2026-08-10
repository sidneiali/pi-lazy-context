import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type LazyConfig = {
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

export const DEFAULT_CONFIG: LazyConfig = {
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

export async function initializeConfig(cwd: string): Promise<void> {
  const piDir = join(cwd, CONFIG_DIR_NAME);
  const configFile = join(piDir, "lazy-context.json");
  await mkdir(piDir, { recursive: true });
  if (!existsSync(configFile)) {
    await writeFile(configFile, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}
`, "utf8");
  }
}

export async function loadConfig(cwd: string, ctx: ExtensionContext): Promise<LazyConfig> {
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

