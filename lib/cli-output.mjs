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

// Same summing problem as contextAgyUsage: result.usage adds up every model
// call, so a tool-heavy run reported millions of prompt tokens for a prompt
// under 950k and OpenClaw compacted needlessly. Report the first call's full
// prompt instead. OpenClaw's completions parser only reads cache writes from
// prompt_tokens_details (subtracted from prompt_tokens), so writes go there
// and into prompt_tokens; the top-level cache_creation_input_tokens that
// normalizedClaudeUsage keeps for the log is invisible to it.
export function contextClaudeUsage(firstCallUsage, cumulativeUsage) {
  const first = firstCallUsage && typeof firstCallUsage === "object" ? firstCallUsage : null;
  const total = cumulativeUsage && typeof cumulativeUsage === "object" ? cumulativeUsage : null;
  const source = first || total;
  if (!source) return undefined;
  const fresh = usageToken(source.input_tokens);
  const cw = usageToken(source.cache_creation_input_tokens);
  const cr = usageToken(source.cache_read_input_tokens);
  const promptTokens = fresh + cw + cr;
  // Assistant events carry interim output counts; the result total is final.
  const completionTokens = usageToken((total || source).output_tokens);
  return {
    prompt_tokens: promptTokens,
    prompt_tokens_details: { cached_tokens: cr, cache_write_tokens: cw },
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
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
  // ModelUsageStats.output_tokens already includes thinking_output_tokens.
  // Verified against agy 1.2.0 conversation DB: output = thinking + response.
  // Keep thinking as a detail; adding it here bills the same tokens twice.
  const promptTokens = raw.input_tokens + raw.cache_read_tokens;
  const completionTokens = raw.output_tokens;
  return {
    prompt_tokens: promptTokens,
    prompt_tokens_details: { cached_tokens: raw.cache_read_tokens },
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

// agy's result.usage sums every model call in the run, and each tool
// round-trip re-sends the whole transcript: a 15-step request reported
// 271,130 prompt tokens for a 13,081-token prompt. OpenClaw sizes the session
// context from prompt_tokens, so that sum triggered needless compaction.
// The gateway sends the full conversation fresh on every request and the
// run's tool traffic never enters OpenClaw's transcript, so the first call's
// prompt is the context OpenClaw will resend. Report that; completion stays
// cumulative. Billing totals remain in the gateway log's usage/usage_raw.
export function contextAgyUsage(firstCallUsage, cumulativeUsage) {
  const total = normalizedAgyUsage(cumulativeUsage);
  const first = rawAgyUsage(firstCallUsage);
  const promptTokens = first ? first.input_tokens + first.cache_read_tokens : 0;
  if (promptTokens === 0) return total;
  const completionTokens = total ? total.completion_tokens : first.output_tokens;
  return {
    prompt_tokens: promptTokens,
    prompt_tokens_details: { cached_tokens: first.cache_read_tokens },
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
