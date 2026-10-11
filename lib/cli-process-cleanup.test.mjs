import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { createCliProcessCleanup } from './cli-process-cleanup.mjs';

test('a missing close event has a bounded, exactly-once failure', async () => {
  const child = new EventEmitter();
  let destroyed = 0, calls = 0;
  child.stdio = [{ destroy() { destroyed++; } }];
  const cause = Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
  // Keep the test alive while production timers deliberately remain unrefed.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await new Promise(resolve => {
      const cleanup = createCliProcessCleanup(child, {
        killGraceMs: 10, pipeGraceMs: 10,
        onForcedClose(error) { calls++; assert.equal(error, cause); resolve(); },
      });
      cleanup.terminate(cause);
      cleanup.terminate(new Error('must not replace the original error'));
    });
    assert.equal(destroyed, 1);
    assert.equal(calls, 1);
  } finally { clearInterval(keepAlive); }
});

test('leader exit reaps descendants that keep its output pipes open', async () => {
  const child = spawn(process.execPath, ['-e', `
    const {spawn}=require('node:child_process');
    const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});
    descendant.unref();
    console.log(descendant.pid);
    setTimeout(()=>process.exit(1),100);
  `], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  const cleanup = createCliProcessCleanup(child, { onForcedClose: e => assert.fail(e.message) });
  try {
    await Promise.race([once(child, 'close'), new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('descendant blocked close')), 2000); timer.unref();
    })]);
    const pid = Number(output.trim());
    assert.ok(pid > 0);
    for (let i = 0; i < 50; i++) {
      try { process.kill(pid, 0); } catch (e) { assert.equal(e.code, 'ESRCH'); return; }
      await new Promise(r => setTimeout(r, 20));
    }
    assert.fail('descendant survived leader exit');
  } finally { cleanup.dispose(); }
});
