"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { selectRunAssistantTexts: select, readSqliteAssistantTexts: read } = require("./session-reply-store");

const user = (run, content = "same input") => ({ type: "message", message: { role: "user", content, idempotencyKey: `${run}:user` } });
const assistant = (content, extra = {}) => ({ type: "message", message: { role: "assistant", content, ...extra } });
const base = [user("a"), assistant("attachment [[EVE_ATTACHMENT:{}]]"), assistant("final")];

test("exact producer run anchor reconstructs multiple blocks without timestamp guesses", () => {
  assert.deepEqual(select(base, "a", "final"), ["attachment [[EVE_ATTACHMENT:{}]]", "final"]);
  assert.equal(select(base, "b", "final"), null);
  assert.equal(select(base, null, "final"), null);
});

test("empty and sentinel finals cannot select a latest reply", () => {
  for (const final of ["", " ", "NO_REPLY", "HEARTBEAT_OK", "ANNOUNCE_SKIP", "REPLY_SKIP"]) {
    assert.equal(select([...base, assistant(final)], "a", final), null);
  }
});

test("no substring matching against an earlier answer", () => {
  assert.equal(select([user("a"), assistant("prefix final suffix")], "a", "final"), null);
});

test("duplicate input identity or duplicate final text fails closed", () => {
  assert.equal(select([...base, user("a")], "a", "final"), null);
  assert.equal(select([...base, assistant("final")], "a", "final"), null);
});

test("external user boundary prevents cross-request replies even for identical inputs", () => {
  assert.equal(select([user("a"), assistant("progress"), user("b"), assistant("final")], "a", "final"), null);
  assert.deepEqual(select([...base, user("b"), assistant("unrelated")], "a", "final"), ["attachment [[EVE_ATTACHMENT:{}]]", "final"]);
});

test("internal provenance is not a requester-run correlation receipt", () => {
  const internal = user("announce");
  internal.message.provenance = { kind: "inter_session", sourceTool: "subagent_announce", sourceSessionKey: "child" };
  assert.equal(select([user("a"), assistant("progress"), internal, assistant("final")], "a", "final"), null);
});

test("drop tool results, hidden context, reasoning, sentinels and delivery mirrors", () => {
  const entries = [user("a"),
    { type: "custom_message", display: false, content: "yield-private" },
    { type: "message", message: { role: "toolResult", content: "child-output" } },
    assistant("hidden-display", { display: false }),
    assistant("delivery-mirror", { provider: "openclaw", model: "delivery-mirror" }),
    assistant("error-body", { stopReason: "error" }),
    assistant("abort-body", { stopReason: "aborted" }),
    assistant("HEARTBEAT_OK"),
    assistant([{ type: "thinking", thinking: "private-thinking" }, { type: "text", text: "part one" }]),
    assistant([{ type: "text", text: "part two" }, { type: "text", text: "final" }]),
  ];
  assert.deepEqual(select(entries, "a", "part two\n\nfinal"), ["part one", "part two", "final"]);
});

test("later unowned assistant output is not appended past the CLI final", () => {
  assert.deepEqual(select([...base, assistant("later-parent-or-heartbeat")], "a", "final"), ["attachment [[EVE_ATTACHMENT:{}]]", "final"]);
});

test("SQLite active branch and clean index are authoritative", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reply-store-test-"));
  const file = path.join(root, "agent.sqlite");
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE session_nodes(session_key TEXT PRIMARY KEY, current_session_id TEXT);
      CREATE TABLE session_transcript_index_state(session_id TEXT PRIMARY KEY, needs_rebuild INTEGER);
      CREATE TABLE transcript_events(session_id TEXT, seq INTEGER, event_json TEXT);
      CREATE TABLE session_transcript_active_events(session_id TEXT, active_position INTEGER, event_seq INTEGER, message_position INTEGER);
      INSERT INTO session_nodes VALUES ('target', 's');
      INSERT INTO session_transcript_index_state VALUES ('s', 0);
    `);
    const events = [user("a"), assistant("active"), assistant("final"), assistant("abandoned-branch"), user("old")];
    events.forEach((entry, i) => {
      db.prepare("INSERT INTO transcript_events VALUES ('s', ?, ?)").run(i, JSON.stringify(entry));
      if (i < 3) db.prepare("INSERT INTO session_transcript_active_events VALUES ('s', ?, ?, ?)").run(i, i, i);
    });
    assert.deepEqual(read(file, "target", "a", "final"), ["active", "final"]);
    assert.equal(read(file, "other", "a", "final"), null);
    db.exec("UPDATE session_transcript_index_state SET needs_rebuild = 1");
    assert.equal(read(file, "target", "a", "final"), null);
    db.exec("UPDATE session_transcript_index_state SET needs_rebuild = 0; UPDATE session_nodes SET current_session_id = 'reset'");
    assert.equal(read(file, "target", "a", "final"), null);
    fs.symlinkSync(file, path.join(root, "link"));
    assert.equal(read(path.join(root, "link"), "target", "a", "final"), null);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
