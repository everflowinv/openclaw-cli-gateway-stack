import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MuseDetails } from './details.mjs';

test('journal details survive split UTF-8, deduplicate mirrors and exclude background/encrypted content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-details-'));
  try {
    const file = path.join(root, 'session.jsonl'), events = [];
    const reader = new MuseDetails(root, (event, data) => events.push({ event, ...data }));
    const record = (id, event, run_id = 'main') => JSON.stringify({ id, payload: { run_id, source_run_record_id: id, event } }) + '\n';
    const tool = record('tool', { kind: 'assistant_tool_calls_committed', tool_calls: [{ call_id: 'call', name: 'read', args: '{"path":"中文😀"}' }] });
    const bytes = Buffer.from(tool), split = bytes.indexOf(Buffer.from('😀')) + 2;
    fs.writeFileSync(file, bytes.subarray(0, split));
    reader.poll('main'); assert.equal(events.length, 0);
    fs.appendFileSync(file, bytes.subarray(split)); reader.poll('main');
    assert.deepEqual(events, [{ event: 'tool', name: 'read', toolUseId: 'call', args: '{"path":"中文😀"}', via: 'Muse session journal' }]);
    fs.mkdirSync(path.join(root, 'mirror')); fs.writeFileSync(path.join(root, 'mirror/session.jsonl'), tool);
    fs.appendFileSync(file, record('child', { kind: 'reasoning_committed', text: 'PRIVATE_CHILD' }, 'child') + record('encrypted', { kind: 'reasoning_committed', text: '', encrypted_content: 'SECRET' }) + record('public', { kind: 'reasoning_committed', text: 'visible reasoning' }));
    reader.poll('main'); reader.poll('main');
    assert.equal(events.length, 2); assert.equal(events[1].text, 'visible reasoning');
    assert.doesNotMatch(JSON.stringify(events), /SECRET|PRIVATE_CHILD/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
