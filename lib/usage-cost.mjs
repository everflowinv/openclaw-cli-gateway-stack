import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
let saved, stamp = 0;
function catalog() {
  if (Date.now() - stamp < 60000 && saved) return saved;
  stamp = Date.now();
  try { saved = JSON.parse(fs.readFileSync(process.env.CLI_GATEWAY_PRICE_CONFIG || path.join(os.homedir(), '.openclaw/openclaw.json'), 'utf8')).models?.providers || {}; }
  catch { saved = {}; }
  return saved;
}
export function priceUsage(cost, usage, { perCall = false } = {}) {
  if (!cost || !usage || typeof cost !== 'object') return null;
  const write = usage.prompt_tokens_details?.cache_write_tokens ?? usage.cache_creation_input_tokens ?? 0;
  const read = usage.prompt_tokens_details?.cached_tokens ?? 0;
  // Legacy Claude log prompt_tokens excludes cache writes; canonical detail
  // cache_write_tokens declares that writes are already inside prompt_tokens.
  const fresh = usage.prompt_tokens - read - (usage.prompt_tokens_details?.cache_write_tokens !== undefined ? write : 0);
  const values = [fresh, write, read, usage.completion_tokens];
  if (!values.every(x => Number.isSafeInteger(x) && x >= 0)) return null;
  let rates = cost;
  if (cost.tieredPricing?.length) {
    if (!perCall) return null; // A run total cannot choose a per-context tier.
    for (const tier of [...cost.tieredPricing].sort((a,b) => a.range[0]-b.range[0])) {
      if (fresh + write + read >= tier.range[0]) rates = { ...cost, ...tier };
    }
  }
  const keys = ['input', 'cacheWrite', 'cacheRead', 'output'];
  let total = 0;
  for (let i=0;i<4;i++) {
    if (!values[i]) continue;
    if (!Number.isFinite(rates[keys[i]]) || rates[keys[i]] < 0) return null;
    total += values[i]*rates[keys[i]]/1e6;
  }
  return total;
}
export function estimateUsageCost(provider, model, usage, { perCall = false, cliCost } = {}) {
  if (Number.isFinite(cliCost) && cliCost >= 0) return { estimatedCostUsd: cliCost, costBasis: 'cli-reported-api-equivalent-not-subscription-charge' };
  const cost = catalog()[provider]?.models?.find(m => m.id === model)?.cost;
  const estimate = priceUsage(cost, usage, { perCall });
  return { estimatedCostUsd: estimate, costBasis: estimate === null ? 'unpriced-or-unknown-tier' : 'local-catalog-api-equivalent-not-subscription-charge' };
}
