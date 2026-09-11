"use strict";

const fs = require("node:fs");

const SILENT_REPLIES = new Set(["NO_REPLY", "HEARTBEAT_OK", "ANNOUNCE_SKIP", "REPLY_SKIP"]);
const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim();

function assistantTexts(message) {
  if (message?.role !== "assistant" || message.display === false
      || message.provider === "openclaw"
      || ["error", "aborted"].includes(message.stopReason)) return [];
  const blocks = typeof message.content === "string"
    ? [message.content]
    : Array.isArray(message.content)
      ? message.content.filter((block) => block?.type === "text").map((block) => block.text)
      : [];
  return blocks.filter((text) => typeof text === "string" && text.trim()
    && !SILENT_REPLIES.has(text.trim())).map((text) => text.trim());
}

// Gateway prepareAgentRunUserTurn persists `${runId}:user` (not a timestamp
// heuristic). Never reconstruct across another input, even an internal one:
// sourceTool alone does not prove which requester run owns its completion.
// This only supplements a non-yield CLI final; it is NOT a yield observer.
function selectRunAssistantTexts(entries, runId, payloadReply) {
  if (typeof runId !== "string" || !runId || !normalize(payloadReply)) return null;
  const roots = entries.flatMap((entry, i) => entry.type === "message"
    && entry.message?.role === "user"
    && entry.message.idempotencyKey === `${runId}:user` ? [i] : []);
  if (roots.length !== 1) return null;
  const texts = [];
  const matches = [];
  for (const entry of entries.slice(roots[0] + 1)) {
    if (entry.type !== "message") continue;
    if (entry.message?.role === "user") break;
    const blocks = assistantTexts(entry.message);
    texts.push(...blocks);
    // Match a complete assistant message, not a substring in an older answer.
    if (blocks.length && normalize(blocks.join("\n\n")) === normalize(payloadReply)) {
      matches.push(texts.length);
    }
  }
  return matches.length === 1 ? texts.slice(0, matches[0]) : null;
}

// Only the current active SQLite branch is authoritative. A stale/rebuilding
// index fails closed; callers keep the CLI's own nonempty final, never JSON.
function readSqliteActiveSnapshot(databasePath, sessionKey) {
  let db;
  try {
    const stat = fs.lstatSync(databasePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(databasePath, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=0; BEGIN");
    const current = db.prepare(`
      SELECT n.current_session_id AS sessionId, i.needs_rebuild AS needsRebuild
      FROM session_nodes n
      JOIN session_transcript_index_state i ON i.session_id = n.current_session_id
      WHERE n.session_key = ?
    `).get(sessionKey);
    if (!current || current.needsRebuild !== 0) return null;
    const rows = db.prepare(`
      SELECT e.event_json AS eventJson
      FROM session_transcript_active_events a
      JOIN transcript_events e ON e.session_id = a.session_id AND e.seq = a.event_seq
      WHERE a.session_id = ? AND a.message_position IS NOT NULL
      ORDER BY a.active_position
    `).iterate(current.sessionId);
    return { sessionId: current.sessionId, entries: Array.from(rows, (row) => JSON.parse(row.eventJson)) };
  } catch (_) {
    return null;
  } finally {
    if (db) db.close();
  }
}

function readSqliteAssistantTexts(databasePath, sessionKey, runId, payloadReply) {
  const snapshot = readSqliteActiveSnapshot(databasePath, sessionKey);
  return snapshot ? selectRunAssistantTexts(snapshot.entries, runId, payloadReply) : null;
}

module.exports = { readSqliteAssistantTexts, selectRunAssistantTexts, readSqliteActiveSnapshot };
