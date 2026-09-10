# 用量统计深入核账与修复

确认同时存在重复累加和漏记，已修复并通过 Workshop 应用到 main agent 的 model-usage-cost 2.0.0。生产网关也已更新；模型可选列表未改。

## 原因与证据

- **Codex 状态重复**：在固定 30D 窗口，OpenClaw 的 583 条累计未变化事件重复加了 41,758,233 tokens；手动 Codex 的 118 条重复加了 14,162,818 tokens。新版保留累计增加的真实同大小响应，并兼容跨 turn 计数重置。
- **Claude 分块重复与子代理漏记**：同一 message.id 多个内容块重复携带 usage。主会话旧统计重复 2,332,495,178 tokens；递归补读 138 个子代理文件，11,210 个消息按 final 用量计为 2,476,560,674 tokens。早先取首次消息的审计估算还少了 8,021,972 tokens。已入账 final 不会被旧 partial 文件降级。
- **原生 OpenAI 被整类排除**：现在按 thread/turn 明确区分原生 transport 与 Codex runtime。30D 补入 1,051 条原生汇总，共 1,251,307,095 tokens；907 条 runtime trajectory 与对应 rollout 的整轮或最后响应对齐，不再重复加入。
- **agy 重复 thinking**：本地 CLI 1.2.0 的 protobuf 描述符和实际 ModelUsageStats 证明 output_tokens 已含 thinking。实例：47,488 = 26,507 thinking + 20,981 正文，旧网关却返回 73,995。网关、独立 parser、统计脚本现在统一不再加第二遍。
- **agy 直接 CLI 漏计**：121 个成功 gateway 请求全部与会话 DB 唯一对齐，对应 2,714 个模型响应；其余 249 个本地模型响应共 24,826,036 tokens 也已纳入。后者可能含直接 CLI 和失败/取消 gateway 的已计量部分，不武断全部归为“手动”。
- **迁移归档与 Dalton**：补读 SQLite 导入归档，按事件身份与当前库去重；Dalton 长期 usage 表、有限容量 journal 按 invocation ID 和最新 revision 合并，重试缓存不另计调用。

## 固定窗口复算

事件截止点：**2026-09-10T14:24:40.060925Z**。使用当前保留原始记录及已入账证据，不是云端账单，也不是当时磁盘的完整快照。

| 窗口 | 原统计 tokens | 修复后 tokens |
|---|---:|---:|
| 1D | 1,121,193,955 | 3,214,477,668 |
| 7D | 6,050,290,319 | 7,195,594,222 |
| 30D | 16,194,453,916 | 18,107,797,721 |

重复和漏计会相互抵消，单项加减不能直接当净变化。生产版本重扫同一截止点，三个窗口的完整 rows/totals 完全一致。

## 防止复发

- 权限 0600 的本地 SQLite 账本只保留技术 ID、时间、计数和对账字段，不存提示词、答案或凭据。先存原始观察，再对账；后来补到权威证据时替换 fallback。
- 扫描缓存按文件 inode/大小/mtime 和 SQLite WAL 失效；归档和实时数据库分别缓存。
- Claude gateway 保留逐消息 usage、message ID、完整 request UUID。失败请求没有最终汇总时，已完成响应仍可入账；成功汇总不与逐消息再相加。
- agy gateway 新增 conversation ID 和 usage schema 标识。
- Dalton collector 每 60 秒采集，不调用模型。状态原子写入 `~/.openclaw/usage-accounting/collector-status.json`，已执行成功。
- `--top` 只裁剪显示，合计保留全量。价格按 provider/model 隔离；未知历史价格保留 token，单列未定价部分。

## 仍存在的历史边界

- 固定截点仍有 **40 条历史 gateway 汇总**无法无歧义对齐，共 82,436,221 tokens，可能与已计入请求重叠。因此没有额外加到 TOTAL，也不能直接认作新增漏计。
- 某些旧失败/取消日志没有 usage，原始源也没保留完整遥测。新版明确披露，不填零后宣称全部覆盖。
- 成本仍是当前本地 catalog 的刊例估算，没有声称恢复所有历史时段/长上下文价格或订阅实付；不会为补成本把退役模型加回可选列表。

## 验证与部署

- 32 项 Python 回归通过：状态重复/真实相同大小响应、主/子会话、fork、reset/model switch、负时区、SQLite WAL/归档、轮转、agy thinking、失败 partial、账本幂等/修订/旧 partial 回退、缓存 WAL 失效、top 和 provider 定价隔离。
- 6 项共享助手测试、2 项 HTTP + 合成 CLI 集成测试、13 项独立 parser 检查通过。
- 两套生产 gateway 在 activeRequests=0、queuedRequests=0 时重启，健康正常。OpenClaw 主网关无需重启。
- Workshop 提案：`model-usage-cost-20260910-8c79ddfaac`、`model-usage-cost-20260910-617ef76bcd`、`model-usage-cost-20260910-2c4a567a47` 均已应用。

本地复核文件：selftest-live.json、summary-live.json、summary-live-repeat.json、counter-semantics.json、source-totals.json、forensics.py、agy-matches.json。真实账本和会话数据不提交到仓库。
