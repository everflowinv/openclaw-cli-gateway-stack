'use strict';
const { randomUUID } = require('node:crypto');

// The transport owns caller identity. Tool arguments name targets, never a
// replacement caller. Standalone MCP clients get their own private namespace.
function createRequesterContext({ sessionKey, agentId = 'main', id = randomUUID() } = {}) {
  const bound = typeof sessionKey === 'string' && sessionKey.trim() && sessionKey.trim() !== 'main'
    ? sessionKey.trim() : `agent:${agentId}:mcp:${id}`;
  return {
    sessionKey: bound,
    source: bound === sessionKey?.trim() ? 'transport' : 'isolated-mcp',
    resolve(requested) {
      if (requested !== undefined && requested !== null && requested !== '' && requested !== bound) {
        throw new Error('Requester session is bound by the MCP transport. Omit sessionKey; use the session target argument only on target-oriented tools.');
      }
      return bound;
    },
  };
}
module.exports = { createRequesterContext };
