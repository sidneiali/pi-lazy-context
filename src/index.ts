import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import { pruneMessages } from "./context.js";
import { registerLazyCommand } from "./menu.js";
import type { LazyRuntime } from "./runtime.js";
import { trimToolDescriptionsInPayload } from "./tool-specs.js";
import { decideToolSet, sameToolSet } from "./tools.js";

export default function (pi: ExtensionAPI) {
  const runtime: LazyRuntime = {
    config: { ...DEFAULT_CONFIG },
    cwd: "",
    initialized: false,
    totalCharsSaved: 0,
    lastActiveCount: 0,
    lastTotalCount: 0,
    pendingPromptText: "",
    stats: { requests: 0, originalChars: 0, optimizedChars: 0, savedChars: 0, originalTokens: 0, optimizedTokens: 0, savedTokens: 0 },
  };

  pi.on("session_start", async (_event, ctx) => {
    runtime.cwd = ctx.cwd;
    runtime.initialized = existsSync(join(ctx.cwd, ".pi", "lazy-context.json"));
    runtime.config = runtime.initialized ? await loadConfig(runtime.cwd, ctx) : { ...DEFAULT_CONFIG, enabled: false };
    if (!runtime.config.enabled) return;
    const all = pi.getAllTools().map((tool) => tool.name);
    runtime.lastTotalCount = all.length;
    runtime.lastActiveCount = pi.getActiveTools().length;
  });

  pi.on("input", async (event) => {
    if (!runtime.initialized) return;
    runtime.pendingPromptText = typeof event.text === "string" ? event.text : "";
  });

  pi.on("before_agent_start", async () => {
    if (!runtime.initialized || !runtime.config.enabled || !runtime.config.lazyTools) return;
    const allToolNames = pi.getAllTools().map((tool) => tool.name);
    const desired = decideToolSet(runtime.pendingPromptText, allToolNames, runtime.config);
    if (!sameToolSet(pi.getActiveTools(), desired)) {
      pi.setActiveTools(desired);
      runtime.lastActiveCount = desired.length;
      runtime.lastTotalCount = allToolNames.length;
    }
  });

  pi.on("context", async (event) => {
    if (!runtime.initialized || !runtime.config.enabled || !runtime.config.lazyContext) return;
    const originalChars = JSON.stringify(event.messages).length;
    const { messages, removedChars, toonSavedChars } = pruneMessages(event.messages, runtime.config);
    const optimizedChars = JSON.stringify(messages).length;
    const measuredSaved = Math.max(0, originalChars - optimizedChars);
    runtime.stats.requests += 1;
    runtime.stats.originalChars += originalChars;
    runtime.stats.optimizedChars += optimizedChars;
    runtime.stats.savedChars += measuredSaved;
    runtime.stats.originalTokens += Math.round(originalChars / 4);
    runtime.stats.optimizedTokens += Math.round(optimizedChars / 4);
    runtime.stats.savedTokens += Math.round(measuredSaved / 4);
    runtime.stats.updatedAt = new Date().toISOString();
    if (removedChars === 0 && toonSavedChars === 0) return;
    runtime.totalCharsSaved += measuredSaved;
    return { messages };
  });

  pi.on("before_provider_request", async (event) => {
    if (!runtime.initialized || !runtime.config.enabled || !runtime.config.trimToolDescriptions) return;
    const result = trimToolDescriptionsInPayload(event.payload, runtime.config.toolDescriptionMaxChars);
    if (result.trimmedCount === 0) return;
    runtime.totalCharsSaved += result.charsSaved;
    return result.payload;
  });

  registerLazyCommand(pi, runtime);
}
