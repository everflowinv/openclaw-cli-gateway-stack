---
name: "model-usage-cost"
description: "按 1D/7D/1M 统计本机各模型 token 用量，按 openclaw.json 刊例价估算理论花费。"
user-invocable: true
---

# model-usage-cost

统计这台 Mac 上所有 LLM 调用的 token 用量，并按 OpenClaw catalog（`~/.openclaw/openclaw.json` → `models.providers.*.models[].cost`）的官方刊例价折算理论花费。默认 1D / 7D / 30D（1M）三个窗口一次出全，单次扫描按窗口分桶，不重复读文件。

## 命令

```bash
# 默认：1D/7D/30D 三窗口汇总表（按花费降序，含 provider rollup）
bash skills/model-usage-cost/scripts/run.sh summary

# 自定义窗口 / 单窗口
bash skills/model-usage-cost/scripts/run.sh summary --windows 1,7,30
bash skills/model-usage-cost/scripts/run.sh summary --days 7

# 改 claude-cli-gateway 的缓存拆分比例（fresh,cacheWrite,cacheRead，默认 0.005,0.065,0.93）
bash skills/model-usage-cost/scripts/run.sh summary --split 0.008,0.032,0.96

# 跨来源按模型合并（去掉 openclaw/手动 的来源拆分）
bash skills/model-usage-cost/scripts/run.sh summary --by-model

# 每窗口只显示前 N 行（合计仍是全量）
bash skills/model-usage-cost/scripts/run.sh summary --top 10

# 查看当前生效的刊例价表
bash skills/model-usage-cost/scripts/run.sh prices

# JSON 输出（程序化消费）
bash skills/model-usage-cost/scripts/run.sh --json summary
bash skills/model-usage-cost/scripts/run.sh --json self-test

# 自检：四个数据源 + 价格 catalog 逐项验活
bash skills/model-usage-cost/scripts/run.sh self-test
```

## 数据源与权威层级

每个 provider 取"最权威的可用口径"，互相去重，不重复计数：

| 优先级 | 来源 | 路径 | 覆盖 | 备注 |
|---|---|---|---|---|
| 1 | codex rollouts | `~/.openclaw/agents/*/agent/codex-home/sessions/**`、`~/.openclaw/acpx/codex-home/sessions/**`、`~/.codex/sessions/**` | OpenClaw 与手动 Codex CLI 的 OpenAI 模型 | `token_count` 事件，模型取自 `turn_context` |
| 1 | claude-cli-gateway live log | `~/.openclaw/logs/claude-cli-gateway.stdout.log` | OpenClaw 的 Claude 模型 | 每请求一条 `done` 带 usage；gateway 的 `normalizedUsage()` 会压平缓存拆分，所以这里按比例估算（见下） |
| 1 | antigravity-cli-gateway live log | `~/.openclaw/logs/antigravity-cli-gateway.stdout.log` | OpenClaw 的 Antigravity 模型 | 每请求一条 `done`；2026-09-05 起 `usage_raw` 带 agy 真实拆分（fresh=input，cacheR=cache_read，out=output+thinking），更早的事件按全 fresh 回溯 |
| 2 | OpenClaw trajectories | `~/.openclaw/agents/*/sessions/*.trajectory.jsonl` | 其余所有 provider（google/xai/deepseek/qwen/zai/…），缓存拆分真实 | 按 `(traceId,runId,seq,ts)` 去重取 max total；跳过 openai/claude-cli-gateway/antigravity-cli-gateway（已由上面覆盖） |
| 2 | Claude Code 本地会话 | `~/.claude/projects/*/*.jsonl` | 手动 Claude Code CLI | 缓存拆分真实，同时是 gateway 拆分比例的标定源 |

## 口径与已知误差（输出里会带这些提示）

1. **claude-cli-gateway 的 fresh/cacheW/cacheR 是估算拆分**，不是读出来的。gateway 用 `--no-session-persistence`，本地没有逐次拆分。默认比例 0.5% / 6.5% / 93%（2026-08-16 用手动 Claude Code 会话标定：三个长度差 5 倍的 session，cache_read 稳定在 prompt 的 93–95%）。表里这些行标 `*`。精确值只能看 Anthropic 后台账单。
2. **codex rollout 不区分 cache write**，该项已按 fresh input 计价，略微高估。
3. **openai 侧是本地 rollout 下限**。云端 `account/usage/read` 才是权威口径（2026-08-16 实测本地 rollout 只解释 79%）。
4. **名义价 ≠ 实付**。全部按 openclaw.json 刊例价（短上下文档，tiered 取第一档）；订阅（Pro/Max）内边际现金支出为 0。
5. 文件按 mtime 预筛 + 事件时间戳二次过滤，只影响 append-only 日志，不会漏窗口内事件。

## 定价

- 动态读 `openclaw.json`，新模型进 catalog 后自动生效，**不在脚本里硬编码价格**。
- 未在 catalog 里的模型：花费列显示 `n/a`，表末汇总列出模型名，提示补 catalog。
- 同名模型跨 provider 价格冲突时取先到的并告警。
- `prices` 子命令可随时核对当前价格表。

## self-test

逐项检查：catalog 可读且 ≥1 个模型有价格、gateway log 存在且尾部有带 usage 的 `done`、trajectory glob 有文件且能解析出 `model.completed`、三个 rollout 根至少一个有文件、`~/.claude/projects` 存在。失败项输出 `hint`，退出码非 0。

## 目录布局

`SKILL.md` 在根目录；`run.sh`、`requirements.txt`、`model_usage_cost_cli.py` 都在 `scripts/`（Workshop 支持目录限制）。venv 首次运行时建在 skill 根目录。
