import { inspect } from "node:util";

// CLI JSON may contain numeric strings or malformed counters. Never emit
// NaN/Infinity (JSON null), negative counts, or fractional token counts.
export function usageToken(value) {
  if (typeof value !== "number" && typeof value !== "string") return 0;
  const token = Math.trunc(Number(value));
  return Number.isSafeInteger(token) && token > 0 ? token : 0;
}

export function normalizedClaudeUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const fresh = usageToken(usage.input_tokens);
  const cw = usageToken(usage.cache_creation_input_tokens);
  const cr = usageToken(usage.cache_read_input_tokens);
  const out = usageToken(usage.output_tokens);
  // Preserve the existing accounting and field shape: cache reads are part
  // of prompt_tokens; cache writes are separate but included in total_tokens.
  return {
    prompt_tokens: fresh + cr,
    prompt_tokens_details: { cached_tokens: cr },
    cache_creation_input_tokens: cw,
    completion_tokens: out,
    total_tokens: fresh + cw + cr + out,
  };
}

export function rawAgyUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  return {
    input_tokens: usageToken(usage.input_tokens),
    cache_read_tokens: usageToken(usage.cache_read_tokens),
    output_tokens: usageToken(usage.output_tokens),
    thinking_tokens: usageToken(usage.thinking_tokens),
  };
}

export function normalizedAgyUsage(usage) {
  const raw = rawAgyUsage(usage);
  if (!raw) return undefined;
  // agy excludes cache reads from input and bills thinking as output.
  const promptTokens = raw.input_tokens + raw.cache_read_tokens;
  const completionTokens = raw.output_tokens + raw.thinking_tokens;
  return {
    prompt_tokens: promptTokens,
    prompt_tokens_details: { cached_tokens: raw.cache_read_tokens },
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

export function truncateText(value, max) {
  let text;
  if (typeof value === "string") text = value;
  else if (value === null || value === undefined) text = "";
  else if (!(value instanceof Error)) {
    try { text = JSON.stringify(value); } catch { /* inspect handles cycles/BigInt */ }
  }
  if (typeof text !== "string") {
    try {
      text = inspect(value, {
        depth: 4, maxArrayLength: 20, maxStringLength: max,
        breakLength: Infinity, compact: true, customInspect: false, getters: false,
      });
    } catch { text = "[Unprintable value]"; }
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
