import fs from 'node:fs';
import { sessionFiles } from './usage.mjs';

// Read only new bytes from this request's session mirrors. Never publish
// encrypted reasoning, prompts, or background reminder/subagent traffic.
export class MuseDetails {
  constructor(root, onEvent) { this.root = root; this.onEvent = onEvent; this.files = new Map(); this.seen = new Set(); }
  poll(runId) {
    if (!runId) return;
    for (const file of sessionFiles(this.root)) {
      let state = this.files.get(file);
      if (!state) { state = { offset: 0, pending: Buffer.alloc(0) }; this.files.set(file, state); }
      const fd = fs.openSync(file, 'r');
      try {
        let count;
        const chunk = Buffer.alloc(64 * 1024);
        while ((count = fs.readSync(fd, chunk, 0, chunk.length, state.offset)) > 0) {
          state.offset += count;
          state.pending = Buffer.concat([state.pending, chunk.subarray(0, count)]);
          let end;
          while ((end = state.pending.indexOf(10)) >= 0) {
            const line = state.pending.subarray(0, end).toString('utf8');
            state.pending = state.pending.subarray(end + 1);
            let record;
            try { record = JSON.parse(line); } catch { continue; }
            const p = record?.payload, event = p?.event;
            if (p?.run_id !== runId || !event) continue;
            const id = p.source_run_record_id ?? record.id;
            if (!id || this.seen.has(id)) continue;
            this.seen.add(id);
            if (event.kind === 'assistant_tool_calls_committed') {
              for (const call of event.tool_calls ?? []) {
                this.onEvent?.('tool', { name: call.name, toolUseId: call.call_id, args: call.args, via: 'Muse session journal' });
              }
            } else if (event.kind === 'reasoning_committed' && typeof event.text === 'string' && event.text) {
              this.onEvent?.('thinking', { text: event.text });
            }
          }
          if (state.pending.length > 16 * 1024 ** 2) throw new Error('Muse journal record exceeds diagnostic limit');
        }
      } finally { fs.closeSync(fd); }
    }
  }
}
