export type LazyStats = {
  requests: number;
  originalChars: number;
  optimizedChars: number;
  savedChars: number;
  originalTokens: number;
  optimizedTokens: number;
  savedTokens: number;
  updatedAt?: string;
};


export function formatCompactNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute < 1000) return String(Math.round(value));
  const units = [[1_000_000_000, "B"], [1_000_000, "M"], [1_000, "K"]] as const;
  const unit = units.find(([size]) => absolute >= size);
  if (!unit) return String(Math.round(value));
  const compact = (value / unit[0]).toFixed(1).replace(/\.0$/, "");
  return `${compact}${unit[1]}`;
}

export function formatSavedSize(chars: number): string {
  return formatCompactNumber(Math.max(0, chars));
}

export function formatStats(stats: LazyStats): string {
  const saved = stats.savedChars;
  const ratio = stats.originalChars > 0 ? (saved / stats.originalChars * 100).toFixed(1) : "0.0";
  return `${stats.requests} req., ${formatSavedSize(saved)} / ~${formatCompactNumber(stats.savedTokens)} tokens, ${ratio}%`;
}

