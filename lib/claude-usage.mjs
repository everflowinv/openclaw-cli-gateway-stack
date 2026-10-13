// Claude streams publish initial usage, cumulative message_delta usage, then
// replay assistant envelopes which may still contain the initial output count.
export class ClaudeUsageTracker {
  constructor(onUsage = () => {}) { this.calls = new Map(); this.active = new Map(); this.onUsage = onUsage; }
  accept(event) {
    const stream = event.type === 'stream_event' ? event.event : null;
    const lane = event.parent_tool_use_id || 'foreground';
    let message, complete = false;
    if (stream?.type === 'message_start') {
      message = stream.message;
      if (message?.id) this.active.set(lane, message.id);
    } else if (stream?.type === 'message_delta' && stream.usage) {
      message = { id: this.active.get(lane), usage: stream.usage };
      complete = Boolean(stream.delta?.stop_reason);
    } else if (event.type === 'assistant') message = event.message;
    if (!message?.id || !message.usage) return;
    const previous = this.calls.get(message.id);
    const usage = { ...previous?.usage };
    for (const [key, value] of Object.entries(message.usage)) {
      if (Number.isSafeInteger(value) && value >= 0) usage[key] = Math.max(usage[key] || 0, value);
    }
    const next = { id: message.id, model: message.model || previous?.model,
      usage, complete: complete || previous?.complete || false, scope: lane === 'foreground' ? 'main' : 'background' };
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    this.calls.set(message.id, next);
    this.onUsage(next);
  }
  get foreground() { return [...this.calls.values()].filter(call => call.scope === 'main'); }
}
