"use strict";

// Share OpenClaw's saved include/exclude selection with the HTTP bridge.
// This only narrows the existing bridge allowlist; it never adds a server.
function matches(pattern, name) {
  if (typeof pattern !== "string") return false;
  return new RegExp("^" + pattern.split("*").map(part =>
    part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(name);
}

function upstreamToolSelected(entry, name) {
  if (entry?.enabled === false) return false;
  const filter = entry?.toolFilter || {};
  if (Array.isArray(filter.include) && !filter.include.some(p => matches(p, name))) return false;
  return !Array.isArray(filter.exclude) || !filter.exclude.some(p => matches(p, name));
}

module.exports = { upstreamToolSelected };
