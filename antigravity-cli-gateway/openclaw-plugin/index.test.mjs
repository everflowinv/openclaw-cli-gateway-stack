import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createPluginDefinition } from './index.mjs';

function createTool(pluginConfig) {
  let provider;
  createPluginDefinition().register({
    pluginConfig,
    registerWebSearchProvider(value) { provider = value; },
  });
  return provider.createTool();
}

test('configured URL keeps internal slashes and strips only trailing slashes', async (t) => {
  const requests = [];
  const payload = { content: 'fixture', citations: [] };
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(url);
    return { json: async () => payload };
  });
  for (const [baseUrl, expected] of [
    [undefined, 'http://127.0.0.1:4570'],
    ['', 'http://127.0.0.1:4570'],
    ['http://localhost:4570', 'http://localhost:4570'],
    ['http://localhost:4570///', 'http://localhost:4570'],
    ['http://localhost:4570/a//b///', 'http://localhost:4570/a//b'],
  ]) {
    assert.deepEqual(await createTool({ baseUrl }).execute({ query: 'fixture' }), payload);
    assert.equal(requests.at(-1), `${expected}/v1/web-search`);
  }
});

test('long non-matching slash sequence cannot stall configuration', () => {
  // A child-process deadline also interrupts synchronous regexp backtracking.
  const source = `
    import { createPluginDefinition } from ${JSON.stringify(new URL('./index.mjs', import.meta.url).href)};
    const baseUrl = 'http://localhost:4570/' + '/'.repeat(1_000_000) + 'x';
    globalThis.fetch = async (url) => {
      if (url !== baseUrl + '/v1/web-search') throw new Error('URL changed');
      return { json: async () => ({ content: 'ok' }) };
    };
    let provider;
    createPluginDefinition().register({
      pluginConfig: { baseUrl },
      registerWebSearchProvider(value) { provider = value; },
    });
    await provider.createTool().execute({ query: 'fixture' });
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    timeout: 5000,
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
