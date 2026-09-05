#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""model-usage-cost — per-model token usage and list-price cost on this machine.

Windows: default 1D / 7D / 30D (1M). Single scan, per-window buckets.
Prices: OpenClaw model catalog (~/.openclaw/openclaw.json -> models.providers.*.models[].cost),
USD per 1M tokens, official list, short-context tier (tiered -> first flat block).

Sources (most authoritative available per provider, mutually de-duplicated):
  A. codex rollouts      ~/.openclaw/agents/*/agent/codex-home/sessions/**,
                         ~/.openclaw/acpx/codex-home/sessions/**, ~/.codex/sessions/**
  B. claude-cli-gateway live log (~/.openclaw/logs/claude-cli-gateway.stdout.log);
     cache split estimated from prompt total (flag --split)
  C. OpenClaw trajectories (all providers except openai / claude-cli-gateway /
     antigravity-cli-gateway)
  D. ~/.claude/projects/*/*.jsonl  (manual Claude Code CLI sessions, true cache split)
  E. antigravity-cli-gateway live log (~/.openclaw/logs/antigravity-cli-gateway.stdout.log);
     true cache split from agy raw usage (usage_raw) since 2026-09-05, flattened
     fallback for older events
"""
import argparse
import datetime as dt
import glob
import json
import os
import sys

VERSION = "1.1.0"
DEFAULT_CONFIG = "~/.openclaw/openclaw.json"
GATEWAY_LOG = "~/.openclaw/logs/claude-cli-gateway.stdout.log"
AGY_GATEWAY_LOG = "~/.openclaw/logs/antigravity-cli-gateway.stdout.log"
TRAJ_GLOB = "~/.openclaw/agents/*/sessions/*.trajectory.jsonl"
ROLLOUT_GLOBS = {
    "openclaw": [
        "~/.openclaw/agents/*/agent/codex-home/sessions/**/rollout-*.jsonl",
        "~/.openclaw/acpx/codex-home/sessions/**/rollout-*.jsonl",
    ],
    "codex-cli(手动)": ["~/.codex/sessions/**/rollout-*.jsonl"],
}
CLAUDE_PROJECTS_GLOB = "~/.claude/projects/*/*.jsonl"
DEFAULT_WINDOWS = "1,7,30"
DEFAULT_SPLIT = (0.005, 0.065, 0.93)  # gateway prompt total -> fresh, cacheWrite, cacheRead
SKIP_TRAJ_PROVIDERS = ("openai", "claude-cli-gateway", "antigravity-cli-gateway")  # covered by A/B/E

NOTES = [
    "claude-cli-gateway 的 fresh/cacheW/cacheR 为估算拆分（标 * 行），比例可用 --split 调整；精确值以 Anthropic 账单为准。",
    "antigravity-cli-gateway 自 2026-09-05 起用 agy 原始 usage 真实拆分（fresh/cacheR/out）；更早的 done 事件无拆分，按全 fresh 回溯，略微高估。",
    "codex rollout 不区分 cache write，该项按 fresh input 计价，略微高估。",
    "openai 侧为本地 rollout 口径（下限）；云端 account/usage 才是权威口径。",
    "全部为 openclaw.json 刊例价（短上下文档，tiered 取第一档）名义成本；订阅内实际边际现金支出为 0。",
]


def ex(p):
    return os.path.expanduser(p)


def parse_ts(s):
    if not isinstance(s, str) or not s:
        return None
    try:
        t = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return t


def blank():
    return {"n": 0, "fresh": 0, "cw": 0, "cr": 0, "out": 0}


def _bump(b, fresh=0, cw=0, cr=0, out=0, n=1):
    b["n"] += n
    b["fresh"] += fresh or 0
    b["cw"] += cw or 0
    b["cr"] += cr or 0
    b["out"] += out or 0


def mtime_utc(path):
    try:
        return dt.datetime.fromtimestamp(os.path.getmtime(path), dt.timezone.utc)
    except OSError:
        return None


def read_lines(path):
    with open(path, errors="ignore") as f:
        for line in f:
            yield line


class Agg:
    """rows[window_days][(source, provider, model)] -> counters"""

    def __init__(self, windows):
        now = dt.datetime.now(dt.timezone.utc)
        self.now = now
        self.windows = sorted(windows)
        self.cuts = {w: now - dt.timedelta(days=w) for w in self.windows}
        self.widest_cut = self.cuts[self.windows[-1]]
        self.rows = {w: {} for w in self.windows}

    def add(self, ts, key, **kw):
        for w in self.windows:
            if ts >= self.cuts[w]:
                _bump(self.rows[w].setdefault(key, blank()), **kw)


# ---------- pricing ----------

def load_prices(config_path):
    """model id -> {input, cacheWrite, cacheRead, output} USD per 1M tokens."""
    path = ex(config_path)
    if not os.path.exists(path):
        return None, "config not found: %s" % path, []
    try:
        cfg = json.load(open(path))
    except (OSError, ValueError) as e:
        return None, "cannot parse config: %s" % e, []
    prices, conflicts = {}, []
    providers = (cfg.get("models") or {}).get("providers") or {}
    for pname in sorted(providers):
        for m in providers[pname].get("models", []):
            mid, c = m.get("id"), m.get("cost")
            if not mid or not isinstance(c, dict):
                continue
            flat = {k: float(c.get(k) or 0) for k in ("input", "cacheWrite", "cacheRead", "output")}
            if mid in prices and prices[mid] != flat:
                conflicts.append("%s(%s)" % (mid, pname))
                continue
            prices[mid] = flat
    if not prices:
        return None, "no models.providers.*.models[].cost found in config", []
    return prices, None, conflicts


def cost_of(prices, model, v):
    pr = prices.get(model)
    if pr is None:
        return None
    return (v["fresh"] * pr["input"] + v["cw"] * pr["cacheWrite"]
            + v["cr"] * pr["cacheRead"] + v["out"] * pr["output"]) / 1e6


# ---------- scanners ----------

def scan_rollouts(agg):
    for src, globs in ROLLOUT_GLOBS.items():
        files = []
        for g in globs:
            files += glob.glob(ex(g), recursive=True)
        for p in files:
            if mtime_utc(p) is None or mtime_utc(p) < agg.widest_cut:
                continue
            lines = open(p, errors="ignore").readlines()
            mdl = "unknown"
            for line in lines:  # pre-scan first turn_context for early token_counts
                if '"turn_context"' in line:
                    try:
                        d = json.loads(line)
                        pl = d.get("payload") or {}
                        if d.get("type") == "turn_context" and isinstance(pl.get("model"), str):
                            mdl = pl["model"]
                    except Exception:
                        pass
                    break
            for line in lines:
                if '"token_count"' in line:
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    pl = d.get("payload") or {}
                    if pl.get("type") != "token_count":
                        continue
                    ts = parse_ts(d.get("timestamp"))
                    if ts is None or ts < agg.widest_cut:
                        continue
                    u = ((pl.get("info") or {}).get("last_token_usage")) or {}
                    if not u:
                        continue
                    tin = u.get("input_tokens", 0) or 0
                    cac = u.get("cached_input_tokens", 0) or 0
                    agg.add(ts, (src, "openai", mdl),
                            fresh=tin - cac, cr=cac, out=u.get("output_tokens", 0) or 0)
                elif '"turn_context"' in line:
                    try:
                        d = json.loads(line)
                        pl = d.get("payload") or {}
                        if d.get("type") == "turn_context" and isinstance(pl.get("model"), str):
                            mdl = pl["model"]
                    except Exception:
                        pass


def scan_gateway(agg, split):
    path = ex(GATEWAY_LOG)
    if not os.path.exists(path):
        return
    startmodel = {}
    for line in read_lines(path):
        if not line.startswith("[CLIGW] "):
            continue
        try:
            o = json.loads(line[8:])
        except Exception:
            continue
        ev, r = o.get("event"), o.get("request")
        if ev == "start":
            startmodel[r] = o.get("model")
        elif ev == "done":
            ts = parse_ts(o.get("ts"))
            if ts is None or ts < agg.widest_cut:
                continue
            u = o.get("usage") or {}
            prompt = u.get("prompt_tokens", 0) or 0
            agg.add(ts, ("openclaw", "claude-cli-gateway", startmodel.pop(r, None) or "unknown"),
                    fresh=int(prompt * split[0]), cw=int(prompt * split[1]),
                    cr=int(prompt * split[2]), out=u.get("completion_tokens", 0) or 0)


def strip_effort_suffix(model, prices):
    """Legacy agy ids embedded effort (gemini-3.8-flash-high); price by base id."""
    if model in prices or not isinstance(model, str):
        return model
    for eff in ("-low", "-medium", "-high"):
        if model.endswith(eff) and model[: -len(eff)] in prices:
            return model[: -len(eff)]
    return model


def scan_agy_gateway(agg, prices):
    path = ex(AGY_GATEWAY_LOG)
    if not os.path.exists(path):
        return
    startmodel = {}
    for line in read_lines(path):
        if not line.startswith("[AGYGW] "):
            continue
        try:
            o = json.loads(line[7:])
        except Exception:
            continue
        ev, r = o.get("event"), o.get("request")
        if ev == "start":
            startmodel[r] = strip_effort_suffix(o.get("model"), prices)
        elif ev == "done":
            ts = parse_ts(o.get("ts"))
            if ts is None or ts < agg.widest_cut:
                continue
            mdl = startmodel.pop(r, None) or "unknown"
            raw = o.get("usage_raw")
            if isinstance(raw, dict) and "input_tokens" in raw:
                # agy truth: input EXCLUDES cache_read (total=input+cr+out+think);
                # thinking is billed as output
                cr = raw.get("cache_read_tokens", 0) or 0
                inp = raw.get("input_tokens", 0) or 0
                agg.add(ts, ("openclaw", "antigravity-cli-gateway", mdl),
                        fresh=inp, cw=0, cr=cr,
                        out=(raw.get("output_tokens", 0) or 0) + (raw.get("thinking_tokens", 0) or 0))
            else:
                # historical events carry only the flattened OpenAI-style usage
                u = o.get("usage") or {}
                agg.add(ts, ("openclaw", "antigravity-cli-gateway", mdl),
                        fresh=u.get("prompt_tokens", 0) or 0, cw=0, cr=0,
                        out=u.get("completion_tokens", 0) or 0)


def scan_trajectories(agg):
    best = {}
    for p in glob.glob(ex(TRAJ_GLOB)):
        mt = mtime_utc(p)
        if mt is None or mt < agg.widest_cut:
            continue
        for line in read_lines(p):
            if '"model.completed"' not in line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("provider") in SKIP_TRAJ_PROVIDERS:
                continue
            ts = parse_ts(d.get("ts"))
            if ts is None or ts < agg.widest_cut:
                continue
            u = (d.get("data") or {}).get("usage") or {}
            k = (d.get("traceId"), d.get("runId"), d.get("seq"), d.get("ts"))
            tot = u.get("total") or 0
            if k in best and best[k][2] >= tot:
                continue
            best[k] = (d, u, tot, ts)
    for d, u, _tot, ts in best.values():
        agg.add(ts, ("openclaw", d.get("provider"), d.get("modelId")),
                fresh=u.get("input") or 0, cw=u.get("cacheWrite") or 0,
                cr=u.get("cacheRead") or 0, out=u.get("output") or 0)


def scan_claude_projects(agg):
    for p in glob.glob(ex(CLAUDE_PROJECTS_GLOB)):
        mt = mtime_utc(p)
        if mt is None or mt < agg.widest_cut:
            continue
        for line in read_lines(p):
            if '"usage"' not in line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("type") != "assistant":
                continue
            msg = o.get("message") or {}
            u = msg.get("usage")
            if not u:
                continue
            ts = parse_ts(o.get("timestamp"))
            if ts is None or ts < agg.widest_cut:
                continue
            m = msg.get("model", "?")
            if m == "<synthetic>":
                continue
            agg.add(ts, ("claude-code(手动)", "anthropic", m),
                    fresh=u.get("input_tokens", 0) or 0,
                    cw=u.get("cache_creation_input_tokens", 0) or 0,
                    cr=u.get("cache_read_input_tokens", 0) or 0,
                    out=u.get("output_tokens", 0) or 0)


# ---------- output ----------

def fnum(n):
    if n >= 1e9:
        return "%.2fB" % (n / 1e9)
    if n >= 1e6:
        return "%.1fM" % (n / 1e6)
    if n >= 1e3:
        return "%.1fK" % (n / 1e3)
    return str(int(n))


def merge_by_model(rows):
    out = {}
    for (src, prov, mdl), v in rows.items():
        key = mdl
        b = out.setdefault(key, {"prov": set(), "src": set(), "v": blank(), "est": False})
        b["prov"].add(prov)
        b["src"].add(src)
        if prov == "claude-cli-gateway":
            b["est"] = True
        _bump(b["v"], fresh=v["fresh"], cw=v["cw"], cr=v["cr"], out=v["out"], n=v["n"])
    return out


def render_window_text(w, agg, prices, top, by_model):
    cut, rows = agg.cuts[w], agg.rows[w]
    items = list(rows.items())
    if by_model:
        merged = merge_by_model(rows)
        items = [((("|".join(sorted(b["src"])))[:16], "|".join(sorted(b["prov"])), mdl), b["v"])
                 for mdl, b in merged.items()]
    items.sort(key=lambda kv: (-(cost_of(prices, kv[0][2], kv[1]) or -1), -kv[1]["fresh"]))
    if top:
        items = items[:top]

    hdr = ("%-17s%-19s%-27s%7s%9s%9s%9s%8s%10s"
           % ("source", "provider", "model", "calls", "fresh", "cacheW", "cacheR", "out", "$"))
    sep = "-" * 105
    lines = ["═" * 12 + " window %gD  %s → %s " % (w, cut.astimezone().strftime("%m-%d %H:%M"),
                                                   agg.now.astimezone().strftime("%m-%d %H:%M")) + "═" * 12]
    lines += [hdr, sep]
    T, TC = blank(), 0.0
    unpriced = set()
    prov_cost = {}
    for key, v in items:
        src, prov, mdl = key
        c = cost_of(prices, mdl, v)
        if c is None:
            unpriced.add(mdl)
        else:
            TC += c
            prov_cost[prov] = prov_cost.get(prov, 0.0) + c
        star = "*" if ((prov == "claude-cli-gateway") if not by_model else merged[mdl]["est"]) else " "
        lines.append("%-17s%-19s%-26s%s%7d%9s%9s%9s%8s%10s"
                     % (src[:17], prov[:19], str(mdl)[:26], star, v["n"],
                        fnum(v["fresh"]), fnum(v["cw"]), fnum(v["cr"]), fnum(v["out"]),
                        ("$%.2f" % c) if c is not None else "n/a"))
        _bump(T, fresh=v["fresh"], cw=v["cw"], cr=v["cr"], out=v["out"], n=v["n"])
    lines.append(sep)
    lines.append("%-63s%7d%9s%9s%9s%8s%10s"
                 % ("TOTAL", T["n"], fnum(T["fresh"]), fnum(T["cw"]), fnum(T["cr"]),
                    fnum(T["out"]), "$%.2f" % TC))
    lines.append("prompt total = %s   output = %s" % (fnum(T["fresh"] + T["cw"] + T["cr"]), fnum(T["out"])))
    rollup = sorted(prov_cost.items(), key=lambda kv: -kv[1])
    if rollup:
        lines.append("provider rollup: " + " · ".join("%s $%.2f" % kv for kv in rollup))
    return "\n".join(lines), T, TC, unpriced


def cmd_summary(args):
    prices, err, conflicts = load_prices(args.config)
    if err:
        fail(err, "hint: check --config path (default ~/.openclaw/openclaw.json); "
                  "the catalog lives at models.providers.*.models[].cost")
    windows = [float(x) for x in args.days.split(",")] if args.days else \
              [float(x) for x in args.windows.split(",")]
    split = tuple(float(x) for x in args.split.split(","))
    if len(split) != 3 or abs(sum(split) - 1.0) > 0.01:
        fail("--split needs 3 ratios summing to ~1.0, e.g. 0.005,0.065,0.93",
             "hint: order is fresh,cacheWrite,cacheRead")

    agg = Agg(windows)
    scan_rollouts(agg)
    scan_gateway(agg, split)
    scan_agy_gateway(agg, prices)
    scan_trajectories(agg)
    scan_claude_projects(agg)

    if args.json:
        out = {"ok": True, "version": VERSION, "generated_at": agg.now.isoformat(),
               "config": ex(args.config), "split": list(split),
               "windows": [], "notes": NOTES, "unpriced_models": [], "price_conflicts": conflicts}
        all_unpriced = set()
        for w in agg.windows:
            rows = []
            merged = merge_by_model(agg.rows[w]) if args.by_model else None
            items = merged if merged else agg.rows[w]
            for key, v in items.items():
                if merged:
                    mdl = key
                    src = "|".join(sorted(v["src"]))
                    prov = "|".join(sorted(v["prov"]))
                    est = v["est"]
                    vv = v["v"]
                else:
                    src, prov, mdl = key
                    vv = v
                    est = (prov == "claude-cli-gateway")
                c = cost_of(prices, mdl, vv)
                if c is None:
                    all_unpriced.add(mdl)
                rows.append({"source": src, "provider": prov, "model": mdl,
                             "calls": vv["n"], "fresh": vv["fresh"], "cache_write": vv["cw"],
                             "cache_read": vv["cr"], "output": vv["out"],
                             "cost_usd": round(c, 4) if c is not None else None,
                             "estimated_split": est})
            rows.sort(key=lambda r: -(r["cost_usd"] if r["cost_usd"] is not None else -1))
            out["windows"].append({"days": w,
                                   "from": agg.cuts[w].isoformat(), "to": agg.now.isoformat(),
                                   "rows": rows})
        out["unpriced_models"] = sorted(all_unpriced)
        print(json.dumps(out, ensure_ascii=False, indent=1))
        return

    unpriced_all = set()
    for w in agg.windows:
        text, _T, _TC, unpriced = render_window_text(w, agg, prices, args.top, args.by_model)
        unpriced_all |= unpriced
        print(text + "\n")
    if conflicts:
        print("! 价格冲突（同名模型跨 provider，取先到）: " + ", ".join(conflicts))
    if unpriced_all:
        print("! 未定价模型（n/a）: " + ", ".join(sorted(unpriced_all))
              + "\n  hint: 在 openclaw.json models.providers.*.models[] 补 cost 后自动生效")
    print("\n".join("%d. %s" % (i + 1, n) for i, n in enumerate(NOTES)))


def cmd_prices(args):
    prices, err, conflicts = load_prices(args.config)
    if err:
        fail(err, "hint: check --config path")
    if args.json:
        print(json.dumps({"ok": True, "config": ex(args.config), "prices": prices,
                          "conflicts": conflicts}, ensure_ascii=False, indent=1))
        return
    print("catalog: %s  (USD / 1M tokens, 短上下文档/tiered 第一档)" % ex(args.config))
    print("%-42s%10s%10s%10s%10s" % ("model", "input", "cacheW", "cacheR", "output"))
    for m in sorted(prices):
        p = prices[m]
        print("%-42s%10g%10g%10g%10g" % (m, p["input"], p["cacheWrite"], p["cacheRead"], p["output"]))
    if conflicts:
        print("! 冲突: " + ", ".join(conflicts))


def cmd_selftest(args):
    checks = []

    def check(name, ok, detail="", hint=""):
        checks.append({"name": name, "ok": bool(ok), "detail": detail, "hint": hint})

    prices, err, _ = load_prices(args.config)
    check("config+prices", prices is not None, err or "%d models priced" % len(prices),
          "openclaw.json 的 models.providers.*.models[].cost 缺失或不可读")

    gpath = ex(GATEWAY_LOG)
    gok, gdetail = False, "log not found"
    if os.path.exists(gpath):
        gok, gdetail = False, "no [CLIGW] done-with-usage in tail"
        with open(gpath, errors="ignore") as f:
            tail = f.readlines()[-20000:]
        for line in tail:
            if line.startswith("[CLIGW] ") and '"event":"done"' in line and '"usage"' in line:
                gok, gdetail = True, "recent done events carry usage"
                break
    check("gateway-log", gok, gdetail,
          "claude-cli-gateway 服务未运行或日志格式变化；检查 ~/.openclaw/logs/claude-cli-gateway.stdout.log")

    apath = ex(AGY_GATEWAY_LOG)
    aok, adetail = False, "log not found"
    if os.path.exists(apath):
        aok, adetail = False, "no [AGYGW] done-with-usage in tail"
        with open(apath, errors="ignore") as f:
            atail = f.readlines()[-20000:]
        for line in atail:
            if line.startswith("[AGYGW] ") and '"event":"done"' and '"usage"' in line:
                aok, adetail = True, "recent done events carry usage"
                break
    check("agy-gateway-log", aok, adetail,
          "antigravity-cli-gateway 服务未运行或日志格式变化；检查 ~/.openclaw/logs/antigravity-cli-gateway.stdout.log")

    tfiles = glob.glob(ex(TRAJ_GLOB))
    tok, tdetail = False, "no trajectory files"
    if tfiles:
        newest = max(tfiles, key=os.path.getmtime)
        for line in read_lines(newest):
            if '"model.completed"' in line:
                try:
                    d = json.loads(line)
                    tok = isinstance(d.get("provider"), str)
                    tdetail = "newest file %s parse ok" % os.path.basename(newest)
                    break
                except Exception:
                    tok = False
    check("trajectories", tok, tdetail, "找不到 ~/.openclaw/agents/*/sessions/*.trajectory.jsonl")

    rok, rdetail = False, "no rollout files"
    for src, globs in ROLLOUT_GLOBS.items():
        for g in globs:
            fs = glob.glob(ex(g), recursive=True)
            if fs:
                rok, rdetail = True, "%s: %d files (%s)" % (src, len(fs), os.path.dirname(fs[0]))
                break
        if rok:
            break
    check("codex-rollouts", rok, rdetail,
          "三个 rollout 根目录都没有文件；OpenAI 侧将统计为 0")

    ccount = len(glob.glob(ex(CLAUDE_PROJECTS_GLOB)))
    check("claude-projects", ccount > 0 or os.path.isdir(ex("~/.claude/projects")),
          "%d session files" % ccount,
          "~/.claude/projects 不存在；手动 Claude Code 用量将被跳过（可忽略）")

    ok = all(c["ok"] for c in checks)
    if args.json:
        print(json.dumps({"ok": ok, "version": VERSION, "checks": checks}, ensure_ascii=False, indent=1))
    else:
        for c in checks:
            print("[%s] %-16s %s" % ("PASS" if c["ok"] else "FAIL", c["name"], c["detail"]))
            if not c["ok"]:
                print("       hint: %s" % c["hint"])
        print("self-test: %s" % ("OK" if ok else "FAILED"))
    sys.exit(0 if ok else 1)


def fail(error, hint=""):
    if '--json' in sys.argv:
        print(json.dumps({"ok": False, "error": error, "hint": hint}, ensure_ascii=False))
    else:
        print("ERROR: %s" % error)
        if hint:
            print("hint: %s" % hint)
    sys.exit(1)


def main():
    # --json 可出现在任意位置（含子命令之后）
    use_json = "--json" in sys.argv
    argv = [a for a in sys.argv[1:] if a != "--json"]
    p = argparse.ArgumentParser(prog="model-usage-cost",
                                description="本机各模型 token 用量 + openclaw.json 刊例价理论花费")
    p.add_argument("--version", action="version", version="%(prog)s " + VERSION)
    p.add_argument("--json", action="store_true", help="JSON 输出（位置不限）")
    p.add_argument("--config", default=DEFAULT_CONFIG, help="OpenClaw 配置路径（价格来源）")
    sub = p.add_subparsers(dest="cmd")

    s = sub.add_parser("summary", help="多窗口汇总（默认命令）")
    s.add_argument("--windows", default=DEFAULT_WINDOWS, help="窗口天数列表，逗号分隔（默认 1,7,30）")
    s.add_argument("--days", default=None, help="单窗口天数，如 --days 7（覆盖 --windows）")
    s.add_argument("--split", default="%.4g,%.4g,%.4g" % DEFAULT_SPLIT,
                   help="gateway prompt 拆分比例 fresh,cacheWrite,cacheRead")
    s.add_argument("--top", type=int, default=0, help="每窗口只显示前 N 行（默认全部）")
    s.add_argument("--by-model", action="store_true", help="跨来源按模型合并")
    s.set_defaults(func=cmd_summary)

    q = sub.add_parser("prices", help="显示当前 catalog 刊例价")
    q.set_defaults(func=cmd_prices)

    t = sub.add_parser("self-test", help="数据源与价格 catalog 自检")
    t.set_defaults(func=cmd_selftest)

    args = p.parse_args(argv)
    args.json = args.json or use_json
    if not getattr(args, "cmd", None):
        # 裸调用 -> 默认 summary
        for k, v in dict(windows=DEFAULT_WINDOWS, days=None,
                         split="%.4g,%.4g,%.4g" % DEFAULT_SPLIT, top=0, by_model=False).items():
            setattr(args, k, v)
        args.cmd, args.func = "summary", cmd_summary
    args.func(args)


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(0)
