import type { LazyConfig } from "./config.js";
import type { LazyStats } from "./stats.js";

export interface LazyRuntime {
  config: LazyConfig;
  cwd: string;
  totalCharsSaved: number;
  lastActiveCount: number;
  lastTotalCount: number;
  pendingPromptText: string;
  stats: LazyStats;
}
