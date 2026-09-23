import assert from "node:assert/strict";
import test from "node:test";
import { usageToken, normalizedClaudeUsage, contextClaudeUsage, rawAgyUsage, normalizedAgyUsage, contextAgyUsage, truncateText } from "./cli-output.mjs";

test("token counters accept numeric strings and reject malformed values", () => {
  for (const value of ["abc", "Infinity", NaN, Infinity, -Infinity, -5, null, undefined, {}, [], true, Number.MAX_VALUE]) {
    assert.equal(usageToken(value), 0);
  }
  assert.equal(usageToken("12"), 12);
  assert.equal(usageToken(10.7), 10);
});

test("Claude preserves cache accounting and explicit zero cache fields", () => {
  assert.deepEqual(normalizedClaudeUsage({input_tokens:100, cache_read_input_tokens:900, cache_creation_input_tokens:50, output_tokens:20}), {
    prompt_tokens:1000, prompt_tokens_details:{cached_tokens:900},
    cache_creation_input_tokens:50, completion_tokens:20, total_tokens:1070,
  });
  assert.deepEqual(normalizedClaudeUsage({input_tokens:"abc", cache_read_input_tokens:-5, cache_creation_input_tokens:Infinity, output_tokens:20.7}), {
    prompt_tokens:0, prompt_tokens_details:{cached_tokens:0},
    cache_creation_input_tokens:0, completion_tokens:20, total_tokens:20,
  });
  assert.equal(normalizedClaudeUsage(null), undefined);
});

test("agy normalized and raw counters agree, without counting thinking twice", () => {
  const usage = {input_tokens:"100", cache_read_tokens:900, output_tokens:70, thinking_tokens:50};
  assert.deepEqual(normalizedAgyUsage(usage), {
    prompt_tokens:1000, prompt_tokens_details:{cached_tokens:900}, completion_tokens:70, total_tokens:1070,
  });
  assert.deepEqual(rawAgyUsage(usage), {input_tokens:100, cache_read_tokens:900, output_tokens:70, thinking_tokens:50});
  const bad = {input_tokens:"abc", cache_read_tokens:-2, output_tokens:20.7, thinking_tokens:Infinity};
  assert.deepEqual(rawAgyUsage(bad), {input_tokens:0, cache_read_tokens:0, output_tokens:20, thinking_tokens:0});
  assert.equal(normalizedAgyUsage(bad).total_tokens, 20);
  assert.equal(normalizedAgyUsage(null), undefined);
  assert.equal(rawAgyUsage(null), undefined);
});

test("tool diagnostics preserve ordinary objects, errors and primitive text", () => {
  assert.equal(truncateText({error:"ENOENT",path:"/tmp/x",code:2},300), '{"error":"ENOENT","path":"/tmp/x","code":2}');
  assert.match(truncateText(new Error("shell exited 127"),300), /Error: shell exited 127/);
  assert.equal(truncateText("file not found",300), "file not found");
  assert.equal(truncateText(null,300), "");
  assert.equal(truncateText(42,300), "42");
  assert.equal(truncateText("abcdef",3), "abc…");
});

test("unusual tool diagnostics cannot throw or become undefined", () => {
  const cyclic = {error:"ENOENT"}; cyclic.self = cyclic;
  assert.match(truncateText(cyclic,300), /ENOENT/);
  assert.match(truncateText(cyclic,300), /Circular/);
  assert.match(truncateText({code:2n},300), /2n/);
  assert.equal(typeof truncateText({toJSON:()=>undefined},300), "string");
  assert.equal(typeof truncateText({toJSON:()=>{throw Error("no JSON");}},300), "string");
  assert.equal(typeof truncateText(Object.create(null),300), "string");
  assert.ok(truncateText({error:"x".repeat(2000)},300).length <= 301);
});

// 43 model responses in retained agy conversation ac0d125f...; protobuf
// output=47488, thinking=26507, response=20981; old gateway returned 73995.
test("retained agy telemetry counts 26,507 thinking tokens once", () => {
  const r=normalizedAgyUsage({input_tokens:225189,cache_read_tokens:2931913,output_tokens:47488,thinking_tokens:26507});
  assert.equal(r.completion_tokens,47488);
  assert.equal(r.total_tokens,3204590);
});

// agy 1.2.9 probe, 2026-09-23: 15 model calls; first call 13,081 input,
// result.usage summed to 153,535 input + 117,595 cache reads.
test("agy reports the first call's prompt as context, keeping cumulative output", () => {
  const first = {input_tokens:13081, output_tokens:1256, thinking_tokens:1158, cache_read_tokens:0};
  const total = {input_tokens:153535, output_tokens:3872, thinking_tokens:2539, cache_read_tokens:117595};
  assert.deepEqual(contextAgyUsage(first, total), {
    prompt_tokens:13081, prompt_tokens_details:{cached_tokens:0}, completion_tokens:3872, total_tokens:16953,
  });
  assert.deepEqual(contextAgyUsage({input_tokens:100, cache_read_tokens:900, output_tokens:5}, null), {
    prompt_tokens:1000, prompt_tokens_details:{cached_tokens:900}, completion_tokens:5, total_tokens:1005,
  });
});

test("agy without per-call usage falls back to the result totals", () => {
  const total = {input_tokens:100, cache_read_tokens:900, output_tokens:70};
  assert.deepEqual(contextAgyUsage(null, total), normalizedAgyUsage(total));
  assert.deepEqual(contextAgyUsage({input_tokens:0, cache_read_tokens:"x"}, total), normalizedAgyUsage(total));
  assert.equal(contextAgyUsage(null, null), undefined);
});

// Claude gateway request 2026-09-23 (3 model calls): first call 2 fresh +
// 63,388 cache writes + 1,384 cache reads; result.usage summed to 6 fresh +
// 66,145 writes + 131,574 reads, which the old gateway reported as a
// 131,580-token prompt with the writes invisible to OpenClaw.
test("Claude reports the first call's full prompt, cache writes included", () => {
  const first = {input_tokens:2, cache_creation_input_tokens:63388, cache_read_input_tokens:1384, output_tokens:8};
  const total = {input_tokens:6, cache_creation_input_tokens:66145, cache_read_input_tokens:131574, output_tokens:470};
  const reported = contextClaudeUsage(first, total);
  assert.deepEqual(reported, {
    prompt_tokens:64774, prompt_tokens_details:{cached_tokens:1384, cache_write_tokens:63388},
    completion_tokens:470, total_tokens:65244,
  });
  // OpenClaw parseOpenAICompletionsUsage: input = prompt - cacheRead - cacheWrite.
  const d = reported.prompt_tokens_details;
  assert.equal(reported.prompt_tokens - d.cached_tokens - d.cache_write_tokens, 2);
});

test("Claude without per-call usage reports result totals in the same shape", () => {
  const total = {input_tokens:6, cache_creation_input_tokens:66145, cache_read_input_tokens:131574, output_tokens:470};
  assert.deepEqual(contextClaudeUsage(null, total), {
    prompt_tokens:197725, prompt_tokens_details:{cached_tokens:131574, cache_write_tokens:66145},
    completion_tokens:470, total_tokens:198195,
  });
  assert.equal(contextClaudeUsage(null, total).total_tokens, normalizedClaudeUsage(total).total_tokens);
  assert.deepEqual(contextClaudeUsage({input_tokens:"abc", cache_read_input_tokens:-1, output_tokens:3}, null), {
    prompt_tokens:0, prompt_tokens_details:{cached_tokens:0, cache_write_tokens:0}, completion_tokens:3, total_tokens:3,
  });
  assert.equal(contextClaudeUsage(null, null), undefined);
});
