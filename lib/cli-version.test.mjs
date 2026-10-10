import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCliVersionProbe } from './cli-version.mjs';

test('version probes coalesce, stay asynchronous, and refresh after CLI upgrades', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-version-'));
  try {
    const bin = path.join(dir, 'fake');
    const install = version => fs.writeFileSync(bin, `#!/bin/sh\nsleep 0.1\nprintf '${version}\\n'\n`, {mode:0o700});
    install('v1');
    const probe = createCliVersionProbe(bin, { ttl: 0 });
    const one = probe(); assert.equal(probe(), one);
    let ticked = false; setTimeout(() => { ticked = true; }, 10);
    assert.equal(await one, 'v1'); assert.ok(ticked);
    install('v2'); assert.equal(await probe(), 'v2');
  } finally { fs.rmSync(dir, {recursive:true,force:true}); }
});
