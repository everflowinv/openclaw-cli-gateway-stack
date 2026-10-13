# Muse Code CLI Gateway

沿用本仓库 Claude CLI / Antigravity CLI 的结构：OpenClaw 调用本机 OpenAI 兼容接口，网关启动官方 `muse exec`，工具操作交给现有 OpenClaw MCP proxy。

默认仅监听 `127.0.0.1:4571`，支持 `muse-spark-1.3`、`muse-spark-1.3-contributor`、`muse-wonder-1.0` 与 `muse-wonder-full-1.0`。不直连 Meta 推理 API，不提取或转发订阅 token，不自动切到 API key 付费。

## 认证与隔离

- 必须先通过官方 `muse login` 完成设备登录。网关检查官方认证元数据为 `oauth / device_code / keychain`，不读取 Keychain 中的凭据。
- 每个请求建立独立的私有配置目录和空工作目录；配置目录中的 `auth.json` 只链接到官方认证元数据，实际认证仍由 Muse Code 处理。原有 `~/.config/muse/settings.json` 不变。
- 子进程清除 `META_API_KEY`、`MODEL_API_KEY` 和 transport trace 环境变量，避免按量 key 覆盖订阅登录。
- 每次请求显式指定 Contributor 模式：仅 `muse-spark-1.3-contributor` 为 `on`，其余三个型号为 `off`，不依赖客户端默认值，也不修改用户全局设置。
- 权限为最大档位：子进程以 `--yolo` 运行（免审批、关沙箱、信任工作区），与 Claude/AGY 两条通道的 bypass 姿势一致；reminder 代理关闭（`--disable-reminders`），避免一次性会话里无谓的后台 token 消耗。工具面按每次请求决定：未提供 `tools` 时 MCP proxy 全量开放；提供了列表则只开放列表与已知工具的交集；空工具列表或 `tool_choice: none` 时不启动 MCP 且关闭 native shell/write/web，避免空白名单被误读。压缩阈值显式钉在高位（见下方环境变量），保证被字节上限约束的首轮输入不会在推理前被压缩；工具结果回灌有字节上限。
- 每次 HTTP 请求启动新 CLI。多轮对话由 OpenClaw 传入的完整历史续接，与现有两个网关一致；不宣称提供持久原生 Muse 会话绑定。
- 超时、断连会终止独立进程组并清理请求文件。日志默认记录实时正文、工具名称/参数/结果、模型与用量；设置 `MUSE_CLI_GATEWAY_LOG_CONTENT=0` 可关闭内容日志。提示词和图片不写入日志。工具参数来自前台会话账本，按源事件去重；仅显示 CLI 提供的明文推理，不记录加密推理。

认证检查证明使用官方设备登录路径，不代表已经核对账户账单或剩余额度。订阅额度耗尽时原样报错，不新增付费凭据。

## 接口

- `GET /health`：CLI 版本、认证元数据是否满足订阅路径、队列状态。
- `GET /v1/models`：四个型号、安全上下文、最大输出元数据和 API 刊例价格；Full 的 `pricing` 为 `null`，并标明官方未公布 token 价格。
- `POST /v1/chat/completions`：文本、内联 PNG/JPEG/WebP 图片；JSON 或 SSE。

日志页实时显示正文与工具详情。SSE 先发角色与运行/工具进度，正文在前台任务终态成功且 CLI 正常退出后交付。失败任务的中间文本不会冒充成功答案。`run.model.configured` 必须确认 `meta` 和请求的精确型号，子任务终态不会完成主请求。

推理档位：Muse 1.4.7 的原生 `none / minimal / low / medium / high / xhigh / max / ultra` 原样直通；默认 `high`，仅 OpenAI 风格的 `off` 翻译为原生 `none`。具体订阅是否支持最高档仍以服务端结果为准。结构化输出：`response_format: json_schema` 经官方 `--output-schema` 传递（对象 schema 递归补齐 `additionalProperties: false`）；`json_object` 使用只输出一个 JSON 对象的提示词约束，不宣称原生 schema 强制保证。

### 限制

- 用量来自官方临时会话账本中的 `model_completed`，不是 stdout JSONL。主调用和后台观察器一起计入，按源记录 ID 去重；缓存属于输入、推理属于输出，不重复相加。原始会话目录提取完即删除，服务日志保留计数、技术 ID 及上述可配置内容。未报告的调用不填零；旧版未落盘请求无法补回。
- API 刊例估算不是订阅实付：每百万 tokens 的输入/缓存输入/输出，Spark Standard 为 $1.25/$0.15/$4.25，Spark Contributor 为 $0.10/$0.002/$0.20，Wonder Standard 为 $4/$0.20/$20。Wonder Full 仅通过订阅提供，官方没有公布 token 刊例价；成本保持未知，不填零，也不套用 Wonder 的价格。Contributor 允许输入/输出用于训练，不应承载敏感资料。
- `max_tokens` 不会变成 CLI 的精确输出 token 上限；目前用总超时、流停滞超时和 `max-model-steps` 控制请求。
- 不接受远程图片 URL；OpenClaw 应先下载并以内联 data URI 提供图片。图片按编号与消息历史关联，通过官方 `--image` 输入。
- 本版使用稳定的 `exec --json`。MSP `serve` 在本机探针中接受 turn 后未完成输出，因此没有部署未经验证的 MSP 路径。
- Native CLI 的会话恢复、模型切换和独立子会话不由这个 HTTP 网关提供。

## 配置

常用环境变量：

- `MUSE_CLI_GATEWAY_LOG_CONTENT`：默认开启正文和工具详情日志；`0` 关闭。
- `MUSE_CLI_BIN`：默认 `~/.local/bin/muse`。
- `MUSE_CLI_GATEWAY_PORT`：默认 `4571`；监听地址固定为 loopback。
- `MUSE_CLI_GATEWAY_MAX_CONCURRENT`：默认 `2`。
- `MUSE_CLI_GATEWAY_QUEUE_TIMEOUT_MS`：默认 `120000`。
- `MUSE_CLI_GATEWAY_TIMEOUT_MS`：默认 `1800000`。
- `MUSE_CLI_GATEWAY_STALL_MS`：默认 `300000`。
  仅 CLI stdout 刷新停滞计时，网关心跳不计入。失败终态立即触发进程组清理；
  取消、停滞、超时后先 SIGTERM，2 秒后 SIGKILL，再过 1 秒仍未关闭输出管道
  则强制收尾、释放槽位并删除临时目录。CLI 主进程退出时也回收 MCP 子进程。
  `/health` 返回停滞阈值、进程组清理状态及清理时限。
- `MUSE_CLI_GATEWAY_MAX_MODEL_STEPS`：默认 `100`。
- `MUSE_CLI_GATEWAY_EXEC_MAX_TIMEOUT_MS`：默认 `600000`。
- `MUSE_CLI_GATEWAY_COMPACTION_SOFT_THRESHOLD` / `MUSE_CLI_GATEWAY_COMPACTION_HARD_THRESHOLD`：默认 `0.9` / `0.98`，透传官方 `--context-compaction-*-threshold`。钉在高位是为了让被 1,900,000 字节上限约束的首轮输入不会在推理前被压缩；逐请求的账本校验仍会在压缩发生时以 413 失败关闭。CLI 自身的估算器会以 512k 压缩预算硬拒绝超大首轮输入，明确的上下文拒绝归一为 413 `MUSE_CONTEXT_LIMIT`。对于至少 1MB、无工具、无图片、无 schema 的纯文本请求，仅将已实测的通用 invalid-parameters 错误签名按可能超限处理；其他 API 400 保持普通失败，避免掩盖参数错误。
- `MUSE_CLI_GATEWAY_MAX_TOOL_OUTPUT_BYTES`：默认 `262144`，透传官方 `--max-tool-output-bytes`，避免单个巨大工具结果一次撑爆上下文。
- `MUSE_CLI_GATEWAY_MAX_PROMPT_BYTES`：默认 `1900000`（不可通过环境变量上调），按 UTF-8 字节检查。
- `MUSE_CLI_GATEWAY_STATE_DIR`：默认 `~/.openclaw/state/muse-cli-gateway`。
- `MUSE_CLI_GATEWAY_API_KEY`：可选的本地网关认证，不是 Meta 凭据。
- `MUSE_CLI_GATEWAY_MCP_PROXY`：默认本仓库的 `openclaw-mcp-proxy/server.js`。

## 安装服务

先跑测试，确认本机官方 CLI 登录可用，再仅安装此服务；不会重启 Claude、Antigravity 或 OpenClaw 网关。

```bash
node --test muse-cli-gateway/gateway.test.mjs
python3 muse-cli-gateway/install.py --render-only /tmp/muse-gateway-preview.plist
python3 muse-cli-gateway/install.py
```

日志：`~/.openclaw/logs/muse-cli-gateway.{stdout,stderr}.log`。实际 launchd label 为 `ai.openclaw.muse-cli-gateway`。仓库根目录的 `bash launchd/install.sh` 也会安装同一服务，其 `launchd/muse-cli-gateway.plist.template` 与本目录 `install.py` 渲染出语义一致的 plist（改一处需同步另一处）；只安装/重启本服务时优先用上面的 `install.py`。

OpenClaw 注册独立 provider `muse-cli-gateway`，base URL 为 `http://127.0.0.1:4571/v1`，api 为 `openai-completions`。模型目录、modelPolicy allow 和 alias 须一起添加，但不改默认模型及回退链。示例 key 可用本地占位值；这里绝不放订阅凭据。

Wonder / Full 的别名为 `MuseWonder` / `MuseWonderFull`。Full 的 OpenClaw 原始配置省略 `cost`；当前 OpenClaw 会把缺省成本规范化为零，因此其费用界面的零值只是未知价格的占位，不代表免费。本网关的模型目录和用量日志保留 `null`。

## 验证

离线回归覆盖 Unicode、历史边界、请求级 MCP 白名单、订阅认证检查、终态/模型校验、队列、取消、超时、SSE 失败传播及敏感字段遮盖：

```bash
node --test muse-cli-gateway/gateway.test.mjs
curl --fail http://127.0.0.1:4571/health
```

真实验收还需短答、历史续聊、图片和只读 MCP 工具调用。不能用 health 或 CLI exit 0 代替这些验收。

官方依据：

- <https://dev.meta.ai/docs/muse-code/subscriptions.md>
- <https://dev.meta.ai/docs/muse-code/auth.md>
- <https://dev.meta.ai/docs/muse-code/extending.md>
- <https://dev.meta.ai/docs/pricing-rate-limits.md>
- <https://dev.meta.ai/models/muse-wonder>

## 实际上下文与看板

API 宣传窗口为1,048,576，CLI目录报告1,007,997，但本机1.3.0运行时的压缩策略使用512,000预算，软/硬阈值分别384,000/460,800。2.5MB及更大测试被自动压缩，只保留尾部校验值，CLI仍exit0。

2026-10-12 至 13 日，在 Muse Code 1.4.7 上，四个型号均通过约 1.9MB 英文输入的 6 个随机校验值测试，并通过首轮账本字节校验，报告约 337k 输入 tokens；Contributor 另通过 1.4MB 中文输入（约 308k tokens）。因此文本网关上限从 1,400,000 提升至 **1,900,000 UTF-8 字节**，包括网关包装、系统指令和历史。在线网关还通过 1.85MB 英文请求（6/6 校验值、约 329k tokens）。[探针证据](../docs/muse-context-probes-2026-10-13.json) 保存了脱敏结果；这是指定测试文本的验证，不代表任何 1.9MB 内容都能容纳。

OpenClaw 安全 context 继续为 **384,000 tokens**，最大输出元数据为 128,000。CLI 的目录窗口 1,007,997 不等于可用网关窗口：压缩估算器的硬阈值为 501,760（512k × 0.98），2.09MB 及以上英文探针已被拒绝，高 token 密度内容也可能更早触发限制。不能把字节上限上调解释为已验证更大的 token 窗口。

网关显式透传 `--context-compaction-soft-threshold 0.9` 与 `--context-compaction-hard-threshold 0.98`，并逐请求核对首轮模型输入的 `current_user_message_bytes`；CLI 若预先压缩或裁剪原文，返回 413，不把截短回答报成成功。HTTP/SSE `usage` 使用首轮前台输入与累计前台输出；日志 `usage` 保留包含后台的计费总量，`usage_reported` 记录返回客户端的上下文口径。计费用量不是上下文占用量，不能混用。

现有 HTML 看板的 Muse Code 页签为 `http://127.0.0.1:8765/#muse-cli-gateway`。显示请求状态、主/后台用量、缓存、推理、刊例估算及覆盖缺口；usage/done 重复事件按请求 ID 合并，不双计。仅显示当前加载日志，不是全历史账单。
