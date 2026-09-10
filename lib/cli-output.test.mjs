import assert from "node:assert/strict";
import test from "node:test";
import { usageToken, normalizedClaudeUsage, rawAgyUsage, normalizedAgyUsage, truncateText } from "./cli-output.mjs";

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

test("agy normalized and raw counters agree, including billed thinking", () => {
  const usage = {input_tokens:"100", cache_read_tokens:900, output_tokens:20, thinking_tokens:50};
  assert.deepEqual(normalizedAgyUsage(usage), {
    prompt_tokens:1000, prompt_tokens_details:{cached_tokens:900}, completion_tokens:70, total_tokens:1070,
  });
  assert.deepEqual(rawAgyUsage(usage), {input_tokens:100, cache_read_tokens:900, output_tokens:20, thinking_tokens:50});
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
