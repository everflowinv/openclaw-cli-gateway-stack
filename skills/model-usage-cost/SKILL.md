---
name: "model-usage-cost"
description: "核对本机模型用量、跨来源去重和补录，输出覆盖缺口及刊例成本估算。"
user-invocable: true
---

# model-usage-cost

统计本机仍保留、或已采入本地账本的模型用量。默认一次给出 1D / 7D / 30D，按事件时间分桶。**不是云端账单，也不承诺本机所有历史调用都有完整遥测。** 必须随结果说明 `coverage`；不能因为 `ok: true` 或 self-test 通过就称为“全部准确”。

## 命令

使用当前 skill 目录下的 `scripts/run.sh`。main agent 的 Workshop 安装位置如下（其他 agent 请用 catalog 返回的 skill 路径）：

```bash
bash ~/.openclaw/agents/main/agent/workshop-skills/model-usage-cost/scripts/run.sh summary
bash ~/.openclaw/agents/main/agent/workshop-skills/model-usage-cost/scripts/run.sh summary --days 7 --json
bash ~/.openclaw/agents/main/agent/workshop-skills/model-usage-cost/scripts/run.sh summary --windows 1,7,30 --top 10
bash ~/.openclaw/agents/main/agent/workshop-skills/model-usage-cost/scripts/run.sh summary --by-model --json
bash ~/.openclaw/agents/main/agent/workshop-skills/model-usage-cost/scripts/run.sh prices --json
bash ~/.openclaw/agents/main/agent/workshop-skills/model-usage-cost/scripts/run.sh self-test --json
```

- `--top N` 只裁剪展示行；JSON/text totals 都保留全量，包括未定价 token。
- `--by-model` 在同一 provider 内合并来源；不同 provider 的同名模型保留各自价格。
- `--as-of 2026-09-10T14:24:40Z` 固定统计截止时间；这是对当前保留证据的事件时间筛选，不是恢复当时的完整磁盘快照。
- `--no-ledger` 完全从当前源读取且不写账本/扫描缓存，适合对照审计。
- `--no-cache` 重扫源数据，仍保留账本；`--ledger PATH` 可用隔离账本做回归。
- `--audit-records PATH` 导出已计入/未对齐记录的技术元数据，不包含提示词或答案。
- `--split fresh,cacheWrite,cacheRead` 仅用于没有缓存拆分的历史 Claude gateway 日志。默认 `0.005,0.065,0.93`，保留精确 prompt 总数并标注 estimated。
- `collect-broker --json` 只采集 Dalton 长期用量表和有限容量 broker journal；不调用模型。适合每分钟执行，避免 journal 淘汰速度快于人工报表频率。

## 数据源与去重

1. **Codex runtime / 手动 Codex**：读取 agent codex-home、acpx codex-home 和 `~/.codex` 的 sessions/archived_sessions。累计 `token_count` 未变化的状态事件不重复入账；相同大小但累计值增加的真实响应保留；计数重置保留新的 last usage。按 turn 身份与原始事件时间去掉复制的历史前缀。模型跟随 turn_context。input 包含 cache，拆成 fresh/cacheWrite/cacheRead；output 已包含 reasoning。
2. **Claude Code 主会话与子代理**：递归扫描 `~/.claude/projects/**/*.jsonl`，按 `message.id` 去重，内容块不是独立调用。相同 ID 的单调增长 partial→final 用量取完成版本；冲突会报告。
3. **OpenClaw trajectories**：只读 SQLite/WAL、旧 sessions JSONL 和 `session-sqlite-import-archive`，按 trace/run/seq/time 去重。OpenAI 原生 transport 保留；Codex runtime 的 thread/turn 明确匹配 rollout 后，识别整轮/最后响应投影，避免再次累加。缺少对应 rollout 的 runtime 汇总作为 fallback。
4. **Claude gateway**：当前及轮转（含 gzip）日志。按 request 身份去重；完成请求汇总与逐消息 usage 互相替代，失败请求仍保留已经完成的消息用量。新的生产端日志保留 message ID 和完整 request UUID；旧错误日志没保存用量的部分无法凭空补齐。
5. **agy**：只读 `~/.gemini/antigravity-cli/conversations/*.db` 中 steps.metadata 的 ModelUsageStats，按 provider response/message ID 去重。protobuf 字段来自本地 agy 1.2.0 描述符；output_tokens 已包含 thinking，不再相加。按请求时间区间及完整用量向量与 gateway 日志做唯一匹配；新日志还含 conversation ID。匹配后数据库记录替代 gateway 汇总，兼容旧版重复 thinking 的日志。无法识别模型时保留 enum ID 与 token，费用不瞎猜。无法对齐的重叠 gateway 汇总单列，不直接加总。
6. **Dalton**：读取 core.sqlite 的 observability_usage_entries 最新 revision，保留 provider_reported 计量；journal 仅补缺。两者按 invocation ID 去重，不能把重试缓存当第二次调用。journal 无独立完成时间时标注 request-start；provider 之外的估计/缺失计量会在 coverage 中披露。
7. **Gateway 跨来源**：trajectory / transcript 中的 response UUID 与 gateway request UUID 匹配。优先完整 gateway/agy 计量；原始 trajectory 可能丢 cacheWrite 或只保存最后响应。尚不能对齐的 aggregate 被单列，它可能与已计入记录重叠，**不能把 unresolved token 数直接加到 TOTAL**。

## 账本和覆盖状态

默认账本：`~/.openclaw/usage-accounting/evidence.sqlite`，权限 0600。只存时间、模型、来源、计数、技术 ID 与对账字段；不存提示词、答案、凭据或 HTTP 响应头。先保存规范化观察，再重新对账，所以重扫不累加历史总数，后补权威记录可以替代 fallback。扫描缓存用路径/inode/大小/mtime 和 SQLite WAL 状态失效，归档与实时数据库分开缓存。

- `records`/兼容字段 `calls` 是**计量记录数**。`units` 区分 model-response、gateway-request、agent-run、model-invocation，不能将它们混称 API 调用次数。
- `coverage.complete` 始终为 false：本地记录不能证明云端全部使用情况。`issues`、`inventory`、`stats` 和 `unresolved_aggregate_records` 说明可读性、补漏与对账情况。
- 失败/取消无 usage、坏 JSON、缺 usage、schema 漂移与身份冲突必须披露。数据库读失败直接返回 `ok:false` 和非零退出码；不能作为成功的零用量结果。
- coverage 的源扫描诊断包括缓存保留范围，不能当成某一窗口的独立请求数量。
- 账本只能保护已经采到的证据。此前已删除的会话、journal 已淘汰且长期表也未记录的调用、云端其他设备的调用不能恢复为精确用量。

## 成本

价格按 `(provider,model)` 从 `openclaw.json` 当前 catalog 读取。手动 Anthropic 对明确相同模型可使用 Claude gateway catalog 对照价；不会给其他同名 provider 随意套价。删除的模型用量照常保留，未定价 token 单独列出，**不要为了让历史成本有数而把退役模型重新加回可选模型列表**。

`cost_usd` / `priced_cost_usd` 明确标记 current-catalog-estimate。这不是已重建的历史时段/长上下文价格，更不是订阅账户实际现金支出。报告含未定价 token 时不可把 priced_cost_usd 说成总账单。

## 验证与维护

`self-test` 运行离线 accounting fixtures，不发模型请求。覆盖重复/真实同大小调用、跨窗口状态重放、fork、model switch/reset、Claude 主/子会话、原生 OpenAI 与 Codex 对账、SQLite WAL 与导入归档、agy thinking、轮转日志、失败后的 partial usage、账本幂等/修订、时区、top 全量 totals、provider 定价隔离及坏数据。

修改先在 staging 测试，通过 Skill Workshop 更新。保留 run.sh auto-bootstrap、requirements.txt、JSON CLI、self-test 和 actionable error hints。生产 gateway 的 usage 语义与本 skill 必须一起验证。
