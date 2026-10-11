// Call only for a CLI spawned with detached:true (its own process group).
// A descendant may retain stdout after the leader exits, so `close` alone is
// not a reliable deadline for releasing a request's concurrency slot.
const cleanups = new Set();
process.once('exit', () => { for (const dispose of cleanups) dispose(); });

export function createCliProcessCleanup(child, {
  onForcedClose, killGraceMs = 5000, pipeGraceMs = 1000,
} = {}) {
  let error, stopping = false, disposed = false, killTimer, closeTimer;
  const killGroup = signal => {
    if (!Number.isInteger(child.pid) || child.pid <= 0) return;
    try { process.kill(-child.pid, signal); } catch {}
  };
  const forceClose = () => {
    if (disposed) return;
    const cause = error ?? Object.assign(new Error('CLI exited but its output pipes did not close'), {
      code: 'CLI_CLOSE_TIMEOUT', statusCode: 502,
    });
    dispose();
    try { onForcedClose(cause); }
    finally { for (const stream of child.stdio) stream?.destroy?.(); }
  };
  const armCloseDeadline = () => {
    closeTimer ??= setTimeout(forceClose, pipeGraceMs);
    closeTimer.unref();
  };
  const onExit = () => {
    if (disposed) return;
    // Reap remaining MCP children even when the CLI itself exited normally.
    clearTimeout(killTimer);
    killGroup('SIGKILL');
    armCloseDeadline();
  };
  function dispose() {
    if (disposed) return;
    disposed = true;
    cleanups.delete(dispose);
    clearTimeout(killTimer); clearTimeout(closeTimer);
    child.removeListener('exit', onExit);
    child.removeListener('close', dispose);
    killGroup('SIGKILL');
  }
  child.once('exit', onExit);
  child.once('close', dispose);
  cleanups.add(dispose);
  return {
    get error() { return error; },
    terminate(cause) {
      if (disposed || stopping) return;
      stopping = true; error = cause;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => {
        killGroup('SIGKILL');
        armCloseDeadline();
      }, killGraceMs);
      killTimer.unref();
    },
    dispose,
  };
}
