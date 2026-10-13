'use strict';

// A disappearing subagents-list row is not completion. Only the exact run's
// native terminal receipt and reply snapshot can settle an accepted child.
async function waitForSpawnedRuns({ entries, observe, remove, timeoutMs = 240000, now = Date.now, delay = ms => new Promise(r => setTimeout(r, ms)) }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 1800000) throw new Error('timeoutMs must be an integer between 1 and 1800000');
  if (!entries.length) return { status: 'no_pending_subagent', subagents: [], message: 'No accepted child runs are pending for this MCP requester.' };
  const deadline = now() + timeoutMs;
  const pending = new Map(entries.map(entry => [entry.runId, entry]));
  const settled = [];
  while (pending.size && now() < deadline) {
    await Promise.all([...pending.values()].map(async entry => {
      const remaining = deadline - now();
      if (remaining <= 0) return;
      let result;
      try { result = await observe(entry.runId, Math.min(10000, remaining), deadline); }
      catch { return; } // Transport failure is not proof that the child failed.
      if (result?.runId !== entry.runId || result.terminalReceipt?.runId !== entry.runId
        || !Number.isFinite(result.endedAt) || result.endedAt <= 0 || result.pendingError === true) return;
      if (!['ok', 'error', 'timeout'].includes(result.status)) return;
      if (result.yielded === true || result.livenessState === 'paused') return;
      const status = result.aborted === true || result.error || ['error','aborted'].includes(result.stopReason) ? 'error' : result.status;
      const reply = result.terminalReply;
      // Missing reply evidence is unknown, including a superficially "ok" run.
      if (status === 'ok' && !['visible', 'silent', 'empty'].includes(reply?.disposition)) return;
      if (reply?.disposition === 'visible' && typeof reply.text !== 'string') return;
      const item = { runId: entry.runId, childSessionKey: entry.childSessionKey ?? null,
        status, replyDisposition: reply?.disposition ?? null,
        ...(reply?.disposition === 'visible' ? { reply: reply.text, replySource: 'native_terminal_snapshot', replyLimitChars: 4096, replyMayBeTruncated: reply.text.length >= 4095 } : {}),
        ...(result.error ? { error: String(result.error) } : {}),
        delivery: 'returned-to-mcp-caller' };
      settled.push(item);
      pending.delete(entry.runId);
      remove(entry.runId);
    }));
    if (pending.size && now() < deadline) await delay(Math.min(250, deadline - now()));
  }
  return { status: pending.size ? 'timeout' : settled.some(item => item.status !== 'ok') ? 'error' : 'completed',
    count: settled.length, subagents: settled, pending: [...pending.keys()],
    ...(pending.size ? { message: 'Observation deadline reached; children may still be running. Call sessions_yield again; do not respawn the same task.' } : {}) };
}
module.exports = { waitForSpawnedRuns };
