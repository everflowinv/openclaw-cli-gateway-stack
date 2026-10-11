---
name: model-usage-cost
description: "核对本机模型用量、Token 周报、跨来源重复及覆盖缺口，输出可复算的当前 catalog 成本估算。"
---

# model-usage-cost

## 1. 固定窗口并采集

使用本 skill 的 `scripts/run.sh`：

```bash
bash scripts/run.sh summary --days 7 --by-model --json
bash scripts/run.sh summary --windows 1,7,30 --json
bash scripts/run.sh summary --days 7 --as-of 2026-10-10T04:00:00Z --audit-records /absolute/private/records.json --json
bash scripts/run.sh prices --json
bash scripts/run.sh self-test --json
```

以输出的 `from` / `to` 为准，区间为 `[from,to)`。修订旧报告时固定原截止点；重新触发 cron 时按该次执行时点统计。`--top` 只裁剪展示行，totals 保持全量；生成周报用未裁剪 JSON。

读取成功且 `ok:true` 后继续。失败时报告具体来源错误，不生成成功的零用量报告。

## 2. 核查来源与关联

读取 `coverage.inventory`、`issues`、`stats` 和 `unresolved_aggregate_records`，按以下计量规则解释结果：

- Codex：读取 OpenClaw/acpx codex-home 及手动 `~/.codex` 的 rollout。累计计数未变的状态事件不重复入账；保留真实同大小响应、模型切换和计数重置。另读取 `compacted.latest_token_usage_record`，要求 response ID 与 compaction response ID 一致；复制历史按 response ID 去重，与普通 token 事件的重叠单列。
- Claude Code：递归扫描主会话与子代理；按 message ID 去重，单调增长 partial→final 取完整值。Claude gateway 的完成汇总替代其逐响应记录；失败请求保留已完成响应。完整逐响应拆分可用于分档计价。
- OpenClaw：读取 SQLite/WAL、导入归档与旧 trajectory；同时解压 `transcript_events.event_zstd` 以恢复 response ID 关联。Codex thread/turn 与 rollout 对齐后不再累加运行汇总；原生 transport 保留。
- Antigravity：读取会话 DB 的 ModelUsageStats，output 已含 thinking。优先用 `gen_metadata` 中模型名与 enum 的对应关系，保留接入渠道；不要把 Antigravity 渠道下的 Claude 归为 Google。只有枚举且存在唯一对应时才还原名称，冲突保持待识别。按会话、请求时间和完整用量与网关对齐。
- Muse：读取 `~/.local/share/muse/sessions/**/session.jsonl` 和 Muse gateway 的完整 `modelCalls`。按 run ID + source record ID 去重，包含主调用、子代理和后台模型；完整模型响应替代 request/trajectory 的上下文投影。各后台模型保留自己的名称和价格。
- Dalton：长期用量表取最新 revision，journal 按 invocation ID 补缺。与 CLI gateway 的重复优先用共同请求 ID；历史缺 ID 时仅用同渠道/模型、完整四项用量及请求时间的双向唯一匹配。推断关联计入 `dalton_gateway_inferred_records`；多个候选或重叠但用量不符的汇总单列，不能叠加。
- ZCode：只读 builtin provider 的数据库与 rollout，主对话、子代理、标题、压缩和工具内部请求按现存 usage 计量；`turn_usage` 不另加。没有同渠道价格时保持未定价。

核对每条用量由 fresh、cache_write、cache_read、output 四个不重叠部分构成；output 含 reasoning/thinking。`records`/兼容字段 `calls` 是计量记录数，units 区分 model-response、gateway-request、agent-run、model-invocation，报告统一称“条计量记录”。

## 3. 保留覆盖和价格边界

`coverage.complete` 始终为 false。本机留存无法证明云端所有调用完整。失败/取消未返回 usage、已删除且未入账、非 provider-reported 计量以及未对齐汇总须随周报披露。诊断计数包含相邻对账窗口，不能当作七天内独立失败请求数。

关联到网关后使用完成时间；历史只有请求开始时间的记录保留并以 `request_start_time_records` 单列。跨窗口扫描保留相邻一天证据，只在最终输出按目标时间窗筛选。

价格按 `(provider,model)` 从当前 `openclaw.json` catalog 读取。手动 Claude 可使用相同模型的 Claude gateway 对照价；Muse 原生与 gateway 使用同一 Muse 模型 catalog 参考价。单响应按输入上下文选择 `tieredPricing`；完整逐响应拆分分别计价。缺拆分的上层汇总按基础档估算，以 `tier_context_unknown_records` 披露，不能把多响应总 Prompt 当作一个长上下文。

金额称“当前 catalog 参考成本”，订阅实付以账单为准。缺价格的 Tokens 保留在总量并单列；不要为补历史价格将退役模型重新加入可选目录。缓存指标称“Prompt 缓存读取占比（按 Token 加权）”，不推断成调用命中率或成本节省率。

## 4. 保护易淘汰证据并复算

默认账本 `~/.openclaw/usage-accounting/evidence.sqlite`，权限 0600，只存技术计量字段。观察先入账再对账，补采权威来源可替代 fallback；重新扫描不累加历史总数。

```bash
bash scripts/run.sh collect-broker --days 2 --json
bash scripts/run.sh summary --days 7 --no-cache --ledger /absolute/private/staging.sqlite --json
bash scripts/run.sh summary --days 7 --no-ledger --json
```

`collect-broker` 保留兼容命令名，现采集 Dalton、Antigravity 会话及网关、Claude gateway、Muse 原生与网关等易轮转证据；本机现有每分钟 collector 调用它，不调用模型。用 `collector-status.json` 验证周期采集成功。它保护采到的证据，不恢复此前已丢失历史。

`--no-cache` 重扫但保留账本；`--no-ledger` 不读写账本/扫描缓存。源数据已轮转时两者可不同，不把差额直接当作重复或漏记。用隔离账本固定时间复算，确认 totals、模型行和证据关联幂等。

## 5. 验证并发布修复

先在 staging 改代码，运行 `self-test`、固定窗口实数复算及账本重复扫描检查；保留 run.sh 自动环境准备、requirements、JSON CLI、错误提示和既有测试。通过 Workshop 发布 support files 与 SKILL.md，再验证生产入口。周报还需验证模型合并、完整四项构成、coverage、价格合计及保存的计量/卡片快照。

用户要求重发时，优先触发既有周报 cron，检查该轮执行结果、保存的 delivery 回执和飞书消息读回；避免再从另一路手动发送相同报告。
