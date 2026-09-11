"use strict";

const DEFAULT_FULL_REPLY_MAX_CHARS = 400000;
const NATIVE_SNAPSHOT_MAX_CHARS = 4096;

function truncateUtf16(text, limit) {
  let end = Math.max(0, Math.floor(limit));
  if (end >= text.length) return text;
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return text.slice(0, end);
}

// OpenClaw 2026.9.1 producer preview: trim, then 4095 UTF-16 units + ellipsis.
// Never expand raw text containing runtime metadata. Such replies retain only
// the producer-sanitized preview instead of reimplementing the entire sanitizer
// or importing a stateful internal Gateway bundle into the bridge process.
function hasInternalMetadata(text) {
  return text.includes("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>")
    || text.includes("<<<END_OPENCLAW_INTERNAL_CONTEXT>>>")
    || text.includes("This context is runtime-generated, not user-authored. Keep internal details private.")
    || text.includes("⟦openclaw:ctx⟧")
    || text.includes("<active_memory_plugin>")
    || /^\s*Delivery:/m.test(text)
    || /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\]/.test(text);
}
function producerPreview(text) {
  const clean = text.trim();
  return clean.length <= NATIVE_SNAPSHOT_MAX_CHARS ? clean : truncateUtf16(clean, 4095).trimEnd() + "…";
}
function finalText(message, runId) {
  if (message?.role !== "assistant" || message.__openclaw?.runId !== runId
      || message.stopReason !== "stop" || message.display === false || message.provider === "openclaw") return null;
  const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }]
    : Array.isArray(message.content) ? message.content : [];
  if (blocks.some((b) => b?.type === "toolCall")) return null;
  const texts = [];
  for (const block of blocks) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    if (typeof block.textSignature === "string" && block.textSignature.startsWith("{")) {
      let signature;
      try { signature = JSON.parse(block.textSignature); } catch (_) { return null; }
      if (signature.phase && signature.phase !== "final_answer") return null;
    }
    if (block.text.trim()) texts.push(block.text.trim());
  }
  const text = texts.join("\n\n");
  if (!text || ["NO_REPLY", "HEARTBEAT_OK", "ANNOUNCE_SKIP", "REPLY_SKIP"].includes(text)
      || hasInternalMetadata(text)) return null;
  return text;
}

function expandContinuationReply(snapshot, candidate, wait, terminal, maxChars = DEFAULT_FULL_REPLY_MAX_CHARS) {
  if (terminal?.status !== "ok") return terminal;
  const limit = Math.min(DEFAULT_FULL_REPLY_MAX_CHARS,
    Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : DEFAULT_FULL_REPLY_MAX_CHARS);
  const fallback = (reason) => ({ ...terminal,
    reply: truncateUtf16(terminal.reply, limit), replyLimitChars: Math.min(NATIVE_SNAPSHOT_MAX_CHARS, limit),
    replyMayBeTruncated: terminal.replyMayBeTruncated || terminal.reply.length > limit,
    fullReplyAvailable: false, fullReplyUnavailable: reason });
  const receipt = wait?.terminalReceipt;
  if (!snapshot || receipt?.runId !== candidate.runId || receipt.sessionId !== snapshot.sessionId
      || wait.runId !== candidate.runId || wait.status !== "ok" || wait.yielded === true || wait.aborted === true
      || !Number.isFinite(wait.endedAt)) return fallback("identity_unverified");
  const roots = snapshot.entries.flatMap((e, index) => e.type === "message" && e.id === candidate.inputId
    && e.message?.role === "user" && e.message.idempotencyKey === `${candidate.runId}:user` ? [index] : []);
  if (roots.length !== 1) return fallback("input_unverified");
  const matches = [];
  for (const entry of snapshot.entries.slice(roots[0] + 1)) {
    if (entry.type !== "message") continue;
    if (entry.message?.role === "user") break;
    const text = finalText(entry.message, candidate.runId);
    if (text !== null && producerPreview(text) === wait.terminalReply?.text) matches.push({ text, id: entry.id });
  }
  if (matches.length !== 1 || typeof matches[0].id !== "string") return fallback("final_not_unique_or_unverified");
  const { text, id } = matches[0];
  const truncated = text.length > limit;
  const notice = `\n\n（回复超过连接器 ${limit} 字符上限，已截短；末尾已保留。）\n\n`;
  let reply = text;
  if (truncated && limit < 256) {
    reply = truncateUtf16(text, limit); // Structured truncation fields remain explicit.
  } else if (truncated) {
    const tailSize = Math.min(8000, Math.floor(limit / 4));
    let tailStart = text.length - tailSize;
    if (/[\uDC00-\uDFFF]/.test(text[tailStart]) && /[\uD800-\uDBFF]/.test(text[tailStart - 1])) tailStart++;
    const tail = text.slice(tailStart);
    reply = truncateUtf16(text, limit - tail.length - notice.length) + notice + tail;
  }
  return { ...terminal, reply, replySource: "verified_continuation_transcript", replyBlocks: 1,
    fullReplyAvailable: true, finalMessageId: id, replyChars: reply.length, replyOriginalChars: text.length,
    replyMayBeTruncated: truncated, replyTruncated: truncated, replyLimitChars: limit };
}

module.exports = { expandContinuationReply, producerPreview, truncateUtf16, DEFAULT_FULL_REPLY_MAX_CHARS };
