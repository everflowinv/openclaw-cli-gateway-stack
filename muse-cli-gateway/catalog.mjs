// API list prices checked 2026-10-12. These are estimates, not subscription bills.
export const MODEL = 'muse-spark-1.3';
export const CONTRIBUTOR_MODEL = 'muse-spark-1.3-contributor';
export const WONDER_MODEL = 'muse-wonder-1.0';
export const WONDER_FULL_MODEL = 'muse-wonder-full-1.0';
// Muse 1.4.7's native reasoning tiers, passed through unchanged.
export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const SAFE_CONTEXT = 384000;
export const MAX_OUTPUT_TOKENS = 128000;
// 2026-10-12 probes on 1.4.7 (all four models, random-marker preservation
// + journal byte verification): English prompts pass fully preserved at
// 1.9MB (337k reported tokens); Contributor also passed CJK at 1.4MB
// (308k tokens). The CLI's
// own estimator hard-rejects first inputs it estimates above its 512k
// compaction budget (501,760 at the pinned 0.98); English probes at 2.09MB
// and above were rejected. 1,900,000 is the tested conservative byte cap,
// not an exact universal overflow boundary. Token-denser content inside
// the cap can still hit the estimator; that failure now maps to a clean
// 413 (see process.mjs). SAFE_CONTEXT stays at 384,000: the binding limit
// is the estimator, not reported tokens, and no content type verified a
// higher real-token budget.
export const MAX_PROMPT_BYTES = 1900000;
export const MODELS = new Map([
  [MODEL, { id: MODEL, name: 'Muse Spark 1.3', contributor: false, input: 1.25, cacheRead: .15, output: 4.25 }],
  [CONTRIBUTOR_MODEL, { id: CONTRIBUTOR_MODEL, name: 'Muse Spark 1.3 Contributor', contributor: true, input: .10, cacheRead: .002, output: .20 }],
  [WONDER_MODEL, { id: WONDER_MODEL, name: 'Muse Wonder 1.0', contributor: false, input: 4, cacheRead: .20, output: 20 }],
  // Meta offers Full only through subscriptions; no public per-token list price.
  [WONDER_FULL_MODEL, { id: WONDER_FULL_MODEL, name: 'Muse Wonder Full 1.0', contributor: false, input: null, cacheRead: null, output: null }],
]);
export function listPriceCost(model, usage) {
  const rates = MODELS.get(model);
  if (!rates || !usage || ![rates.input, rates.cacheRead, rates.output].every(Number.isFinite)) return null;
  const cached = usage.prompt_tokens_details.cached_tokens;
  return ((usage.prompt_tokens - cached) * rates.input + cached * rates.cacheRead + usage.completion_tokens * rates.output) / 1e6;
}
