import { execFile } from 'node:child_process';

// Health probes must not synchronously block other requests or freeze a
// startup version after an independently updated CLI binary changes.
export function createCliVersionProbe(bin, { timeout = 15000, ttl = 60000 } = {}) {
  let cached = null, checkedAt = 0, pending;
  return () => {
    if (pending) return pending;
    if (Date.now() - checkedAt < ttl) return Promise.resolve(cached);
    pending = new Promise(resolve => {
      execFile(bin, ['--version'], { timeout, encoding: 'utf8', env: { ...process.env, MUSE_NO_AUTO_UPDATE: '1' } }, (error, stdout) => {
        cached = error ? null : stdout.trim();
        checkedAt = Date.now(); pending = null; resolve(cached);
      });
    });
    return pending;
  };
}
