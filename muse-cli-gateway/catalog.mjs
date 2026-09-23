// API list prices checked 2026-09-22. These are estimates, not subscription bills.
export const MODEL = 'muse-spark-1.3';
export const CONTRIBUTOR_MODEL = 'muse-spark-1.3-contributor';
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const SAFE_CONTEXT = 384000;
export const MAX_PROMPT_BYTES = 1400000;
export const MODELS = new Map([
  [MODEL, { id: MODEL, name: 'Muse Spark 1.3', contributor: false, input: 1.25, cacheRead: .15, output: 4.25 }],
  [CONTRIBUTOR_MODEL, { id: CONTRIBUTOR_MODEL, name: 'Muse Spark 1.3 Contributor', contributor: true, input: .10, cacheRead: .002, output: .20 }],
]);
export function listPriceCost(model, usage) {
  const rates = MODELS.get(model);
  if (!rates || !usage) return null;
  const cached = usage.prompt_tokens_details.cached_tokens;
  return ((usage.prompt_tokens - cached) * rates.input + cached * rates.cacheRead + usage.completion_tokens * rates.output) / 1e6;
}
