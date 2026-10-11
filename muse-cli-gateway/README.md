# Muse Code CLI Gateway

沿用本仓库 Claude CLI / Antigravity CLI 的结构：OpenClaw 调用本机 OpenAI 兼容接口，网关启动官方 `muse exec`，工具操作交给现有 OpenClaw MCP proxy。

默认仅监听 `127.0.0.1:4571`，支持 `muse-spark-1.3` 与 `muse-spark-1.3-contributor`。不直连 Meta 推理 API，不提取或转发订阅 token，不自动切到 API key 付费。

## 认证与隔离

- 必须先通过官方 `muse login` 完成设备登录。网关检查官方认证元数据为 `oauth / device_code / keychain`，不读取 Keychain 中的凭据。
- 每个请求建立独立的私有配置目录和空工作目录；配置目录中的 `auth.json` 只链接到官方认证元数据，实际认证仍由 Muse Code 处理。原有 `~/.config/muse/settings.json` 不变。
- 子进程清除 `META_API_KEY`、`MODEL_API_KEY` 和 transport trace 环境变量，避免按量 key 覆盖订阅登录。
- Native shell、write、web tools 关闭；MCP proxy 的服务端工具白名单来自该次 OpenClaw 请求的 `tools`。未提供工具、空工具列表或 `tool_choice: none` 不启动 MCP，避免空白名单被解释为全放行。
- 每次 HTTP 请求启动新 CLI。多轮对话由 OpenClaw 传入的完整历史续接，与现有两个网关一致；不宣称提供持久原生 Muse 会话绑定。
- 超时、断连会终止独立进程组并清理请求文件。日志默认记录实时正文、工具名称/参数/结果、模型与用量；设置 `MUSE_CLI_GATEWAY_LOG_CONTENT=0` 可关闭内容日志。提示词和图片不写入日志。工具参数来自前台会话账本，按源事件去重；仅显示 CLI 提供的明文推理，不记录加密推理。

认证检查证明使用官方设备登录路径，不代表已经核对账户账单或剩余额度。订阅额度耗尽时原样报错，不新增付费凭据。

## 接口

- `GET /health`：CLI 版本、认证元数据是否满足订阅路径、队列状态。
- `GET /v1/models`：Standard 与 Contributor 两个模型，含安全上下文和 API 刊例价格。
- `POST /v1/chat/completions`：文本、内联 PNG/JPEG/WebP 图片；JSON 或 SSE。

日志页实时显示正文与工具详情。SSE 先发角色与运行/工具进度，正文在前台任务终态成功且 CLI 正常退出后交付。失败任务的中间文本不会冒充成功答案。`run.model.configured` 必须确认 `meta / muse-spark-1.3`，子任务终态不会完成主请求。

推理档位：`minimal / low / medium / high / xhigh / max`；默认 `high`，`off/none` 映射为 `minimal`，`ultra` 映射为 `max`。具体订阅是否支持最高档仍以服务端结果为准。

### 限制

- 用量来自官方临时会话账本中的 `model_completed`，不是 stdout JSONL。主调用和后台观察器一起计入，按源记录 ID 去重；缓存属于输入、推理属于输出，不重复相加。原始会话目录提取完即删除，服务日志保留计数、技术 ID 及上述可配置内容。未报告的调用不填零；旧版未落盘请求无法补回。
- API 刊例估算不是订阅实付：Standard 输入/缓存/输出为 $1.25/$0.15/$4.25，Contributor 为 $0.10/$0.002/$0.20，每百万 tokens。Contributor 允许输入/输出用于训练，不应承载敏感资料。
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
- `MUSE_CLI_GATEWAY_MAX_PROMPT_BYTES`：默认 `1400000`（不可通过环境变量上调），按 UTF-8 字节检查。
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

日志：`~/.openclaw/logs/muse-cli-gateway.{stdout,stderr}.log`。实际 launchd label 为 `ai.openclaw.muse-cli-gateway`。

OpenClaw 注册独立 provider `muse-cli-gateway`，base URL 为 `http://127.0.0.1:4571/v1`，api 为 `openai-completions`。模型目录、modelPolicy allow 和 alias 须一起添加，但不改默认模型及回退链。示例 key 可用本地占位值；这里绝不放订阅凭据。

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

## 实际上下文与看板

API 宣传窗口为1,048,576，CLI目录报告1,007,997，但本机1.3.0运行时的压缩策略使用512,000预算，软/硬阈值分别384,000/460,800。2.5MB及更大测试被自动压缩，只保留尾部校验值，CLI仍exit0。

两种模型均通过约1.4MB、约400k已报告输入tokens的6个随机校验值测试；中文900k字节测试也完整通过。为给CLI自身提示及工具上下文留余量，OpenClaw配置安全context为384,000，文本网关上限1,400,000 UTF-8字节。逐请求还检查首轮模型输入的current_user_message_bytes，若CLI预先压缩/裁剪原文则返回413，绝不把截短回答报成成功。计费用量不是上下文占用量，不能混用。HTTP/SSE `usage` 使用首轮前台输入与累计前台输出；日志 `usage` 保留包含后台的计费总量，`usage_reported` 记录返回客户端的上下文口径。

CLI模型目录的output_limit为128,000；它是模型能力元数据，不是此网关对max_tokens的硬执行保证。Contributor目录列出max且本机max短请求通过；API Models页面对max仅Standard的描述与CLI实际行为不同，接入按本次CLI证据记录。

现有HTML看板增加Muse Code页签：`http://127.0.0.1:8765/#muse-cli-gateway`。显示请求状态、主/后台用量、缓存、推理、刊例估算及覆盖缺口；usage/done重复事件按请求ID合并，不双计。仅显示当前加载日志，不是全历史账单。
