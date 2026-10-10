import assert from 'node:assert/strict';

// Shared black-box checks against each real server with its fake CLI.
export async function checkCancelledQueue(port, body) {
  const base = `http://127.0.0.1:${port}`;
  const post = signal => fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  const health = async () => (await fetch(base + '/health')).json();
  const wait = async predicate => {
    for (let i = 0; i < 40; i++) {
      if (predicate(await health())) return;
      await new Promise(r => setTimeout(r, 20));
    }
    assert.fail('queue state did not settle');
  };
  const first = post();
  await wait(h => h.activeRequests === 1);
  const controller = new AbortController();
  const queued = post(controller.signal);
  // Attach rejection handler before triggering abort.
  const rejected = assert.rejects(queued);
  await wait(h => h.queuedRequests === 1);
  controller.abort(); await rejected;
  await wait(h => h.queuedRequests === 0);
  assert.equal((await health()).activeRequests, 1);
  assert.equal((await first).status, 200);
  await wait(h => h.activeRequests === 0);
}
