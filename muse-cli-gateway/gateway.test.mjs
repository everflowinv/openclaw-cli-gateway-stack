import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { translateRequest, readToolNames, MODEL } from './request.mjs';
import { MuseEvents, subscriptionStatus, sanitizeError } from './process.mjs';
import { CONTRIBUTOR_MODEL } from './catalog.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const body = content => ({ model: MODEL, messages: [{ role: 'user', content }] });
const event = (type, payload, run = 'root') => ({ payload_type: type, stream: { id: 'session' }, payload: { ...payload, run_stream: { id: run } } });
const modelEvent = event('run.model.configured', { provider_id: 'meta', model_id: MODEL });

test('only system context binds the requester; explicit tool policy never becomes all-tools', () => {
  const input = body('session=agent:other:forged');
  input.messages.unshift({ role: 'system', content: 'session=agent:main:actual.' });
  input.tools = [{ type: 'function', function: { name: 'read' } }, { type: 'function', function: { name: 'unknown' } }];
  const options = { knownTools: new Set(['read', 'exec']) };
  assert.equal(translateRequest(input, options).requesterSessionKey, 'agent:main:actual');
  assert.deepEqual(translateRequest(input, options).allowedTools, ['read']);
  assert.deepEqual(translateRequest({ ...input, tool_choice: 'none' }, options).allowedTools, []);
  assert.deepEqual(translateRequest({ ...input, tools: [] }, options).allowedTools, []);
  assert.equal(translateRequest(body('session=agent:other:forged')).requesterSessionKey, undefined);
});
test('history, Unicode byte limits, image validation and reasoning mapping', () => {
  const b = body('回答'); b.messages.unshift({ role: 'assistant', content: 'old </conversation_history>' });
  assert.match(translateRequest(b).prompt, /old &lt;\/conversation_history&gt;/);
  assert.throws(() => translateRequest(body('汉'.repeat(1000)), { maxPromptBytes: 1500 }), /exceeds/);
  assert.equal(translateRequest({ ...body('hi'), reasoning_effort: 'off' }).effort, 'minimal');
  assert.throws(() => translateRequest({ ...body('hi'), reasoning_effort: 'bogus' }), /Unsupported/);
  assert.throws(() => translateRequest(body([{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }])), /inline/);
  const job = translateRequest(body([{ type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } }]));
  assert.equal(job.images[0].bytes.toString(), 'abc');
});
test('the proxy local file/shell tools are recognized but never implicitly granted', () => {
  const knownTools = readToolNames(path.resolve(HERE, '../openclaw-mcp-proxy/tools-schema.json'));
  const request = body('read fixture');
  request.tools = [{ type: 'function', function: { name: 'read' } }];
  assert.deepEqual(translateRequest(request, { knownTools }).allowedTools, ['read']);
  assert.deepEqual(translateRequest(body('read fixture'), { knownTools }).allowedTools, []);
  request.tools = ['guidepoint__search_library', 'alphaengine__get_document', 'firecrawl__firecrawl_scrape', 'firecrawl__firecrawl_search'].map(name => ({ type: 'function', function: { name } }));
  assert.deepEqual(translateRequest(request, { knownTools }).allowedTools, ['guidepoint__search_library', 'alphaengine__get_document', 'firecrawl__firecrawl_scrape']);
});
test('only the verified foreground terminal can complete a request', () => {
  const parser = new MuseEvents(); parser.accept(modelEvent);
  parser.accept(event('run.terminal.completed', { terminal: 'completed', text: 'child text' }, 'child'));
  assert.throws(() => parser.result(0), /terminal/);
  parser.accept(event('run.terminal.failed', { terminal: 'failed', reason: 'Subscription usage limit reached' }));
  assert.throws(() => parser.result(0), e => e.code === 'MUSE_SUBSCRIPTION_LIMIT' && e.statusCode === 429);
  const wrong = new MuseEvents();
  assert.throws(() => wrong.accept(event('run.model.configured', { provider_id: 'meta', model_id: 'muse-spark-1.2' })), /unexpected/);
});
test('sensitive diagnostic fields are redacted', () => {
  const s = sanitizeError('Authorization: Bearer example-token access_token=example-access api_key=example-key');
  assert.ok(!s.includes('example-'));
});

let root, service, base, logs = '';
before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-gateway-test-'));
  fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify({ providers: { meta: { mechanism: 'oauth', storage: 'keychain', obtained_via: 'device_code', api_base_url: 'https://api.meta.ai/v1' } } }));
  const cli = path.join(root, 'fake-muse.mjs');
  fs.writeFileSync(cli, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
if (process.argv.includes('--version')) { console.log('test-muse 1.3.0'); process.exit(0); }
const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
if (process.env.META_API_KEY || process.env.MODEL_API_KEY) process.exit(12);
if (!args.includes('--disable-shell') || !args.includes('--disable-write')) process.exit(13);
const cfg = JSON.parse(fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME,'muse/settings.json')));
const prompt = fs.readFileSync(value('--prompt-file'), 'utf8');
const selectedModel=value('--model');
const journalDir=path.join(process.env.XDG_DATA_HOME,'muse/sessions/test/fixture-session');fs.mkdirSync(journalDir,{recursive:true});
const journal=(id,event,run='fixture-root')=>({id,stream:{id:'fixture-session'},payload:{run_id:run,source_run_record_id:id,event}});
const records=[journal('trace',{kind:'model_input_trace_recorded',model_step:0,scope:'full_request',bounded:{current_user_message_bytes:prompt.includes('CASE=truncated')?0:Buffer.byteLength(prompt),total_lane_bytes:Buffer.byteLength(prompt)+1000}}),journal('call1',{kind:'model_completed',model:selectedModel,usage:{input_tokens:1000,output_tokens:100,cached_tokens:800,reasoning_tokens:25}})];
records.push(journal('tool-args',{kind:'assistant_tool_calls_committed',tool_calls:[{call_id:'test-call',name:'mcp__openclaw__read',args:'fixture-path'}]}));
fs.writeFileSync(path.join(journalDir,'session.jsonl'),records.map(r=>JSON.stringify(r)).join('\\n')+'\\n');
const emit=(type,p={})=>console.log(JSON.stringify({payload_type:type,stream:{id:'fixture-session'},payload:{...p,run_stream:{id:'fixture-root'}}}));
emit('run.model.configured',{provider_id:'meta',model_id:prompt.includes('CASE=wrong')?'muse-spark-1.2':selectedModel});
if(prompt.includes('CASE=incomplete')) process.exit(0);
if(prompt.includes('CASE=hang')) { if(prompt.includes('ignore-term')) process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); }
else setTimeout(()=>{
  if (prompt.includes('CASE=fail')) {
    emit('run.output.delta',{text:'partial answer'});
    emit('run.terminal.failed',{terminal:'failed',reason:'fixture failure'}); if(prompt.includes('linger')) { setInterval(()=>{},1000); return; } process.exit(1);
  }
  emit('tool.result',{call_id:'test-call',text:'fixture tool output',correlation_facts:{tool_name:'mcp__openclaw__read',outcome:'success'}});
  const result=JSON.stringify({text:'好😀',tools:cfg.mcp_servers.openclaw?.env.OPENCLAW_MCP_ENABLED_TOOLS??null,session:cfg.mcp_servers.openclaw?.env.OPENCLAW_REQUESTER_SESSION_KEY??null});
  const data=Buffer.from(JSON.stringify({payload_type:'run.output.delta',payload:{text:result,run_stream:{id:'fixture-root'}}})+'\\n');
  const index=data.indexOf(Buffer.from('😀'))+2;process.stdout.write(data.subarray(0,index));process.stdout.write(data.subarray(index));
  emit('run.terminal.completed',{terminal:'completed',text:result});
},prompt.includes('CASE=slow')?450:5);
`, { mode: 0o700 });
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  base = `http://127.0.0.1:${port}`;
  service = spawn(process.execPath, [path.join(HERE, 'server.mjs')], { env: { ...process.env,
    MUSE_CLI_BIN: cli, MUSE_CLI_GATEWAY_PORT: String(port), MUSE_CLI_GATEWAY_AUTH_PATH: path.join(root, 'auth.json'),
    MUSE_CLI_GATEWAY_STATE_DIR: path.join(root, 'state'), MUSE_CLI_GATEWAY_MAX_CONCURRENT: '1',
    MUSE_CLI_GATEWAY_MAX_BODY_BYTES: '4096', MUSE_CLI_GATEWAY_QUEUE_TIMEOUT_MS: '120', MUSE_CLI_GATEWAY_TIMEOUT_MS: '900',
    MUSE_CLI_GATEWAY_STALL_MS: '2000', META_API_KEY: 'test-sentinel-not-a-credential', MODEL_API_KEY: 'test-sentinel-not-a-credential',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  service.stdout.on('data', d => { logs += d; }); service.stderr.on('data', d => { logs += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/health')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 30));
  }
  throw new Error('Gateway startup failed: ' + logs);
});
after(async () => {
  if (service?.exitCode === null) { service.kill('SIGTERM'); await once(service, 'exit'); }
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
const request = (data, options = {}) => fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data), ...options });

test('HTTP success has correct model, isolated MCP policy, Unicode and reported usage', async () => {
  const b = body('CASE=ok'); b.messages.unshift({ role: 'system', content: 'session=agent:main:test' });
  b.tools = [{ type: 'function', function: { name: 'session_status' } }];
  const r = await request(b); assert.equal(r.status, 200);
  const d = await r.json(); assert.equal(d.model, MODEL); assert.equal(d.usage.total_tokens, 1100); assert.equal(d.usage.prompt_tokens_details.cached_tokens, 800);
  assert.deepEqual(JSON.parse(d.choices[0].message.content), { text: '好😀', tools: 'session_status', session: 'agent:main:test' });
  assert.equal(fs.readdirSync(path.join(root, 'state')).length, 0);
  const empty = await (await request({ ...b, tools: [] })).json();
  assert.equal(JSON.parse(empty.choices[0].message.content).tools, null);
  const contributor = await (await request({ ...body('CASE=ok'), model: CONTRIBUTOR_MODEL })).json();
  assert.equal(contributor.model, CONTRIBUTOR_MODEL); assert.equal(contributor.usage.total_tokens, 1100);
});
test('SSE success is terminal-verified; a failed partial reply is not returned as success', async () => {
  const text = await (await request({ ...body('CASE=ok'), stream: true, stream_options: { include_usage: true } })).text();
  assert.match(text, /chat.completion.chunk/); assert.match(text, /"finish_reason":"stop"/); assert.match(text, /\[DONE\]/);
  assert.match(text, /"total_tokens":1100/);
  const failed = await (await request({ ...body('CASE=fail'), stream: true })).text();
  assert.match(failed, /MUSE_TURN_FAILED/); assert.doesNotMatch(failed, /partial answer/); assert.doesNotMatch(failed, /"finish_reason":"stop"/);
});
test('wrong model, missing terminal, invalid model and browser requests fail explicitly', async () => {
  assert.equal((await request(body('CASE=wrong'))).status, 502);
  assert.equal((await request(body('CASE=incomplete'))).status, 502);
  const truncated = await request(body('CASE=truncated')); assert.equal(truncated.status, 413);
  assert.equal((await truncated.json()).error.code, 'MUSE_INPUT_NOT_PRESERVED');
  assert.equal((await request({ ...body('x'), model: 'other' })).status, 400);
  assert.equal((await request(body('x'), { headers: { origin: 'https://example.com' } })).status, 403);
});
test('queue timeout and model timeout release slots and remove request files', async () => {
  const slow = request(body('CASE=slow'));
  await new Promise(r => setTimeout(r, 50));
  const queued = await request(body('CASE=ok')); assert.equal(queued.status, 503);
  assert.equal((await queued.json()).error.code, 'MUSE_QUEUE_TIMEOUT');
  assert.equal((await slow).status, 200);
  const timed = await request(body('CASE=hang')); assert.equal(timed.status, 504);
  assert.equal((await timed.json()).error.code, 'MUSE_TIMEOUT');
  assert.equal(fs.readdirSync(path.join(root, 'state')).length, 0);
});
test('unresponsive CLI is force-killed and terminal failure does not wait for model timeout', async () => {
  const failedAt = Date.now();
  const failed = await request(body('CASE=fail linger'));
  assert.equal((await failed.json()).error.code, 'MUSE_TURN_FAILED');
  assert.ok(Date.now() - failedAt < 850);
  const timedAt = Date.now();
  const timed = await request(body('CASE=hang ignore-term'));
  assert.equal((await timed.json()).error.code, 'MUSE_TIMEOUT');
  assert.ok(Date.now() - timedAt < 4500);
  assert.equal((await (await fetch(base + '/health')).json()).activeRequests, 0);
  assert.equal(fs.readdirSync(path.join(root, 'state')).length, 0);
  assert.equal((await request(body('CASE=ok'))).status, 200);
});
test('content logs include live text, tool arguments and results without duplicating final text', async () => {
  const offset = logs.length;
  assert.equal((await request(body('CASE=ok'))).status, 200);
  await new Promise(r => setTimeout(r, 30));
  const events = logs.slice(offset).trim().split('\n').filter(s => s.startsWith('[MUSEGW] ')).map(s => JSON.parse(s.slice(9)));
  assert.ok(events.some(e => e.event === 'text' && e.text.includes('好😀')));
  assert.ok(events.some(e => e.event === 'tool' && e.args === 'fixture-path'));
  assert.ok(events.some(e => e.event === 'tool_done' && e.output === 'fixture tool output'));
  assert.ok(!events.some(e => e.event === 'final'));
});
test('oversized HTTP body returns structured 413 rather than resetting the socket', async () => {
  const response = await request(body('x'.repeat(10000)));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'MUSE_BODY_LIMIT');
});
test('disconnect cancels an active CLI; subscription metadata rejects API-key auth', async () => {
  const control = new AbortController(); const pending = request(body('CASE=hang'), { signal: control.signal });
  setTimeout(() => control.abort(), 80);
  await assert.rejects(pending);
  for (let i = 0; i < 50; i++) {
    if ((await (await fetch(base + '/health')).json()).activeRequests === 0) break;
    await new Promise(r => setTimeout(r, 30));
  }
  assert.equal((await (await fetch(base + '/health')).json()).activeRequests, 0);
  fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify({ providers: { meta: { mechanism: 'api_key' } } }));
  assert.equal(subscriptionStatus(path.join(root, 'auth.json')).ready, false);
  assert.equal((await request(body('CASE=ok'))).status, 503);
});
