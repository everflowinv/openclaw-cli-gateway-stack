"use strict";

// One set of stateful Craft processes per proxy, never shared across clients.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const CRAFT_SERVERS = ["gridcraft", "wordcraft", "pdfcraft"];

class StdioClient {
  constructor(config) {
    this.pending = new Map();
    this.nextId = 0;
    this.tail = Promise.resolve();
    this.timeoutMs = config.requestTimeoutMs || 120000;
    this.child = spawn(config.command, config.args || [], {
      cwd: config.cwd, env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.resume(); // Protocol stdout stays clean; do not log document contents.
    this.lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.method && message.id != null) {
          this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: message.id,
            error: { code: -32601, message: "Client requests are not supported" } }) + "\n");
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } catch { this.close(new Error("Invalid Craft MCP response")); }
    });
    this.child.on("error", error => this.close(error));
    this.child.on("exit", () => this.close(new Error("Craft MCP process exited; reopen documents in a new session")));
    this.child.stdin.on("error", error => this.close(error));
  }

  request(method, params, timeoutMs = this.timeoutMs) {
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => this.close(new Error("Craft MCP timed out; state is uncertain, start a new session")), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async initialize(timeoutMs) {
    await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "openclaw-craft-bridge", version: "1.0.0" } }, timeoutMs);
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }

  call(name, args) {
    // Mutations and reads are ordered, including after a recoverable tool error.
    const result = this.tail.then(() => this.request("tools/call", { name, arguments: args || {} }));
    this.tail = result.catch(() => {});
    return result;
  }

  close(error = new Error("Craft MCP client closed")) {
    if (this.closed) return;
    this.closed = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.child.stdin.destroy();
    this.child.kill("SIGTERM");
    const killTimer = setTimeout(() => { if (this.child.exitCode === null) this.child.kill("SIGKILL"); }, 2000);
    killTimer.unref();
  }
}

function match(pattern, name) {
  return new RegExp("^" + pattern.split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(name);
}

function createCraftBridge({ openclawHome, disabled = false, allowlist = new Set(), isToolAllowed = () => true,
  log = message => process.stderr.write("[openclaw-mcp] " + message + "\n") }) {
  const clients = [], routes = new Map(), tools = [];
  const ready = (async () => {
    if (disabled) return;
    const config = JSON.parse(fs.readFileSync(path.join(openclawHome, "openclaw.json"), "utf8"));
    await Promise.all(CRAFT_SERVERS.map(async name => {
      const entry = config.mcp?.servers?.[name];
      const prefix = name + "__";
      if (!entry || entry.enabled === false || entry.transport !== "stdio" || !entry.command) return;
      if (allowlist.size && ![...allowlist].some(tool => tool.startsWith(prefix))) return;
      const client = new StdioClient(entry);
      clients.push(client);
      try {
        await client.initialize(entry.connectionTimeoutMs || 30000);
        let cursor;
        do {
          const catalog = await client.request("tools/list", cursor ? { cursor } : {});
          for (const tool of catalog.tools || []) {
            const filter = entry.toolFilter || {};
            if (filter.include && !filter.include.some(p => match(p, tool.name))) continue;
            if (filter.exclude?.some(p => match(p, tool.name))) continue;
            const qualified = prefix + tool.name;
            if (!isToolAllowed(qualified)) continue;
            tools.push({ ...tool, name: qualified });
            routes.set(qualified, { client, name: tool.name });
          }
          cursor = catalog.nextCursor;
        } while (cursor);
        log("Craft " + name + ": " + tools.filter(t => t.name.startsWith(prefix)).length + " tools ready");
      } catch (error) {
        client.close(error);
        for (let i = tools.length - 1; i >= 0; i--) if (tools[i].name.startsWith(prefix)) { routes.delete(tools[i].name); tools.splice(i, 1); }
        log("WARNING: Craft " + name + " unavailable: " + error.message);
      }
    }));
  })().catch(error => log("WARNING: Craft config unavailable: " + error.message));
  return { ready, tools, has: name => routes.has(name),
    call(name, args) { const route = routes.get(name); if (!route) throw new Error("Unknown Craft tool"); return route.client.call(route.name, args); },
    close() { for (const client of clients) client.close(); },
  };
}

module.exports = { createCraftBridge, StdioClient };
