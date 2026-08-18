import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initializeConfig, loadConfig } from "./config.js";
import type { LazyRuntime } from "./runtime.js";
import { formatCompactNumber, formatSavedSize, formatStats } from "./stats.js";

export function registerLazyCommand(pi: ExtensionAPI, runtime: LazyRuntime): void {
  pi.registerCommand("lazy", {
    description: "Controla a reducao automatica de tools e contexto (lazy-context)",
    getArgumentCompletions: (prefix: string) => {
      const subcommands = ["init", "status", "on", "off", "stats", "trim-specs on", "trim-specs off"];
      const filtered = subcommands.filter((item) => item.startsWith(prefix)).map((item) => ({ value: item, label: item }));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const subcommand = args.trim();
      if (subcommand !== "init" && !runtime.initialized) {
        ctx.ui.notify("Execute /lazy init neste projeto antes de usar o pi-lazy-context.", "warning");
        return;
      }
      switch (subcommand) {
        case "init":
          await initializeConfig(ctx.cwd);
          runtime.cwd = ctx.cwd;
          runtime.initialized = true;
          runtime.config = await loadConfig(runtime.cwd, ctx);
          ctx.ui.notify("Configuração do pi-lazy-context inicializada em .pi/lazy-context.json.", "info");
          break;
        case "on":
          runtime.config.enabled = true;
          ctx.ui.notify("lazy-context: ativado", "info");
          break;
        case "off":
          runtime.config.enabled = false;
          pi.setActiveTools(pi.getAllTools().map((tool) => tool.name));
          ctx.ui.notify("lazy-context: desativado, toolset completo restaurado", "info");
          break;
        case "stats":
          ctx.ui.notify(
            `lazy-context stats — tools ativas: ${runtime.lastActiveCount}/${runtime.lastTotalCount}, ` +
              `acumulado: ~${formatSavedSize(runtime.totalCharsSaved)} (~${formatCompactNumber(runtime.stats.savedTokens)} tokens), ` +
              formatStats(runtime.stats),
            "info",
          );
          break;
        case "trim-specs on":
          runtime.config.trimToolDescriptions = true;
          ctx.ui.notify("lazy-context: corte de description de tools ATIVADO (opt-in, risco: pode encurtar avisos de uso das tools)", "warning");
          break;
        case "trim-specs off":
          runtime.config.trimToolDescriptions = false;
          ctx.ui.notify("lazy-context: corte de description de tools desativado", "info");
          break;
        case "status":
        default:
          ctx.ui.notify(
            `lazy-context: ${runtime.config.enabled ? "ativado" : "desativado"} — ` +
              `lazyTools=${runtime.config.lazyTools}, lazyContext=${runtime.config.lazyContext}, ` +
              `trimToolDescriptions=${runtime.config.trimToolDescriptions}. ` +
              "Uso: /lazy init | status | on | off | stats | trim-specs on | trim-specs off",
            "info",
          );
      }
    },
  });
}
